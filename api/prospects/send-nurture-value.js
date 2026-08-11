/**
 * GET /api/prospects/send-nurture-value   (Vercel cron, every 15 min)
 * ?dry=1 previews without sending.
 *
 * Fires the value touches that schedule-nurture.js planned. Email goes via
 * Resend, SMS from the booking rep's own Quo line through the shared sendSms
 * (so it inherits the duplicate-body guard and the 24h rate cap).
 *
 * Every touch re-validates against the CURRENT state of the lead immediately
 * before sending, not against the state at planning time. A plan written on
 * Monday for a Thursday meeting can be wrong by Wednesday: the meeting moved,
 * they cancelled, they asked us to stop, or they already bought. Sending a
 * "before our call" email to someone who cancelled is worse than sending
 * nothing, so the checks live here rather than only in the planner.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { sendSms } = require('./_sms');
const { normalizePhone } = require('../openphone/_shared');

const MAX_PER_TICK = Number(process.env.NURTURE_MAX_PER_TICK || 25);

// Goes to a prospect who already BOOKED, so it must not ride cold sending
// reputation. sendTransactional is Gmail first with a Resend fallback, and it is
// text-only by design: no HTML part and no tracking pixel is what keeps these in
// Primary. See _gmail_send.js.
async function sendEmail(to, subject, bodyText, senderName) {
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const replyTo = process.env.STILO_REPLY_TO || fromEmail;
    const { sendTransactional } = require('./_gmail_send');
    const r = await sendTransactional({
        to: to,
        subject: subject || 'Before our call',
        text: bodyText + '\n\n' + (senderName || process.env.STILO_SENDER_NAME || 'Remy Leon') + '\nSTILO AI Partners',
        replyTo: replyTo,
    });
    return { status: r.status, id: r.id, via: r.via, error: r.err || null, skipped: r.skip };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query || {}).dry || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const now = new Date();
    const { data: due, error } = await sb.from('nurture_touches')
        .select('*').eq('status', 'pending')
        .lte('scheduled_for', now.toISOString())
        .order('scheduled_for', { ascending: true })
        .limit(MAX_PER_TICK);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
    if (!due.length) return res.status(200).json({ ok: true, sent: 0, note: 'Nothing due.' });

    const results = { sent: 0, skipped: {}, failed: 0, preview: [] };

    for (const touch of due) {
        const { data: lead } = await sb.from('leads')
            .select('id,name,owner_name,owner_email,email,meeting_scheduled_at,do_not_call,meeting_booked_by_sdr,owner_phone_e164,owner_phone,phone,last_called_outcome')
            .eq('id', touch.lead_id).maybeSingle();

        const skip = function (reason) {
            results.skipped[reason] = (results.skipped[reason] || 0) + 1;
            if (!dry) {
                sb.from('nurture_touches')
                    .update({ status: 'skipped', error: reason, updated_at: now.toISOString() })
                    .eq('id', touch.id).then(function () {}, function () {});
            }
        };

        if (!lead) { skip('lead_missing'); continue; }
        if (lead.do_not_call) { skip('do_not_call'); continue; }
        // The meeting moved or was cleared after this touch was planned.
        if (!lead.meeting_scheduled_at) { skip('meeting_cancelled'); continue; }
        if (new Date(lead.meeting_scheduled_at).toISOString() !== new Date(touch.meeting_at).toISOString()) {
            skip('meeting_rescheduled'); continue;
        }
        // The meeting already happened; a "before our call" note now is noise.
        if (new Date(lead.meeting_scheduled_at) < now) { skip('meeting_already_passed'); continue; }

        let senderName = 'Remy';
        try {
            const { data: rep } = await pub.from('sdr_users')
                .select('display_name, openphone_number').eq('email', lead.meeting_booked_by_sdr).maybeSingle();
            if (rep && rep.display_name) senderName = rep.display_name.trim().split(/\s+/)[0];
            touch._line = rep && rep.openphone_number ? normalizePhone(rep.openphone_number) : null;
        } catch (_) { /* falls back below */ }

        if (dry) {
            results.preview.push({
                touch_id: touch.id, lead: lead.name, step: touch.step_key, channel: touch.channel,
                scheduled_for: touch.scheduled_for, subject: touch.subject,
                body: String(touch.body || '').slice(0, 240),
            });
            results.sent++;
            continue;
        }

        try {
            if (touch.channel === 'email') {
                const to = lead.owner_email || lead.email;
                if (!to) { skip('no_email'); continue; }
                // Pre-send gate. This cron had no bounce, suppression or MX check
                // of any kind; it mails booked prospects, so a bounce here also
                // burns the address that sends their meeting confirmation.
                const gate = await require('./_email_guard').canSend({ email: to, leadId: lead.id });
                if (!gate.ok) { skip('blocked_' + gate.reason); continue; }
                const r = await sendEmail(to, touch.subject, touch.body, senderName);
                if (r.skipped) { skip(r.skipped); continue; }
                if (r.error) throw new Error(r.error);
            } else {
                const to = normalizePhone(lead.owner_phone_e164 || lead.owner_phone || lead.phone || '');
                if (!to) { skip('no_phone'); continue; }
                const from = touch._line || require('./_sms').REMY_LINE;
                const r = await sendSms(from, to, touch.body, { leadId: lead.id });
                if (r.skip) { skip(r.skip); continue; }
                if (r.err) throw new Error(r.err);
            }
            // The sent-stamp is the only thing standing between this touch and
            // a resend every 15 minutes (eligibility is status='pending'). So
            // the update's error is CHECKED, and a failed stamp moves the touch
            // to 'failed', which halts it, rather than leaving it pending. Same
            // bug class as the 40-text loop of 2026-07-20, email flavor.
            const { error: stampErr } = await sb.from('nurture_touches')
                .update({ status: 'sent', sent_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() })
                .eq('id', touch.id);
            if (stampErr) {
                const { error: failErr } = await sb.from('nurture_touches')
                    .update({ status: 'failed', error: ('sent_but_stamp_failed: ' + stampErr.message).slice(0, 200), updated_at: new Date().toISOString() })
                    .eq('id', touch.id);
                results.stamp_failed = (results.stamp_failed || 0) + 1;
                console.error('[nurture] STAMP FAILED touch=' + touch.id + ' (message DID send): ' + stampErr.message
                    + (failErr ? '. AND the failed-mark also failed (' + failErr.message + '), touch is still pending and WILL RESEND next tick. Fix the row now.' : '. Parked as failed.'));
            }
            results.sent++;
        } catch (e) {
            results.failed++;
            await sb.from('nurture_touches')
                .update({ status: 'failed', error: String(e.message || e).slice(0, 200), updated_at: new Date().toISOString() })
                .eq('id', touch.id);
            console.error('[nurture] send failed touch=' + touch.id + ': ' + (e && e.message));
        }
    }

    return res.status(200).json({
        ok: true, dry: dry,
        sent: results.sent, failed: results.failed, skipped: results.skipped,
        stamp_failed: results.stamp_failed || 0,
        preview: results.preview.slice(0, 15),
        due_remaining: Math.max(0, due.length - MAX_PER_TICK),
    });
};

// Must come AFTER the handler assignment: `module.exports = ...` replaces the
// exports object, so setting maxDuration before it was silently discarded and
// Vercel ran this function with the default 10s limit.
module.exports.maxDuration = 120;
