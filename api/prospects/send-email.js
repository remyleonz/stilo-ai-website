/**
 * POST /api/prospects/send-email
 * Body: { id, to, subject, body }
 *
 * Sends the follow-up email the rep composed in the lead drawer. Wraps the
 * (possibly edited) body in the light-mode HTML shell, appends the sender's
 * footer + a calendar CTA, sends through Resend, and records the touch in
 * prospecting.lead_messages so it shows up as a logged email.
 *
 * From is the verified STILO domain sender (Resend can't send as a personal
 * Gmail), shown as "<Rep Name> · STILO AI Partners". Reply-to is set to the
 * rep so replies reach them directly.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const kit = require('./_email_kit');
const crypto = require('crypto');
const dns = require('dns').promises;

// ── Bounce guard ──────────────────────────────────────────────────────────
// ~15% of cold emails bounce because many prospect addresses are GUESSED from
// name+domain patterns. This guard blocks the clearly-undeliverable sends before
// we hit Resend, without touching the rep's normal flow. It is deliberately
// conservative: it only blocks addresses the data says are bad, and any MX/DNS
// problem FAILS OPEN (never blocks a legit send because the check itself failed).

// Known throwaway/disposable inbox domains. Sending to these wastes reputation
// and never converts. Small, high-signal list; extend as new ones show up.
const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com',
    'trashmail.com', 'yopmail.com', '10minutemail.com', 'temp-mail.org', 'tempmail.com',
    'getnada.com', 'maildrop.cc', 'dispostable.com', 'throwawaymail.com', 'fakeinbox.com',
    'mailnesia.com', 'mohmal.com', 'emailondeck.com', 'spam4.me', 'discard.email'
]);

// Stored verdicts that mean the email-finder explicitly gave up: there is no
// verified address, so anything present is a raw guess. In the current data all
// three of these move together (the 55 "bad" leads carry all three) but we check
// each independently so a future backfill of any one column still gates. We do
// We do NOT verify addresses with a paid external service (no per-email cost).
// Low/none-confidence guesses still send; the rep confirms the real email with
// the client on the call. Only guaranteed-dead addresses are blocked below:
// already-bounced, or a domain that literally cannot receive mail (no MX /
// disposable). Those are free DNS checks, not a verification service.

function domainOf(email) {
    const at = String(email || '').lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

// Inline MX check on the recipient domain. Blocks disposable domains and domains
// that publish NO MX records (they cannot receive mail). FAILS OPEN on any
// timeout, network error, or non-definitive DNS failure. Returns { block, reason }.
async function mxGate(email, timeoutMs) {
    const domain = domainOf(email);
    if (!domain) return { block: false, reason: 'no_domain' };            // regex already validated shape; fail open
    if (DISPOSABLE_DOMAINS.has(domain)) return { block: true, reason: 'disposable_domain' };
    let timer;
    try {
        const lookup = dns.resolveMx(domain);
        const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('mx_timeout')), timeoutMs || 4000); });
        const records = await Promise.race([lookup, guard]);
        clearTimeout(timer);
        if (!Array.isArray(records) || records.length === 0) return { block: true, reason: 'no_mx' };
        return { block: false, reason: 'has_mx' };
    } catch (e) {
        clearTimeout(timer);
        // ENOTFOUND / ENODATA definitively mean "domain publishes no MX" → block.
        // Every OTHER error (timeout, SERVFAIL, transient network) fails OPEN.
        const code = e && e.code;
        if (code === 'ENOTFOUND' || code === 'ENODATA') return { block: true, reason: 'no_mx' };
        return { block: false, reason: 'mx_lookup_error:' + (code || (e && e.message) || 'unknown') };
    }
}

// One-click List-Unsubscribe. Gmail/Yahoo require this header on bulk mail or
// they route it to spam. Mints the same signed token /api/unsubscribe verifies:
// base64url(JSON{c,e,ts}) + '.' + base64url(HMAC-SHA256(payload, secret)).
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = b64url(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }));
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'resend_not_configured' });

    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    const to = (body.to || '').trim();
    const subject = (body.subject || '').trim() || 'Following up from STILO AI Partners';
    const message = (body.body || '').trim();
    // A/B arm the rep actually sent (set by draft-email). Only A or B are valid.
    // Whitelist both test families: STILO's A/B and the client-campaign arms.
    // This list is what lands in lead_messages.variant, which is the ONLY thing
    // ab-results.js aggregates — an unlisted key silently logs null and the send
    // vanishes from the test (the first Blason send did exactly that).
    const VARIANTS = ['A', 'B'].concat(kit.CLIENT_VARIANT_KEYS || []);
    const variant = VARIANTS.indexOf(body.variant) !== -1 ? body.variant : null;
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    if (!validEmail(to)) return res.status(400).json({ error: 'invalid_to_email' });
    if (message.length < 20) return res.status(400).json({ error: 'empty_body' });

    const sb = leadsClient();
    const { data: lead } = await sb.from('leads')
        .select('id,name,owner_email,email,bounced_at')
        .eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // ── Bounce guard (runs before Resend) ──────────────────────────────────
    // Scoped to the ADDRESS, not the lead.
    //
    // This used to be `if (lead.bounced_at) return 409`, a flag the Resend
    // webhook sets on the whole lead. One bad guessed address therefore
    // poisoned every other address at that company, permanently. Lead 27523
    // (Rello Search) is the case that exposed it: bhartman@rellosearch.com was
    // a guess and hard-bounced on 2026-08-13, which then blocked
    // bobhartmann@rellosearch.com, a different address the rep had just
    // confirmed with the client by phone. Guessing an address wrong is the
    // normal case in prospecting; it must not burn the company.
    //
    // lead_messages already records the bounce per recipient (to_address +
    // bounced_at), which is what emailable.js reads, so the correct check was
    // already sitting in the data.
    let bouncedHere = false;
    try {
        const { data: b } = await sb.from('lead_messages')
            .select('id').eq('lead_id', id).eq('channel', 'email')
            .ilike('to_address', to).not('bounced_at', 'is', null).limit(1);
        bouncedHere = !!(b && b.length);
    } catch (_) {
        // Fail CLOSED to the old behaviour if we cannot read the per-address
        // history: an unreadable bounce table is not evidence the address is
        // good, and re-mailing a hard bounce is a reputation hit.
        bouncedHere = !!lead.bounced_at;
    }

    // The override Remy asked for: a rep who has confirmed the address on the
    // phone can send to it anyway. Deliberately NOT available for unsubscribes
    // or spam complaints further down; those are consent, and consent has no
    // "but I called them" exception. A hard bounce is only ever a delivery
    // fact, so a human with better information is allowed to overrule it.
    const overrideBounce = body.override_bounce === true;
    const overrideReason = String(body.override_reason || '').trim();
    if (bouncedHere && !overrideBounce) {
        return res.status(409).json({
            error: 'recipient_bounced',
            detail: to + ' hard-bounced on a previous send.',
            can_override: true,
            address: to,
        });
    }
    if (bouncedHere && overrideBounce) {
        if (overrideReason.length < 4) {
            return res.status(400).json({ error: 'override_reason_required', detail: 'Say how you confirmed this address.' });
        }
        console.warn('[send-email] BOUNCE OVERRIDE by ' + gate.email + ' lead=' + id
            + ' to=' + to + ' reason=' + overrideReason.slice(0, 200));
        try {
            const stamp = '\n[' + new Date().toISOString().slice(0, 10) + '] Bounce override: '
                + gate.email + ' emailed ' + to + ' after it hard-bounced. Reason: ' + overrideReason.slice(0, 200);
            const { data: cur } = await sb.from('leads').select('rep_notes').eq('id', id).maybeSingle();
            await sb.from('leads').update({ rep_notes: (cur && cur.rep_notes ? cur.rep_notes : '') + stamp }).eq('id', id);
        } catch (_) { /* audit note is best effort, never blocks the send */ }
    }
    // 2. Inline MX / disposable check on the recipient domain. Blocks only a
    //    domain that literally cannot receive mail (no MX) or a disposable inbox.
    //    Fails OPEN on any lookup error or timeout so a DNS blip never blocks.
    try {
        const mx = await mxGate(to, 4000);
        if (mx.block) {
            return res.status(409).json({ error: 'recipient_undeliverable', detail: mx.reason === 'disposable_domain'
                ? 'Recipient domain is a disposable/throwaway inbox.'
                : 'Recipient domain has no mail server (no MX record).' });
        }
    } catch (_) { /* fail open: never block a send because the guard itself threw */ }

    // Honor unsubscribes: the one-click header writes to public.lcr_suppressions.
    // Never email an opted-out address (CAN-SPAM + deliverability). Fail open if
    // the check itself errors so a transient DB blip doesn't block every send.
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', to).limit(1);
        if (sup && sup.length) return res.status(409).json({ error: 'recipient_unsubscribed', detail: to + ' opted out and will not be emailed.' });
    } catch (_) { /* fail open */ }

    const sender = await kit.getSenderIdentity(gate.email);

    // ── CLIENT CAMPAIGN (content firewall) ──────────────────────────────
    // A client-pool lead gets client branding end to end: display name says
    // the CLIENT, footer says the rep is writing for the client, no STILO
    // calendar CTA, no STILO signature. Sent from the dedicated client
    // subdomain when BLASON_SENDER_EMAIL is configured, so client-campaign
    // volume never rides the same sending domain as STILO's own outreach.
    let clientName = null, clientEs = false, clientSite = '';
    try {
        const { data: lr } = await sb.from('leads').select('client_id, primary_language').eq('id', id).maybeSingle();
        if (lr && lr.client_id) {
            clientEs = lr.primary_language === 'es';
            const pub2 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
            const { data: c } = await pub2.from('clients').select('business_name, website').eq('id', lr.client_id).maybeSingle();
            clientName = (c && c.business_name) || 'Blason Spa Equipment';
            // clients.website drives the footer link, so a new client campaign
            // needs no code change: set the column and the footer follows.
            clientSite = (c && c.website) || '';
        }
    } catch (_) { /* on error treat as STILO — the draft copy still carries the client branding */ }

    const html = clientName
        ? kit.buildClientEmailHtml({ bodyText: message, sender: sender, clientName: clientName, es: clientEs, website: clientSite })
        : kit.buildEmailHtml({ bodyText: message, sender: sender });
    // Plain-text alternative (multipart). Mirrors the HTML body, so the message
    // reads clean in text-only clients and looks less "marketing" to Gmail.
    const plainText = clientName
        ? kit.sanitizeCopy(message) + '\n\n' + kit.clientFooterText(sender, clientName, clientEs, clientSite)
        : kit.ensureBookingLink(kit.sanitizeCopy(message)) + '\n\n' + kit.footerText(sender);

    // Per-rep envelope address (alejandrobarrios@, jorgeayes@, ...). The rep who
    // dialed the prospect is the rep the prospect hears from. Falls back to the
    // master address for anyone not in sdr_users. See senderAddress() in
    // _email_kit.js for the Workspace-alias requirement.
    // Client campaigns send from the dedicated client subdomain when configured
    // (deliverability isolation from STILO's own outreach domain).
    const fromEmail = clientName
        ? (process.env.BLASON_SENDER_EMAIL || sender.fromEmail || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com')
        : (sender.fromEmail || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com');
    // Quote the display name (RFC 5322) — it carries a middot, and the rep's
    // name could contain characters that would otherwise need escaping.
    const fromName = '"' + sender.name.replace(/"/g, '') + ' · ' + (clientName || 'STILO AI Partners') + '"';

    // ── Idempotency claim, BEFORE Resend ───────────────────────────────────
    // This route had no duplicate guard at all and sends before it logs, so a
    // second request for the same email sent a second email: a double-click, a
    // client retry, a proxy replaying a slow POST. Five prospects got the same
    // message twice between Aug 1 and Aug 28, three of them on one day.
    //
    // A read-then-check cannot close this. Two requests two seconds apart both
    // read an empty history before either writes. So we CLAIM the send with a
    // uniquely-indexed key first; the loser of the race fails the insert and
    // returns instead of sending. The key carries a 5-minute bucket, so a
    // genuine follow-up with the same subject later is unaffected.
    const dedupeKey = require('crypto').createHash('sha1')
        .update([id, 'email', to, subject, Math.floor(Date.now() / 300000)].join('|'))
        .digest('hex');
    const claim = await sb.from('lead_messages').insert({
        lead_id: id,
        direction: 'outbound',
        channel: 'email',
        subject: subject,
        sent_at: new Date().toISOString(),
        sent_by: gate.email || null,
        to_address: to,
        provider: 'resend',
        status: 'sending',
        variant: variant,
        dedupe_key: dedupeKey
    }).select('id').single();
    if (claim.error) {
        // 23505 = unique violation: an identical send is already in flight or
        // just completed. Report it as success-shaped so a retrying client
        // stops rather than escalating, but send nothing.
        if (String(claim.error.code) === '23505') {
            console.warn('[send-email] duplicate suppressed lead=' + id + ' subject=' + JSON.stringify(subject));
            return res.status(200).json({ ok: true, duplicate_suppressed: true,
                detail: 'An identical email to this lead was sent moments ago. Nothing was sent again.' });
        }
        return res.status(500).json({ error: 'claim_failed', detail: claim.error.message });
    }
    const claimId = claim.data.id;

    let sendResult;
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: fromName + ' <' + fromEmail + '>',
                to: [to],
                // MASTER INBOX: every client reply routes to the one STILO inbox
                // Remy checks (remyleon@stiloaipartners.com via STILO_REPLY_TO),
                // not the rep's personal email. So all replies land in one place.
                reply_to: process.env.STILO_REPLY_TO || fromEmail,
                subject: subject,
                // Open-tracking pixel (logs email_open into vsl_events for the Sales tab).
                html: html + '<img src="https://stiloaipartners.com/api/public/vsl-event?event=email_open&lid=' + id + '" width="1" height="1" style="display:none" alt=""/>',
                text: plainText,
                // Gmail/Yahoo deliverability: one-click unsubscribe.
                headers: (function () {
                    const t = unsubToken(to);
                    if (!t) return undefined;
                    return {
                        'List-Unsubscribe': '<https://stiloaipartners.com/api/unsubscribe?t=' + t + '>, <mailto:' + (process.env.STILO_REPLY_TO || fromEmail) + '?subject=unsubscribe>',
                        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                    };
                })()
            })
        });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) {
            // Nothing went out, so release the claim or the rep cannot retry
            // for five minutes.
            await sb.from('lead_messages').delete().eq('id', claimId);
            return res.status(502).json({ error: 'send_failed', detail: j.message || ('http_' + r.status) });
        }
        sendResult = { id: j.id };
    } catch (e) {
        await sb.from('lead_messages').delete().eq('id', claimId);
        return res.status(502).json({ error: 'send_failed', detail: String(e.message || e) });
    }

    // Record the touch. Best-effort: never fail the send if logging hiccups.
    // Also save the email onto the lead if we didn't have one.
    const plain = kit.sanitizeCopy(message) + '\n\n' + kit.footerText(sender);
    try {
        // supabase-js returns { error } rather than throwing, so CHECK it —
        // a swallowed error here is how email tracking silently broke before
        // (service_role lacked USAGE on lead_messages_id_seq). Now surfaced.
        // UPDATE the claim row rather than inserting a second one — the claim
        // above already created this message's row. Inserting here would leave
        // two rows per send and defeat the point.
        const { error: logErr } = await sb.from('lead_messages').update({
            body: plain,
            body_preview: plain.slice(0, 280),
            from_address: fromEmail,
            provider_message_id: sendResult.id || null,
            status: 'sent'
        }).eq('id', claimId);
        if (logErr) console.error('[send-email] lead_messages log failed:', logErr.message);
    } catch (e) { console.error('[send-email] lead_messages log threw:', e && e.message); }
    try {
        if (!lead.owner_email && !lead.email) {
            await sb.from('leads').update({ owner_email: to }).eq('id', id);
        }
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({ ok: true, id: sendResult.id, to: to });
};
