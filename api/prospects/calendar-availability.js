/**
 * GET /api/prospects/calendar-availability?days=7
 *
 * Returns 30-min slots over the next N business days (Mon–Fri 9am–6pm ET)
 * that are NOT busy on Remy's Google Calendar. Frontend renders these as
 * the slot picker grid in the prospecting drawer.
 *
 * Auth: admin JWT.
 * Requires env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *               GOOGLE_OAUTH_REFRESH_TOKEN.
 *
 * Returns 503 with a clear message if OAuth isn't configured yet — frontend
 * shows a "Configure Google Calendar" prompt instead of a broken picker.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { getCalendarRefreshToken, accessTokenFromRefresh } = require('./_google_calendar');

// Matches Remy's Google booking page ("STILO AI PARTNERS MEETING"):
// Mon–Fri, 10:00am–7:00pm ET, 15-minute appointments. Weekends are skipped
// in generateBusinessSlots (Sun/Sat unavailable on the booking page too).
const SLOT_MIN = 15;
const BIZ_START_HOUR = 10;  // 10am ET
const BIZ_END_HOUR = 19;    // 7pm ET
const TZ_OFFSET_HOURS = 4;  // ET = UTC-4 (DST); -5 in winter; close enough for slot generation

function generateBusinessSlots(days) {
    const slots = [];
    const now = new Date();
    for (let d = 0; d <= days; d++) {
        const day = new Date(now.getTime() + d * 86400000);
        const dow = day.getUTCDay();
        if (dow === 0 || dow === 6) continue; // skip weekends
        for (let h = BIZ_START_HOUR; h < BIZ_END_HOUR; h++) {
            for (let m = 0; m < 60; m += SLOT_MIN) {
                const s = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h + TZ_OFFSET_HOURS, m, 0));
                if (s.getTime() < now.getTime() + 60 * 60 * 1000) continue; // skip <1h-from-now slots
                const e = new Date(s.getTime() + SLOT_MIN * 60000);
                slots.push({ start: s.toISOString(), end: e.toISOString() });
            }
        }
    }
    return slots;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '7', 10), 1), 14);

    const refreshToken = await getCalendarRefreshToken();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !refreshToken) {
        return res.status(503).json({
            error: 'google_calendar_not_configured',
            detail: 'The STILO booking calendar is not connected. Open /api/oauth?provider=google-calendar&action=start signed in as remyleon@stiloaipartners.com to link it.',
            // Return the slot grid anyway so the frontend can render a "configure"
            // hint with realistic time labels.
            slots: generateBusinessSlots(days),
            configured: false
        });
    }

    try {
        const accessToken = await accessTokenFromRefresh(refreshToken);
        const candidateSlots = generateBusinessSlots(days);
        if (!candidateSlots.length) return res.status(200).json({ slots: [], configured: true });

        const fb = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                timeMin: candidateSlots[0].start,
                timeMax: candidateSlots[candidateSlots.length - 1].end,
                items: [{ id: 'primary' }]
            })
        });
        if (!fb.ok) throw new Error('freebusy_failed: ' + (await fb.text()).slice(0, 200));
        const fbData = await fb.json();
        const busy = (fbData.calendars && fbData.calendars.primary && fbData.calendars.primary.busy) || [];

        const free = candidateSlots.filter(function (s) {
            const sStart = new Date(s.start).getTime();
            const sEnd = new Date(s.end).getTime();
            return !busy.some(function (b) {
                const bStart = new Date(b.start).getTime();
                const bEnd = new Date(b.end).getTime();
                return sStart < bEnd && sEnd > bStart; // overlap
            });
        });

        return res.status(200).json({ slots: free, configured: true });
    } catch (e) {
        console.error('[calendar-availability]', e);
        return res.status(502).json({ error: 'calendar_query_failed', detail: String(e.message || e) });
    }
};
