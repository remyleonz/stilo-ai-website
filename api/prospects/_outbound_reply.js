/**
 * api/prospects/_outbound_reply.js
 *
 * Handles an inbound SMS that belongs to an Outbound campaign target. Called
 * from openphone/webhook.js the moment a reply lands, because the whole point
 * of the campaign is speed to lead and a cron that runs every 5 minutes would
 * burn most of a 4-minute SLA before anyone knew there was a reply.
 *
 * Three things happen, in this order:
 *   1. STOP-word check. An opt-out is terminal: the target goes to 'opted_out'
 *      AND the lead is flagged do_not_call, so it drops out of every dialing
 *      surface too, not just this campaign. Opting out of a text and then
 *      getting a cold call is the complaint that ends an account.
 *   2. Otherwise the target moves to 'replied' and the callback clock starts.
 *   3. An email fires to the assigned rep and to the owner inbox.
 *
 * The alert is idempotent via reply_alert_sent_at, so a webhook redelivery (Quo
 * retries on any non-2xx) cannot spam the same alert repeatedly.
 */

const { createClient } = require('@supabase/supabase-js');

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'remove', 'optout', 'opt out'];

function isStop(text) {
    const t = String(text || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (!t) return false;
    // Only treat a SHORT message as an opt-out. "stop by tomorrow and take a
    // look" is interest, not an unsubscribe, and auto-DNCing it would delete a
    // live lead.
    if (t.split(/\s+/).length > 3) return false;
    return STOP_WORDS.some(w => t === w || t.startsWith(w + ' '));
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendAlert(opts) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    const fromName = process.env.STILO_SENDER_NAME || 'STILO Outbound';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const owner = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

    const to = Array.from(new Set([opts.repEmail, owner].filter(Boolean)));
    const adminUrl = 'https://stiloaipartners.com/admin/?lead=' + opts.leadId;
    const telLink = 'tel:' + String(opts.phone || '').replace(/[^\d+]/g, '');

    const html = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">',
        '<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;font-weight:700">Reply received</p>',
        '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">' + esc(opts.business || 'A lead') + ' just texted back</h1>',
        '<div style="background:#F3F4F6;border-left:3px solid #2563EB;padding:14px 16px;margin:0 0 20px;border-radius:4px">',
        '<p style="margin:0;font-size:16px;line-height:1.5;white-space:pre-wrap">' + esc(opts.replyBody) + '</p>',
        '</div>',
        '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">',
        '<tr><td style="padding:5px 0;color:#6B7280;width:120px">Phone</td><td style="padding:5px 0"><a href="' + telLink + '" style="color:#2563EB;text-decoration:none;font-weight:600">' + esc(opts.phone) + '</a></td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Owner</td><td style="padding:5px 0">' + esc(opts.ownerName || 'unknown') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Industry</td><td style="padding:5px 0">' + esc(opts.niche || '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Assigned to</td><td style="padding:5px 0">' + esc(opts.repName || opts.repEmail || '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">We sent</td><td style="padding:5px 0;color:#6B7280">' + esc(opts.lastSent || '') + '</td></tr>',
        '</table>',
        '<p style="margin:0 0 8px;font-size:15px;font-weight:600">Call them within ' + opts.slaMinutes + ' minutes.</p>',
        '<p style="margin:0 0 20px;font-size:14px;color:#6B7280">Callback due by ' + esc(opts.dueLocal) + '.</p>',
        '<a href="' + adminUrl + '" style="display:inline-block;background:#2563EB;color:#fff;padding:11px 20px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px">Open the lead</a>',
        '</div>',
    ].join('');

    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: to,
            reply_to: owner,
            subject: 'Reply: ' + (opts.business || 'lead') + ' — call within ' + opts.slaMinutes + ' min',
            html: html,
        }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
}

/**
 * @param {string} fromPhone E.164 the reply came FROM (the prospect)
 * @param {string} toPhone   E.164 the reply came TO (our line)
 * @param {string} text      message body
 * @returns {object|null}    null when this reply isn't part of any campaign
 */
