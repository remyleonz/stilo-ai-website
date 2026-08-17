/**
 * api/prospects/_missed_call_alert.js
 *
 * Emails when a prospect calls US and nobody picks up. Called from
 * openphone/webhook.js on the call path.
 *
 * This did not exist before 2026-08-17. Reply-to-a-text raised an email; a
 * prospect actually dialing our number raised nothing at all. Neville Walters
 * (lead 17339) called at 7:59pm on 2026-08-16 after re-opening the VSL six
 * times, and the only record was a lead_calls row nobody looked at until the
 * next morning. An inbound call is a stronger buying signal than any text we
 * send, so it is the one event that should always reach a phone.
 *
 * Fires on any inbound call we did not answer: missed_inbound, voicemail, or
 * no_answer. Voicemail matters because deriveOutcome() in the webhook checks
 * the voicemail flag BEFORE the missed-inbound branch, so an inbound call that
 * rolls to voicemail is classified 'voicemail' and would never match a
 * missed_inbound-only gate. That ordering is exactly how Neville's call would
 * have slipped through a narrower version of this.
 *
 * Idempotent on prospecting.lead_calls.alert_sent_at. One call produces several
 * webhook events (call.completed, then transcript, then summary), and each one
 * re-runs this path.
 */

const { createClient } = require('@supabase/supabase-js');

// Inbound outcomes that mean a human tried to reach us and did not get through.
const UNANSWERED_INBOUND = new Set(['missed_inbound', 'voicemail', 'no_answer']);

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
            minute: '2-digit', timeZoneName: 'short',
        }).format(new Date(iso));
    } catch (_) { return String(iso || ''); }
}

/**
 * @param {object} sb    supabase client already bound to the `prospecting` schema
 * @param {object} opts  { callId, leadId, phone, outcome, calledAt, repEmail,
 *                         transcript, summary }
 * @returns {object|null} null when this is not an unanswered inbound call
 */
async function alertMissedInbound(sb, opts) {
    if (!opts || !UNANSWERED_INBOUND.has(opts.outcome)) return null;
    if (!opts.callId) return null;

    // Idempotency read first: cheaper than composing an email we then discard,
    // and this path runs on every event for the same call.
    const { data: existing, error: readErr } = await sb.from('lead_calls')
        .select('id, alert_sent_at').eq('openphone_call_id', opts.callId).maybeSingle();
    if (readErr) {
        console.error('[missed-call] idempotency read failed: ' + readErr.message);
        return { skipped: 'read_failed' };
    }
    if (existing && existing.alert_sent_at) return { skipped: 'already_alerted' };

    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };

    let lead = null;
    if (opts.leadId) {
        const { data } = await sb.from('leads')
            .select('id,name,owner_name,niche,category,stage,assigned_to')
            .eq('id', opts.leadId).maybeSingle();
        lead = data || null;
    }

    const owner = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';
    const alertInbox = process.env.HEALTH_ALERT_TO || 'remyleon11@gmail.com';
    const to = Array.from(new Set(
        [opts.repEmail || (lead && lead.assigned_to), owner, alertInbox]
            .map(function (e) { return String(e || '').toLowerCase().trim(); })
            .filter(function (e) { return e && /.+@.+\..+/.test(e); })
    ));

    const business = (lead && lead.name) || 'Unknown number';
    const telLink = 'tel:' + String(opts.phone || '').replace(/[^\d+]/g, '');
    const adminUrl = lead
        ? 'https://stiloaipartners.com/admin/?lead=' + lead.id
        : 'https://stiloaipartners.com/admin/';

    // A voicemail transcript is the single most useful thing in this email, so
    // it goes above the fold rather than behind a click into the dashboard.
    const vm = String(opts.transcript || opts.summary || '').trim().slice(0, 900);

    const rows = [
        ['Phone', '<a href="' + telLink + '" style="color:#2563EB;text-decoration:none;font-weight:600">' + esc(opts.phone) + '</a>'],
        ['Owner', esc((lead && lead.owner_name) || 'unknown')],
        ['Industry', esc((lead && (lead.niche || lead.category)) || '')],
        ['Stage', esc((lead && lead.stage) || '')],
        ['Came in', esc(fmtTime(opts.calledAt))],
    ].map(function (r) {
        return '<tr><td style="padding:5px 0;color:#6B7280;width:120px">' + r[0]
            + '</td><td style="padding:5px 0">' + r[1] + '</td></tr>';
    }).join('');

    const label = opts.outcome === 'voicemail' ? 'Left a voicemail' : 'Missed call';

    const html = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">',
        '<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;font-weight:700">' + label + '</p>',
        '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">' + esc(business) + ' called you</h1>',
        vm ? '<div style="background:#F3F4F6;border-left:3px solid #2563EB;padding:14px 16px;margin:0 0 20px;border-radius:4px">'
            + '<p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6B7280">What they said</p>'
            + '<p style="margin:0;font-size:15px;line-height:1.5;white-space:pre-wrap">' + esc(vm) + '</p></div>' : '',
        '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">' + rows + '</table>',
        '<p style="margin:0 0 20px;font-size:15px;font-weight:600">They dialed you. Call them back today.</p>',
        '<a href="' + telLink + '" style="display:inline-block;background:#2563EB;color:#fff;padding:11px 20px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px;margin-right:8px">Call back</a>',
        '<a href="' + adminUrl + '" style="display:inline-block;background:#fff;color:#2563EB;border:1px solid #2563EB;padding:10px 19px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px">Open the lead</a>',
        '</div>',
    ].join('');

    let sent = null;
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: (process.env.STILO_SENDER_NAME || 'STILO Outbound')
                    + ' <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>',
                to: to,
                reply_to: owner,
                subject: (opts.outcome === 'voicemail' ? 'Voicemail: ' : 'Missed call: ') + business,
                html: html,
            }),
        });
        const j = await r.json().catch(function () { return {}; });
        sent = { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
    } catch (e) {
        console.error('[missed-call] send threw: ' + (e && e.message));
        return { skipped: 'send_threw' };
    }

    if (sent && !sent.error && sent.status < 300) {
        // Stamp only on a confirmed send. A failed send that stamps anyway is a
        // silently swallowed inbound call, which is the whole bug being fixed.
        await sb.from('lead_calls')
            .update({ alert_sent_at: new Date().toISOString() })
            .eq('openphone_call_id', opts.callId);
    }
    return sent;
}

module.exports = { alertMissedInbound, UNANSWERED_INBOUND };
