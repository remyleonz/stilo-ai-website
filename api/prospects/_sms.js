/**
 * Shared SMS send for the nurture sequence, with a from-line fallback.
 *
 * Texts go out from the booking rep's own Quo line so the prospect sees a reply
 * from the person who called them. But not every email in public.sdr_users maps
 * to a line that can actually SEND. David's +17865742922 is an owner line that
 * lives under Remy's Quo seat for attribution only, and OpenPhone rejects it as
 * a from-number with 404 "Phone number not found when getting by number".
 *
 * That surfaced on a real send: HG Accounting's confirmation email went out but
 * the text silently failed, because meeting_booked_by_sdr was David (he rebooked
 * a meeting Luke had originally set). Rather than drop the message, we retry from
 * Remy's line, which is always sendable.
 *
 * Returns { status, err, from, fellBack } so callers can log which line was used.
 */
const { openphoneFetch, normalizePhone } = require('../openphone/_shared');

const REMY_LINE = '+17868376639';

// OpenPhone's shape for "that from-number is not one you can send from".
function isBadFromLine(r) {
    if (!r || r.status !== 404) return false;
    const body = JSON.stringify(r.json || '');
    return /Phone number not found/i.test(body);
}

async function sendSms(from, to, content) {
    if (!to) return { skip: 'no_phone' };
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
    };
}

module.exports = { sendSms, REMY_LINE };
