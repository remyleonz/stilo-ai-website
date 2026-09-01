/**
 * Shared SMS send for the nurture sequence, with a from-line fallback, plus
 * the shared outbound guardrail used by BOTH the SMS and email senders.
 *
 * Texts go out from the booking rep's own Quo line so the prospect sees a reply
 * from the person who called them. But not every email in public.sdr_users maps
 * to a line that can actually SEND. David's old +17865742922 was an owner line
 * that lived under Remy's Quo seat for attribution only, and OpenPhone rejected
 * it as a from-number with 404 "Phone number not found when getting by number".
 *
 * That specific case is fixed at the source as of 2026-07-28: David moved to a
 * real provisioned line (+17547075311) and 786-574-2922 was retired from the
 * account. The fallback below stays anyway, because the failure it catches is
 * structural, not about one number. Any rep whose sdr_users row drifts from the
 * Quo account hits the same 404, and dropping the message is worse than sending
 * it from a line that works.
 *
 * That surfaced on a real send: HG Accounting's confirmation email went out but
 * the text silently failed, because meeting_booked_by_sdr was David (he rebooked
 * a meeting Luke had originally set). Rather than drop the message, we retry from
 * Remy's line, which is always sendable.
 *
 * Returns { status, err, from, fellBack } so callers can log which line was used.
 */
const { openphoneFetch, normalizePhone } = require('../openphone/_shared');
const { createClient } = require('@supabase/supabase-js');

const REMY_LINE = '+17868376639';

// Safety ceiling. Legitimate nurture is 3 texts and they can legally land in one
// day (book in the morning, watch the VSL, meeting tomorrow). Anything past this
// is a bug, not a campaign.
const MAX_PER_LEAD_24H = 5;

/**
 * Refuse to send when the send looks like a loop rather than a campaign.
 *
 * On 2026-07-20 a rejected nurture_stage value made an idempotency stamp fail,
 * and one prospect got the same text 40 times over three hours before anyone
 * noticed. The per-cron stamp was fixed, but a stamp is a single point of
 * failure: any future cron that fails to record "already sent" recreates the
 * same outage. This is the backstop that makes that class of bug embarrassing
 * instead of catastrophic.
 *
 * Two gates:
 *   1. Identical body to the same lead inside 24h  -> always a bug. Block.
 *   2. More than MAX_SMS_PER_LEAD_24H to one lead  -> runaway. Block.
 *
 * Fails OPEN: if the check itself errors we allow the send, because silently
 * swallowing outbound messages is worse than the thing we are guarding against.
 */
async function guardOutbound(leadId, channel, content, subject) {
    if (!leadId) return { ok: true };
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }, db: { schema: 'prospecting' },
        });
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await sb.from('lead_messages')
            .select('body_preview,subject')
            .eq('lead_id', leadId).eq('channel', channel).eq('direction', 'outbound')
            .gte('sent_at', since).limit(100);
        if (error) return { ok: true };

        const rows = data || [];
        const head = String(content || '').slice(0, 300);
        // For email the body is HTML that can vary on a timestamp, so a subject
        // repeat to the same lead inside 24h is the stronger duplicate signal.
        const dupe = rows.some(function (m) {
            if (channel === 'email' && subject) return m.subject === subject;
            return m.body_preview === head;
        });
        if (dupe) return { ok: false, reason: 'duplicate_' + channel + '_24h' };
        if (rows.length >= MAX_PER_LEAD_24H) {
            return { ok: false, reason: 'rate_cap_24h', count: rows.length };
        }
        return { ok: true };
    } catch (_) {
        return { ok: true };
    }
}
function guardrail(leadId, content) { return guardOutbound(leadId, 'sms', content); }

// OpenPhone's shape for "that from-number is not one you can send from".
function isBadFromLine(r) {
    if (!r || r.status !== 404) return false;
    const body = JSON.stringify(r.json || '');
    return /Phone number not found/i.test(body);
}

async function sendSms(from, to, content, opts) {
    if (!to) return { skip: 'no_phone' };

    const leadId = opts && opts.leadId;
    // Our own people are exempt from every prospect guard. The dedupe and
    // 24h cap exist to protect prospects from us; an SDR's personal cell or a
    // rep's Quo line is not a prospect, and rep-facing alerts routed through
    // here (reminders, internal notifications) must never be starved by lead
    // machinery. See _team_numbers.js.
    const { isTeamNumber } = require('./_team_numbers');
    const internal = await isTeamNumber(to);
    const guard = internal ? { ok: true, waived: 'team_number' } : await guardrail(leadId, content);
    if (!guard.ok) {
        console.error('[sms] BLOCKED lead=' + leadId + ' reason=' + guard.reason + (guard.count ? ' count=' + guard.count : ''));
        return { skip: guard.reason, blocked: true };
    }

    const target = normalizePhone(to);

    let r = await openphoneFetch({ method: 'POST', path: '/messages', body: { from: from, to: [target], content: content } });
    let usedFrom = from;
    let fellBack = false;

    if (isBadFromLine(r) && from !== REMY_LINE) {
        r = await openphoneFetch({ method: 'POST', path: '/messages', body: { from: REMY_LINE, to: [target], content: content } });
        usedFrom = REMY_LINE;
        fellBack = true;
    }

    const ok = r.status >= 200 && r.status < 300;
    return {
        status: r.status,
        err: ok ? null : JSON.stringify(r.json).slice(0, 160),
        from: usedFrom,
        fellBack: fellBack,
        // OpenPhone returns the created message on the POST. Callers (send-sms.js)
        // already read r.messageId and have been getting undefined since this
        // helper was written, which left provider_message_id null on every
        // at-send row. That in turn disabled the webhook's cleanest dedupe check
        // ("have I already seen this provider id?") and was half the reason every
        // outbound text was being logged twice. Shape is { data: { id } }; the
        // fallbacks cover older/plainer response bodies.
        messageId: (r.json && ((r.json.data && r.json.data.id) || r.json.id)) || null,
        to: target,
    };
}

/**
 * The one key that identifies an outbound SMS from BOTH sides of the race.
 *
 * The at-send insert and the OpenPhone webhook both want to record the same
 * text, and either can land first. A read-then-check loses that race, and it
 * did: on lead 31737 the webhook wrote at 18:15:25 and the send path wrote a
 * duplicate at 18:15:26. Both sides now compute this key and write it, and the
 * unique index lead_messages_dedupe_key_uidx makes the loser collide instead of
 * inserting a second row.
 *
 * Phone is normalized before hashing, because the send path historically held
 * "(305) 927-3195" while the webhook held "+13059273195" and any key built on
 * the raw value would differ on the two sides for the same message.
 */
function smsDedupeKey(leadId, toPhone, body) {
    const crypto = require('crypto');
    return crypto.createHash('sha1')
        .update([leadId || 0, 'sms', normalizePhone(toPhone) || '', String(body || '').slice(0, 300)].join('|'))
        .digest('hex');
}

module.exports = { sendSms, guardOutbound, smsDedupeKey, REMY_LINE, MAX_PER_LEAD_24H };
