/**
 * Send ONE lead's meeting confirmation (email + SMS), in one place.
 *
 * Two callers, deliberately:
 *   1. book-meeting.js  — inline, the instant the rep books. This is the point:
 *      the rep is still on the phone and can say "check your email now."
 *   2. send-confirmations.js — the 5-minute cron, now purely a SAFETY NET for
 *      anything the inline send missed (transient Gmail/Quo failure, a booking
 *      made before this shipped, a manual backfill).
 *
 * Idempotency is unchanged: meeting_confirmation_sent_at. The cron only picks up
 * leads where it is still NULL, so a successful inline send means the cron never
 * touches that lead. A failed inline send leaves the stamp null and the cron
 * retries within 5 minutes — the failure mode is "slightly late", not "never".
 *
 * WHY NOT JUST SET CONFIRM_DELAY_MIN=0: the cron ticks every 5 minutes, so a
 * zero delay still means the prospect gets the email up to 5 minutes after the
 * call ends, by which time the rep has hung up. Immediate has to mean inline.
 */
const { buildConfirmation } = require('./_confirmation_email');
const { sendTransactional } = require('./_gmail_send');
const { sendSms, guardOutbound } = require('./_sms');
const { firstName: safeFirstName, greet } = require('./_names');

const REMY_LINE = '+17868376639';
const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const REPLY_TO = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

// One-click unsubscribe, same signing scheme as vsl-campaign.js. Gmail's bulk
// sender rules expect this header even on transactional mail, and its absence is
// a scored spam signal. This moved here with the send itself; leaving it behind
// in send-confirmations.js would have silently dropped it from every
// confirmation the moment the send became inline.
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = Buffer.from(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }))
        .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = require('crypto').createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}
function unsubHeaders(email) {
    const t = unsubToken(email);
    if (!t) return undefined;
    return {
        'List-Unsubscribe': '<' + BASE + '/api/unsubscribe?t=' + t + '>, <mailto:' + REPLY_TO + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}

function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }
function fmtWhen(iso) {
    if (!iso) return 'the time we set';
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York'
    }).format(new Date(iso));
}

/**
 * sendConfirmationForLead(sb, pub, lead, opts)
 *   sb   - supabase client on the `prospecting` schema
 *   pub  - supabase client on `public` (for the sdr_users roster)
 *   lead - lead row; needs id, name, address, owner_*, email, phone,
 *          pitch_agent, matched_product_name, meeting_scheduled_at,
 *          meeting_booked_by_sdr, meeting_booked_at,
 *          confirmation_email_subject/body
 *   opts - { dry?, roster? }  roster is passed by the cron so it resolves once
 *          for the whole batch instead of per lead.
 *
 * Returns a result object; never throws.
 */
