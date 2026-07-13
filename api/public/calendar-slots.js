/**
 * GET /api/public/calendar-slots?days=7
 *
 * PUBLIC (no auth) version of prospects/calendar-availability. Powers the slot
 * picker on the VSL landing pages so prospects can book without signing in.
 * Read-only + no PII (no event titles/attendees), so safe to expose.
 *
 * Uses the shared _google_calendar helper (DB-first refresh token, same source
 * the SDR dashboard books with) so it stays "configured" even though the token
 * lives in public.oauth_tokens, not an env var. Returns { configured:false }
 * (200) when the calendar isn't connected so the picker falls back to the
 * Google scheduling link instead of showing a broken grid.
 */
const { getCalendarRefreshToken, accessTokenFromRefresh, isReauthError } = require('../prospects/_google_calendar');
const { createClient } = require('@supabase/supabase-js');

const SLOT_MIN = 30;
const BUFFER_MIN = 60;
const BIZ_START_HOUR = 10;   // 10am ET
const BIZ_END_HOUR = 19;     // 7pm ET
const TZ_OFFSET_HOURS = 4;   // ET = UTC-4 (DST)

function generateBusinessSlots(days, fromOffset) {
    const slots = [];
    const now = new Date();
    const start = Math.max(0, fromOffset || 0);
    for (let d = start; d <= start + days; d++) {
        const day = new Date(now.getTime() + d * 86400000);
        const dow = day.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        for (let h = BIZ_START_HOUR; h < BIZ_END_HOUR; h++) {
            for (let m = 0; m < 60; m += SLOT_MIN) {
                const s = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h + TZ_OFFSET_HOURS, m, 0));
                if (s.getTime() < now.getTime() + 60 * 60 * 1000) continue;
                const e = new Date(s.getTime() + SLOT_MIN * 60000);
                slots.push({ start: s.toISOString(), end: e.toISOString() });
            }
        }
    }
    return slots;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
    const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '7', 10), 1), 14);
    const from = Math.min(Math.max(parseInt((req.query && req.query.from) || '0', 10), 0), 56);

    const refreshToken = await getCalendarRefreshToken();
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !refreshToken) {
        return res.status(200).json({ configured: false, slots: generateBusinessSlots(days, from) });
    }

    try {
        const accessToken = await accessTokenFromRefresh(refreshToken);
        const candidateSlots = generateBusinessSlots(days, from);
        if (!candidateSlots.length) return res.status(200).json({ slots: [], configured: true });

        const fb = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeMin: candidateSlots[0].start, timeMax: candidateSlots[candidateSlots.length - 1].end, items: [{ id: 'primary' }] })
        });
        if (!fb.ok) throw new Error('freebusy_failed: ' + (await fb.text()).slice(0, 200));
        const fbData = await fb.json();
        const busy = ((fbData.calendars && fbData.calendars.primary && fbData.calendars.primary.busy) || []).slice();

        // Treat DB-booked meetings as busy too (some reschedules never hit Google).
        try {
            const psb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
            const { data: dbMeetings } = await psb.from('leads')
                .select('meeting_scheduled_at, meeting_duration_min')
                .not('meeting_scheduled_at', 'is', null)
                .gte('meeting_scheduled_at', candidateSlots[0].start)
                .lte('meeting_scheduled_at', candidateSlots[candidateSlots.length - 1].end);
            (dbMeetings || []).forEach(function (m) {
                const ms = new Date(m.meeting_scheduled_at).getTime();
                busy.push({ start: new Date(ms).toISOString(), end: new Date(ms + (Number(m.meeting_duration_min) || 15) * 60000).toISOString() });
            });
        } catch (_) { /* DB busy is a safety net */ }

        const BUFFER_MS = BUFFER_MIN * 60000;
        const free = candidateSlots.filter(function (s) {
            const sStart = new Date(s.start).getTime();
            const sEnd = new Date(s.end).getTime();
            return !busy.some(function (b) {
                const bStart = new Date(b.start).getTime();
                const bEnd = new Date(b.end).getTime();
                return (sStart < bEnd && sEnd > bStart) || Math.abs(sStart - bStart) < BUFFER_MS;
            });
        });

        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.status(200).json({ slots: free, configured: true });
    } catch (e) {
        console.error('[public/calendar-slots]', e);
        if (isReauthError(e)) return res.status(200).json({ configured: false, needs_reauth: true, slots: [] });
        return res.status(200).json({ configured: false, slots: [], detail: String(e.message || e) });
    }
};
