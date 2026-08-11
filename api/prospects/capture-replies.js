/**
 * GET|POST /api/prospects/capture-replies
 *
 * REPLY CAPTURE for the cold-email pipeline.
 *
 * The problem: cold emails go out via Resend with reply_to = STILO_REPLY_TO
 * (remyleon@stiloaipartners.com, the master inbox). Resend is send-only, so it
 * never sees the replies. They land in that Gmail inbox unrecorded, which is
 * why prospecting.lead_messages.replied_at has stayed null on all 239 sends.
 *
 * What this does: reads the master Gmail inbox (read-only) for the last N days,
 * matches each inbound message back to the outbound lead_messages row we sent
 * that person, and stamps the reply so it shows up on the dashboard:
 *   - lead_messages.replied_at  = when the reply arrived
 *   - lead_messages.body_preview = first ~200 chars of the reply (see note below)
 *   - lead_messages.raw_payload  = { reply: {...} } for audit
 *   - leads.reply_received_at    = when the reply arrived
 *   - leads.reply_snippet        = first ~200 chars of the reply
 *
 * ADDRESS-LEVEL EXIT. reply_received_at is also stamped on every OTHER lead
 * sitting on the same address (same owner_email, or previously mailed at that
 * to_address), because a reply is a human deciding to talk to us, and the drip
 * must stop for all of that human's rows, not just the one we happened to mail.
 * The reply body, status and lead_messages update stay attributed to the single
 * matched row.
 *
 * NOTE on where the snippet lives: the task described a lead_messages.reply_snippet
 * column, but the live schema does NOT have one. lead_messages has replied_at,
 * body_preview and raw_payload. So we write the reply text to body_preview (and
 * keep the full snapshot in raw_payload). leads.reply_snippet DOES exist and is
 * set as specified. No schema change is made.
 *
 * Matching (most-recent outbound wins):
 *   1) PRIMARY: outbound lead_messages.to_address == the reply's From address,
 *      direction='outbound', replied_at IS NULL.
 *   2) SECONDARY: the reply's In-Reply-To / References headers contain one of
 *      our provider_message_id values. Resend stamps the outgoing email's RFC
 *      Message-ID as "<{provider_message_id}@...resend.email>", so a well-behaved
 *      mail client echoes that bare UUID back inside In-Reply-To/References.
 *
 * Idempotent: an outbound row with replied_at already set is skipped, so
 * re-running (cron) never double-records.
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. An admin/SDR
 * JWT also works for manual triggering from the dashboard.
 *
 * OAuth: reads the master inbox using a STILO-owned, read-only Gmail token
 * stored in public.oauth_tokens under provider 'gmail-inbox' (scope
 * gmail.readonly). This is a SEPARATE row from the calendar token, so granting
 * it never disturbs booking. If that row is missing, this endpoint returns a
 * clear 503 telling the user exactly which /api/oauth link to open.
 */

const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// Where Remy grants the read-only inbox scope. Open this while signed into
// Google as remyleon@stiloaipartners.com (the STILO_REPLY_TO inbox).
const GMAIL_REAUTH_URL = '/api/oauth?provider=gmail-inbox&action=start';

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}
function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// ---- OAuth token helpers (same DB-first pattern as _google_calendar.js) -----

// The read-only inbox refresh token. Persisted by /api/oauth?provider=gmail-inbox
// into public.oauth_tokens. Falls back to an env var for parity with calendar.
async function getGmailRefreshToken(pub) {
    try {
        const { data } = await pub.from('oauth_tokens')
            .select('refresh_token, scope').eq('provider', 'gmail-inbox').maybeSingle();
        if (data && data.refresh_token) return { refresh_token: data.refresh_token, scope: data.scope || '' };
    } catch (_) { /* fall through to env */ }
    if (process.env.GMAIL_INBOX_REFRESH_TOKEN) {
        return { refresh_token: process.env.GMAIL_INBOX_REFRESH_TOKEN, scope: 'gmail.readonly' };
    }
    return null;
}

async function accessTokenFromRefresh(refreshToken) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });
    if (!r.ok) throw new Error('oauth_refresh_failed: ' + (await r.text()).slice(0, 200));
    return (await r.json()).access_token;
}

