/**
 * GET /api/prospects/email-sequence?dry=1&cap=N
 *
 * Drip engine for the 4-step cold email sequence to prospecting leads with a
 * scraped-and-found owner email. Modeled on the guards in vsl-campaign.js,
 * which earned them the hard way; read that file's header before touching any
 * of these.
 *
 * AUDIENCE (every condition required):
 *   - owner_email present AND email_search_status = 'found' (the new scrape)
 *   - active: archived_batch IS NULL
 *   - no prior bounce on the lead or the address (lead_messages.bounced_at)
 *   - not suppressed (public.lcr_suppressions)
 *   - not a role inbox (info@/sales@/office@/... are excluded outright; they
 *     bounced at 22.3% on the VSL run and produced nothing)
 *   - niche resolves to one of the 5 slugs via _vsl.js nicheForLead. No slug,
 *     no email; we never guess an industry.
 *
 * PERMANENT EXITS. A reply (leads.reply_received_at, or an inbound/replied row
 * in lead_messages) or a booked meeting (leads.meeting_booked_at) removes the
 * lead from the sequence forever. A human took over; the robot stands down.
 *
 * STEP TRACKING. The existing leads.email_N_sent_at / email_N_status columns.
 * Steps 2-4 are offset from the STEP 1 send (see STEP_OFFSET_DAYS). Following
 * the retry-loop lesson (twice burned): the sent_at stamp is written BEFORE
 * the send is attempted, so a failed send can never loop. status then records
 * 'sent' or 'failed' for the post-mortem.
 *
 * SENDING. Plain text only, no tracking pixel, Resend, on the SAME cold-sender
 * identity as vsl-campaign (VSL_SENDER_EMAIL) so cold reputation stays off the
 * transactional address. One-click List-Unsubscribe. Every send is logged to
 * prospecting.lead_messages with variant 'seq_<slug>_s<step>'.
 *
 * SAFETY.
 *   - EMAIL_SEQUENCE_ENABLED must be exactly 'true' or nothing sends, same
 *     default-closed contract as OUTBOUND_SEND_ENABLED in _outbound.js.
 *   - ?dry=1 returns the full plan (who, step, subject) and sends nothing.
 *   - Daily cap via ?cap= (default 40, hard ceiling 150) counted off today's
 *     seq_% rows in lead_messages, plus a per-run cap so one cron tick can
 *     never blast the whole day's budget.
 *   - Weekday 12:00-15:00 ET send window. The hourly cron is a no-op outside
 *     it (dry runs still report the full plan so the board is inspectable).
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin/SDR JWT for manual runs.
 */
const crypto = require('crypto');
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { nicheForLead } = require('./_vsl');
const { COPY, NICHE_SLOTS } = require('./_email_sequence_copy');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Days after the STEP 1 send at which each later step becomes due.
const STEP_OFFSET_DAYS = { 2: 4, 3: 8, 4: 15 };
const DEFAULT_DAILY_CAP = 40;
const HARD_DAILY_CEILING = 150;  // a bug in ?cap= must never become a blast
const MAX_PER_RUN = 20;          // one cron tick can't spend the whole day
const WINDOW = { tz: 'America/New_York', startMin: 12 * 60, endMin: 15 * 60 };

const SEQUENCE_ENABLED = String(process.env.EMAIL_SEQUENCE_ENABLED || '').toLowerCase() === 'true';

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');

// Same cold-sender identity as vsl-campaign: outreach rides its own address so
// a bad campaign cannot take the booking confirmations down with it.
const SENDER_EMAIL = process.env.VSL_SENDER_EMAIL || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
const SENDER_NAME = process.env.VSL_SENDER_NAME || 'Remy Leon';
const REPLY_TO = process.env.VSL_REPLY_TO || process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

// Superset of the required info@/sales@/office@/contact@/admin@/support@/hello@
// exclusions, borrowed verbatim from vsl-campaign.js.
const ROLE_RE = /^(info|sales|contact|admin|office|hello|support|team|mail|billing|help|service|reception|frontdesk|no-?reply)@/i;

// Same "is this actually a person's name" bar as vsl-campaign.js. owner_name is
// scraped and ~30% junk; a wrong name is worse than no name.
const NOT_A_NAME = new RegExp('^(' + [
    'program', 'programs', 'executive', 'executives', 'team', 'teams', 'alert', 'alerts',
    'system', 'systems', 'group', 'inc', 'llc', 'corp', 'company', 'co',
    'complete', 'construction', 'service', 'services', 'auto', 'realty', 'realtors',
    'office', 'sales', 'info', 'contact', 'admin', 'support', 'billing',
    'manager', 'owner', 'president', 'ceo', 'director', 'department', 'dept',
    'main', 'front', 'desk', 'customer', 'client', 'new', 'the', 'best', 'top',
    'north', 'south', 'east', 'west', 'beach', 'harbour', 'harbor', 'park',
    'miami', 'florida', 'doral', 'hialeah', 'brickell', 'kendall', 'aventura',
].join('|') + ')$', 'i');

