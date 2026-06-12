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
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { getCalendarRefreshToken, accessTokenFromRefresh } = require('./_google_calendar');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}
function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
const THROTTLE_MS = 90 * 1000; // don't re-hit the calendar more than once per 90s

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

// Email Remy the moment a meeting lands on the calendar, so he never has to
// find out by opening Google Calendar. Sent via Resend to the master inbox.
async function notifyNewBooking(b) {
    if (!process.env.RESEND_API_KEY) return;
    const to = process.env.STILO_REPLY_TO || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const from = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const whenStr = b.when
        ? new Date(b.when).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'
        : 'time TBD';
    const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    const leadUrl = 'https://stiloaipartners.com/admin/#lead=' + b.lead_id;
    const html = [
        '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111;font-size:15px;line-height:1.55;">',
        '<p style="font-size:18px;font-weight:700;margin:0 0 12px;">New meeting booked</p>',
        '<p style="margin:0 0 6px;"><strong>' + esc(b.business || 'Lead') + '</strong>' + (b.owner ? ' (' + esc(b.owner) + ')' : '') + '</p>',
        '<p style="margin:0 0 6px;">When: <strong>' + esc(whenStr) + '</strong></p>',
        '<p style="margin:0 0 6px;">Booked by: ' + esc(b.booker_name || b.booker_email || 'prospect') + '</p>',
        b.meet ? '<p style="margin:14px 0;"><a href="' + esc(b.meet) + '" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;">Join Google Meet</a></p>' : '',
        '<p style="margin:12px 0 0;"><a href="' + esc(leadUrl) + '" style="color:#2563EB;">Open the lead in the dashboard</a></p>',
        '</div>'
    ].join('');
    await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: '"STILO Bookings" <' + from + '>',
            to: [to],
            subject: 'New meeting booked: ' + (b.business || 'lead') + ' · ' + whenStr,
            html: html
        })
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

    // Auth: cron secret (Vercel injects it) OR any logged-in rep/admin — reps
    // trigger this when they open their Booked tab.
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    let gate = { ok: true, isAdmin: true, email: null };
    if (!cronOk) {
        gate = await assertAdminOrSdr(req, res);
        if (!gate.ok) return; // already wrote 401/403
    }

    // Throttle: this runs on every Booked-tab open, so don't actually re-scan
    // the calendar more than once per 90s across all reps. ?force=1 bypasses.
    const kv = publicClient();
    const force = !!(req.query && req.query.force === '1');
    if (!cronOk && !force) {
        try {
            const { data } = await kv.from('app_kv').select('updated_at').eq('key', 'last_booking_sync').maybeSingle();
            if (data && (Date.now() - new Date(data.updated_at).getTime()) < THROTTLE_MS) {
                return res.status(200).json({ ok: true, throttled: true, booked_count: 0 });
            }
        } catch (_) { /* if kv is unavailable, just run */ }
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
        // Keep the display name so we can fall back to name matching when the
        // email they booked with isn't the one we have on the lead.
        const guests = (e.attendees || [])
            .map(function (a) { return { email: (a.email || '').toLowerCase().trim(), name: (a.displayName || '').trim() }; })
            .filter(function (g) { return g.email && !/@stiloaipartners\.com$/.test(g.email) && g.email !== 'remyleon11@gmail.com'; });
        if (!guests.length) continue;

        const meetLink = e.hangoutLink
            || ((e.conferenceData && e.conferenceData.entryPoints || []).find(function (p) { return p.entryPointType === 'video'; }) || {}).uri
            || null;

        const SEL = 'id, name, owner_name, assigned_to, meeting_event_id, last_called_outcome, call_attempts';
        for (const guest of guests) {
            const email = guest.email;
            let lead;
            try {
                const { data } = await sb.from('leads').select(SEL)
                    .or('owner_email.ilike.' + email + ',email.ilike.' + email)
                    .limit(1);
                lead = data && data[0];
            } catch (_) { lead = null; }
            // Fallback: the prospect booked with a different email than we have.
            // Match the booker's name to a lead's owner_name, but ONLY when it's
            // unambiguous (exactly one match) so we never attach to the wrong lead.
            if (!lead && guest.name && guest.name.length > 2) {
                try {
                    const { data } = await sb.from('leads').select(SEL)
                        .ilike('owner_name', '%' + guest.name + '%').limit(2);
                    if (data && data.length === 1) lead = data[0];
                } catch (_) { /* keep unmatched */ }
            }
            if (!lead) { unmatched.push(guest.name ? (guest.email + ' (' + guest.name + ')') : guest.email); continue; }
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
                // Tell Remy a meeting just landed, so he never has to discover it
                // by opening Google Calendar. Best-effort; never block the sync.
                try {
                    await notifyNewBooking({ business: lead.name, owner: lead.owner_name, booker_email: email, booker_name: guest.name, when: start, meet: meetLink, lead_id: lead.id });
                } catch (_) { /* notification is best-effort */ }
            } catch (err) {
                console.error('[sync-bookings] update failed', lead.id, err && err.message);
            }
        }
    }

    // Stamp the throttle clock so the next Booked-tab open within 90s is a no-op.
    try { await kv.from('app_kv').upsert({ key: 'last_booking_sync', value: { by: cronOk ? 'cron' : (gate.email || 'admin') }, updated_at: new Date().toISOString() }); } catch (_) {}

    // Reps get only the count (enough to know whether to refresh their list).
    // Admin/cron get the full detail incl. other reps' leads.
    const privileged = cronOk || gate.isAdmin;
    return res.status(200).json({
        ok: true,
        scanned_events: events.length,
        booked_count: booked.length,
        booked: privileged ? booked : undefined,
        unmatched_emails: privileged ? Array.from(new Set(unmatched)) : undefined
    });
};
