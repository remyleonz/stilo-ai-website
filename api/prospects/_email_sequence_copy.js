/**
 * api/prospects/_email_sequence_copy.js
 *
 * Copy for the 4-step prospecting email sequence (see email-sequence.js).
 *
 * =============================================================================
 * PLACEHOLDER COPY. Every subject and body in this file is a stand-in written
 * to prove the merge plumbing works. The strategist's final copy replaces the
 * strings below, same shape, and nothing else in the engine changes.
 * =============================================================================
 *
 * Shape:  { <niche-slug>: { step1..step4: { subject, body } } }
 * Slugs MUST match _vsl.js AGENTS (the 5 niche pages). A lead whose niche
 * cannot resolve to one of these is never mailed.
 *
 * Merge slots available in subject and body:
 *   {{first_name}}   owner first name. The renderer collapses the greeting to
 *                    "Hi," and strips "{{first_name}}, " from subjects when no
 *                    safe name exists, so copy can use it freely.
 *   {{company}}      cleaned business name
 *   {{city}}         city parsed from the lead's address
 *   {{niche_*}}      any key from NICHE_SLOTS below (per-niche language)
 *
 * Rules for whoever drops in final copy:
 *   - Plain text only. No HTML, no links to anything but our own pages.
 *   - No em dashes anywhere.
 *   - An unknown {{slot}} makes the engine SKIP that lead rather than send a
 *     broken merge, so only use slots that exist in NICHE_SLOTS or the 3 above.
 */

// Per-niche language the copy can reference as {{niche_service}} etc.
const NICHE_SLOTS = {
    'commercial-cleaning': {
        niche_service: 'commercial cleaning',
        niche_buyer: 'facility managers',
        niche_work: 'recurring contracts',
    },
    'commercial-roofing': {
        niche_service: 'commercial roofing',
        niche_buyer: 'building owners',
        niche_work: 'reroof and repair jobs',
    },
    'staffing': {
        niche_service: 'staffing',
        niche_buyer: 'hiring managers',
        niche_work: 'open orders',
    },
    'freight': {
        niche_service: 'freight',
        niche_buyer: 'shippers',
        niche_work: 'lanes',
    },
    'industrial-supplies': {
        niche_service: 'industrial supplies',
        niche_buyer: 'purchasing managers',
        niche_work: 'accounts',
    },
};

// PLACEHOLDER: one generic 4-step skeleton stamped per niche. The strategist
// replaces these with real per-niche copy.
function placeholderSteps() {
    return {
        step1: {
            subject: '{{first_name}}, quick question about {{company}}',
            body: [
                'Hi {{first_name}},',
                '',
                'PLACEHOLDER. I work with {{niche_service}} companies in {{city}} on getting in front of {{niche_buyer}}. Wanted to ask how {{company}} is finding new {{niche_work}} right now.',
                '',
                'Worth a short conversation?',
                '',
                'Remy Leon',
                'STILO AI Partners',
            ].join('\n'),
        },
        step2: {
            subject: 'Re: {{company}}',
            body: [
                'Hi {{first_name}},',
                '',
                'PLACEHOLDER follow-up. Most {{niche_service}} owners we talk to in {{city}} say new {{niche_work}} come almost entirely from referrals. If that sounds like {{company}}, I have a specific idea for you.',
                '',
                'Open to hearing it?',
                '',
                'Remy Leon',
                'STILO AI Partners',
            ].join('\n'),
        },
        step3: {
            subject: 'One idea for {{company}}',
            body: [
                'Hi {{first_name}},',
                '',
                'PLACEHOLDER value note. Short version: we book qualified meetings with {{niche_buyer}} for {{niche_service}} companies, and we only get paid on meetings that actually hold.',
                '',
                'If {{company}} could take on more {{niche_work}}, reply and I will send over how it works.',
                '',
                'Remy Leon',
                'STILO AI Partners',
            ].join('\n'),
        },
        step4: {
            subject: 'Closing the loop, {{first_name}}',
            body: [
                'Hi {{first_name}},',
                '',
                'PLACEHOLDER breakup. I will stop emailing after this one. If more {{niche_work}} ever becomes a priority for {{company}}, my door is open.',
                '',
                'Either way, good luck out there.',
                '',
                'Remy Leon',
                'STILO AI Partners',
            ].join('\n'),
        },
    };
}

const COPY = {};
for (const slug of Object.keys(NICHE_SLOTS)) COPY[slug] = placeholderSteps();

module.exports = { COPY, NICHE_SLOTS };
