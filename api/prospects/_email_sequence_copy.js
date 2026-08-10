/**
 * api/prospects/_email_sequence_copy.js
 *
 * Copy for the 4-step prospecting email sequence (see email-sequence.js).
 *
 * FINAL COPY, transplanted from Strategy/email-sequence-system-2026-08-10.md
 * (5 niches x 4 steps). Do not rewrite the copy here; edit the strategy doc
 * first, then re-transplant.
 *
 * Shape:  { <niche-slug>: { step1..step4: { subject, body } } }
 * Slugs MUST match _vsl.js AGENTS (the 5 niche pages). A lead whose niche
 * cannot resolve to one of these is never mailed.
 *
 * Merge slots available in subject and body:
 *   {{first_name}}   owner first name. The renderer collapses the greeting to
 *                    "Hi," and strips "{{first_name}}, " from subjects when no
 *                    safe name exists, so copy can use it freely.
 *   {{company}}      cleaned business name (falls back to "your company")
 *   {{city}}         city parsed from the lead's address (falls back to "your area")
 *   Any key from NICHE_SLOTS below (per-niche language). Currently:
 *     {{hook_line}}  one per-niche observation sentence used in step 1. The
 *                    strategy doc wanted this per-lead (deep_research_json);
 *                    the engine merges per-niche only, so these are static
 *                    niche-voice lines until the engine grows a per-lead tier.
 *     {{vsl_link}}   the niche VSL page. Static per-niche URL; the ?lid=
 *                    attribution token needs per-lead rendering the engine
 *                    does not do yet.
 *
 * Rules for whoever edits copy:
 *   - Plain text only. No HTML, no links to anything but our own pages.
 *   - No em dashes anywhere.
 *   - An unknown {{slot}} makes the engine SKIP that lead rather than send a
 *     broken merge, so only use slots that exist in NICHE_SLOTS or the 3 above.
 *   - NICHE_SLOTS values must be non-empty strings: the renderer skips empty
 *     values, which leaves the slot unresolved and skips the lead.
 *   - Steps 1 and 4 carry no links. Step 4 has no question mark; its CTA is
 *     the literal line starting `Reply "call"`.
 *   - Seasonal lines (storm season, RFP season, August/October references)
 *     rotate with the calendar; see the strategy doc's markers.
 */

const VSL_BASE = 'https://stiloaipartners.com/vsl/';

// Per-niche language the copy references by key ({{hook_line}}, {{vsl_link}}).
const NICHE_SLOTS = {
    'commercial-cleaning': {
        hook_line: 'The owners who have been through it tell me a lost building takes the better part of a year to replace on referrals alone.',
        vsl_link: VSL_BASE + 'commercial-cleaning',
    },
    'commercial-roofing': {
        hook_line: 'The shops that stay busy year round decided on purpose not to wait on the storm map.',
        vsl_link: VSL_BASE + 'commercial-roofing',
    },
    'staffing': {
        hook_line: 'Usually the recruiters are not the problem, the order book is.',
        vsl_link: VSL_BASE + 'staffing',
    },
    'freight': {
        hook_line: 'Most owners I ask can name the exact week spot rates turned a good month into a wash.',
        vsl_link: VSL_BASE + 'freight',
    },
    'industrial-supplies': {
        hook_line: 'The suppliers growing right now treat new-account work like a standing job, not a rainy-day project.',
        vsl_link: VSL_BASE + 'industrial-supplies',
    },
};

const SIG = ['Remy Leon', 'Miami'];

function body(lines) {
    return lines.concat(['']).concat(SIG).join('\n');
}

