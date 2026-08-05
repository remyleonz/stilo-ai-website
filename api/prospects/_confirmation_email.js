/**
 * The confirmation email copy, in ONE place.
 *
 * Both the cron that actually sends it (send-confirmations.js) and the preview
 * the rep edits in the booking modal (confirmation-preview.js) call this. If the
 * preview were built from its own copy of the wording, the rep would approve one
 * email and the prospect would receive another, which is worse than having no
 * preview at all.
 *
 * PLAIN TEXT ONLY. No HTML part, no tracking pixel, no button. See
 * send-confirmations.js for the full reasoning; short version is that every one
 * of those is a Promotions/spam signal and this email put a real prospect's
 * confirmation in the spam folder on 2026-07-20.
 */
const { signLead } = require('../public/_token');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');

// 2026-08 pivot: the confirmation email no longer links to a per-agent page. A
// booked prospect goes to /vsl/confirmation, which is the same for everyone:
// who Remy is, how we charge, and what happens on the call. Their NICHE video was
// the first touch, before they booked. slugFor is kept only so the older callers
// that still ask for a slug keep resolving; it now returns a niche via _vsl.js.
const { agentKey, confirmUrlFor } = require('./_vsl');
function slugFor(name) {
    return agentKey(name);   // null when the niche cannot be determined
}

function firstName(n) { return (n || '').trim().split(/\s+/)[0] || 'there'; }

function fmtWhen(iso) {
    if (!iso) return 'the time we set';
    return new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York'
    }).format(new Date(iso));
}

// Subject carries the meeting date. Two reasons: it reads better in a crowded
// inbox, and it makes a REBOOKING a genuinely different subject. The 24h
// duplicate guard keys on subject, so a fixed string made a legitimate second
// meeting look like a resend loop and silently suppressed it.
function buildSubject(whenIso) {
    if (!whenIso) return 'You are booked, quick confirm';
    return 'You are booked, quick confirm for ' + new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York'
    }).format(new Date(whenIso));
}

/**
 * buildConfirmation({ lead, agent?, whenIso?, repName? })
 *   -> { subject, body, slug, link, to }
 *
 * `agent` overrides the lead's stored pitch_agent, so the booking modal can
 * preview what a DIFFERENT agent selection would send before it is saved.
 */
function buildConfirmation(opts) {
    const ld = (opts && opts.lead) || {};
    // The rep's live dropdown choice beats the lead's stored niche. Used only to
    // report which niche was resolved; the confirmation link itself is shared.
    const slug = slugFor(opts.agent || ld.niche || ld.category);
    const whenIso = opts.whenIso || ld.meeting_scheduled_at || null;
    const first = firstName(ld.owner_name);
    const when = fmtWhen(whenIso);
    const repName = opts.repName || 'Remy';
    const to = ld.owner_email || ld.email || null;

    // Their NICHE demo, with the confirm flow on. The 6-minute video is what
    // makes them want the meeting; asking them to confirm on a page that only
    // talks about pricing gave them no reason to show up (65% show rate).
    const link = confirmUrlFor(opts.agent ? { niche: opts.agent } : ld, ld.id);

    const body = [
        'Hi ' + first + ',',
        '',
        'You are on the calendar for ' + when + '.',
        '',
        'Confirm you are still good here. Same page has a short walkthrough of exactly how we '
            + 'fill a calendar for a business like ' + (ld.name || 'yours') + ', so you can see what '
            + 'we will actually be talking about:',
        link,
        '',
        'Cannot make it? Just reply and we will find a better time.',
        '',
        'See you then,',
        repName,
        'STILO AI Partners',
    ].join('\n');

    return { subject: buildSubject(whenIso), body: body, slug: slug, link: link, to: to };
}

module.exports = { buildConfirmation, buildSubject, slugFor, firstName, fmtWhen };
