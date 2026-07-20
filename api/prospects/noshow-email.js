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

// The one booking link the whole team sends (mirrors _email_kit CALENDAR_LINK).
const CALENDAR_LINK = 'https://calendar.app.google/qW5iT5kYeK5EipA9A';

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

function buildHtml(opts) {
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const whenStr = opts.whenIso
        ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(new Date(opts.whenIso))
        : null;
    return [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;font-size:15px;line-height:1.55;">',
        '<p>Hi ' + escapeHtml(opts.firstName || 'there') + ',</p>',
        '<p>We had a call on the calendar' + (whenStr ? ' for <strong>' + escapeHtml(whenStr) + '</strong>' : '') + ' but I don\'t think we connected. No problem at all, things come up.</p>',
        '<p>Did something get in the way, or is the timing just off right now? If you\'re still up for it, you can grab a new time that works better here:</p>',
        '<p style="margin:18px 0;"><a href="' + escapeHtml(CALENDAR_LINK) + '" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;">Pick a new time</a></p>',
        '<p>It\'s a quick 15 minutes to walk through where the AI agents fit ' + escapeHtml(opts.businessName || 'your business') + '. If now isn\'t the moment, just reply and let me know, no pressure either way.</p>',
        '<p>Talk soon,<br/>' + escapeHtml(senderName) + '</p>',
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" />',
        '<table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#374151;">',
        '<tr><td><strong style="color:#111;">' + escapeHtml(senderName) + '</strong><br/>STILO AI Partners<br/><a href="https://stiloaipartners.com" style="color:#2563EB;text-decoration:none;">stiloaipartners.com</a> · +1 786 876 8677</td></tr>',
        '</table>',
        '</div>'
    ].join('');
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
        .select('id,name,owner_name,owner_email,email,bounced_at,meeting_scheduled_at')
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
    const subject = 'Did we miss each other?';
    const html = buildHtml({ firstName: firstName, businessName: lead.name, whenIso: lead.meeting_scheduled_at });

    let sendJson = {};
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: fromName + ' <' + fromEmail + '>', to: [to], reply_to: replyTo, subject: subject, html: html })
        });
        sendJson = await r.json().catch(function () { return {}; });
        if (!r.ok) return res.status(502).json({ error: 'send_failed', detail: sendJson.message || ('resend ' + r.status) });
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
