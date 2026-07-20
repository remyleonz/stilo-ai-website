/**
 * GET /api/prospects/send-confirmations   (Vercel cron, every 5 min)
 *
 * Meeting Confirmation flow: ~5 minutes after a meeting is booked, send the
 * prospect a short confirmation EMAIL (Resend, from remyleon@stiloaipartners.com)
 * and SMS (OpenPhone, from the BOOKING REP'S own Quo line) with a link to the
 * agent's VSL page in confirm mode. Idempotent via meeting_confirmation_sent_at.
 *
 * Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; an admin JWT
 * also works for manual runs.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { signLead } = require('../public/_token');
const { sendSms, guardOutbound } = require('./_sms');
const { firstName: safeFirstName, greet } = require('./_names');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const REMY_LINE = '+17868376639';

// ai-seo and ontology were retired 2026-07-15 (never filmed, now redirected in
// vercel.json). Anything that used to route there falls through to receptionist
// rather than mailing a prospect a link that bounces them to the homepage.
function slugFor(name) {
    const s = String(name || '').toLowerCase();
    if (/recept/.test(s)) return 'receptionist';
    if (/reactiv|lcr|lost customer/.test(s)) return 'reactivation';
    if (/lead reply|lead response|outbound|instant lead/.test(s)) return 'lead-reply';
    if (/lead gen|b2b|prospect|scout/.test(s)) return 'b2bleadgen';
    if (/website|web build/.test(s)) return 'website';
    if (/sales coach|coach|sales agent|pitch/.test(s)) return 'sales-agent';
    return 'receptionist';
}
function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }
function fmtWhen(iso) {
    if (!iso) return 'the time we set';
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York' }).format(new Date(iso));
}
// (No esc() here any more — this file sends plain text only, so there is no
// HTML to escape. If you find yourself needing it again, you are re-adding the
// markup that put these emails in spam.)

const REPLY_TO = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

// One-click unsubscribe, same signing scheme as vsl-campaign.js. Gmail's bulk
// sender rules expect this header even on transactional mail, and its absence
// is a scored spam signal.
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = Buffer.from(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }))
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = require('crypto').createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}

/**
 * PLAIN TEXT ONLY. No HTML part, no tracking pixel, no button.
 *
 * This email was landing in prospects' SPAM — confirmed live by Max Bertrand on
 * 2026-07-20, and it is the email a BOOKED prospect must see. It was built the
 * exact opposite way from vsl-campaign.js, which was hardened for this and
 * works: it had an HTML-only body (no text/plain alternative), a hidden 1x1
 * tracking pixel with a query-string id, a #2563EB rounded CTA button, a
 * centered max-width card, and no List-Unsubscribe header. Every one of those
 * is a Promotions/spam signal, and _email_kit.js:336-343 already documented
 * exactly that. This file simply never followed it.
 *
 * DNS is NOT the cause — SPF, DKIM and DMARC all pass and align. Do not go
 * re-checking DNS when this regresses; check for HTML, pixels and buttons.
 */
