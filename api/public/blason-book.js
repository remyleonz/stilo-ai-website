/**
 * POST /api/public/blason-book
 *
 * The last step of the Blason VSL page: the visitor picks a time for a
 * 10-minute phone call with Manuel (mode 'call') or a visit to the Miami
 * showroom (mode 'showroom').
 *
 * This is NOT a STILO discovery booking. No Google Meet, no David on the invite,
 * no STILO-branded confirmation, no attendee invite from a stiloaipartners.com
 * calendar (that would put STILO's name in front of a Blason prospect). Instead:
 *
 *   1. A private event on Remy's calendar (no attendees) so the slot is held and
 *      every other picker sees it as busy. Best-effort: a dead calendar token
 *      must not stop the booking, Remy confirms by phone regardless.
 *   2. The lead row is stamped exactly like a rep-booked client meeting
 *      (api/prospects/book-meeting.js client branch), with
 *      meeting_booked_by_sdr = 'blason_vsl' so the dashboards can tell.
 *   3. The Blason-branded confirmation (email from reps@blason..., SMS from
 *      Remy's line) via _client_booking.sendClientBookingPackage. The brief to
 *      Manuel is HELD: Remy calls the prospect to confirm first (his rule), then
 *      forwards the one-line WhatsApp included in his alert.
 *   4. Remy's alert email, plus the submission row gets booked_at / meeting_at.
 *
 * Body: { site, mode, start_iso, session_id?, visitor_id?, lid?, t?,
 *         name?, business?, phone?, email?, lang?, notes? }
 * The page always sends lid + t from the funnel-lead response, so attribution is
 * exact; name/phone are the fallback if someone books with a stale token.
 */
const F = require('./_funnel');
const { getCalendarRefreshToken, accessTokenFromRefresh } = require('../prospects/_google_calendar');
const { MODES } = require('./blason-slots');