function firstName(ownerName, business, address) {
    const raw = String(ownerName || '').trim();
    if (!raw) return null;
    const first = raw.split(/\s+/)[0];
    if (!first || first.length < 2 || first.length > 20) return null;
    if (!/^[A-Za-z][A-Za-z'’.-]+$/.test(first)) return null;
    if (NOT_A_NAME.test(first)) return null;
    const f = first.toLowerCase();
    if (String(business || '').toLowerCase().includes(f)) return null;
    if (String(address || '').toLowerCase().includes(f)) return null;
    return first;
}

function cleanBusiness(name) {
    let s = String(name || '').trim();
    s = s.replace(/\s+[-–|]\s+.*$/, '');
    s = s.replace(/,\s*(FL|Florida)\b.*$/i, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || null;
}

// "15979 Biscayne Blvd #4605, North Miami Beach, FL 33160" -> "North Miami Beach"
function cityFromAddress(address) {
    const parts = String(address || '').split(',').map(function (p) { return p.trim(); });
    if (parts.length < 2) return null;
    const c = parts[parts.length - 2];
    if (!c || /\d/.test(c) || c.length < 3 || c.length > 30) return null;
    return c;
}

function b64url(s) {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = b64url(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }));
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------
/**
 * Fill {{slots}} into a template. Refuses (ok:false) when any slot is left
 * unresolved, because "Hi {{first_name}}," in a real inbox is how a prospect
 * learns they are a row in a spreadsheet.
 *
 * The greeting works with no name: when values.first_name is empty, the
 * renderer collapses "Hi {{first_name}}," to "Hi," and strips the name (plus
 * its trailing comma-space) from subjects before the unresolved-slot check.
 */
function mergeAndValidate(template, values) {
    let out = String(template || '');
    if (!values.first_name) {
        out = out.replace(/Hi \{\{first_name\}\}/g, 'Hi')
                 .replace(/\{\{first_name\}\},\s*/g, '')
                 .replace(/,\s*\{\{first_name\}\}/g, '')
                 .replace(/\{\{first_name\}\}/g, '');
        out = out.trim();
        // A subject that STARTED with the name can be left capitalized oddly
        // ("quick question...") — acceptable for a subject, broken for nothing.
        if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
    }
    for (const k of Object.keys(values)) {
        if (values[k] == null || values[k] === '') continue;
        out = out.split('{{' + k + '}}').join(String(values[k]));
    }
    const leftover = out.match(/\{\{\s*[\w.-]+\s*\}\}/);
    if (leftover) return { ok: false, why: 'unresolved_slot:' + leftover[0] };
    return { ok: true, text: out };
}

function buildEmail(lead, slug, step) {
    const copy = COPY[slug] && COPY[slug]['step' + step];
    if (!copy) return { ok: false, why: 'no_copy' };
    const values = Object.assign({
        first_name: firstName(lead.owner_name, lead.name, lead.address) || '',
        company: cleanBusiness(lead.name) || 'your company',
        city: cityFromAddress(lead.address) || 'your area',
    }, NICHE_SLOTS[slug] || {});
    const subject = mergeAndValidate(copy.subject, values);
    if (!subject.ok) return subject;
    const body = mergeAndValidate(copy.body, values);
    if (!body.ok) return body;
    return { ok: true, subject: subject.text, body: body.text };
}

// ---------------------------------------------------------------------------
// Send window: weekdays 12:00-15:00 ET. Computed in ET, never server-local,
// because Vercel runs UTC (see _outbound.js windowState for the precedent).
// ---------------------------------------------------------------------------
function windowState(now) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: WINDOW.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const part of fmt.formatToParts(now || new Date())) p[part.type] = part.value;
    const minutes = Number(p.hour) * 60 + Number(p.minute);
    const weekday = ['Sat', 'Sun'].indexOf(p.weekday) === -1;
    return {
        open: weekday && minutes >= WINDOW.startMin && minutes < WINDOW.endMin,
        weekday: p.weekday, local: p.hour + ':' + p.minute + ' ET',
    };
}

// email_N_sent_at is timestamp WITHOUT time zone holding naive-UTC ISO strings
// (same convention as last_called_at). Parse as UTC explicitly.
function parseNaiveUtc(v) {
    if (!v) return null;
    const s = String(v);
    return new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
}

