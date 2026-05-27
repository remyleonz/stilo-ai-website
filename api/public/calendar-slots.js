/**
 * GET /api/public/calendar-slots?days=7
 *
 * Public (no auth) version of /api/prospects/calendar-availability. Used by
 * the marketing site's "Book a 15-min call" picker so prospects can see open
 * times on Remy's Google Calendar without needing to sign in first.
 *
 * Returns 15-min slots Mon-Fri 9am-6pm ET, filtered against Google Calendar
 * free/busy. Read-only — does not expose event titles or attendees.
 *
 * Requires env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *               GOOGLE_OAUTH_REFRESH_TOKEN.
 */

const SLOT_MIN = 15;
const BIZ_START_HOUR = 9;
const BIZ_END_HOUR = 18;
const TZ_OFFSET_HOURS = 4; // ET = UTC-4 (DST)

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!r.ok) throw new Error('oauth_refresh_failed: ' + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}

function generateBusinessSlots(days) {
  const slots = [];
  const now = new Date();
  for (let d = 0; d <= days; d++) {
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
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '7', 10), 1), 14);

  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return res.status(503).json({
      error: 'google_calendar_not_configured',
      configured: false,
      slots: []
    });
  }

  try {
    const accessToken = await getAccessToken();
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
        return sStart < bEnd && sEnd > bStart;
      });
    });

    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ slots: free, configured: true });
  } catch (e) {
    console.error('[public/calendar-slots]', e);
    return res.status(502).json({ error: 'calendar_query_failed', detail: String(e.message || e) });
  }
};
