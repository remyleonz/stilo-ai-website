/**
 * GET /api/prospects/send-vsl-followup   (Vercel cron, every 5 min)
 *
 * Step 2 of the post-booking nurture SMS sequence: ~5 minutes after the prospect
 * OPENS the confirmation VSL page, text them from the booking rep's own Quo line
 * acknowledging they watched it and restating the meeting day and time.
 *
 * The trigger is a public.vsl_events row with flow='confirm' for that lead. That
 * is the same event stream the confirm funnel already counts, so no new client
 * instrumentation is needed.
 *
 * SMS only, no email. Step 1 already sent the email carrying the VSL link, and
 * this fires while the prospect is still on their phone.
 *
 * Idempotent via prospecting.leads.vsl_followup_sms_sent_at.
 *
 * Auth: Vercel cron sends Authorization: Bearer CRON_SECRET; an admin JWT also
 * works for manual runs. ?dry=1 previews without sending.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { openphoneFetch, normalizePhone } = require('../openphone/_shared');

const REMY_LINE = '+17868376639';

function fmtDay(iso) {
    if (!iso) return 'the day we set';
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/New_York' }).format(new Date(iso));
}
function fmtTime(iso) {
    if (!iso) return 'the time we set';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(new Date(iso));
}
async function sendSms(from, to, content) {
    if (!to) return { skip: 'no_phone' };
    const r = await openphoneFetch({ method: 'POST', path: '/messages', body: { from: from, to: [normalizePhone(to)], content: content } });
    return { status: r.status, err: (r.status >= 200 && r.status < 300) ? null : JSON.stringify(r.json).slice(0, 160) };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const DELAY_MIN = Number(process.env.VSL_FOLLOWUP_DELAY_MIN || 5);
    const dueBy = new Date(Date.now() - DELAY_MIN * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();

    // LOOKBACK exists so a page view from weeks ago (or a backfilled event) does
    // not suddenly trigger a "glad you got a chance to watch the video" text. The
    // message only makes sense close to the actual view.
    const LOOKBACK_H = Number(process.env.VSL_FOLLOWUP_LOOKBACK_H || 48);
    const lookbackIso = new Date(Date.now() - LOOKBACK_H * 60 * 60 * 1000).toISOString();

    // Find recent confirm-flow VSL activity. 'view' and 'confirm_open' both mean
    // the prospect actually landed on the page; 'email_open' does NOT, because
    // mail scanners trip the pixel and would text people who never watched.
    const { data: events, error: evErr } = await pub.from('vsl_events')
        .select('lead_id,created_at,event')
        .eq('flow', 'confirm')
        .in('event', ['view', 'confirm_open', 'play', 'confirm'])
        .not('lead_id', 'is', null)
        .lte('created_at', dueBy)
        .gte('created_at', lookbackIso)
        .order('created_at', { ascending: true })
        .limit(500);
    if (evErr) return res.status(500).json({ error: 'events_read_failed', detail: evErr.message });

    const seen = {};
    const leadIds = [];
    (events || []).forEach(function (e) {
        if (e.lead_id != null && !seen[e.lead_id]) { seen[e.lead_id] = e.created_at; leadIds.push(e.lead_id); }
    });
    if (!leadIds.length) return res.status(200).json({ ok: true, dry: dry, found: 0, results: [] });

    const explicitIds = String((req.query && req.query.lead_ids) || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let q = sb.from('leads')
        .select('id,name,owner_name,owner_phone,phone,meeting_scheduled_at,meeting_booked_by_sdr')
        .is('vsl_followup_sms_sent_at', null)
        .gt('meeting_scheduled_at', nowIso)
        .in('id', explicitIds.length ? explicitIds : leadIds);

    const { data: leads, error } = await q.order('meeting_scheduled_at', { ascending: true }).limit(50);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    const roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
    } catch (_) { /* fall back to Remy */ }

    const results = [];
    for (const ld of (leads || [])) {
        const phone = ld.owner_phone || ld.phone || null;
        const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
        const fromLine = (rep && rep.openphone_number) || REMY_LINE;
        const day = fmtDay(ld.meeting_scheduled_at);
        const time = fmtTime(ld.meeting_scheduled_at);

        const sms = 'Glad you got a chance to watch the video. I hope it gave you an idea of how we can help your business. '
            + 'I\'ve got you down for ' + day + ' at ' + time + '. '
            + 'The meeting will explain exactly how we can make you money and answer any questions you may have. Talk soon.';

        if (dry) { results.push({ id: ld.id, to_phone: phone, viewed_at: seen[ld.id], sms_preview: sms }); continue; }

        const sr = await sendSms(fromLine, phone, sms);
        const smsOk = sr && !sr.skip && !sr.err;

        // Only stamp on a real send, so a failure retries next tick instead of
        // being marked done forever.
        if (smsOk) {
            await sb.from('leads').update({
                vsl_followup_sms_sent_at: new Date().toISOString(),
                nurture_stage: 'vsl_watched'
            }).eq('id', ld.id);
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'sms',
                subject: 'Watched the video, meeting restated',
                body_preview: sms.slice(0, 300),
                to_address: phone, from_address: fromLine,
                provider: 'openphone',
                status: 'sent', variant: 'nurture_sms_2_watched',
                sent_by: ld.meeting_booked_by_sdr || null,
                sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, sent: smsOk, sms: sr });
    }
    return res.status(200).json({ ok: true, dry: dry, delay_min: DELAY_MIN, found: results.length, results: results });
};
