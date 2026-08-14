/**
 * POST /api/prospects/noshow-email
 * Body: { id }
 *
 * Sends a warm "we missed each other" email to a prospect who no-showed a booked
 * meeting: asks what happened, offers to reschedule, and drops the one-click
 * Google booking link so they can pick a new time themselves. Sent through Resend
 * from the STILO domain sender (shows as Remy), reply-to Remy, and logged to
 * prospecting.lead_messages so the touch shows in the lead's timeline.
 *
 * Writing rules (CLAUDE.md / humanizer): no em dashes, no AI buzzwords, short and
 * human. Light-mode HTML only (Gmail dark mode inverts light emails cleanly).
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { LANG_COL, langForLead, t } = require('./_lang');

// The one booking link the whole team sends (mirrors _email_kit CALENDAR_LINK).
const CALENDAR_LINK = 'https://calendar.app.google/qW5iT5kYeK5EipA9A';

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

// Plain text, and sent through sendTransactional (Gmail first). This goes to
// someone who BOOKED and then missed, so it must not ride cold sending
// reputation, and it must not look like a marketing template. The previous HTML
// version also pitched "where the AI agents fit", which is the retired offer and
// breaks the rule that no client-facing asset says AI.
function buildText(opts) {
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const lang = opts.lang || 'en';
    return t(lang, 'noshowBody', {
        first: opts.firstName || (lang === 'es' ? 'qué tal' : 'there'),
        whenIso: opts.whenIso,
        link: CALENDAR_LINK,
        biz: opts.businessName || (lang === 'es' ? 'su negocio' : 'your business'),
        sender: senderName,
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'resend_not_configured' });

    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const { data: lead } = await sb.from('leads')
        .select('id,name,owner_name,owner_email,email,bounced_at,meeting_scheduled_at,' + LANG_COL)
        .eq('id', id).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    const to = (body.to && String(body.to).trim()) || lead.owner_email || lead.email || null;
    if (!validEmail(to)) return res.status(400).json({ error: 'no_valid_email', detail: 'This lead has no email on file. Add one to the lead first.' });
    if (lead.bounced_at) return res.status(409).json({ error: 'recipient_bounced', detail: to + ' previously bounced and will not be re-emailed.' });

    // Never email an opted-out address (honors the one-click unsubscribe list).
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data: supp } = await pub.from('lcr_suppressions').select('email').eq('email', String(to).toLowerCase()).maybeSingle();
        if (supp) return res.status(409).json({ error: 'recipient_unsubscribed', detail: to + ' opted out and will not be emailed.' });
    } catch (_) { /* fail open: a suppression-check blip never blocks a send */ }

    const firstName = (lead.owner_name || '').trim().split(/\s+/)[0] || null;
    const fromName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const replyTo = process.env.STILO_REPLY_TO || fromEmail;
    const lang = langForLead(lead);
    const subject = t(lang, 'noshowSubject', {});
    const text = buildText({
        firstName: firstName, businessName: lead.name,
        whenIso: lead.meeting_scheduled_at, lang: lang,
    });

    let sendJson = {};
    try {
        const { sendTransactional } = require('./_gmail_send');
        const r = await sendTransactional({ to: to, subject: subject, text: text, replyTo: replyTo });
        sendJson = { id: r.id, via: r.via };
        if (r.err) return res.status(502).json({ error: 'send_failed', detail: r.err });
    } catch (e) {
        return res.status(502).json({ error: 'send_failed', detail: String(e.message || e) });
    }

    // Log the touch so it shows in the lead's message timeline.
    try {
        await sb.from('lead_messages').insert({
            lead_id: id, direction: 'outbound', channel: 'email',
            subject: subject, body_preview: 'No-show follow-up with a reschedule link.',
            to_address: to, from_address: fromEmail, provider: 'resend',
            provider_message_id: sendJson.id || null, status: 'sent', sent_by: gate.email || null
        });
    } catch (_) { /* logging is best-effort */ }

    return res.status(200).json({ ok: true, id: id, to: to, provider_message_id: sendJson.id || null });
};
