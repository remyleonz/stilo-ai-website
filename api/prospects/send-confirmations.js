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
const { openphoneFetch, normalizePhone } = require('../openphone/_shared');

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
async function sendSms(from, to, content) {
    if (!to) return { skip: 'no_phone' };
    const r = await openphoneFetch({ method: 'POST', path: '/messages', body: { from: from, to: [normalizePhone(to)], content: content } });
    return { status: r.status, err: (r.status >= 200 && r.status < 300) ? null : JSON.stringify(r.json).slice(0, 160) };
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

    const explicitIds = String((req.query && req.query.lead_ids) || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let q = sb.from('leads')
        .select('id,name,owner_name,owner_email,email,owner_phone,phone,matched_product_name,meeting_scheduled_at,meeting_booked_by_sdr,meeting_booked_at')
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
        const slug = slugFor(ld.matched_product_name);
        const token = signLead(ld.id);
        const link = BASE + '/agents/' + slug + '?lid=' + ld.id + '&t=' + token + '&confirm=1';
        const first = firstName(ld.owner_name);
        const when = fmtWhen(ld.meeting_scheduled_at);
        const email = ld.owner_email || ld.email || null;
        const phone = ld.owner_phone || ld.phone || null;
        const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
        const repName = (rep && rep.display_name) || 'Remy';
        const fromLine = (rep && rep.openphone_number) || REMY_LINE;

        const pixel = BASE + '/api/public/vsl-event?event=email_open&lid=' + ld.id + '&agent=' + slug;
        const html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
            + '<p>Hi ' + esc(first) + ',</p>'
            + '<p>You are on the calendar for <strong>' + esc(when) + '</strong>. Quick thing: tap below to confirm you are still good, and you will see your details and the video link.</p>'
            + '<div style="text-align:center;margin:24px 0"><a href="' + esc(link) + '" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:8px">Confirm my meeting</a></div>'
            + '<p style="color:#374151;font-size:13px">Cannot make it? Just reply and we will find a better time.</p>'
            + '<p>See you then,<br/>Remy<br/>STILO AI Partners</p>'
            + '<img src="' + esc(pixel) + '" width="1" height="1" style="display:none" alt=""/></div>';
        const sms = 'Hi ' + first + ', it\'s ' + repName + ' from STILO. You\'re booked for ' + when + '. Confirm here so we hold your spot: ' + link;

        let er = { skip: 'no_email' }, sr = { skip: 'no_phone' };
        if (email) er = await sendEmail(email, 'You are booked, quick confirm', html);
        if (phone) sr = await sendSms(fromLine, phone, sms);

        // Only mark sent if a channel actually landed. The old code stamped
        // unconditionally, so a lead whose email AND sms both failed was burned
        // forever: the stamp made it invisible to every later run. Leaving it
        // null lets the next 5-min tick retry.
        const emailOk = er && !er.skip && !er.err;
        const smsOk = sr && !sr.skip && !sr.err;
        if (emailOk || smsOk) {
            await sb.from('leads').update({
                meeting_confirmation_sent_at: new Date().toISOString(),
                nurture_stage: 'vsl_sent'
            }).eq('id', ld.id);
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
                subject: 'You are booked, quick confirm',
                body_preview: 'Confirmation + VSL link for ' + when,
                to_address: email,
                from_address: 'remyleon@stiloaipartners.com',
                provider: 'resend', provider_message_id: er.id || null,
                status: 'sent', variant: 'meeting_confirm',
                sent_at: new Date().toISOString(),
            });
        }
        results.push({ id: ld.id, slug: slug, sent: (emailOk || smsOk), email: er, sms: sr });
    }
    return res.status(200).json({ ok: true, sent: results.length, results: results });
};