const RL_PER_IP_PER_HOUR = 5;
const RL_GLOBAL_PER_DAY = 40;
const _rl = { ipHits: new Map(), day: null, dayCount: 0 };
function rateLimited(req) {
    const now = Date.now(), day = new Date().toISOString().slice(0, 10);
    if (_rl.day !== day) { _rl.day = day; _rl.dayCount = 0; }
    if (_rl.dayCount >= RL_GLOBAL_PER_DAY) return 'global_daily_limit';
    const ip = F.ipOf(req) || 'unknown';
    const hits = (_rl.ipHits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
    if (hits.length >= RL_PER_IP_PER_HOUR) { _rl.ipHits.set(ip, hits); return 'ip_hourly_limit'; }
    hits.push(now); _rl.ipHits.set(ip, hits); _rl.dayCount++;
    if (_rl.ipHits.size > 5000) _rl.ipHits.clear();
    return null;
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const body = await F.readJsonBody(req);
    if (body && body.error === 'body_too_large') return res.status(413).json({ error: 'body_too_large' });
    const site = F.SITES[String(body.site || '')];
    if (!site) return res.status(400).json({ error: 'unknown_site' });
    if (!F.configured()) return res.status(503).json({ error: 'not_configured' });

    const mode = MODES[body.mode] ? body.mode : 'call';
    const cfg = MODES[mode];
    const start = new Date(String(body.start_iso || ''));
    if (isNaN(start.getTime())) return res.status(400).json({ error: 'invalid_start_iso' });
    if (start.getTime() < Date.now() + 30 * 60000) return res.status(400).json({ error: 'slot_too_soon' });
    if (start.getTime() > Date.now() + 60 * 86400000) return res.status(400).json({ error: 'slot_too_far' });
    const lang = /^es/i.test(String(body.lang || '')) ? 'es' : 'en';
    const notes = F.str(body.notes, 600);

    const rl = rateLimited(req);
    if (rl) { console.warn('[blason-book] rate limited:', rl); return res.status(429).json({ error: 'rate_limited' }); }

    const pros = F.sbProspecting();
    const pub = F.sbPublic();

    // --- the lead: token first, then phone/email fallback -------------------
    let found = null;
    try { found = await F.findLead(pros, site, body); } catch (e) { console.warn('[blason-book] findLead failed:', e && e.message); }
    if (!found) return res.status(400).json({ error: 'unknown_lead', detail: 'Fill in your details first.' });
    const lead = found.lead;
    if (lead.client_id !== site.client_id && found.how === 'token') {
        // A STILO lead's token pasted onto the Blason page. Refuse rather than
        // stamp a Blason meeting on the wrong pool.
        return res.status(400).json({ error: 'lead_not_in_pool' });
    }

    const startIso = start.toISOString();
    const endIso = new Date(start.getTime() + cfg.durationMin * 60000).toISOString();
    const whenEt = F.etStamp(startIso);
    const business = lead.name || F.str(body.business, 160) || 'Blason prospect';
    const ownerName = lead.owner_name || F.str(body.name, 120) || null;
    const ownerPhone = lead.owner_phone || lead.phone || null;
    const ownerEmail = lead.owner_email || lead.email || (F.isEmail(body.email) ? body.email : null);

    const { data: clientCo } = await pub.from('clients').select('id,business_name,contact_name,email,phone,address').eq('id', site.client_id).maybeSingle();

    // --- 1. hold the slot on Remy's calendar (private, no attendees) --------
    let ev = null;
    try {
        const refreshToken = await getCalendarRefreshToken();
        if (refreshToken && process.env.GOOGLE_OAUTH_CLIENT_ID) {
            const accessToken = await accessTokenFromRefresh(refreshToken);
            const summary = (mode === 'call' ? 'Blason · 10-min call with Manuel · ' : 'Blason · showroom visit · ') + business;
            const description = [
                'Self-booked from the Blason VSL page (lead #' + lead.id + ', ' + found.how + ').',
                'Contact: ' + (ownerName || 'n/a') + (ownerPhone ? ' · ' + ownerPhone : '') + (ownerEmail ? ' · ' + ownerEmail : ''),
                'Language: ' + lang,
                mode === 'call' ? 'Manuel calls them. CONFIRM WITH THE PROSPECT BY PHONE FIRST, then send Manuel the brief.' : 'Showroom visit. Confirm by phone first.',
                notes ? 'Notes: ' + notes : '',
            ].filter(Boolean).join('\n');
            const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    summary: summary, description: description,
                    start: { dateTime: startIso, timeZone: 'America/New_York' },
                    end: { dateTime: endIso, timeZone: 'America/New_York' },
                    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
                }),
            });
            if (r.ok) ev = await r.json(); else console.warn('[blason-book] calendar event failed:', r.status, (await r.text()).slice(0, 200));
        }
    } catch (e) { console.warn('[blason-book] calendar skipped:', e && e.message); }

    // --- 2. stamp the lead ---------------------------------------------------
    let persisted = false;
    try {
        const now = new Date().toISOString();
        const upd = {
            meeting_event_id: ev ? ev.id : null, meeting_event_link: ev ? ev.htmlLink : null, meeting_meet_link: null,
            meeting_scheduled_at: startIso, meeting_duration_min: cfg.durationMin,
            meeting_booked_by_sdr: 'blason_vsl', meeting_booked_at: now,
            stage: 'MEETING_BOOKED', last_called_outcome: 'booked_meeting', last_called_at: now,
            nurture_stage: 'booked', meeting_confirmation_sent_at: now, meeting_confirmed_at: null,
            meeting_reminder_sent_at: null, closer_reminder_sent_at: null, day_before_sms_sent_at: null,
            next_step: (mode === 'call' ? 'Confirm the 10-min call with Manuel by phone' : 'Confirm the showroom visit by phone') + ' · ' + whenEt + ' ET',
            next_step_due: now,
            call_notes: (mode === 'call' ? '10-min phone call with Manuel' : 'Showroom visit') + ' self-booked on the Blason VSL page for ' + whenEt + ' ET' + (notes ? '. Notes: ' + notes : ''),
            updated_at: now,
        };
        if (!lead.owner_email && ownerEmail) upd.owner_email = ownerEmail;
        const r = await pros.from('leads').update(upd).eq('id', lead.id);
        persisted = !r.error;
        if (r.error) console.warn('[blason-book] persist failed:', r.error.message);
    } catch (e) { console.warn('[blason-book] persist threw:', e && e.message); }

    // --- 3. Blason-branded confirmation to the prospect ----------------------
    let pkg = null;
    try {
        const { sendClientBookingPackage } = require('../prospects/_client_booking');
        const leadFull = Object.assign({}, lead, { owner_name: ownerName, owner_email: ownerEmail, primary_language: lead.primary_language || lang });
        pkg = await sendClientBookingPackage(pros, leadFull, clientCo || { id: site.client_id, business_name: site.name }, {
            whenIso: startIso, prospectEmail: ownerEmail, repEmail: 'blason_vsl',
            mode: mode, origin: 'vsl', skipClientBrief: true,
        });
    } catch (e) { pkg = { error: String(e && e.message || e) }; console.error('[blason-book] package failed:', e && e.message); }

    // --- 4. bookkeeping + Remy's alert ----------------------------------------
    const sessionId = F.str(body.session_id, 64), visitorId = F.str(body.visitor_id, 64);
    try {
        await pub.from('funnel_events').insert({
            site: body.site, event: 'booking_confirmed', session_id: sessionId, visitor_id: visitorId,
            lead_id: lead.id, lead_claimed: true, answer: mode,
            meta: { start: startIso, calendar_event: !!ev, package: pkg && !pkg.error ? 'sent' : 'failed' },
            path: F.str(body.path, 300), lang: lang, ua: String(req.headers['user-agent'] || '').slice(0, 300), ip_hash: F.ipHash(req),
        });
        let q = pub.from('funnel_submissions').update({ booked_at: new Date().toISOString(), meeting_at: startIso }).eq('lead_id', lead.id).is('booked_at', null);
        if (sessionId) q = q.eq('session_id', sessionId);
        await q;
    } catch (_) { /* best-effort */ }

    try {
        const first = ownerName ? ownerName.split(/\s+/)[0] : '';
        const manuelLine = (mode === 'call'
            ? 'Manuel, te agendé una llamada de 10 minutos: ' + whenEt + ' (hora Miami). ' + business + (ownerName ? ', ' + ownerName : '') + (ownerPhone ? ', cel ' + ownerPhone : '') + '. Tú los llamas.'
            : 'Manuel, te agendé una visita al showroom: ' + whenEt + ' (hora Miami). ' + business + (ownerName ? ', ' + ownerName : '') + (ownerPhone ? ', cel ' + ownerPhone : '') + '.');
        await F.notify(
            'Blason booking: ' + business + ' · ' + (mode === 'call' ? '10-min call' : 'showroom') + ' · ' + whenEt,
            '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
            + '<p><strong>' + F.esc(business) + '</strong> booked ' + (mode === 'call' ? 'a 10-minute call with Manuel' : 'a showroom visit') + ' for <strong>' + F.esc(whenEt) + ' ET</strong>' + (lang === 'es' ? ' (Spanish)' : '') + '.</p>'
            + '<p style="font-size:18px">' + (ownerName ? F.esc(ownerName) + '<br>' : '') + (ownerPhone ? '<a href="tel:' + F.esc(ownerPhone) + '">' + F.esc(ownerPhone) + '</a>' : 'no phone') + (ownerEmail ? '<br>' + F.esc(ownerEmail) : '') + '</p>'
            + (notes ? '<p>Their note: ' + F.esc(notes) + '</p>' : '')
            + '<p><strong>Step 1:</strong> call ' + F.esc(first || 'them') + ' now and confirm. <strong>Step 2:</strong> once confirmed, send Manuel this on WhatsApp:</p>'
            + '<p style="background:#f4f4f4;padding:12px;border-radius:8px">' + F.esc(manuelLine) + '</p>'
            + '<p style="color:#555">Confirmation ' + (pkg && !pkg.error ? 'was sent to the prospect' : 'FAILED, send it by hand') + '. Calendar hold ' + (ev ? 'created' : 'NOT created (check the calendar token)') + '. Lead #' + lead.id + ' (' + F.esc(found.how) + ').</p>'
            + '<p><a href="https://admin.stiloaipartners.com/#prospecting?lead=' + lead.id + '">Open lead #' + lead.id + '</a></p></div>'
        );
    } catch (_) { /* best-effort */ }

    return res.status(200).json({ ok: true, lead_id: lead.id, mode: mode, start: startIso, when_et: whenEt, persisted: persisted, calendar: !!ev, confirmation: pkg && !pkg.error ? 'sent' : 'failed' });
};