async function handleInboundSms(fromPhone, toPhone, text) {
    if (!fromPhone) return null;
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });

    // Match on the number we texted, which is exact, rather than re-deriving the
    // lead from its phone columns. A lead can carry three different numbers and
    // the campaign knows precisely which one it used.
    const { data: targets, error } = await sb.from('outbound_targets')
        .select('*').eq('to_phone', fromPhone)
        .in('stage', ['sent', 'replied', 'queued'])
        .order('id', { ascending: false }).limit(1);
    if (error || !targets || !targets.length) return null;
    const t = targets[0];

    const now = new Date();

    if (isStop(text)) {
        await sb.from('outbound_targets').update({
            stage: 'opted_out', first_reply_at: t.first_reply_at || now.toISOString(),
            first_reply_body: t.first_reply_body || text, updated_at: now.toISOString(),
        }).eq('id', t.id);
        // Terminal across the whole system, not just this campaign.
        await sb.from('leads').update({ do_not_call: true }).eq('id', t.lead_id);
        console.warn('[outbound] OPT-OUT lead=' + t.lead_id + ' phone=' + fromPhone);
        return { action: 'opted_out', lead_id: t.lead_id };
    }

    const { data: campaign } = await sb.from('outbound_campaigns')
        .select('id,name,callback_sla_minutes,timezone').eq('id', t.campaign_id).maybeSingle();
    const sla = (campaign && campaign.callback_sla_minutes) || 4;
    const due = new Date(now.getTime() + sla * 60 * 1000);

    const isFirstReply = !t.first_reply_at;
    const patch = {
        stage: 'replied',
        updated_at: now.toISOString(),
    };
    if (isFirstReply) {
        patch.first_reply_at = now.toISOString();
        patch.first_reply_body = String(text || '').slice(0, 1000);
        patch.callback_due_at = due.toISOString();
    }
    await sb.from('outbound_targets').update(patch).eq('id', t.id);

    // Alert once per target. A second message from the same person before
    // anyone has called back is the same lead, not a new one.
    if (t.reply_alert_sent_at) return { action: 'replied', lead_id: t.lead_id, alerted: false };

    const { data: lead } = await sb.from('leads')
        .select('id,name,owner_name,niche,category').eq('id', t.lead_id).maybeSingle();

    let repName = t.assigned_to;
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data: rep } = await pub.from('sdr_users').select('display_name').eq('email', t.assigned_to).maybeSingle();
        if (rep && rep.display_name) repName = rep.display_name;
    } catch (_) { /* cosmetic only */ }

    const dueLocal = new Intl.DateTimeFormat('en-US', {
        timeZone: (campaign && campaign.timezone) || 'America/New_York',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(due);

    const lastSent = t.step3_sent_at ? t.step3_body : (t.step2_sent_at ? t.step2_body : t.step1_body);

    let alert = { skipped: 'not_attempted' };
    try {
        alert = await sendAlert({
            repEmail: t.assigned_to,
            repName: repName,
            leadId: t.lead_id,
            business: lead && lead.name,
            ownerName: lead && lead.owner_name,
            niche: lead && (lead.niche || lead.category),
            phone: fromPhone,
            replyBody: text,
            lastSent: lastSent,
            slaMinutes: sla,
            dueLocal: dueLocal,
        });
    } catch (e) {
        console.error('[outbound] reply alert failed lead=' + t.lead_id + ': ' + (e && e.message));
    }

    if (alert && !alert.error && alert.status && alert.status < 300) {
        await sb.from('outbound_targets').update({ reply_alert_sent_at: now.toISOString() }).eq('id', t.id);
    }

    return { action: 'replied', lead_id: t.lead_id, alerted: !!(alert && alert.id), callback_due_at: due.toISOString() };
}

module.exports = { handleInboundSms, isStop };
