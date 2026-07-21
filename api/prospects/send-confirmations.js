/**
 * GET /api/prospects/send-confirmations   (Vercel cron, every 5 min)
 *
 * SAFETY NET for the meeting confirmation. The confirmation now goes out
 * INLINE the moment the rep books (see book-meeting.js), so the rep can tell the
 * prospect to check their email while still on the call. This cron only catches
 * what that missed: a transient Gmail/Quo failure, a booking made before the
 * inline send shipped, or a manual backfill.
 *
 * Both paths call the same sendConfirmationForLead() in _send_confirmation.js.
 * Idempotent via meeting_confirmation_sent_at, so a successful inline send means
 * this cron never touches the lead.
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; an admin JWT
 * also works for manual runs.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { sendConfirmationForLead, CONFIRM_LEAD_COLS } = require('./_send_confirmation');

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // TRIGGER SEMANTICS (not a catch-window): a lead is due for its confirmation
    // once the booking is at least DELAY_MIN old and the meeting is still ahead.
    // There is deliberately NO lower bound on meeting_booked_at — the old code
    // only looked back 30 minutes, so anything booked before the feature shipped
    // (or any run the cron missed) was silently skipped forever. Idempotency is
    // meeting_confirmation_sent_at, so "no lower bound" can't double-send.
    //
    // HORIZON_DAYS stops us emailing "you're booked, quick confirm" for a meeting
    // four months out. Those aren't dropped — they stay unsent and fire naturally
    // once the meeting comes inside the horizon.
    //
    // ?lead_ids=1,2,3 forces a send for specific leads (manual backfill), still
    // honouring the not-yet-sent + still-upcoming guards.
    const DELAY_MIN = Number(process.env.CONFIRM_DELAY_MIN || 5);
    const HORIZON_DAYS = Number(process.env.CONFIRM_HORIZON_DAYS || 30);
    const nowIso = new Date().toISOString();
    const dueBy = new Date(Date.now() - DELAY_MIN * 60 * 1000).toISOString();
    const horizon = new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // ?dry=1 previews without sending. This did NOT exist while every sibling
    // cron had it, so "?dry=1" here looked like a safe preview and was actually
    // a live send — it texted a real prospect on 2026-07-20. An unsupported
    // safety flag is worse than no safety flag.
    const dry = String((req.query && req.query.dry) || '') === '1';

    const explicitIds = String((req.query && req.query.lead_ids) || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let q = sb.from('leads')
        .select(CONFIRM_LEAD_COLS)
        .is('meeting_confirmation_sent_at', null)
        .not('meeting_booked_at', 'is', null)
        .gt('meeting_scheduled_at', nowIso);

    if (explicitIds.length) {
        q = q.in('id', explicitIds);
    } else {
        q = q.lte('meeting_booked_at', dueBy).lt('meeting_scheduled_at', horizon);
    }

    const { data: leads, error } = await q.order('meeting_scheduled_at', { ascending: true }).limit(50);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    // Resolve the rep roster ONCE for the whole batch rather than per lead.
    let roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
    } catch (_) { /* sendConfirmationForLead falls back to Remy */ }

    const results = [];
    for (const ld of (leads || [])) {
        results.push(await sendConfirmationForLead(sb, pub, ld, { dry: dry, roster: roster }));
    }
    return res.status(200).json({ ok: true, sent: results.length, results: results });
};
