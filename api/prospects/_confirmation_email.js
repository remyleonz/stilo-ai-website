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
const { firstName: canonicalFirstName } = require('./_names');
const { langForLead, t } = require('./_lang');
function slugFor(name) {
    return agentKey(name);   // null when the niche cannot be determined
}

// Delegates to _names.js, the canonical rule. Taking word one of owner_name
// was sending "Hi ask," and "Hi N/A," to prospects who had just booked a
// meeting, because owner_name is only ~70% real names and the rest is
// placeholder text ("ask for owner", "verify on call"). Keeps the 'there'
// fallback so every caller still gets a usable greeting.
function firstName(n, business, address) { return canonicalFirstName(n, business, address) || 'there'; }

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
// `lang` defaults to English so the older callers that pass only a date keep
// working unchanged. buildConfirmation always passes the lead's language.
function buildSubject(whenIso, lang) {
    return t(lang || 'en', 'confirmSubject', { whenIso: whenIso });
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
    const first = firstName(ld.owner_name, ld.name, ld.address);
    const repName = opts.repName || 'Remy';
    const to = ld.owner_email || ld.email || null;

    // Their NICHE demo, with the confirm flow on. The 6-minute video is what
    // makes them want the meeting; asking them to confirm on a page that only
    // talks about pricing gave them no reason to show up (65% show rate).
    const link = confirmUrlFor(opts.agent ? { niche: opts.agent } : ld, ld.id);

    // A Spanish-speaking owner who cannot read this email cannot confirm and
    // cannot watch the video. See _lang.js for the incident that prompted this.
    const lang = langForLead(ld);
    const body = t(lang, 'confirmBody', {
        first: first, whenIso: whenIso, biz: ld.name || (lang === 'es' ? 'el suyo' : 'yours'),
        link: link, rep: repName,
    });

    return {
        subject: buildSubject(whenIso, lang), body: body,
        slug: slug, link: link, to: to, lang: lang,
    };
}

module.exports = { buildConfirmation, buildSubject, slugFor, firstName, fmtWhen };
