/**
 * GET /api/prospects/sync-bookings
 *
 * Pulls recent bookings off the STILO booking calendar
 * (remyleon@stiloaipartners.com) and lands them on the dashboard automatically,
 * so Remy doesn't have to watch Google Calendar each morning.
 *
 * When a client clicks "Book a 15-minute call" in a rep's email and books via
 * the appointment-schedule link, Google creates an event on the calendar with
 * the booker as an ATTENDEE. We match that attendee email to a lead, flip the
 * lead to booked_meeting (so it shows in the Booked tab), and attribute it to
 * the rep who emailed that lead (lead_messages.sent_by), falling back to the
 * lead's assigned_to.
 *
 * Idempotent: a lead already stamped with this event's id is skipped, so
 * re-running (every cron tick) never double-books and never clobbers
 * SDR-booked meetings created by /book-meeting.
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. An admin JWT
 * also works for manual triggering.
 */
const { assertAdmin, methodNotAllowed } = require('./_shared');
const { getCalendarRefreshToken, accessTokenFromRefresh } = require('./_google_calendar');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

// Which rep gets credit: the one who emailed this lead most recently, else the
// lead's owner.
async function resolveSdr(sb, leadId, assignedTo) {
    try {
        const { data } = await sb.from('lead_messages')
            .select('sent_by').eq('lead_id', leadId).eq('channel', 'email')
            .not('sent_by', 'is', null).order('sent_at', { ascending: false }).limit(1);
        if (data && data[0] && data[0].sent_by) return data[0].sent_by;
    } catch (_) { /* fall back */ }
    return assignedTo || null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

    // Auth: cron secret (Vercel injects it) OR an admin JWT for manual runs.
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) {
        const gate = await assertAdmin(req, res);
        if (!gate.ok) return; // assertAdmin already wrote 401/403
    }

    const refreshToken = await getCalendarRefreshToken();
    if (!refreshToken) return res.status(503).json({ error: 'google_calendar_not_configured' });

    let accessToken;
    try { accessToken = await accessTokenFromRefresh(refreshToken); }
    catch (e) { return res.status(502).json({ error: 'calendar_auth_failed', detail: String(e.message || e) }); }

    // Look at events starting from 2 days ago (catch same-day) that were
    // created/updated in the last ~3h (a comfortable margin over the cron tick).
    const timeMin = new Date(Date.now() - 2 * 864e5).toISOString();
    const updatedMin = new Date(Date.now() - 3 * 36e5).toISOString();
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
        + '?singleEvents=true&maxResults=250'
        + '&timeMin=' + encodeURIComponent(timeMin)
        + '&updatedMin=' + encodeURIComponent(updatedMin);

    let events;
    try {
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
        if (!r.ok) return res.status(502).json({ error: 'calendar_list_failed', detail: (await r.text()).slice(0, 300) });
        events = (await r.json()).items || [];
    } catch (e) {
        return res.status(502).json({ error: 'calendar_unreachable', detail: String(e.message || e) });
    }

    const sb = leadsClient();
    const booked = [];
    const unmatched = [];

    for (const e of events) {
        const start = (e.start && (e.start.dateTime || e.start.date)) || null;
        if (!start || e.status === 'cancelled') continue;
        // External attendees = the booker(s). Drop our own org + Remy's gmail.
        const guests = (e.attendees || [])
            .map(function (a) { return (a.email || '').toLowerCase().trim(); })
            .filter(function (em) { return em && !/@stiloaipartners\.com$/.test(em) && em !== 'remyleon11@gmail.com'; });
        if (!guests.length) continue;

        const meetLink = e.hangoutLink
            || ((e.conferenceData && e.conferenceData.entryPoints || []).find(function (p) { return p.entryPointType === 'video'; }) || {}).uri
            || null;

        for (const email of guests) {
            let lead;
            try {
                const { data } = await sb.from('leads')
                    .select('id, name, assigned_to, meeting_event_id, last_called_outcome, call_attempts')
                    .or('owner_email.ilike.' + email + ',email.ilike.' + email)
                    .limit(1);
                lead = data && data[0];
            } catch (_) { lead = null; }
            if (!lead) { unmatched.push(email); continue; }
            if (lead.meeting_event_id === e.id) continue; // already processed (incl. SDR-booked)

            const sdr = await resolveSdr(sb, lead.id, lead.assigned_to);
            try {
                await sb.from('leads').update({
                    last_called_outcome: 'booked_meeting',
                    last_called_at: new Date().toISOString(),
                    meeting_event_id: e.id,
                    meeting_event_link: e.htmlLink || null,
                    meeting_meet_link: meetLink,
                    meeting_scheduled_at: start,
                    meeting_duration_min: 15,
                    meeting_booked_by_sdr: sdr,
                    updated_at: new Date().toISOString()
                }).eq('id', lead.id);
                booked.push({ lead_id: lead.id, business: lead.name, email: email, sdr: sdr, when: start });
            } catch (err) {
                console.error('[sync-bookings] update failed', lead.id, err && err.message);
            }
        }
    }

    return res.status(200).json({
        ok: true,
        scanned_events: events.length,
        booked_count: booked.length,
        booked: booked,
        unmatched_emails: Array.from(new Set(unmatched))
    });
};