/**
 * Which step (if any) this lead is due for right now. Offsets anchor on the
 * step 1 send so the cadence a strategist wrote is the cadence that happens,
 * even if a middle send slipped a day.
 */
function dueStep(lead, now) {
    if (!lead.email_1_sent_at) return 1;
    if (lead.email_4_sent_at) return null; // sequence complete
    const anchor = parseNaiveUtc(lead.email_1_sent_at);
    if (!anchor) return null;
    const days = (now - anchor) / 86400000;
    for (const step of [2, 3, 4]) {
        if (lead['email_' + step + '_sent_at']) continue;
        return days >= STEP_OFFSET_DAYS[step] ? step : null;
    }
    return null;
}

async function sendEmail(to, subject, text) {
    const t = unsubToken(to);
    const headers = t ? {
        'List-Unsubscribe': '<' + BASE + '/api/unsubscribe?t=' + t + '>, <mailto:' + REPLY_TO + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: SENDER_NAME + ' <' + SENDER_EMAIL + '>',
            to: [to],
            reply_to: REPLY_TO,
            subject: subject,
            text: text, // plain text only: no html part, no pixel
            headers: headers,
        }),
    });
    const j = await r.json().catch(function () { return {}; });
    return { ok: r.ok, status: r.status, id: j.id, err: r.ok ? null : (j.message || 'send_failed') };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'resend_not_configured' });

    const dry = String((req.query && req.query.dry) || '') === '1';
    const cap = Math.min(
        Number((req.query && req.query.cap) || process.env.EMAIL_SEQUENCE_DAILY_CAP || DEFAULT_DAILY_CAP),
        HARD_DAILY_CEILING
    );

    const now = new Date();
    const win = windowState(now);
    // Outside the window the cron tick is a no-op. Dry runs still compute the
    // plan so the board can be inspected at any hour.
    if (!win.open && !dry) {
        return res.status(200).json({ ok: true, sent: 0, note: 'send_window_closed', window: win });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // ---- audience ----------------------------------------------------------
    const { data: leads, error } = await sb.from('leads')
        .select('id,name,owner_name,owner_email,address,niche,category,assigned_to,'
            + 'email_1_sent_at,email_2_sent_at,email_3_sent_at,email_4_sent_at')
        .eq('email_search_status', 'found')
        .not('owner_email', 'is', null)
        .is('archived_batch', null)
        .is('meeting_booked_at', null)   // permanent exit: booked
        .is('reply_received_at', null)   // permanent exit: replied
        .is('email_4_sent_at', null)     // sequence already finished
        .limit(5000);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    // Permanent exit: any inbound or replied message on the lead. A human is
    // talking to them now; the drip must never interrupt that conversation.
    const { data: replies } = await sb.from('lead_messages')
        .select('lead_id')
        .or('direction.eq.inbound,replied_at.not.is.null')
        .limit(10000);
    const repliedLeads = new Set((replies || []).map(function (r) { return r.lead_id; }));

    // Never re-mail a bounce, on this lead or this address.
    const { data: bounces } = await sb.from('lead_messages')
        .select('lead_id,to_address').not('bounced_at', 'is', null).limit(10000);
    const bouncedLeads = new Set((bounces || []).map(function (r) { return r.lead_id; }));
    const bouncedAddrs = new Set((bounces || []).map(function (r) { return String(r.to_address || '').toLowerCase(); }));

    const { data: sup } = await pub.from('lcr_suppressions').select('email').limit(10000);
    const suppressed = new Set((sup || []).map(function (r) { return String(r.email || '').toLowerCase(); }));

    // Daily cap: counted off today's seq_% sends in lead_messages, not a
    // counter column, so it survives re-runs and manual edits.
    const midnightEtIso = (function () {
        const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: WINDOW.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        // ET is -04:00 (EDT) or -05:00 (EST); pick whichever round-trips to 00:00.
        const hm = new Intl.DateTimeFormat('en-US', { timeZone: WINDOW.tz, hour: '2-digit', minute: '2-digit', hour12: false });
        for (const off of ['-04:00', '-05:00']) {
            const d = new Date(ymd + 'T00:00:00' + off);
            const h = hm.format(d);
            if (h === '00:00' || h === '24:00') return d.toISOString();
        }
        return new Date(ymd + 'T00:00:00-05:00').toISOString();
    })();
    const { count: sentToday } = await sb.from('lead_messages')
        .select('id', { count: 'exact', head: true })
        .like('variant', 'seq_%')
        .gte('sent_at', midnightEtIso);
    const dailyRemaining = Math.max(0, cap - (sentToday || 0));
    const budget = Math.min(dailyRemaining, MAX_PER_RUN);

    const skipped = { role_inbox: 0, replied: 0, bounced: 0, suppressed: 0, no_niche: 0, not_due: 0, dupe_inbox: 0, bad_merge: 0 };
    const seen = new Set();
    const plan = [];
    for (const l of (leads || [])) {
        if (repliedLeads.has(l.id)) { skipped.replied++; continue; }
        if (bouncedLeads.has(l.id)) { skipped.bounced++; continue; }
        const em = String(l.owner_email || '').trim();
        if (!em || em.indexOf('@') === -1) continue;
        const low = em.toLowerCase();
        if (ROLE_RE.test(em)) { skipped.role_inbox++; continue; }
        if (bouncedAddrs.has(low)) { skipped.bounced++; continue; }
        if (suppressed.has(low)) { skipped.suppressed++; continue; }
        const slug = nicheForLead(l);
        if (!slug) { skipped.no_niche++; continue; }
        const step = dueStep(l, now);
        if (!step) { skipped.not_due++; continue; }
        if (seen.has(low)) { skipped.dupe_inbox++; continue; } // same inbox twice in one run looks like spam
        seen.add(low);
        plan.push({ lead: l, email: em, slug: slug, step: step });
    }
    // Later steps first: finishing a sequence someone is mid-way through beats
    // opening a new one. Then oldest lead id for a stable, resumable order.
    plan.sort(function (a, b) { return (b.step - a.step) || (a.lead.id - b.lead.id); });
    const batch = plan.slice(0, budget);

    const perNiche = {};
    const perStep = {};
    for (const p of plan) {
        perNiche[p.slug] = (perNiche[p.slug] || 0) + 1;
        perStep['step' + p.step] = (perStep['step' + p.step] || 0) + 1;
    }

    if (dry || !SEQUENCE_ENABLED) {
        return res.status(200).json({
            ok: true,
            dry: dry,
            send_enabled_env: SEQUENCE_ENABLED,
            note: !SEQUENCE_ENABLED ? 'EMAIL_SEQUENCE_ENABLED lock is closed; nothing sends' : undefined,
            window: win,
            cap: cap, sent_today: sentToday || 0, per_run_cap: MAX_PER_RUN, budget_this_run: budget,
            due_now: plan.length,
            due_by_niche: perNiche,
            due_by_step: perStep,
            skipped: skipped,
            would_send: batch.map(function (p) {
                const e = buildEmail(p.lead, p.slug, p.step);
                return {
                    id: p.lead.id, to: p.email, niche: p.slug, step: p.step,
                    subject: e.ok ? e.subject : null,
                    merge_error: e.ok ? undefined : e.why,
                };
            }),
        });
    }

    const results = [];
    for (const p of batch) {
        const l = p.lead;
        const e = buildEmail(l, p.slug, p.step);
        if (!e.ok) { skipped.bad_merge++; results.push({ id: l.id, step: p.step, ok: false, err: e.why }); continue; }

        // Stamp the attempt BEFORE evaluating the result (the retry-loop rule,
        // learned twice). A lead whose send explodes mid-flight is marked and
        // never re-attempted by the next tick; status records what happened.
        const stampCol = 'email_' + p.step + '_sent_at';
        const statusCol = 'email_' + p.step + '_status';
        const attempt = {};
        attempt[stampCol] = now.toISOString();
        attempt[statusCol] = 'sending';
        const { error: stampErr } = await sb.from('leads').update(attempt).eq('id', l.id).is(stampCol, null);
        if (stampErr) { results.push({ id: l.id, step: p.step, ok: false, err: 'stamp_failed:' + stampErr.message }); continue; }

        const r = await sendEmail(p.email, e.subject, e.body);

        const outcome = {};
        outcome[statusCol] = r.ok ? 'sent' : 'failed';
        await sb.from('leads').update(outcome).eq('id', l.id);

        if (r.ok) {
            await sb.from('lead_messages').insert({
                lead_id: l.id, direction: 'outbound', channel: 'email',
                subject: e.subject, body: e.body, body_preview: e.body.slice(0, 180),
                to_address: p.email, from_address: SENDER_EMAIL,
                provider: 'resend', provider_message_id: r.id || null,
                status: 'sent',
                sent_by: l.assigned_to || null,
                variant: 'seq_' + p.slug + '_s' + p.step,
                sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: l.id, to: p.email, niche: p.slug, step: p.step, ok: r.ok, err: r.err });
    }

    const sent = results.filter(function (r) { return r.ok; }).length;
    return res.status(200).json({
        ok: true, window: win, cap: cap, budget_this_run: budget,
        sent: sent, failed: results.length - sent,
        due_by_niche: perNiche, due_by_step: perStep, skipped: skipped,
        remaining_due: plan.length - batch.length,
        results: results,
    });
};
