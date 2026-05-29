/**
 * POST /api/public/book-meeting
 *
 * Public booking endpoint for the marketing site's "Book a 15-min call" CTA.
 * Creates a Google Calendar event on Remy's calendar with the prospect as a
 * guest, and emails a confirmation via Resend.
 *
 * Body: {
 *   start_iso:     "2026-05-28T19:30:00.000Z",   // ISO 8601, required
 *   email:         "jane@plumbingco.com",        // required
 *   name:          "Jane Doe",                   // required
 *   business_name: "Plumbing Co",                // optional
 *   notes:         "We get 30 missed calls a day...",  // optional
 * }
 *
 * Requires env: GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN, RESEND_API_KEY (optional)
 */

const { createClient } = require('@supabase/supabase-js');

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

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function isEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    return res.status(503).json({ error: 'google_calendar_not_configured' });
  }

  const body = await readJsonBody(req);
  const startIso = body.start_iso;
  const email = body.email;
  const name = (body.name || '').trim();
  const businessName = (body.business_name || '').trim();
  const notes = (body.notes || '').slice(0, 1000);

  if (!startIso || !email || !name) return res.status(400).json({ error: 'missing_required_fields' });
  if (!isEmail(email)) return res.status(400).json({ error: 'invalid_email' });

  const startDate = new Date(startIso);
  if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'invalid_start_iso' });
  if (startDate.getTime() < Date.now() + 60 * 60 * 1000) {
    return res.status(400).json({ error: 'slot_too_soon' });
  }
  const endDate = new Date(startDate.getTime() + 15 * 60 * 1000);

  let accessToken;
  try { accessToken = await getAccessToken(); }
  catch (e) { return res.status(502).json({ error: 'oauth_failed', detail: String(e.message || e) }); }

  const summary = 'STILO AI Partners x ' + (businessName || name);
  const description = [
    'Prospect:   ' + name + ' <' + email + '>',
    businessName ? 'Business:   ' + businessName : '',
    'Source:     stiloaipartners.com booking',
    notes ? '\nNotes from prospect:\n' + notes : ''
  ].filter(Boolean).join('\n');

  // Create the calendar event with the prospect as a guest
  try {
    const createResp = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: summary,
          description: description,
          start: { dateTime: startDate.toISOString() },
          end: { dateTime: endDate.toISOString() },
          attendees: [{ email: email, displayName: name, responseStatus: 'accepted' }],
          conferenceData: {
            createRequest: {
              requestId: 'stilo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          },
          reminders: { useDefault: true }
        })
      }
    );
    if (!createResp.ok) {
      const errText = await createResp.text();
      console.error('[public/book-meeting] create failed:', createResp.status, errText.slice(0, 300));
      return res.status(502).json({ error: 'event_create_failed', detail: errText.slice(0, 300) });
    }
    const ev = await createResp.json();

    // Booking tracking: find the most-recent quiz_complete row for this
    // email and stamp the booking details onto it. That way the admin sees
    // ONE row per lead with a "Booked" pill, instead of a fresh audit row
    // disconnected from the quiz answers. If no quiz_complete exists yet
    // (someone got the email and clicked the link from a different inbox),
    // we insert a new audit row as a fallback.
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        const bookingPatch = {
          meeting_booked_at: new Date().toISOString(),
          meeting_event_id: ev.id || null,
          meeting_start_iso: ev.start && ev.start.dateTime,
          meeting_meet_link: ev.hangoutLink || null
        };
        const { data: existing, error: lookupErr } = await sb
          .from('quiz_submissions')
          .select('id, created_at')
          .ilike('email', email)
          .eq('cta_type', 'quiz_complete')
          .order('created_at', { ascending: false })
          .limit(1);
        if (!lookupErr && existing && existing[0]) {
          await sb.from('quiz_submissions').update(bookingPatch).eq('id', existing[0].id);
        } else {
          await sb.from('quiz_submissions').insert(Object.assign({
            cta_type: 'audit',
            contact_name: name,
            email: email,
            business_name: businessName || null,
            page_url: 'booking-modal',
            quiz_answers: { source: 'book_meeting_modal', notes: notes || '' },
            tier: null,
            selected_agents: []
          }, bookingPatch));
        }
      } catch (e) { console.warn('[public/book-meeting] supabase log failed:', e && e.message); }
    }

    return res.status(200).json({
      ok: true,
      event_id: ev.id,
      meet_link: ev.hangoutLink || null,
      start: ev.start && ev.start.dateTime,
      end: ev.end && ev.end.dateTime
    });
  } catch (e) {
    console.error('[public/book-meeting]', e);
    return res.status(500).json({ error: 'unexpected', detail: String(e.message || e) });
  }
};
