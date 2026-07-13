/**
 * POST /api/public/book-meeting
 *
 * Public booking endpoint for the VSL landing pages' slot picker. Books a Google
 * Calendar event (Remy's booking calendar, David + prospect invited, Meet link),
 * then writes the meeting straight onto a prospecting.leads row so it AUTO-APPEARS
 * in the admin dashboard — no manual matching.
 *
 * Attribution:
 *   - If the emailed link carried ?lid=<id>&t=<token> and the token verifies, we
 *     book onto that EXACT lead (perfect attribution for emailed prospects).
 *   - Otherwise we match an existing lead by email, or create a new one
 *     (source = 'vsl_landing') for cold/organic visitors.
 *
 * Body: { start_iso, email, name, business_name?, notes?, lid?, t?, agent? }
 * Uses the shared _google_calendar helper (DB-first refresh token).
 */
const { createClient } = require('@supabase/supabase-js');
const { getCalendarRefreshToken, accessTokenFromRefresh, isReauthError, REAUTH_URL } = require('../prospects/_google_calendar');
const { verifyLead } = require('./_token');

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
function isEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }

async function sendResend(payload) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const j = await r.json().catch(function () { return {}; });
        return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
    } catch (e) { return { error: String(e.message || e) }; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const body = await readJsonBody(req);
    const startIso = body.start_iso;
    const email = (body.email || '').trim();
    const name = (body.name || '').trim();
    const businessName = (body.business_name || '').trim();
    const notes = (body.notes || '').slice(0, 1000);
    const lid = body.lid != null && /^\d+$/.test(String(body.lid)) ? parseInt(String(body.lid), 10) : null;
    const token = body.t || null;

    if (!startIso || !email || !name) return res.status(400).json({ error: 'missing_required_fields' });
    if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    const startDate = new Date(startIso);
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'invalid_start_iso' });
    if (startDate.getTime() < Date.now() + 60 * 60 * 1000) return res.status(400).json({ error: 'slot_too_soon' });

    const refreshToken = await getCalendarRefreshToken();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !refreshToken) return res.status(503).json({ error: 'google_calendar_not_configured', detail: 'The booking calendar is not connected yet.' });

    const durationMin = 30;
    const endDate = new Date(startDate.getTime() + durationMin * 60000);

    const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } })
        : null;

    // --- Resolve the lead (token attribution first, then match, then create) ---
    let leadId = null, attributed = false, lead = null;
    if (sb) {
        try {
            if (lid != null && verifyLead(lid, token)) {
                const { data } = await sb.from('leads').select('id,name,owner_name,owner_email,call_attempts').eq('id', lid).maybeSingle();
                if (data) { lead = data; leadId = data.id; attributed = true; }
            }
            if (leadId == null) {
                const { data: match } = await sb.from('leads').select('id,name,owner_name,owner_email,call_attempts').or('owner_email.ilike.' + email + ',email.ilike.' + email).limit(1);
                if (match && match[0]) { lead = match[0]; leadId = match[0].id; }
            }
            if (leadId == null) {
                const { data: created, error: cErr } = await sb.from('leads').insert({
                    name: businessName || name || 'Website booking',
                    owner_name: name || null,
                    owner_email: email,
                    source: 'vsl_landing',
                    stage: 'NEW'
                }).select('id').single();
                if (!cErr && created) { leadId = created.id; lead = { id: leadId, call_attempts: 0 }; }
            }
        } catch (e) { console.warn('[public/book-meeting] lead resolve failed:', e && e.message); }
    }

    // --- Access token ---
    let accessToken;
    try { accessToken = await accessTokenFromRefresh(refreshToken); }
    catch (e) {
        if (isReauthError(e)) return res.status(409).json({ error: 'calendar_reauth_required', reauth_url: REAUTH_URL });
        return res.status(502).json({ error: 'oauth_failed', detail: String(e.message || e) });
    }

    // --- Create the calendar event (David rides every meeting) ---
    const summary = 'STILO AI Partners discovery · ' + (businessName || name);
    const description = [
        'Contact: ' + name + ' <' + email + '>',
        businessName ? 'Business: ' + businessName : '',
        'Source: VSL landing page' + (attributed ? ' (attributed lead #' + leadId + ')' : ''),
        body.agent ? 'Interested in: ' + String(body.agent) : '',
        notes ? '\nNotes from prospect:\n' + notes : ''
    ].filter(Boolean).join('\n');
    let ev;
    try {
        const createResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                summary: summary,
                description: description,
                start: { dateTime: startDate.toISOString(), timeZone: 'America/New_York' },
                end: { dateTime: endDate.toISOString(), timeZone: 'America/New_York' },
                attendees: [
                    { email: 'davidcoira@stiloaipartners.com', displayName: 'David Coira (STILO)', responseStatus: 'accepted' },
                    { email: email, displayName: name }
                ],
                conferenceData: { createRequest: { requestId: 'stilo-vsl-' + (leadId || 'x') + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
                reminders: { useDefault: true }
            })
        });
        if (!createResp.ok) {
            const t = await createResp.text();
            console.error('[public/book-meeting] create failed:', createResp.status, t.slice(0, 300));
            return res.status(502).json({ error: 'event_create_failed', detail: t.slice(0, 300) });
        }
        ev = await createResp.json();
    } catch (e) { return res.status(500).json({ error: 'unexpected', detail: String(e.message || e) }); }

    const meetLink = (ev.conferenceData && ev.conferenceData.entryPoints && (ev.conferenceData.entryPoints.find(function (p) { return p.entryPointType === 'video'; }) || {}).uri) || ev.hangoutLink || null;

    // --- Persist onto the lead so it shows in the admin dashboard ---
    let persisted = false;
    if (sb && leadId != null) {
        try {
            const upd = await sb.from('leads').update({
                meeting_event_id: ev.id || null,
                meeting_event_link: ev.htmlLink || null,
                meeting_meet_link: meetLink || null,
                meeting_scheduled_at: startDate.toISOString(),
                meeting_duration_min: durationMin,
                meeting_booked_by_sdr: 'vsl_landing',
                meeting_booked_at: new Date().toISOString(),
                stage: 'MEETING_BOOKED',
                last_called_outcome: 'booked_meeting',
                last_called_at: new Date().toISOString(),
                call_attempts: (Number(lead && lead.call_attempts) || 0) + 1,
                owner_email: (lead && lead.owner_email) || email,
                owner_name: (lead && lead.owner_name) || name || null,
                call_notes: 'Self-booked from VSL landing page for ' + startDate.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' + (attributed ? ' (attributed via emailed link)' : ' (matched/created by email)')
            }).eq('id', leadId);
            persisted = !upd.error;
            if (upd.error) console.warn('[public/book-meeting] persist failed:', upd.error.message);
        } catch (e) { console.warn('[public/book-meeting] persist threw:', e && e.message); }
    }

    // --- Prospect confirmation + internal heads-up (best-effort) ---
    const whenStr = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(startDate);
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remy@stiloaipartners.com';
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    try {
        await sendResend({
            from: senderName + ' <' + fromEmail + '>', to: [email], reply_to: fromEmail,
            subject: 'Confirmed: your STILO call, ' + whenStr,
            html: '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
                + '<p>Hi ' + esc(firstName(name)) + ',</p><p>You are booked for <strong>' + esc(whenStr) + '</strong>.</p>'
                + (meetLink ? '<p>Google Meet: <a href="' + esc(meetLink) + '" style="color:#2563EB">' + esc(meetLink) + '</a></p>' : '')
                + '<p>If anything comes up, just reply and we will move it.</p><p>Talk soon,<br/>' + esc(senderName) + '<br/>STILO AI Partners</p></div>'
        });
    } catch (_) { /* never block booking on email */ }
    try {
        const notify = process.env.STILO_NOTIFY_EMAIL || 'remyleon@stiloaipartners.com';
        await sendResend({
            from: 'STILO AI Partners <' + fromEmail + '>', to: [notify],
            subject: 'New VSL booking: ' + (businessName || name) + ' (' + whenStr + ')',
            html: '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
                + '<p><strong>New self-booking from a VSL page.</strong></p><ul style="padding-left:18px">'
                + '<li>Business: <strong>' + esc(businessName || name) + '</strong></li><li>When: <strong>' + esc(whenStr) + '</strong></li>'
                + '<li>Contact: ' + esc(name) + ' &middot; ' + esc(email) + '</li>'
                + '<li>Lead: ' + (leadId != null ? '#' + leadId + (attributed ? ' (attributed)' : ' (matched/created)') : 'not linked') + '</li>'
                + (body.agent ? '<li>Interested in: ' + esc(String(body.agent)) + '</li>' : '')
                + (meetLink ? '<li>Meet: <a href="' + esc(meetLink) + '">' + esc(meetLink) + '</a></li>' : '') + '</ul></div>'
        });
    } catch (_) { /* best-effort */ }

    return res.status(200).json({ ok: true, event_id: ev.id, meet_link: meetLink, start: ev.start && ev.start.dateTime, lead_id: leadId, attributed: attributed, persisted: persisted });
};
