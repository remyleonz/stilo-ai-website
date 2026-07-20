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
    const variant = (body.variant === 'A' || body.variant === 'B') ? body.variant : null;
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    if (!validEmail(to)) return res.status(400).json({ error: 'invalid_to_email' });
    if (message.length < 20) return res.status(400).json({ error: 'empty_body' });

    const sb = leadsClient();
    const { data: lead } = await sb.from('leads')
        .select('id,name,owner_email,email,bounced_at')
        .eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // ── Bounce guard (runs before Resend) ──────────────────────────────────
    // 1. Never re-send to an address that already hard-bounced.
    if (lead.bounced_at) {
        return res.status(409).json({ error: 'recipient_bounced', detail: to + ' previously bounced and will not be re-emailed.' });
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
    const html = kit.buildEmailHtml({ bodyText: message, sender: sender });
    // Plain-text alternative (multipart). Mirrors the HTML body, so the message
    // reads clean in text-only clients and looks less "marketing" to Gmail.
    const plainText = kit.ensureBookingLink(kit.sanitizeCopy(message)) + '\n\n' + kit.footerText(sender);

    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    // Quote the display name (RFC 5322) — it carries a middot, and the rep's
    // name could contain characters that would otherwise need escaping.
    const fromName = '"' + sender.name.replace(/"/g, '') + ' · STILO AI Partners"';

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
        if (!r.ok) return res.status(502).json({ error: 'send_failed', detail: j.message || ('http_' + r.status) });
        sendResult = { id: j.id };
    } catch (e) {
        return res.status(502).json({ error: 'send_failed', detail: String(e.message || e) });
    }

    // Record the touch. Best-effort: never fail the send if logging hiccups.
    // Also save the email onto the lead if we didn't have one.
    const plain = kit.sanitizeCopy(message) + '\n\n' + kit.footerText(sender);
    try {
        // supabase-js returns { error } rather than throwing, so CHECK it —
        // a swallowed error here is how email tracking silently broke before
        // (service_role lacked USAGE on lead_messages_id_seq). Now surfaced.
        const { error: logErr } = await sb.from('lead_messages').insert({
            lead_id: id,
            direction: 'outbound',
            channel: 'email',
            subject: subject,
            body: plain,
            body_preview: plain.slice(0, 280),
            sent_at: new Date().toISOString(),
            sent_by: gate.email || null,
            to_address: to,
            from_address: fromEmail,
            provider: 'resend',
            provider_message_id: sendResult.id || null,
            variant: variant,
            status: 'sent'
        });
        if (logErr) console.error('[send-email] lead_messages log failed:', logErr.message);
    } catch (e) { console.error('[send-email] lead_messages log threw:', e && e.message); }
    try {
        if (!lead.owner_email && !lead.email) {
            await sb.from('leads').update({ owner_email: to }).eq('id', id);
        }
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({ ok: true, id: sendResult.id, to: to });
};