async function sendConfirmationForLead(sb, pub, ld, opts) {
    opts = opts || {};
    const dry = !!opts.dry;

    let roster = opts.roster;
    if (!roster) {
        roster = {};
        try {
            const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number');
            (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s; });
        } catch (_) { /* fall back to Remy below */ }
    }

    // Resolve the booking rep FIRST: the email signs off with their name and the
    // SMS goes from their own Quo line.
    const rep = roster[String(ld.meeting_booked_by_sdr || '').toLowerCase()] || null;
    const repName = (rep && rep.display_name) || 'Remy';
    const repFirst = firstName(repName);
    const fromLine = (rep && rep.openphone_number) || REMY_LINE;

    // ONE source for this copy: _confirmation_email.js, shared with the booking
    // modal's editable preview.
    const built = buildConfirmation({ lead: ld, repName: repFirst });

    // A rep can edit the email in the booking modal. If they did, send THEIR
    // words. Storing the override and then ignoring it would make the preview a lie.
    const subject = ld.confirmation_email_subject || built.subject;
    const body = ld.confirmation_email_body || built.body;
    const edited = !!(ld.confirmation_email_subject || ld.confirmation_email_body);

    // Email keeps the softer 'Hi there' fallback; the SMS must not use it, so we
    // carry a strict version that is null when the name is untrustworthy.
    const safeFirst = safeFirstName(ld.owner_name, ld.name, ld.address);
    const when = fmtWhen(ld.meeting_scheduled_at);
    const email = ld.owner_email || ld.email || null;
    const phone = ld.owner_phone || ld.phone || null;

    // Step 1 of the nurture SMS sequence. Deliberately carries NO link: it points
    // at the email so the prospect has to open it, which is what puts them on the
    // VSL page where the confirm button lives.
    //
    // The opener is time-aware. Sent inline at booking this is "just now", which
    // is now literally true. The cron also picks up leads booked days earlier (a
    // failed inline send, a manual backfill), and texting "really enjoyed talking
    // just now" about a call from last week is the exact tell we avoid.
    const bookedAgeH = ld.meeting_booked_at
        ? (Date.now() - new Date(ld.meeting_booked_at).getTime()) / 3600000
        : 0;
    const whenWeTalked = bookedAgeH <= 6 ? 'just now' : 'the other day';
    const sms = greet('Hey', safeFirst) + 'this is ' + repFirst + ' from Stilo Partners. Really enjoyed talking ' + whenWeTalked + '. '
        + 'As I mentioned, I just emailed you a short video that explains the implementation we talked about in detail. '
        + 'Give it a watch ASAP, so you can confirm your meeting on that page. The link\'s in your email.';

    if (dry) {
        return { id: ld.id, slug: built.slug, to_email: email, to_phone: phone, when: when, sms_preview: sms, subject: subject, rep_edited: edited, dry: true };
    }

    let er = { skip: 'no_email' }, sr = { skip: 'no_phone' };
    if (email) {
        // Email has no provider-side dedupe. Same backstop the SMS path gets:
        // refuse a repeat subject to the same lead inside 24h. This is also what
        // stops the inline send and the cron both mailing the same prospect if
        // the stamp ever fails to land.
        const eg = await guardOutbound(ld.id, 'email', body, subject);
        if (!eg.ok) {
            console.error('[confirmation] EMAIL BLOCKED lead=' + ld.id + ' reason=' + eg.reason);
            er = { skip: eg.reason, blocked: true };
        } else {
            er = await sendTransactional({ to: email, subject: subject, text: body, replyTo: REPLY_TO, headers: unsubHeaders(email) });
        }
    }
    if (phone) sr = await sendSms(fromLine, phone, sms, { leadId: ld.id });

    const emailOk = er && !er.skip && !er.err;
    const smsOk = sr && !sr.skip && !sr.err;

    // Only mark sent if a channel actually landed, so a total failure retries on
    // the next cron tick rather than being marked done forever.
    if (emailOk || smsOk) {
        // Stamp ALONE and check the error. Sharing this UPDATE with nurture_stage
        // is the exact shape that sent one prospect 40 texts on 2026-07-20.
        const { error: stampErr } = await sb.from('leads')
            .update({ meeting_confirmation_sent_at: new Date().toISOString() })
            .eq('id', ld.id);
        if (stampErr) {
            console.error('[confirmation] STAMP FAILED lead=' + ld.id + ' — halting to avoid a resend loop:', stampErr.message);
            return { id: ld.id, sent: true, stamp_failed: true, detail: stampErr.message };
        }
        const { error: stageErr } = await sb.from('leads')
            .update({ nurture_stage: 'vsl_sent' }).eq('id', ld.id);
        if (stageErr) console.error('[confirmation] nurture_stage write failed lead=' + ld.id + ':', stageErr.message);
    }

    // Log both channels. Without this the confirmation flow is invisible: no row
    // on the lead panel, nothing for vsl-analytics to count, and no row for the
    // bounce/open webhooks to attach to.
    if (emailOk) {
        await sb.from('lead_messages').insert({
            lead_id: ld.id, direction: 'outbound', channel: 'email',
            subject: subject,
            // Store the WORDS, not a description of them. body_preview used to be
            // the only thing written here, and it said "Confirmation + VSL link
            // for Friday" — which meant the lead panel could never show the email
            // the prospect actually read, and the VSL link we sent them was not
            // clickable anywhere in the dashboard.
            body: body,
            body_preview: 'Confirmation + VSL link for ' + when,
            to_address: email,
            from_address: 'remyleon@stiloaipartners.com',
            provider: (er && er.via) || 'resend', provider_message_id: er.id || null,
            status: 'sent', variant: 'meeting_confirm',
            sent_by: ld.meeting_booked_by_sdr || null,
            sent_at: new Date().toISOString(),
        });
    }
    if (smsOk) {
        await sb.from('lead_messages').insert({
            lead_id: ld.id, direction: 'outbound', channel: 'sms',
            subject: 'Meeting booked, watch the video',
            body: sms,
            body_preview: sms.slice(0, 300),
            to_address: phone, from_address: (sr && sr.from) || fromLine,
            provider: 'openphone',
            status: 'sent', variant: 'nurture_sms_1_booked',
            sent_by: ld.meeting_booked_by_sdr || null,
            sent_at: new Date().toISOString(),
        });
    }

    return { id: ld.id, slug: built.slug, sent: (emailOk || smsOk), rep_edited: edited, email: er, sms: sr };
}

module.exports = { sendConfirmationForLead, CONFIRM_LEAD_COLS: [
    'id', 'name', 'address', 'owner_name', 'owner_email', 'email', 'owner_phone', 'phone',
    'pitch_agent', 'matched_product_name', 'meeting_scheduled_at',
    'meeting_booked_by_sdr', 'meeting_booked_at',
    'confirmation_email_subject', 'confirmation_email_body',
].join(',') };
