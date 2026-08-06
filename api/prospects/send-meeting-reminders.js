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
 * ALSO reminds the closers: the same tick emails Remy + David (Resend) with the
 * lead, the admin deep link, and the Meet link, idempotent via its own stamp
 * (closer_reminder_sent_at). Added after 2026-07-24, when lead 22413 (Maxwell
 * Bossis) showed up to his Meet and no STILO closer joined: the prospect got a
 * reminder, the team got nothing.
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
// Deliberately NOT a local sendSms. This file used to define its own, which
// bypassed the _sms.js guardrail entirely: no duplicate-body check, no 24h rate
// cap, no from-line fallback. A private copy of a shared safety mechanism is a
// safety mechanism you do not have.
const { sendSms, guardOutbound } = require('./_sms');
const { sendTransactional } = require('./_gmail_send');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const REMY_LINE = '+17868376639';
const CLOSER_EMAILS = ['remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }
function fmtTime(iso) {
    if (!iso) return 'shortly';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(new Date(iso));
}
// (No esc() here any more: plain text only, nothing to escape.)

// Plain text only, Gmail first. This is a "join now" nudge to someone who
// booked a meeting; it has to land in the inbox, and a styled HTML card with a
// blue button is exactly what gets it filed as Promotions. Same reasoning as
// send-confirmations.js. See _gmail_send.js.
async function sendEmail(to, subject, text) {
    if (!to) return { skip: 'no_email' };
    return await sendTransactional({ to: to, subject: subject, text: text });
}

// Internal mail goes through Resend directly (same pattern as health-alerts.js),
// not _gmail_send: that helper is tuned for prospect deliverability and its
// suppression checks make no sense for our own inboxes.
async function sendCloserEmail(subject, text) {
    if (!process.env.RESEND_API_KEY) return { skip: 'resend_not_configured' };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: 'STILO Meetings <remyleon@stiloaipartners.com>',
            to: CLOSER_EMAILS, subject: subject, text: text
        })
    });
    const j = await r.json().catch(function () { return {}; });
    return r.ok ? { id: j.id } : { err: j.message || ('resend_' + r.status) };
}

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

        // Plain text. No button, no card. The Meet link has to be the plainest
        // thing in the message so it survives every client.
        const joinLine = meet
            ? ['Join here:', meet]
            : [repName + ' will call you at the number on file.'];
        const body = [
            'Hi ' + first + ',',
            '',
            'Quick reminder, your meeting with STILO is at ' + when + ', about 15 minutes from now.',
            '',
        ].concat(joinLine).concat([
            '',
            'Running late or need to move it? Just reply here.',
            '',
            'See you shortly,',
            repName,
            'STILO AI Partners',
        ]).join('\n');
        const sms = meet
            ? 'Hi ' + first + ', ' + repName + ' from STILO. Our meeting is at ' + when + ', about 15 min out. Join here: ' + meet
            : 'Hi ' + first + ', ' + repName + ' from STILO. Our meeting is at ' + when + ', about 15 min out. I\'ll call you then.';

        if (dry) { results.push({ id: ld.id, to_email: email, to_phone: phone, when: when, meet: !!meet, sms_preview: sms }); continue; }

        let er = { skip: 'no_email' }, sr = { skip: 'no_phone' };
        if (email) {
            const eg = await guardOutbound(ld.id, 'email', body, 'Your STILO meeting starts in ~15 minutes');
            if (!eg.ok) {
                console.error('[send-meeting-reminders] EMAIL BLOCKED lead=' + ld.id + ' reason=' + eg.reason);
                er = { skip: eg.reason, blocked: true };
            } else {
                er = await sendEmail(email, 'Your STILO meeting starts in ~15 minutes', body);
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
                body: sms,
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
                // Same reason as _send_confirmation.js: the preview described the
                // email instead of being it, so the Meet link we sent was not
                // readable or clickable from the lead panel.
                body: body,
                body_preview: 'T-15 reminder + Meet link for ' + when,
                to_address: email, from_address: 'remyleon@stiloaipartners.com',
                // Read the provider off the send result. This was hardcoded to
                // 'resend' while sendEmail() routes through sendTransactional,
                // which prefers Gmail. Every reminder since the Gmail grant
                // (2026-07-21) actually went out through Workspace and was logged
                // as Resend, which made it look like the T-15 reminder was riding
                // the cold pipeline. It never was. Same pattern as
                // _send_confirmation.js:177.
                provider: (er && er.via) || 'resend', provider_message_id: er.id || null,
                status: 'sent', variant: 'meeting_reminder', sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, when: when, sent: (emailOk || smsOk), email: er, sms: sr });
    }

    // ------------------------------------------------------------------
    // Closer half: same window, but eligibility and idempotency live on a
    // SEPARATE query and a SEPARATE stamp (closer_reminder_sent_at). Two
    // reasons:
    //  - the prospect send and the closer send succeed or fail on their own;
    //    a shared stamp would let one side's success swallow the other side's
    //    failure forever.
    //  - a separate query keeps this half's errors (including a not-yet-applied
    //    migration) from taking the prospect reminders above down with it.
    // The stamp UPDATE carries the stamp ALONE (2026-07-20 postmortem: a stamp
    // sharing an UPDATE with a constraint-checked column doesn't get written
    // when that column fails, and an unwritten stamp on a 5-minute cron is a
    // resend loop).
    // ------------------------------------------------------------------
    const closerResults = [];
    let closerError = null;
    let cq = sb.from('leads')
        .select('id,name,owner_name,meeting_scheduled_at,meeting_meet_link,meeting_event_link')
        .is('closer_reminder_sent_at', null)
        .not('meeting_scheduled_at', 'is', null);
    if (explicitIds.length) {
        cq = cq.in('id', explicitIds);
    } else {
        cq = cq.gte('meeting_scheduled_at', floorIso).lte('meeting_scheduled_at', soonIso);
    }
    const { data: closerLeads, error: cErr } = await cq.order('meeting_scheduled_at', { ascending: true }).limit(50);
    if (cErr) {
        console.error('[send-meeting-reminders] closer query failed (prospect reminders unaffected):', cErr.message);
        closerError = cErr.message;
    }
    for (const ld of (closerLeads || [])) {
        const when = fmtTime(ld.meeting_scheduled_at);
        const meet = ld.meeting_meet_link || ld.meeting_event_link || '';
        const adminLink = BASE + '/admin/#lead=' + ld.id;
        const subject = 'Meeting in ~15 min: ' + (ld.name || 'lead ' + ld.id) + ' at ' + when;
        const text = [
            (ld.name || 'Lead ' + ld.id) + ' is on the calendar at ' + when + ', about 15 minutes from now.',
            '',
            'Contact: ' + (ld.owner_name || 'unknown'),
            meet ? 'Join the Meet: ' + meet : 'No Meet link on file, check the lead for how this call happens.',
            'Lead in admin: ' + adminLink,
            '',
            'Automated T-15 closer reminder. The prospect gets their own nudge on the same tick.',
        ].join('\n');

        if (dry) { closerResults.push({ id: ld.id, when: when, to: CLOSER_EMAILS, subject: subject }); continue; }

        const cr = await sendCloserEmail(subject, text);
        const closerOk = cr && !cr.skip && !cr.err;
        if (closerOk) {
            const { error: stampErr } = await sb.from('leads')
                .update({ closer_reminder_sent_at: new Date().toISOString() }).eq('id', ld.id);
            if (stampErr) {
                console.error('[send-meeting-reminders] CLOSER STAMP FAILED lead=' + ld.id + ', will resend next tick:', stampErr.message);
                closerResults.push({ id: ld.id, sent: true, stamp_failed: true, detail: stampErr.message });
                continue;
            }
        }
        closerResults.push({ id: ld.id, when: when, sent: closerOk, email: cr });
    }

    return res.status(200).json({
        ok: true, dry: dry, lead_min: LEAD_MIN,
        found: results.length, results: results,
        closers: { found: closerResults.length, results: closerResults, error: closerError },
    });
};
