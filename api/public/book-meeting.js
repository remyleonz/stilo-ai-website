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
// Strict charset on purpose (audit 2026-08-10): the old /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// accepted , ( ) * and %, which are PostgREST .or()/ilike metacharacters, and a
// crafted "email" could inject filter clauses or wildcards into the lead-match
// query below. Reject anything outside a plain mailbox shape.
function isEmail(s) {
    return typeof s === 'string'
        && s.length <= 320
        && /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

// ── Rate limiting (audit 2026-08-10) ────────────────────────────────────────
// Public endpoint that creates real calendar events + emails, so cap abuse:
// max 5 bookings per IP per hour (in-memory, per warm lambda) and max 20/day
// globally (in-memory counter + a DB count of leads.meeting_booked_at today as
// the cross-instance backstop). On breach: 429.
const RL_PER_IP_PER_HOUR = 5;
const RL_GLOBAL_PER_DAY = 20;
const _rl = { ipHits: new Map(), day: null, dayCount: 0 };
function _ipOf(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
        || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimited(req) {
    const now = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    if (_rl.day !== day) { _rl.day = day; _rl.dayCount = 0; }
    if (_rl.dayCount >= RL_GLOBAL_PER_DAY) return 'global_daily_limit';
    const ip = _ipOf(req);
    const hits = (_rl.ipHits.get(ip) || []).filter(function (t) { return now - t < 60 * 60 * 1000; });
    if (hits.length >= RL_PER_IP_PER_HOUR) { _rl.ipHits.set(ip, hits); return 'ip_hourly_limit'; }
    hits.push(now);
    _rl.ipHits.set(ip, hits);
    _rl.dayCount++;
    // Keep the map from growing without bound on a long-lived instance.
    if (_rl.ipHits.size > 5000) _rl.ipHits.clear();
    return null;
}
async function globalDailyBackstop(sb) {
    if (!sb) return null;
    try {
        const since = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
        // Scoped to self-bookings only: an SDR-heavy booking day must never lock
        // the public picker (they write their own value into meeting_booked_by_sdr).
        const { count } = await sb.from('leads')
            .select('id', { count: 'exact', head: true })
            .eq('meeting_booked_by_sdr', 'vsl_landing')
            .gte('meeting_booked_at', since);
        if (count != null && count >= RL_GLOBAL_PER_DAY) return 'global_daily_limit_db';
    } catch (_) { /* backstop only; never block a real booking on a count error */ }
    return null;
}
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
    const niche = (body.niche || '').trim() || null;
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

    const rlHit = rateLimited(req);
    if (rlHit) {
        console.warn('[public/book-meeting] rate limited:', rlHit, _ipOf(req));
        return res.status(429).json({ error: 'rate_limited', detail: 'Too many bookings. Try again later or email us.' });
    }

    const refreshToken = await getCalendarRefreshToken();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !refreshToken) return res.status(503).json({ error: 'google_calendar_not_configured', detail: 'The booking calendar is not connected yet.' });

    const durationMin = 30;
    const endDate = new Date(startDate.getTime() + durationMin * 60000);

    const sb = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
        ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } })
        : null;

    // Cross-instance backstop for the global daily cap: the in-memory counter
    // above only sees one warm lambda, so also count today's bookings in the DB.
    const dbHit = await globalDailyBackstop(sb);
    if (dbHit) {
        console.warn('[public/book-meeting] rate limited:', dbHit, _ipOf(req));
        return res.status(429).json({ error: 'rate_limited', detail: 'Too many bookings. Try again later or email us.' });
    }

    // --- Resolve the lead (token attribution first, then match, then create) ---
    let leadId = null, attributed = false, lead = null;
    if (sb) {
        try {
            if (lid != null && verifyLead(lid, token)) {
                const { data } = await sb.from('leads').select('id,name,owner_name,owner_email,call_attempts,niche,pitch_agent').eq('id', lid).maybeSingle();
                if (data) { lead = data; leadId = data.id; attributed = true; }
            }
            if (leadId == null) {
                // Two separate .ilike calls instead of a raw .or() string (audit
                // 2026-08-10). PostgREST's .or() takes a filter EXPRESSION, so any
                // metacharacter that survives isEmail would become query syntax.
                // .ilike passes the value as a bound filter argument, so there is
                // nothing to escape and nothing to inject.
                const cols = 'id,name,owner_name,owner_email,call_attempts,niche,pitch_agent';
                const byOwner = await sb.from('leads').select(cols).ilike('owner_email', email).limit(1);
                let hit = byOwner.data && byOwner.data[0];
                if (!hit) {
                    const byEmail = await sb.from('leads').select(cols).ilike('email', email).limit(1);
                    hit = byEmail.data && byEmail.data[0];
                }
                if (hit) { lead = hit; leadId = hit.id; }
            }
            if (leadId == null) {
                const seed = {
                    name: businessName || name || 'Website booking',
                    owner_name: name || null,
                    owner_email: email,
                    stage: 'NEW'
                };
                if (niche) { seed.niche = niche; seed.category = niche; }
                const { data: created, error: cErr } = await sb.from('leads').insert(seed).select('id').single();
                if (!cErr && created) { leadId = created.id; lead = { id: leadId, call_attempts: 0 }; }
                else if (cErr) console.warn('[public/book-meeting] lead insert failed:', cErr.message);
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
                pitch_agent: (lead && lead.pitch_agent) || 'Booked Meetings',
                meeting_booked_at: new Date().toISOString(),
                stage: 'MEETING_BOOKED',
                last_called_outcome: 'booked_meeting',
                last_called_at: new Date().toISOString(),
                call_attempts: (Number(lead && lead.call_attempts) || 0) + 1,
                owner_email: (lead && lead.owner_email) || email,
                owner_name: (lead && lead.owner_name) || name || null,
                niche: (lead && lead.niche) || niche || null,
                call_notes: 'Self-booked from VSL landing page for ' + startDate.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' + (attributed ? ' (attributed via emailed link)' : ' (matched/created by email)')
            }).eq('id', leadId);
            persisted = !upd.error;
            if (upd.error) console.warn('[public/book-meeting] persist failed:', upd.error.message);
        } catch (e) { console.warn('[public/book-meeting] persist threw:', e && e.message); }
    }

    // --- Prospect confirmation + internal heads-up (best-effort) ---
    const whenStr = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(startDate);
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    // Prospect confirmation goes through sendTransactional (Gmail first), NOT
    // straight to Resend. A self-booker's confirmation must not ride the same
    // sending reputation as the cold campaign. See _gmail_send.js. The internal
    // heads-up below stays on Resend: it goes to us, so placement is irrelevant
    // and the HTML summary is easier to scan.
    try {
        const { sendTransactional } = require('../prospects/_gmail_send');
        await sendTransactional({
            to: email,
            subject: 'Confirmed: your STILO call, ' + whenStr,
            replyTo: fromEmail,
            text: [
                'Hi ' + firstName(name) + ',',
                '',
                'You are booked for ' + whenStr + '.',
                meetLink ? '' : null,
                meetLink ? 'Google Meet: ' + meetLink : null,
                '',
                'If anything comes up, just reply and we will move it.',
                '',
                'Talk soon,',
                senderName,
                'STILO AI Partners'
            ].filter(function (l) { return l !== null; }).join('\n')
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