// ---- Gmail parsing helpers --------------------------------------------------

// PostgREST's ilike passes the pattern straight to SQL LIKE, where `_` matches
// any single character and `%` matches any run. Email local-parts are full of
// underscores ("john_smith@acme.com"), so an unescaped address is a wildcard
// that happily matches johnXsmith@acme.com and attributes the reply to the
// wrong lead. Backslash is LIKE's default escape character.
function likeEscape(s) {
    return String(s).replace(/([\\%_])/g, '\\$1');
}

// Pull "Name <a@b.com>" or "a@b.com" down to the bare, lowercased address.
function parseAddress(headerValue) {
    if (!headerValue) return null;
    const m = String(headerValue).match(/<([^>]+)>/);
    const raw = (m ? m[1] : headerValue).trim().toLowerCase();
    const at = raw.match(/[^\s<>,;"']+@[^\s<>,;"']+/);
    return at ? at[0] : null;
}

function headerMap(payload) {
    const out = {};
    const hs = (payload && payload.headers) || [];
    for (const h of hs) out[String(h.name || '').toLowerCase()] = h.value || '';
    return out;
}

// Extract every bare Message-ID token ("<uuid@host>" -> "uuid@host" and "uuid")
// from an In-Reply-To / References header, so we can substring-match our stored
// Resend provider_message_id (a bare UUID) against them.
function referencedIds(hmap) {
    const blob = [hmap['in-reply-to'] || '', hmap['references'] || ''].join(' ');
    const ids = [];
    const re = /<([^>]+)>/g;
    let m;
    while ((m = re.exec(blob)) !== null) {
        const inner = m[1].trim();
        ids.push(inner.toLowerCase());
        // Also the local-part before '@' — Resend's Message-ID is
        // "<{uuid}@region.resend.email>", so the uuid alone is the useful key.
        const local = inner.split('@')[0];
        if (local) ids.push(local.toLowerCase());
    }
    return ids;
}

// Best-effort plain-text body extraction from a Gmail message payload. We only
// need ~200 chars, and Gmail's `snippet` is usually enough, but prefer real body
// text when we can decode it cheaply.
function decodeBase64Url(data) {
    try {
        const norm = String(data).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(norm, 'base64').toString('utf8');
    } catch (_) { return ''; }
}
function extractBodyText(payload) {
    if (!payload) return '';
    const mt = String(payload.mimeType || '');
    if (mt === 'text/plain' && payload.body && payload.body.data) {
        return decodeBase64Url(payload.body.data);
    }
    // Walk multipart, prefer text/plain.
    const parts = payload.parts || [];
    for (const p of parts) {
        if (String(p.mimeType || '') === 'text/plain' && p.body && p.body.data) {
            return decodeBase64Url(p.body.data);
        }
    }
    for (const p of parts) {
        const nested = extractBodyText(p);
        if (nested) return nested;
    }
    return '';
}

// Trim a reply down to a clean ~200-char snippet: collapse whitespace and drop
// the most common quoted-reply lead-ins so the snippet is the person's actual
// words, not "On Tue ... wrote:".
function makeSnippet(text, fallbackSnippet) {
    let s = String(text || '').replace(/\r/g, '');
    // Cut everything from a typical quote marker onward.
    const cut = s.search(/\n\s*On .+ wrote:|\n\s*-{2,}\s*Original Message|\n\s*>{1,}/);
    if (cut > 0) s = s.slice(0, cut);
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) s = String(fallbackSnippet || '').replace(/\s+/g, ' ').trim();
    return s.slice(0, 200);
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailJson(url, accessToken) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!r.ok) {
        const detail = (await r.text()).slice(0, 300);
        const err = new Error('gmail_api_' + r.status + ': ' + detail);
        err.status = r.status;
        throw err;
    }
    return r.json();
}