async function sendEmail(to, subject, text) {
    if (!process.env.RESEND_API_KEY || !to) return { skip: 'no_email_or_key' };
    const t = unsubToken(to);
    const headers = t ? {
        'List-Unsubscribe': '<' + BASE + '/api/unsubscribe?t=' + t + '>, <mailto:' + REPLY_TO + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: 'Remy Leon <' + REPLY_TO + '>',
            to: [to], reply_to: REPLY_TO, subject: subject,
            text: text,   // plain text only: no html part, no pixel
            headers: headers,
        })
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, err: r.ok ? null : (j.message || 'fail') };
}

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
        .select('id,name,address,owner_name,owner_email,email,owner_phone,phone,pitch_agent,matched_product_name,meeting_scheduled_at,meeting_booked_by_sdr,meeting_booked_at')
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

    // Resolve rep name + Quo line once.
    let roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
    } catch (_) { /* fallback to Remy below */ }

    const results = [];
    for (const ld of (leads || [])) {
        // pitch_agent FIRST: it carries the agent the rep actually picked at
        // booking time, on the call, with the prospect. matched_product_name is
        // the older derived guess and is only the fallback. Reading it first is
        // what made the confirmation email able to pitch a different agent than
        // the rep sold.
        const slug = slugFor(ld.pitch_agent || ld.matched_product_name);
        const token = signLead(ld.id);
        const link = BASE + '/agents/' + slug + '?lid=' + ld.id + '&t=' + token + '&confirm=1';
        // Email keeps the softer 'Hi there' fallback; the SMS must not use it,
        // so we carry a strict version that is null when the name is untrustworthy.
        const first = firstName(ld.owner_name);
        const safeFirst = safeFirstName(ld.owner_name, ld.name, ld.address);
        const when = fmtWhen(ld.meeting_scheduled_at);
        const email = ld.owner_email || ld.email || null;
        const phone = ld.owner_phone || ld.phone || null;
        const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
        const repName = (rep && rep.display_name) || 'Remy';
        // The SMS signs off with the rep's FIRST name only, the way they'd
        // introduce themselves on the phone. display_name holds the full name.
        const repFirst = firstName(repName);
        const fromLine = (rep && rep.openphone_number) || REMY_LINE;

        // Plain text, written the way a person types an email. No pixel (the
        // open-tracking signal is not worth the spam score, and image blocking
        // made it undercount anyway), no button, no card. The bare link is the
        // only thing that has to survive.
        const body = [
            'Hi ' + first + ',',
            '',
            'You are on the calendar for ' + when + '.',
            '',
            'Confirm you are still good here, and you will see your details plus a short video on what we are building for you:',
            link,
            '',
            'Cannot make it? Just reply and we will find a better time.',
            '',
            'See you then,',
            repName,
            'STILO AI Partners',
        ].join('\n');
        // Step 1 of the nurture SMS sequence. Deliberately carries NO link: it
        // points at the email so the prospect has to open it, which is what puts
        // them on the VSL page where the confirm button lives. The rep's first
        // name and their own Quo line make it read as a personal follow-up to the
        // call that just happened, not an automated blast.
        //
        // The opener is time-aware. Normally this fires ~5 min after the booking
        // call, so "just now" is right. But the cron also picks up leads booked
        // days earlier (a missed run, a failed first attempt, a manual backfill),
        // and texting "really enjoyed talking just now" about a call from last
        // week is the exact tell we are trying to avoid.
        const bookedAgeH = ld.meeting_booked_at
            ? (Date.now() - new Date(ld.meeting_booked_at).getTime()) / 3600000
            : 0;
        const whenWeTalked = bookedAgeH <= 6 ? 'just now'
            : bookedAgeH <= 48 ? 'the other day'
            : 'the other day';
        const sms = greet('Hey', safeFirst) + 'this is ' + repFirst + ' from Stilo Partners. Really enjoyed talking ' + whenWeTalked + '. '
            + 'As I mentioned, I just emailed you a short video that explains the implementation we talked about in detail. '
            + 'Give it a watch ASAP, so you can confirm your meeting on that page. The link\'s in your email.';

        // Subject carries the meeting date. Two reasons: it reads better in a
        // crowded inbox, and it makes a REBOOKING a genuinely different subject.
        // The 24h duplicate guard keys on subject, so a fixed string made a
        // legitimate second meeting look like a resend loop and silently blocked
        // it — which happened to Hugo Garcia on 2026-07-20: he got the SMS
        // saying "I just emailed you" while the email itself was suppressed.
        const subject = 'You are booked, quick confirm — ' + new Intl.DateTimeFormat('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York'
        }).format(new Date(ld.meeting_scheduled_at));

        if (dry) {
            results.push({ id: ld.id, slug: slug, to_email: email, to_phone: phone, when: when, sms_preview: sms, subject: subject });
            continue;
        }

        let er = { skip: 'no_email' }, sr = { skip: 'no_phone' };
        if (email) {
            // Email has no provider-side dedupe and this cron runs every 5 min.
            // Same backstop the SMS path gets: refuse a repeat subject to the
            // same lead inside 24h.
            const eg = await guardOutbound(ld.id, 'email', body, subject);
            if (!eg.ok) {
                console.error('[send-confirmations] EMAIL BLOCKED lead=' + ld.id + ' reason=' + eg.reason);
                er = { skip: eg.reason, blocked: true };
            } else {
                er = await sendEmail(email, subject, body);
            }
        }
        if (phone) sr = await sendSms(fromLine, phone, sms, { leadId: ld.id });

        // Only mark sent if a channel actually landed. The old code stamped
        // unconditionally, so a lead whose email AND sms both failed was burned
        // forever: the stamp made it invisible to every later run. Leaving it
        // null lets the next 5-min tick retry.
        const emailOk = er && !er.skip && !er.err;
        const smsOk = sr && !sr.skip && !sr.err;
        if (emailOk || smsOk) {
            // Stamp ALONE and check the error. This previously shared one UPDATE
            // with nurture_stage -- the exact shape that sent one prospect 40
            // texts on 2026-07-20 (see send-vsl-followup.js). 'vsl_sent' is legal
            // today, which is the only reason this never fired; any constraint
            // edit would have turned it into 288 sends/day per prospect. And
            // unlike that outage this loop carries an EMAIL, which has no
            // guardrail, so it would run unbounded.
            const { error: stampErr } = await sb.from('leads')
                .update({ meeting_confirmation_sent_at: new Date().toISOString() })
                .eq('id', ld.id);
            if (stampErr) {
                console.error('[send-confirmations] STAMP FAILED lead=' + ld.id + ' — halting to avoid a resend loop:', stampErr.message);
                results.push({ id: ld.id, sent: true, stamp_failed: true, detail: stampErr.message });
                continue;
            }
            const { error: stageErr } = await sb.from('leads')
                .update({ nurture_stage: 'vsl_sent' }).eq('id', ld.id);
            if (stageErr) console.error('[send-confirmations] nurture_stage write failed lead=' + ld.id + ':', stageErr.message);
        }

        // Log the email like every other outbound send. Without this the whole
        // confirmation flow was invisible: no row on the lead panel, nothing for
        // vsl-analytics to count, and Resend's bounce/open webhooks had no row to
        // attach to (they match on provider_message_id). The lead stamp above
        // says "we sent something" but can't say what, to whom, or whether it
        // landed. variant='meeting_confirm' is what the confirm funnel counts.
        if (emailOk) {
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'email',
                subject: subject,
                body_preview: 'Confirmation + VSL link for ' + when,
                to_address: email,
                from_address: 'remyleon@stiloaipartners.com',
                provider: 'resend', provider_message_id: er.id || null,
                status: 'sent', variant: 'meeting_confirm',
                // The rep who booked the meeting owns the confirmation, so it lands
                // on their Emailed tab where they can chase an unconfirmed lead.
                sent_by: ld.meeting_booked_by_sdr || null,
                sent_at: new Date().toISOString(),
            });
        }
        // Log the SMS too. Until now only the email got a lead_messages row, so
        // the texts were invisible everywhere: nothing on the lead panel, nothing
        // in the nurture tracker, and no way to answer "has this prospect heard
        // from us?" without reading OpenPhone by hand.
        if (smsOk) {
            await sb.from('lead_messages').insert({
                lead_id: ld.id, direction: 'outbound', channel: 'sms',
                subject: 'Meeting booked, watch the video',
                body_preview: sms.slice(0, 300),
                to_address: phone, from_address: (sr && sr.from) || fromLine,
                provider: 'openphone',
                status: 'sent', variant: 'nurture_sms_1_booked',
                sent_by: ld.meeting_booked_by_sdr || null,
                sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, slug: slug, sent: (emailOk || smsOk), email: er, sms: sr });
    }
    return res.status(200).json({ ok: true, sent: results.length, results: results });
};
