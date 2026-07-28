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

module.exports.maxDuration = 120;

const MAX_PER_TICK = Number(process.env.NURTURE_MAX_PER_TICK || 25);

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Light, readable, and deliberately NOT dark-themed: Gmail on iPhone
// force-inverts dark emails into something unreadable.
function emailHtml(bodyText, senderName) {
    const paras = String(bodyText || '').split(/\n{2,}/).map(function (p) {
        return '<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#111">' + esc(p).replace(/\n/g, '<br>') + '</p>';
    }).join('');
    return [
        '<div style="background:#ffffff;padding:28px 20px">',
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto">',
        paras,
        '<p style="margin:22px 0 0;font-size:15px;color:#111">' + esc(senderName || 'Remy') + '<br>',
        '<span style="color:#6B7280;font-size:13px">STILO AI Partners, Miami</span></p>',
        '</div></div>',
    ].join('');
}

async function sendEmail(to, subject, bodyText, senderName) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    const fromName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const replyTo = process.env.STILO_REPLY_TO || fromEmail;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: [to], reply_to: replyTo,
            subject: subject || 'Before our call',
            html: emailHtml(bodyText, senderName),
            text: bodyText,
        }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
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
            await sb.from('nurture_touches')
                .update({ status: 'sent', sent_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() })
                .eq('id', touch.id);
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
        preview: results.preview.slice(0, 15),
        due_remaining: Math.max(0, due.length - MAX_PER_TICK),
    });
};
