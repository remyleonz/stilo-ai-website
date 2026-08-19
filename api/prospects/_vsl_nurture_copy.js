/**
 * Copy for the interested-lead VSL nurture (see vsl-nurture.js).
 *
 * This is NOT the cold sequence in _email_sequence_copy.js. Everyone who gets
 * these has already had a real phone conversation with a rep, and the rep has
 * already sent them the video. So the copy never re-introduces the company, and
 * it never re-explains the offer from scratch. See the "never re-explain the
 * offer" rule: if they already heard the pitch, a follow-up is acknowledgement
 * plus one question.
 *
 * Three steps, and they do three different jobs:
 *   1 (email, day 1)  they never landed on the page. Assume the link got lost,
 *                     not that they refused. Re-send it with one line of why.
 *   2 (sms, day 3)    still no play. Short, from the rep's own line, one
 *                     question. No link in the SMS body beyond the VSL itself.
 *   3 (email, day 5)  still no play. STOP asking them to watch. Explain the
 *                     problem in text so the prospect gets the point without
 *                     the video, and ask for the meeting directly. This is the
 *                     step Remy asked for: make sure they understand the
 *                     problem, not just that they clicked.
 *
 * FENCES, enforced by validate() below and re-checked in vsl-nurture.js:
 *   - never a price, a range, or "starting at"
 *   - never the words AI, agent, automation, bot, software
 *   - step 3 must not ask them to watch the video again
 */

// One sentence of problem, in the prospect's own language, per niche. These
// mirror the hook lines in _email_sequence_copy.js on purpose: a lead who got
// the cold sequence AND a rep call should hear one consistent story.
const NICHE = {
    'commercial-cleaning': {
        noun: 'buildings',
        problem: 'A building changes management or sells, the new people bring their own vendor, and you are out a contract you did nothing wrong on. Then it takes the better part of a year to replace it on referrals alone.',
        question: 'are you in a spot where you could take on two or three more buildings right now?',
        meeting: 'which buildings around you we would go after, and how those property managers end up on your calendar',
    },
    'commercial-roofing': {
        noun: 'jobs',
        problem: 'Most shops could handle more work tomorrow. The constraint is never the crew, it is where the next job comes from, and most of it is waiting on the storm map. The shops that stay busy year round decided on purpose to stop waiting.',
        question: 'is your schedule where you want it for the next quarter?',
        meeting: 'which property managers and facility people we would go after, and how they end up on your calendar',
    },
    'staffing': {
        noun: 'client accounts',
        problem: 'Plenty of candidates, not enough client orders to run them against. The fill rate looks fine until you notice it is the same six accounts you have had for years, and one of them just took hiring in-house. Usually the recruiters are not the problem, the order book is.',
        question: 'are you actively taking on new client accounts right now, or pretty much at capacity?',
        meeting: 'which hiring managers with open reqs we would go after, and how they end up on your calendar',
    },
    'freight': {
        noun: 'shippers',
        problem: 'Most owners can name the exact week spot rates turned a good month into a wash. The carriers that ride it out are the ones with direct shipper relationships instead of a load board.',
        question: 'are you looking to add direct shippers right now?',
        meeting: 'which shippers we would go after, and how they end up on your calendar',
    },
    'industrial-supplies': {
        noun: 'accounts',
        problem: 'New-account work is the thing that gets done when somebody has a slow week. It is never a standing job, so the base stays flat and you spend your time defending what you already have. The suppliers growing right now treat it as a standing job.',
        question: 'is opening new accounts something you are pushing on right now?',
        meeting: 'which buyers we would go after, and how they end up on your calendar',
    },
};

const SIG = ['Remy Leon', 'Miami'];

function join(lines) {
    return lines.concat(['']).concat(SIG).join('\n');
}

/**
 * step1 — email, ~day 1, they never opened the page at all.
 * Frame it as the link getting buried, never as them ignoring us. A prospect
 * who feels accused of ignoring you does not reply.
 */
function step1(ctx) {
    const n = NICHE[ctx.niche];
    return {
        subject: 'that video for ' + ctx.company,
        body: join([
            'Hi ' + ctx.first + ',',
            '',
            'Sent you a short video after we spoke and I think it got buried, which is usually what happens with these.',
            '',
            'It is about two minutes and it is the fastest way to see whether this is worth your time: ' + ctx.link,
            '',
            'If it is easier, just tell me and I will give you the short version on the phone instead.',
        ]),
    };
}

/**
 * step2 — SMS, ~day 3, from the rep's own Quo line.
 * Lowercase, texting register, one question, no pitch. Same voice as the
 * outbound campaign openers so a lead who got both does not hear two people.
 */
function step2(ctx) {
    return {
        body: 'hey ' + ctx.firstLower + ', ' + ctx.repFirstLower + ' here. sent you that short video after we talked, not sure it ever landed. '
            + ctx.link + ' — worth two minutes or would you rather i just walk you through it?',
    };
}

/**
 * step3 — email, ~day 5, they still have not played it.
 * STOP asking them to watch. Give them the problem in text and ask for the
 * meeting. This is the whole reason the sequence exists: the goal was never a
 * view, it was that they understand the problem.
 */
function step3(ctx) {
    const n = NICHE[ctx.niche];
    return {
        subject: n.noun + ' at ' + ctx.company,
        body: join([
            'Hi ' + ctx.first + ',',
            '',
            'I will stop pointing you at that link. Here is the whole thing in writing.',
            '',
            n.problem,
            '',
            'What we do about it is narrow: we find the companies worth talking to, we work them by phone, email and text, and we put the ones who are actually interested on your calendar. You run the meeting and you close it. We are not trying to sell for you.',
            '',
            'So the only question that matters: ' + n.question,
            '',
            'If the answer is yes, give me twenty minutes and I will show you ' + n.meeting + '. If it is no, tell me and I will leave you alone.',
        ]),
    };
}

// ---------------------------------------------------------------------------
// Fences. A brief is not a guarantee, so every rendered body is checked before
// it can be sent; vsl-nurture.js refuses to send anything that fails.
const BANNED_PRICE = /\$|\bprice\b|\bpricing\b|\bcost[s]?\b|\bfee\b|per meeting|per month|monthly|retainer|starting at/i;
const BANNED_AI = /\bA\.?I\.?\b|\bagent\b|automat|\bbot\b|\bsoftware\b|\balgorithm/i;
const STEP3_BANNED_WATCH = /\bwatch\b|\bvideo\b|\bvsl\b/i;

function validate(step, rendered) {
    const text = [rendered.subject || '', rendered.body || ''].join('\n');
    const problems = [];
    if (BANNED_PRICE.test(text)) problems.push('price_mentioned');
    if (BANNED_AI.test(text)) problems.push('ai_word');
    if (/\{\{|\bundefined\b|\bnull\b|\[object/i.test(text)) problems.push('unrendered_token');
    if (step === 3 && STEP3_BANNED_WATCH.test(text)) problems.push('step3_still_asks_for_the_watch');
    if (step === 2 && (rendered.body || '').length > 320) problems.push('sms_too_long');
    return problems;
}

module.exports = { NICHE, step1, step2, step3, validate };