const COPY = {

    // ------------------------------------------------------------------ STAFFING
    'staffing': {
        step1: {
            subject: 'open orders at {{company}}',
            body: body([
                'Hi {{first_name}},',
                '',
                "Most staffing firms I talk to have the same math problem: plenty of candidates, not enough client orders to run them against. The fill rate looks fine until you notice it's the same six accounts you've had for years, and one of them just took hiring in-house.",
                '',
                '{{hook_line}}',
                '',
                'Are you actively taking on new client accounts right now, or pretty much at capacity?',
            ]),
        },
        step2: {
            subject: 'how staffing firms add logos',
            body: body([
                'Hi {{first_name}},',
                '',
                "Following up on my note from the other day. The firms growing this year aren't winning on sourcing, they're winning on new client logos. One account with steady orders beats any candidate database.",
                '',
                "That's the part we handle. We book sales meetings for staffing agencies with hiring managers who have open reqs and a budget. You run the pitch. Every meeting comes with notes on headcount, timeline, and who you're talking to.",
                '',
                'Three minutes on how it works: {{vsl_link}}',
                '',
                'Worth a look?',
            ]),
        },
        step3: {
            subject: 'the math on one account',
            body: body([
                'Hi {{first_name}},',
                '',
                'You know your numbers better than I do, so run it yourself: take your average markup on one placed contractor, times the hours, times a year. Then multiply by what a steady account actually orders. That is what one held meeting with the right hiring manager is worth.',
                '',
                "We book those meetings, you close them. Setup takes a couple weeks, and if month one doesn't earn its keep, you walk.",
                '',
                'Got 15 minutes Thursday or Friday?',
            ]),
        },
        step4: {
            subject: 'closing your file',
            body: body([
                'Hi {{first_name}},',
                '',
                "Last note from me. If new client accounts aren't the priority this quarter, no hard feelings, I'll get out of your inbox.",
                '',
                "But if your recruiters are sitting on candidates they can't place because the orders aren't there, that's fixable. Reply \"call\" and I'll ring you this week.",
                '',
                'Either way, good luck this quarter.',
            ]),
        },
    },

    // -------------------------------------------------------- COMMERCIAL CLEANING
    'commercial-cleaning': {
        step1: {
            subject: 'bid lists in {{city}}',
            body: body([
                'Hi {{first_name}},',
                '',
                "Most commercial cleaning companies around {{city}} win work one of two ways: referrals, or grinding through property managers' bid lists against guys who price at cost. And when a contract churns out, the replacement rarely shows up on its own.",
                '',
                '{{hook_line}}',
                '',
                'When you lose an account, where does the next one usually come from?',
            ]),
        },
        step2: {
            subject: 'before it goes to bid',
            body: body([
                'Hi {{first_name}},',
                '',
                "Quick follow-up. The cleaning companies growing right now aren't cleaning better than you. They're in the room with the facility manager before the contract ever hits a bid list, while it's still a conversation instead of a price war.",
                '',
                "That's what we do. We book meetings for janitorial companies with property and facility managers who are unhappy with their current vendor or have new space coming online. You do the walkthrough and the close.",
                '',
                'Three minutes on how it works: {{vsl_link}}',
                '',
                'Worth a look?',
            ]),
        },
        step3: {
            subject: 'one walkthrough',
            body: body([
                'Hi {{first_name}},',
                '',
                "Run your own math on this. One mid-size office contract, at your normal monthly rate, over a two-year term. That's what a single walkthrough with the right facility manager is worth, and it's why grinding bid lists for thin margins is the expensive way to grow.",
                '',
                "We book the walkthrough meetings. You close them. Setup takes a couple weeks, and if month one doesn't pay for itself, you cancel.",
                '',
                'Free for 15 minutes Thursday afternoon?',
            ]),
        },
        step4: {
            subject: 'last one from me',
            body: body([
                'Hi {{first_name}},',
                '',
                "Last one from me. If the account list is full and the night crews are staffed, ignore this and I'll get out of your inbox.",
                '',
                "But if you lost a building this year and haven't replaced it yet, that's the exact gap we fill. Reply \"call\" and I'll ring you this week.",
                '',
                'Good luck either way.',
            ]),
        },
    },

    // --------------------------------------------------------- COMMERCIAL ROOFING
    'commercial-roofing': {
        step1: {
            // Seasonal: "every August" and "past October" rotate with the calendar.
            subject: 'after storm season',
            body: body([
                'Hi {{first_name}},',
                '',
                "Commercial roofers tell me the same thing every August: storm work finds you, it's the shoulder months that decide the year. And waiting on two or three GCs to send bid invites isn't a pipeline, it's a favor economy.",
                '',
                '{{hook_line}}',
                '',
                'Is your calendar set past October, or still filling in?',
            ]),
        },
        step2: {
            subject: 'before the roof leaks',
            body: body([
                'Hi {{first_name}},',
                '',
                'Following up. The roofing companies growing right now get in front of building owners and property managers before the roof fails, not after the claim. By the time it leaks, three other bids are already in.',
                '',
                'We book those meetings. Property managers and owners with aging roofs in your area, sat down with you for an inspection conversation. You quote it, you close it.',
                '',
                'Three minutes on how it works: {{vsl_link}}',
                '',
                'Worth a look?',
            ]),
        },
        step3: {
            subject: 'one re-roof',
            body: body([
                'Hi {{first_name}},',
                '',
                "You know your average re-roof ticket better than I do. Take that number and ask what a steady flow of owner meetings is worth next to waiting on GC bid invites you're pricing against four other shops.",
                '',
                "We book the meetings, complete with notes on the building, the decision maker, and the timeline. Setup takes a couple weeks. If month one doesn't earn its spot, you cancel.",
                '',
                'Got 15 minutes Thursday?',
            ]),
        },
        step4: {
            // Seasonal: "past storm season".
            subject: 'taking you off my list',
            body: body([
                'Hi {{first_name}},',
                '',
                'Last note from me. If the crews are booked through winter, ignore this, and hats off.',
                '',
                "But if the schedule past storm season looks thin and the GC phone isn't ringing, that's the gap we fill. Reply \"call\" and I'll ring you this week.",
                '',
                'Good luck out there.',
            ]),
        },
    },

    // ------------------------------------------------------------------- FREIGHT
    'freight': {
        step1: {
            subject: 'direct freight in your lanes',
            body: body([
                'Hi {{first_name}},',
                '',
                "Most carriers I talk to are running the same lanes at whatever the boards pay, with direct shipper business down to a handful of accounts. Load boards pay the bills. Direct freight pays the profit, and it doesn't show up by itself.",
                '',
                '{{hook_line}}',
                '',
                'Are you actively adding direct shippers right now, or mostly living on the boards?',
            ]),
        },
        step2: {
            subject: 'how carriers get off the boards',
            body: body([
                'Hi {{first_name}},',
                '',
                "Quick follow-up. Shippers don't take cold calls from carriers, but they do take meetings when there's a real reason: capacity in a lane they struggle to cover, or a backhaul you're already running empty.",
                '',
                'Finding those shippers and getting the meeting booked is what we do. You show up, talk lanes and rates, and every meeting comes with notes on their freight and who signs off.',
                '',
                'Three minutes on how it works: {{vsl_link}}',
                '',
                'Worth a look?',
            ]),
        },
        step3: {
            // Seasonal: "RFP season".
            subject: 'one dedicated lane',
            body: body([
                'Hi {{first_name}},',
                '',
                'Run the math on your side. One dedicated lane at contract rates versus the same miles at spot. Over a year, that spread is usually the difference between a good year and a rough one, and it comes down to a handful of shipper relationships.',
                '',
                "We book the shipper meetings, including RFP-season intros. You negotiate the freight. If month one doesn't earn its keep, you cancel.",
                '',
                'Got 15 minutes Thursday or Friday?',
            ]),
        },
        step4: {
            // Seasonal: "before RFP season".
            subject: 'last note',
            body: body([
                'Hi {{first_name}},',
                '',
                'Last one from me. If the trucks are covered on contract freight, delete this and keep rolling.',
                '',
                "But if you're watching spot rates decide your month and want more direct shipper business before RFP season, that's the gap we fill. Reply \"call\" and I'll ring you this week.",
                '',
                'Safe travels.',
            ]),
        },
    },

    // -------------------------------------------------------- INDUSTRIAL SUPPLIES
    'industrial-supplies': {
        step1: {
            subject: 'new POs at {{company}}',
            body: body([
                'Hi {{first_name}},',
                '',
                "Most industrial suppliers I talk to live off house accounts. The repeat POs keep the lights on, but when a buyer retires or a plant changes hands, that revenue walks out with them, and nobody's working on the replacement.",
                '',
                '{{hook_line}}',
                '',
                "When's the last time a brand-new account sent you a PO?",
            ]),
        },
        step2: {
            subject: 'why buyers switch suppliers',
            body: body([
                'Hi {{first_name}},',
                '',
                'Following up. MRO buyers almost never switch suppliers over price. They switch when the incumbent misses a quote deadline, ships wrong, or stops answering. The hard part is being in front of that buyer the week it happens.',
                '',
                "That's our job. We book meetings for suppliers with purchasing managers who are actively looking for a second source, so new business isn't waiting on walk-ins.",
                '',
                'Three minutes on how it works: {{vsl_link}}',
                '',
                'Worth a look?',
            ]),
        },
        step3: {
            subject: 'the math on one PO',
            body: body([
                'Hi {{first_name}},',
                '',
                "You know what a real account orders in a year better than I do. Take one steady customer's annual POs and put that next to the cost of winning them: usually one meeting, one fast quote, one clean first delivery.",
                '',
                "We book that first meeting with buyers who have live demand. You quote it and take it from there. If month one doesn't pay for itself, you cancel.",
                '',
                'Got 15 minutes Thursday?',
            ]),
        },
        step4: {
            subject: 'wrapping up',
            body: body([
                'Hi {{first_name}},',
                '',
                'Last note from me. If the house accounts are healthy and the quote queue is full, ignore this.',
                '',
                'But if this year\'s growth plan is "hope the phone rings," it\'s worth 15 minutes. Reply "call" and I\'ll ring you this week.',
                '',
                'Either way, good luck with the season.',
            ]),
        },
    },
};

module.exports = { COPY, NICHE_SLOTS };
