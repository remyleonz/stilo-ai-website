/**
 * GET /api/public/blason-slots?mode=call|showroom&days=7&from=0
 *
 * Open times for the Blason VSL page, Monday to Friday Eastern. 'call' = a phone
 * call with Manuel, 9:00 am to 6:00 pm on 15-minute marks (Remy, 2026-10-06: he
 * can answer the phone later than the showroom is open); 'showroom' = a visit,
 * 9:00 am to 4:00 pm on 30-minute marks. Same-day is allowed
 * with two hours' notice because Remy phones every booking to confirm anyway.
 *
 * Busy = Remy's primary Google Calendar (free/busy, no titles) plus every meeting
 * already stamped on prospecting.leads, so a slot the public STILO picker or an
 * SDR already took never shows here. If the calendar token is missing the
 * generated grid still comes back (configured:false): the booking is confirmed
 * by phone, so an unconnected calendar must not take the page down.
 *
 * Eastern offset is computed with Intl, not hardcoded. The old picker's fixed
 * UTC-4 would have drifted an hour the week DST ends.
 */
const { getCalendarRefreshToken, accessTokenFromRefresh, isReauthError } = require('../prospects/_google_calendar');
const { createClient } = require('@supabase/supabase-js');

const TZ = 'America/New_York';
const MODES = {
    call: { startHour: 9, endHour: 18, stepMin: 15, durationMin: 15, leadMs: 2 * 3600000 },
    showroom: { startHour: 9, endHour: 16, stepMin: 30, durationMin: 30, leadMs: 3 * 3600000 },
};

// UTC offset (minutes) in effect at `date` for America/New_York.
function etOffsetMin(date) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(date).reduce(function (o, p) { o[p.type] = p.value; return o; }, {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - date.getTime()) / 60000);
}
function etDayKey(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
// Build the instant for ET wall-clock y-m-d h:m. Two passes handle the offset
// changing across the DST boundary.
function etInstant(y, m, d, h, mi) {
    let guess = new Date(Date.UTC(y, m - 1, d, h, mi, 0));
    let off = etOffsetMin(guess);
    let inst = new Date(guess.getTime() - off * 60000);
    const off2 = etOffsetMin(inst);
    if (off2 !== off) inst = new Date(guess.getTime() - off2 * 60000);
    return inst;
}

function generateSlots(mode, days, fromOffset) {
    const cfg = MODES[mode];
    const now = new Date();
    const out = [];
    const start = Math.max(0, fromOffset || 0);
    for (let d = start; d <= start + days; d++) {
        const day = new Date(now.getTime() + d * 86400000);
        const key = etDayKey(day);                           // yyyy-mm-dd in ET
        const [y, m, dd] = key.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        for (let h = cfg.startHour; h < cfg.endHour; h++) {
            for (let mi = 0; mi < 60; mi += cfg.stepMin) {
                const s = etInstant(y, m, dd, h, mi);
                if (s.getTime() < now.getTime() + cfg.leadMs) continue;
                out.push({ start: s.toISOString(), end: new Date(s.getTime() + cfg.durationMin * 60000).toISOString() });
            }
        }
    }
    return out;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
    const q = req.query || {};
    const mode = MODES[q.mode] ? q.mode : 'call';
    const days = Math.min(Math.max(parseInt(q.days || '7', 10) || 7, 1), 14);
    // The page's day picker reaches 58 days out (blason-book refuses past 60).
    const from = Math.min(Math.max(parseInt(q.from || '0', 10) || 0, 0), 58);
    const candidates = generateSlots(mode, days, from);
    if (!candidates.length) return res.status(200).json({ configured: true, mode: mode, slots: [] });

    const refreshToken = await getCalendarRefreshToken();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !refreshToken) {
        return res.status(200).json({ configured: false, mode: mode, slots: candidates });
    }
    try {
        const accessToken = await accessTokenFromRefresh(refreshToken);
        const fb = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeMin: candidates[0].start, timeMax: candidates[candidates.length - 1].end, items: [{ id: 'primary' }] }),
        });
        if (!fb.ok) throw new Error('freebusy_failed: ' + (await fb.text()).slice(0, 200));
        const fbData = await fb.json();
        const busy = ((fbData.calendars && fbData.calendars.primary && fbData.calendars.primary.busy) || []).slice();

        try {
            const psb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
            const { data: dbMeetings } = await psb.from('leads')
                .select('meeting_scheduled_at, meeting_duration_min')
                .not('meeting_scheduled_at', 'is', null)
                .gte('meeting_scheduled_at', candidates[0].start)
                .lte('meeting_scheduled_at', candidates[candidates.length - 1].end);
            (dbMeetings || []).forEach(function (m) {
                const ms = new Date(m.meeting_scheduled_at).getTime();
                busy.push({ start: new Date(ms).toISOString(), end: new Date(ms + (Number(m.meeting_duration_min) || 15) * 60000).toISOString() });
            });
        } catch (_) { /* safety net only */ }

        const free = candidates.filter(function (s) {
            const sS = new Date(s.start).getTime(), sE = new Date(s.end).getTime();
            return !busy.some(function (b) {
                const bS = new Date(b.start).getTime(), bE = new Date(b.end).getTime();
                return sS < bE && sE > bS;
            });
        });
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(200).json({ configured: true, mode: mode, slots: free });
    } catch (e) {
        console.error('[public/blason-slots]', e && e.message);
        // Degrade to the raw grid: Remy confirms by phone either way.
        return res.status(200).json({ configured: false, mode: mode, slots: candidates, needs_reauth: isReauthError(e) || undefined });
    }
};

module.exports.MODES = MODES;
module.exports.etOffsetMin = etOffsetMin;
