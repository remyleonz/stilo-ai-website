/**
 * GET /api/prospects/send-day-before   (Vercel cron, hourly)
 *
 * Step 3 of the post-booking nurture SMS sequence: ~1 day before the meeting,
 * text the prospect from the booking rep's own Quo line saying the team has
 * already looked at their business, and ask what they want covered.
 *
 * The closing question is the point of the message. "Anything in particular you
 * want me and my team to look at before the meeting?" converts a calendar entry
 * into a commitment and hands the closer a piece of live discovery before the
 * call starts. Replies land in Quo on the rep's line.
 *
 * SMS only. The T-15 email/SMS nudge (send-meeting-reminders.js) is separate and
 * still fires on the day.
 *
 * Idempotent via prospecting.leads.day_before_sms_sent_at.
 *
 * WHY A WINDOW: the cron ticks hourly, so we fire once when the meeting falls
 * inside the next LEAD_H..FLOOR_H hours. With the defaults that is roughly 20 to
 * 28 hours out, which reads as "tomorrow" for any meeting during business hours.
 *
 * Auth: Vercel cron sends Authorization: Bearer CRON_SECRET; an admin JWT also
 * works for manual runs. ?dry=1 previews without sending.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { sendSms } = require('./_sms');
const { firstName, greet } = require('./_names');

const REMY_LINE = '+17868376639';


module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const LEAD_H = Number(process.env.DAY_BEFORE_LEAD_H || 28);
    const FLOOR_H = Number(process.env.DAY_BEFORE_FLOOR_H || 20);
    const ceilIso = new Date(Date.now() + LEAD_H * 60 * 60 * 1000).toISOString();
    const floorIso = new Date(Date.now() + FLOOR_H * 60 * 60 * 1000).toISOString();

    const explicitIds = String((req.query && req.query.lead_ids) || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let q = sb.from('leads')
        .select('id,name,address,owner_name,owner_phone,phone,meeting_scheduled_at,meeting_booked_by_sdr')
        .is('day_before_sms_sent_at', null)
        .not('meeting_scheduled_at', 'is', null);
    if (explicitIds.length) {
        q = q.in('id', explicitIds);
    } else {
        q = q.gte('meeting_scheduled_at', floorIso).lte('meeting_scheduled_at', ceilIso);
    }
    const { data: leads, error } = await q.order('meeting_scheduled_at', { ascending: true }).limit(50);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    const roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
    } catch (_) { /* fall back to Remy */ }

    const results = [];
    for (const ld of (leads || [])) {
        // Null when owner_name is junk (a city, the business name, 'Program').
        // greet() then drops the name entirely rather than saying 'Hey there'.
        const first = firstName(ld.owner_name, ld.name, ld.address);
        const phone = ld.owner_phone || ld.phone || null;
        const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
        const fromLine = (rep && rep.openphone_number) || REMY_LINE;
        // Fall back to "your business" rather than printing an empty string or a
        // raw null into a text the prospect actually reads.
        const biz = (ld.name || '').trim() || 'your business';

        const sms = greet('Hey', first) + 'looking forward to the meeting tomorrow. '
            + 'I had a deep look at ' + biz + ' with my team, and we have a plan set that you will find valuable. '
            + 'Anything in particular you want me and my team to look at before the meeting?';

        if (dry) { results.push({ id: ld.id, to_phone: phone, when: ld.meeting_scheduled_at, sms_preview: sms }); continue; }

        const sr = await sendSms(fromLine, phone, sms, { leadId: ld.id });
        const smsOk = sr && !sr.skip && !sr.err;

        if (smsOk) {
            // Stamp the idempotency column ALONE and check the error. These must
            // never share an UPDATE with nurture_stage: a rejected stage value
            // fails the whole statement, the stamp never lands, and the lead is
            // re-texted every tick forever. That shipped once (2026-07-20, one
            // prospect got 40 texts) and must not ship again.
            const { error: stampErr } = await sb.from('leads')
                .update({ day_before_sms_sent_at: new Date().toISOString() })
                .eq('id', ld.id);
            if (stampErr) {
                console.error('[send-day-before] STAMP FAILED lead=' + ld.id + ' — halting to avoid a resend loop:', stampErr.message);
                results.push({ id: ld.id, sent: true, stamp_failed: true, detail: stampErr.message });
                continue;
            }
            // Best effort, cosmetic. A failure here must not block anything.
            const { error: stageErr } = await sb.from('leads')
                .update({ nurture_stage: 'day_before_sent' }).eq('id', ld.id);
            if (stageErr) console.error('[send-day-before] nurture_stage write failed lead=' + ld.id + ':', stageErr.message);
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'sms',
                subject: 'Day-before check in',
                body: sms,
                body_preview: sms.slice(0, 300),
                to_address: phone, from_address: (sr && sr.from) || fromLine,
                provider: 'openphone',
                status: 'sent', variant: 'nurture_sms_3_day_before',
                sent_by: ld.meeting_booked_by_sdr || null,
                sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, when: ld.meeting_scheduled_at, sent: smsOk, sms: sr });
    }
    return res.status(200).json({ ok: true, dry: dry, window_h: [FLOOR_H, LEAD_H], found: results.length, results: results });
};
