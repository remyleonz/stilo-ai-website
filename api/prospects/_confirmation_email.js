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

// ai-seo and ontology were retired 2026-07-15 (redirected in vercel.json).
// Anything that used to route there falls through to receptionist rather than
// mailing a prospect a link that bounces them to the homepage.
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
    // Explicit agent (the rep's live dropdown choice) beats the stored value.
    const slug = slugFor(opts.agent || ld.pitch_agent || ld.matched_product_name);
    const whenIso = opts.whenIso || ld.meeting_scheduled_at || null;
    const first = firstName(ld.owner_name);
    const when = fmtWhen(whenIso);
    const repName = opts.repName || 'Remy';
    const to = ld.owner_email || ld.email || null;

    const link = BASE + '/agents/' + slug + '?lid=' + ld.id + '&t=' + signLead(ld.id) + '&confirm=1';

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

    return { subject: buildSubject(whenIso), body: body, slug: slug, link: link, to: to };
}

module.exports = { buildConfirmation, buildSubject, slugFor, firstName, fmtWhen };