// ---- handler ----------------------------------------------------------------

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

    // Auth: cron secret OR any logged-in admin/SDR (for manual dashboard runs).
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) {
        const gate = await assertAdminOrSdr(req, res);
        if (!gate.ok) return; // already wrote 401/403
    }

    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
        return res.status(500).json({ error: 'oauth_not_configured', detail: 'Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.' });
    }

    // Window: default last 7 days, override with ?days=N (capped 1..30).
    let days = parseInt((req.query && req.query.days) || '7', 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 30) days = 30;
    const dryRun = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));

    const pub = publicClient();

    // Mint the read-only Gmail access token for the master inbox.
    const tok = await getGmailRefreshToken(pub);
    if (!tok) {
        return res.status(503).json({
            error: 'gmail_inbox_not_authorized',
            detail: 'No read-only Gmail token for the master inbox. Grant it once, signed into Google as remyleon@stiloaipartners.com.',
            grant_scope: 'https://www.googleapis.com/auth/gmail.readonly',
            grant_url: GMAIL_REAUTH_URL
        });
    }
    // Flag if the stored token predates the gmail.readonly scope (e.g. it was a
    // calendar-only grant that got reused). This is the "must re-authorize" case.
    if (tok.scope && !/gmail\.readonly/.test(tok.scope)) {
        return res.status(503).json({
            error: 'gmail_scope_missing',
            detail: 'The stored gmail-inbox token is missing the gmail.readonly scope. Re-authorize it.',
            current_scope: tok.scope,
            grant_scope: 'https://www.googleapis.com/auth/gmail.readonly',
            grant_url: GMAIL_REAUTH_URL
        });
    }

    let accessToken;
    try { accessToken = await accessTokenFromRefresh(tok.refresh_token); }
    catch (e) {
        // invalid_grant => the refresh token is dead (expired/revoked). Only a
        // re-auth fixes it. Google expires refresh tokens after 7 days while the
        // consent screen is in "Testing" mode — publish to Production to stop it.
        return res.status(502).json({
            error: 'gmail_auth_failed',
            detail: String(e.message || e),
            grant_url: GMAIL_REAUTH_URL,
            hint: 'Open the grant_url signed in as remyleon@stiloaipartners.com to mint a fresh token.'
        });
    }

    // List inbound messages in the window. `in:inbox` + a date floor keeps this
    // cheap. We exclude our own sends so we only look at real inbound mail.
    const afterEpoch = Math.floor((Date.now() - days * 864e5) / 1000);
    const q = encodeURIComponent('in:inbox -from:stiloaipartners.com after:' + afterEpoch);
    let listing;
    try {
        listing = await gmailJson(GMAIL + '/messages?maxResults=100&q=' + q, accessToken);
    } catch (e) {
        return res.status(502).json({ error: 'gmail_list_failed', detail: String(e.message || e) });
    }
    const ids = (listing.messages || []).map(function (m) { return m.id; });

    const sb = leadsClient();
    const matched = [];
    const unmatched = [];
    let scanned = 0;

    for (const mid of ids) {
        scanned++;
        let msg;
        try {
            // metadata for headers + snippet is enough for matching + preview.
            msg = await gmailJson(
                GMAIL + '/messages/' + encodeURIComponent(mid) +
                '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=Date',
                accessToken
            );
        } catch (_) { continue; } // skip a single unreadable message, keep going

        const hmap = headerMap(msg.payload);
        const fromAddr = parseAddress(hmap['from']);
        if (!fromAddr) continue;

        // Reply arrival time: prefer Gmail's internalDate (ms epoch).
        const receivedAt = msg.internalDate
            ? new Date(parseInt(msg.internalDate, 10)).toISOString()
            : new Date().toISOString();

        const refIds = referencedIds(hmap);
        const snippet = makeSnippet('', msg.snippet); // metadata format => use Gmail snippet

        // Find the outbound row this is a reply to. Most-recent unreplied wins.
        // PRIMARY: to_address == reply's From.
        let outbound = null;
        try {
            const { data } = await sb.from('lead_messages')
                .select('id, lead_id, to_address, provider_message_id, sent_at')
                .eq('direction', 'outbound')
                .is('replied_at', null)
                .ilike('to_address', likeEscape(fromAddr))
                .order('sent_at', { ascending: false })
                .limit(1);
            if (data && data[0]) outbound = data[0];
        } catch (_) { /* try secondary */ }

        // SECONDARY: match a provider_message_id echoed in In-Reply-To/References.
        if (!outbound && refIds.length) {
            try {
                const { data } = await sb.from('lead_messages')
                    .select('id, lead_id, to_address, provider_message_id, sent_at')
                    .eq('direction', 'outbound')
                    .is('replied_at', null)
                    .not('provider_message_id', 'is', null)
                    .order('sent_at', { ascending: false })
                    .limit(200);
                if (data && data.length) {
                    outbound = data.find(function (row) {
                        const pmid = String(row.provider_message_id || '').toLowerCase();
                        return pmid && refIds.some(function (rid) { return rid === pmid || rid.indexOf(pmid) !== -1; });
                    }) || null;
                }
            } catch (_) { /* leave unmatched */ }
        }

        if (!outbound) {
            unmatched.push({ from: fromAddr, subject: hmap['subject'] || '', when: receivedAt });
            continue;
        }

        if (dryRun) {
            matched.push({ from: fromAddr, lead_id: outbound.lead_id, message_row: outbound.id, when: receivedAt, snippet: snippet, dry: true });
            continue;
        }

        // Stamp the outbound row. Idempotent: we only selected rows with
        // replied_at IS NULL, and we re-guard the update on that so a concurrent
        // run can't double-record. body_preview holds the reply snippet (no
        // reply_snippet column exists on lead_messages); raw_payload keeps a
        // full snapshot for audit.
        try {
            const { data: upd, error: updErr } = await sb.from('lead_messages')
                .update({
                    replied_at: receivedAt,
                    body_preview: snippet,
                    status: 'replied',
                    raw_payload: { reply: { gmail_message_id: mid, from: fromAddr, subject: hmap['subject'] || '', received_at: receivedAt, snippet: snippet } }
                })
                .eq('id', outbound.id)
                .is('replied_at', null)   // idempotency guard
                .select('id');
            if (updErr) { console.error('[capture-replies] message update failed', outbound.id, updErr.message); continue; }
            if (!upd || !upd.length) continue; // someone else recorded it first
        } catch (e) { console.error('[capture-replies] message update threw', outbound.id, e && e.message); continue; }

        // Stamp the lead. Best-effort; don't undo the message stamp if this fails.
        try {
            await sb.from('leads').update({
                reply_received_at: receivedAt,
                reply_snippet: snippet
            }).eq('id', outbound.lead_id);
        } catch (e) { console.error('[capture-replies] lead update threw', outbound.lead_id, e && e.message); }

        // Address-level exit. One person can own several lead rows (a franchise
        // group, one owner with three LLCs). When they reply once, every lead
        // on that address has to stop, or the drip keeps mailing the same human
        // from a different row. Only reply_received_at is copied across: the
        // snippet and the lead_messages attribution belong to the row that
        // actually received the reply, not to its siblings.
        let siblingIds = [];
        try {
            const pattern = likeEscape(fromAddr);
            const both = await Promise.all([
                sb.from('lead_messages').select('lead_id').ilike('to_address', pattern).limit(500),
                sb.from('leads').select('id').ilike('owner_email', pattern).is('reply_received_at', null).limit(500),
            ]);
            const ids = new Set();
            for (const r of ((both[0] && both[0].data) || [])) { if (r.lead_id) ids.add(r.lead_id); }
            for (const r of ((both[1] && both[1].data) || [])) { if (r.id) ids.add(r.id); }
            ids.delete(outbound.lead_id);
            siblingIds = Array.from(ids);
            if (siblingIds.length) {
                const { error: sibErr } = await sb.from('leads')
                    .update({ reply_received_at: receivedAt })
                    .in('id', siblingIds)
                    .is('reply_received_at', null);
                if (sibErr) console.error('[capture-replies] sibling stamp failed', fromAddr, sibErr.message);
            }
        } catch (e) { console.error('[capture-replies] sibling stamp threw', fromAddr, e && e.message); }

        matched.push({
            from: fromAddr, lead_id: outbound.lead_id, message_row: outbound.id,
            when: receivedAt,
            sibling_leads_exited: siblingIds.length,
        });
    }

    return res.status(200).json({
        ok: true,
        window_days: days,
        scanned_inbox: scanned,
        matched_count: matched.length,
        unmatched_count: unmatched.length,
        matched: matched,
        unmatched: unmatched,
        dry_run: dryRun
    });
};
