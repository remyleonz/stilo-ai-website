/**
 * GET /api/prospects/send-meeting-reminders   (Vercel cron, every 5 min)
 *
 * T-15 heads-up: ~15 minutes before a booked meeting, send the prospect a short
 * EMAIL (Resend) and SMS (OpenPhone, from the booking rep's own Quo line) with
 * the Google Meet join link. This is the "you have a meeting with us shortly"
 * nudge, separate from the confirmation flow that fires right after booking.
 *
 * Idempotent via prospecting.leads.meeting_reminder_sent_at.
 *
 * WHY A WINDOW, NOT AN EXACT TIME: the cron ticks every 5 minutes, so a meeting
 * never lines up exactly with T-15. We fire once when the meeting is inside the
 * next LEAD_MIN..0 minutes and hasn't been reminded yet. With LEAD_MIN=18 a 10:00
 * meeting gets its nudge on the 9:42, 9:47, or 9:52 tick (whichever lands first),
 * always 8-18 min ahead. The stamp guarantees exactly one send.
 *
 * Auth: Vercel cron sends Authorization: Bearer CRON_SECRET; an admin JWT also
 * works for manual runs. ?dry=1 previews without sending.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const REMY_LINE = '+17868376639';

function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }
function fmtTime(iso) {
    if (!iso) return 'shortly';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(new Date(iso));
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

async function sendEmail(to, subject, html) {
    if (!process.env.RESEND_API_KEY || !to) return { skip: 'no_email_or_key' };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Remy Leon <remyleon@stiloaipartners.com>', to: [to], reply_to: 'remyleon@stiloaipartners.com', subject: subject, html: html })
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, err: r.ok ? null : (j.message || 'fail') };
}
// Deliberately NOT a local sendSms any more. This file used to define its own,
// which meant it bypassed the _sms.js guardrail entirely -- no duplicate-body
// check, no 24h rate cap, and no from-line fallback for lines that cannot send.
// A private copy of a shared safety mechanism is a safety mechanism you do not
// have. See api/prospects/_sms.js.
const { sendSms, guardOutbound } = require('./_sms');

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // Fire when the meeting starts within the next LEAD_MIN minutes and is still
    // in the future. GRACE_MIN is a small floor so a meeting that already started
    // (rep is late, clock skew) doesn't get a "starts shortly" text after the fact.
    const LEAD_MIN = Number(process.env.REMINDER_LEAD_MIN || 18);
    const GRACE_MIN = Number(process.env.REMINDER_GRACE_MIN || 1);
    const nowIso = new Date().toISOString();
    const soonIso = new Date(Date.now() + LEAD_MIN * 60 * 1000).toISOString();
    const floorIso = new Date(Date.now() + GRACE_MIN * 60 * 1000).toISOString();

    const explicitIds = String((req.query && req.query.lead_ids) || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let q = sb.from('leads')
        .select('id,name,owner_name,owner_email,email,owner_phone,phone,meeting_scheduled_at,meeting_meet_link,meeting_event_link,meeting_booked_by_sdr')
        .is('meeting_reminder_sent_at', null)
        .not('meeting_scheduled_at', 'is', null);
    if (explicitIds.length) {
        q = q.in('id', explicitIds);
    } else {
        q = q.gte('meeting_scheduled_at', floorIso).lte('meeting_scheduled_at', soonIso);
    }
    const { data: leads, error } = await q.order('meeting_scheduled_at', { ascending: true }).limit(50);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    // Rep name + Quo line for the SMS "from" and signature.
    const roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
    } catch (_) { /* fall back to Remy */ }

    const results = [];
    for (const ld of (leads || [])) {
        const first = firstName(ld.owner_name);
        const when = fmtTime(ld.meeting_scheduled_at);
        const meet = ld.meeting_meet_link || ld.meeting_event_link || '';
        const email = ld.owner_email || ld.email || null;
        const phone = ld.owner_phone || ld.phone || null;
        const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
        const repName = (rep && rep.display_name && rep.display_name.split(/\s+/)[0]) || 'Remy';
        const fromLine = (rep && rep.openphone_number) || REMY_LINE;

        // No VSL, no tracking pixel: this is a transactional "join now" nudge, and
        // a mail-scanner opening a pixel here would tell us nothing useful.
        const joinBtn = meet
            ? '<div style="text-align:center;margin:22px 0"><a href="' + esc(meet) + '" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:8px">Join the meeting</a></div>'
            + '<p style="color:#374151;font-size:13px;text-align:center;word-break:break-all">' + esc(meet) + '</p>'
            : '<p>' + esc(repName) + ' will call you at the number on file.</p>';
        const html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
            + '<p>Hi ' + esc(first) + ',</p>'
            + '<p>Quick reminder, your meeting with STILO is at <strong>' + esc(when) + '</strong>, about 15 minutes from now.</p>'
            + joinBtn
            + '<p style="color:#374151;font-size:13px">Running late or need to move it? Just reply here.</p>'
            + '<p>See you shortly,<br/>' + esc(repName) + '<br/>STILO AI Partners</p></div>';
        const sms = meet
            ? 'Hi ' + first + ', ' + repName + ' from STILO. Our meeting is at ' + when + ', about 15 min out. Join here: ' + meet
            : 'Hi ' + first + ', ' + repName + ' from STILO. Our meeting is at ' + when + ', about 15 min out. I\'ll call you then.';

        if (dry) { results.push({ id: ld.id, to_email: email, to_phone: phone, when: when, meet: !!meet, sms_preview: sms }); continue; }

        let er = { skip: 'no_email' }, sr = { skip: 'no_phone' };
        if (email) {
            const eg = await guardOutbound(ld.id, 'email', html, 'Your STILO meeting starts in ~15 minutes');
            if (!eg.ok) {
                console.error('[send-meeting-reminders] EMAIL BLOCKED lead=' + ld.id + ' reason=' + eg.reason);
                er = { skip: eg.reason, blocked: true };
            } else {
                er = await sendEmail(email, 'Your STILO meeting starts in ~15 minutes', html);
            }
        }
        if (phone) sr = await sendSms(fromLine, phone, sms, { leadId: ld.id });

        const emailOk = er && !er.skip && !er.err;
        const smsOk = sr && !sr.skip && !sr.err;
        // Only stamp if a channel landed, so a total failure retries next tick
        // rather than being marked done forever. The error IS checked: an
        // unchecked stamp on a cron whose eligibility filter is "stamp IS NULL"
        // is precisely how one prospect got 40 texts on 2026-07-20.
        if (emailOk || smsOk) {
            const { error: stampErr } = await sb.from('leads')
                .update({ meeting_reminder_sent_at: new Date().toISOString() }).eq('id', ld.id);
            if (stampErr) {
                console.error('[send-meeting-reminders] STAMP FAILED lead=' + ld.id + ' — halting to avoid a resend loop:', stampErr.message);
                results.push({ id: ld.id, sent: true, stamp_failed: true, detail: stampErr.message });
                continue;
            }
        }
        // Log the SMS too. Reminder texts were written nowhere, so they were
        // invisible on the lead panel AND uncounted by the _sms.js 24h rate cap,
        // which quietly weakened that backstop for every other sender.
        if (smsOk) {
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'sms',
                subject: 'T-15 meeting reminder',
                body_preview: sms.slice(0, 300),
                to_address: phone, from_address: (sr && sr.from) || fromLine,
                provider: 'openphone', status: 'sent',
                variant: 'meeting_reminder', sent_at: new Date().toISOString(),
            });
        }
        if (emailOk) {
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'email',
                subject: 'Your STILO meeting starts in ~15 minutes',
                body_preview: 'T-15 reminder + Meet link for ' + when,
                to_address: email, from_address: 'remyleon@stiloaipartners.com',
                provider: 'resend', provider_message_id: er.id || null,
                status: 'sent', variant: 'meeting_reminder', sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, when: when, sent: (emailOk || smsOk), email: er, sms: sr });
    }
    return res.status(200).json({ ok: true, dry: dry, lead_min: LEAD_MIN, found: results.length, results: results });
};
