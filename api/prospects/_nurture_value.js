/**
 * api/prospects/_nurture_value.js
 *
 * The VALUE layer of the post-booking nurture sequence.
 *
 * The existing four steps (confirmation, VSL follow-up, day-before, T-15) are
 * logistics. They tell the prospect the meeting is real and when it is. This
 * module carries the other half, per Haynes: several substantive touches
 * between booking and meeting so the prospect walks in already educated instead
 * of cold, and so the meeting starts at "how would this work for me" rather
 * than "so what do you guys do".
 *
 * ---------------------------------------------------------------------------
 * THE PLAN ADAPTS TO HOW FAR OUT THE MEETING IS
 *
 * A fixed five-touch sequence is wrong for a meeting booked for tomorrow
 * morning: it either fires everything in three hours (which reads as spam and
 * is the fastest way to lose a booked meeting) or silently drops most of it.
 * So the plan is chosen by the gap between now and the meeting, and any slot
 * that lands in the past or inside quiet hours is dropped at planning time
 * rather than at send time. What you see in the dashboard is what will send.
 *
 * ---------------------------------------------------------------------------
 * NUMBERS DISCIPLINE
 *
 * Every figure in this content is a published benchmark or a plain statement
 * about how our system works, and it is always framed as a benchmark. It is
 * never presented as THIS prospect's number. That rule exists because inventing
 * a prospect's numbers is a documented reason our meetings have died: a
 * fabricated conversion rate got price-checked and lost the deal, while numbers
 * extracted from the prospect's own mouth closed the conversation. The value
 * emails set up the money conversation; they never pre-empt it.
 */

const AGENT_FACTS = {
    receptionist: {
        label: 'AI Receptionist',
        how: 'It answers on the first ring, in English or Spanish, holds a real conversation, qualifies the caller, books straight into your calendar, and writes the whole call up in your dashboard.',
        benchmark: 'Industry studies put missed-call rates at local service businesses around 62% outside staffed hours. The typical caller does not leave a voicemail, they dial the next name on the list.',
        proof: 'The thing to measure is not calls answered, it is booked jobs from calls that used to go to voicemail.',
        objection: 'The usual worry is that it will sound like a robot and annoy people. Fair. That is why the demo on our call is a live phone call, not a slide.',
    },
    lead_response: {
        label: 'Outbound Lead Response agent',
        how: 'The moment a lead hits your form or ad, it replies by text and email and places a callback, qualifies them, and pushes them to book. Minutes, not hours.',
        benchmark: 'The widely cited Harvard Business Review study on lead response found that contacting a lead within an hour makes qualifying them dramatically more likely than waiting even a few hours. First to call usually wins the job.',
        proof: 'The number that moves is the share of inbound leads that turn into a booked appointment.',
        objection: 'Most people ask whether it will annoy the lead. It is one text and one call, the same thing your best rep would do if they were free.',
    },
    reactivation: {
        label: 'Lost Customer Reactivation agent',
        how: 'It reads your customer list, finds the people who quietly stopped coming back, and works them with personalized email and text until they rebook.',
        benchmark: 'Selling to an existing customer is consistently cheaper than acquiring a new one. These are people who already chose you once, so there is no trust to build from scratch.',
        proof: 'This is the fastest one to prove, because the list already exists. You can see the revenue inside a few weeks.',
        objection: 'The common question is whether old customers will find it annoying. They opted in with you once, and the message is an offer, not a newsletter.',
    },
    lead_gen: {
        label: 'B2B Lead Generator',
        how: 'It finds businesses matching your ideal customer, researches each one properly, and sends outreach written for that specific business, then hands you the replies.',
        benchmark: 'Generic cold outreach mostly gets ignored. Personalized outreach at volume is the only version of this that still works, and personalization at volume is exactly what an agent is good at.',
        proof: 'Measured on booked conversations with the right kind of company, not on messages sent.',
        objection: 'People ask if it is just a spam cannon. It is the opposite, the whole edge is that each message is researched.',
    },
    website: {
        label: 'Website',
        how: 'A fast, modern site built around one job: turning a visitor into a booked appointment. Obvious book-now button, click to call, the trust signals buyers actually look for.',
        benchmark: 'Google has published that most mobile visitors abandon a page that takes more than about three seconds to load. A site can look fine and still leak most of the people who land on it.',
        proof: 'The measure is booked appointments from the site, not traffic and not how it looks.',
        objection: 'If you already have a site, the question is not whether it exists, it is whether it books anyone. That is what we would look at together.',
    },
    seo: {
        label: 'AI SEO agent',
        how: 'It gets you cited in AI answers. Schema, content, and citations built so ChatGPT, Gemini, and Google AI Overviews name you when someone asks who the best in your area is.',
        benchmark: 'AI assistants increasingly answer local buying questions directly and name only a handful of businesses. If you are not in that shortlist, you are invisible at the exact moment somebody is deciding who to call.',
        proof: 'Measured on whether you actually get named, which we can test live on the call.',
        objection: 'Most people ask how this differs from normal SEO. Normal SEO fights for a link position. This fights to be the answer.',
    },
    growth: {
        label: 'Ontology and Internal Report agent',
        how: 'It maps how your business actually makes money, then reports on the handful of numbers that move it, every week, without anyone building a spreadsheet.',
        benchmark: 'Most owner-operated businesses run on a gut read of last month. The gap between that and a real weekly number is usually where the margin went.',
        proof: 'Measured on decisions made with it, not dashboards produced.',
        objection: 'The fair question is whether this is just another dashboard nobody opens. That is why it comes as a written report, not a login.',
    },
    custom: {
        label: 'Custom Automations',
        how: 'We map the workflow eating your team\'s hours and build an agent that runs it, then we operate it for you.',
        benchmark: 'The work worth automating is usually the boring repeatable middle, not the skilled part. That is where the hours actually go.',
        proof: 'Measured in hours returned to the team and errors removed.',
        objection: 'People ask what happens if it breaks. We run it, so that is our problem, not yours.',
    },
};

function agentKeyFrom(pitchAgent) {
    const v = String(pitchAgent || '').toLowerCase();
    if (/website|forge/.test(v)) return 'website';
    if (/\bseo\b|geo|signal/.test(v)) return 'seo';
    if (/ontology|oracle|growth/.test(v)) return 'growth';
    if (/custom|flux/.test(v)) return 'custom';
    if (/lcr|reactivat|lost customer|revive/.test(v)) return 'reactivation';
    if (/outbound|lead reply|lead response|ignite/.test(v)) return 'lead_response';
    if (/lead gen|scout|generator/.test(v)) return 'lead_gen';
    if (/receptionist|echo/.test(v)) return 'receptionist';
    return 'receptionist';
}

/**
 * The touch catalogue. `offsetFromMeetingHours` is hours BEFORE the meeting.
 * Slots are chosen per plan below, then filtered against now and quiet hours.
 */
const TOUCHES = {
    how_it_works: {
        channel: 'email',
        subjectHint: 'how it actually works',
        brief: 'Explain in plain language how the agent works end to end. No jargon, no feature list. The reader should be able to describe it to a partner afterwards. Close by saying you will show it live on the call.',
    },
    the_numbers: {
        channel: 'email',
        subjectHint: 'what the numbers usually look like',
        brief: 'Give the published benchmark for this problem and explain how to think about ROI. Be explicit that these are industry benchmarks, not their numbers, and that you will work out their actual numbers together on the call. Do NOT estimate their revenue, traffic, or job value.',
    },
    use_case: {
        channel: 'email',
        subjectHint: 'a business like yours',
        brief: 'Describe how a business in their industry would use this day to day, concretely, hour by hour. Written as a scenario, not a case study, and never claim a named client or a specific result we have not produced.',
    },
    quick_thought: {
        channel: 'sms',
        brief: 'One short text with a single useful thought about their industry and this problem. Not a pitch, not a reminder about the meeting. Under 200 characters. Ends with a light question they can answer in a few words.',
    },
    what_to_expect: {
        channel: 'sms',
        brief: 'Short text the morning of the meeting saying exactly what will happen on the call: how long, what you will show, and that they will leave with a number either way. Under 250 characters.',
    },
    objection_prehandle: {
        channel: 'email',
        subjectHint: 'the part people usually push back on',
        brief: 'Name the most common objection to this agent honestly, then answer it straight. Do not be defensive and do not oversell. This is the slot the second VSL will eventually live in, so keep it focused on pre-handling doubt.',
    },
};

/**
 * Pick the plan by how much runway there is. Each entry is
 * [stepKey, hoursBeforeMeeting].
 */
function planFor(hoursUntilMeeting) {
    if (hoursUntilMeeting >= 96) {
        return [
            ['how_it_works', 90],
            ['quick_thought', 78],
            ['the_numbers', 66],
            ['use_case', 42],
            ['objection_prehandle', 26],
            ['what_to_expect', 3],
        ];
    }
    if (hoursUntilMeeting >= 48) {
        return [
            ['how_it_works', 44],
            ['the_numbers', 32],
            ['quick_thought', 27],
            ['use_case', 22],
            ['objection_prehandle', 8],
            ['what_to_expect', 3],
        ];
    }
    if (hoursUntilMeeting >= 24) {
        return [
            ['how_it_works', 22],
            ['the_numbers', 15],
            ['use_case', 9],
            ['what_to_expect', 3],
        ];
    }
    if (hoursUntilMeeting >= 8) {
        return [
            ['how_it_works', 6],
            ['what_to_expect', 2],
        ];
    }
    // Under 8 hours there is no room for a value sequence without carpet
    // bombing someone who already agreed to meet. The existing confirmation and
    // T-15 messages carry it.
    return [];
}

// Quiet hours in the prospect's local time. A value email at 6am is a reason to
// cancel a meeting, not a reason to attend one.
const QUIET_START = 20; // 8pm
const QUIET_END = 8;    // 8am

function localHour(date, tz) {
    return Number(new Intl.DateTimeFormat('en-US', {
        timeZone: tz || 'America/New_York', hour: '2-digit', hour12: false,
    }).format(date));
}

/**
 * Build the schedule for one lead's meeting. Pure function: returns rows, does
 * not write. Callers persist them so the whole plan is inspectable before a
 * single message goes out.
 */
function buildSchedule(meetingAt, opts) {
    const tz = (opts && opts.timezone) || 'America/New_York';
    const now = (opts && opts.now) || new Date();
    const meeting = new Date(meetingAt);
    if (isNaN(meeting.getTime())) return [];

    const hoursUntil = (meeting.getTime() - now.getTime()) / 3600000;
    const plan = planFor(hoursUntil);
    const out = [];

    for (const [stepKey, hoursBefore] of plan) {
        const touch = TOUCHES[stepKey];
        if (!touch) continue;
        let when = new Date(meeting.getTime() - hoursBefore * 3600000);

        // Never in the past, never inside a lead's first 30 minutes (the
        // confirmation email is already landing then).
        const floor = new Date(now.getTime() + 30 * 60000);
        if (when < floor) continue;

        // Nudge out of quiet hours rather than dropping: a touch scheduled for
        // 6am is still a good touch, it just belongs at 8am.
        let guard = 0;
        while (guard < 24) {
            const h = localHour(when, tz);
            if (h >= QUIET_END && h < QUIET_START) break;
            when = new Date(when.getTime() + 3600000);
            guard++;
        }
        // If nudging pushed it past the meeting, it has no purpose.
        if (when >= meeting) continue;

        out.push({
            step_key: stepKey,
            channel: touch.channel,
            scheduled_for: when.toISOString(),
            meeting_at: meeting.toISOString(),
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

async function geminiWrite(prompt, maxTokens) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 12000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens || 700, thinkingConfig: { thinkingBudget: 0 } },
            }),
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const j = await r.json();
        const t = j && j.candidates && j.candidates[0] && j.candidates[0].content
            && j.candidates[0].content.parts && j.candidates[0].content.parts[0]
            && j.candidates[0].content.parts[0].text;
        if (!t || t.trim().length < 30) return null;
        return t.trim();
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

function firstNameOf(full) {
    const f = String(full || '').trim().split(/\s+/)[0];
    if (!f || /^(owner|the|practice|office|manager|front|personal|commercial)$/i.test(f)) return '';
    return f;
}

function fallbackContent(stepKey, lead, facts, senderName) {
    const who = firstNameOf(lead.owner_name);
    const hi = who ? 'Hi ' + who + ',' : 'Hi,';
    const biz = lead.name || 'your business';
    if (stepKey === 'quick_thought') {
        return { subject: null, body: 'Hey' + (who ? ' ' + who : '') + ', ' + senderName + ' from STILO. One thought before we talk: ' + facts.proof.toLowerCase() + ' Does that match how you\'d judge it?' };
    }
    if (stepKey === 'what_to_expect') {
        return { subject: null, body: 'Morning' + (who ? ' ' + who : '') + '. Quick note on today: about 20 minutes, I\'ll show you the ' + facts.label + ' running live, and we\'ll work out what it\'s worth for ' + biz + ' using your numbers. You\'ll leave with a straight answer either way.' };
    }
    const bodies = {
        how_it_works: hi + '\n\nBefore we talk, here\'s how the ' + facts.label + ' actually works.\n\n' + facts.how + '\n\n' + facts.proof + '\n\nI\'ll show you the whole thing running on our call.\n\n' + senderName,
        the_numbers: hi + '\n\nA bit of context on the numbers before we meet.\n\n' + facts.benchmark + '\n\nThat\'s an industry benchmark, not your number. We\'ll work out yours together on the call, using figures from your business rather than my guesses.\n\n' + senderName,
        use_case: hi + '\n\nHere\'s what this looks like day to day for a business like ' + biz + '.\n\n' + facts.how + '\n\n' + facts.proof + '\n\nHappy to walk through your specific setup when we talk.\n\n' + senderName,
        objection_prehandle: hi + '\n\nOne thing worth raising before we meet.\n\n' + facts.objection + '\n\nIf that\'s on your mind, bring it up early on the call and we\'ll deal with it first.\n\n' + senderName,
    };
    const subjects = {
        how_it_works: 'How the ' + facts.label + ' actually works',
        the_numbers: 'What the numbers usually look like',
        use_case: 'What this looks like for ' + biz,
        objection_prehandle: 'The part people usually push back on',
    };
    return { subject: subjects[stepKey] || 'Before our call', body: bodies[stepKey] || bodies.how_it_works };
}

/**
 * Generate one touch's content, personalized to the lead, niche, and the agent
 * we are actually selling them.
 */
async function generateTouch(stepKey, lead, sender) {
    const touch = TOUCHES[stepKey];
    if (!touch) return null;
    const key = agentKeyFrom(lead.pitch_agent);
    const facts = AGENT_FACTS[key];
    const senderName = (sender && sender.first_name) || 'Remy';
    const who = firstNameOf(lead.owner_name);
    const niche = lead.niche || lead.category || 'their industry';

    const prompt = [
        touch.channel === 'sms'
            ? 'Write ONE text message. Output only the message text.'
            : 'Write ONE short email body. Output only the body, no subject line, no signature block.',
        '',
        'Sender: ' + senderName + ' at STILO AI Partners, a small Miami team that builds and runs AI agents for local businesses.',
        'Recipient: ' + (who ? who + ', the owner of ' : 'the owner of ') + (lead.name || 'a business') + '.',
        'Their industry: ' + niche + '.',
        lead.address ? 'Location: ' + lead.address : '',
        'They already booked a meeting with us. This is a value touch before that meeting, not a pitch and not a reminder.',
        '',
        'The product we are selling them: ' + facts.label,
        'How it works: ' + facts.how,
        'Relevant benchmark: ' + facts.benchmark,
        'How success is measured: ' + facts.proof,
        'Most common objection: ' + facts.objection,
        '',
        'What this specific message must do:',
        touch.brief,
        '',
        'Hard rules:',
        '- Write for THIS industry. Use their vocabulary and their actual daily situation.',
        '- NEVER invent a number about their business: not their revenue, traffic, job value, call volume, or customer count. Benchmarks must be labelled as benchmarks.',
        '- Never claim a named client, a testimonial, or a result we have not produced.',
        '- No em dashes. Use commas or periods.',
        '- No exclamation points.',
        '- Never use: leverage, utilize, streamline, seamless, robust, cutting-edge, innovative, holistic, elevate, unlock, delve.',
        '- Use contractions. Vary sentence length. Sound like a sharp person, not a brochure.',
        touch.channel === 'sms' ? '- Under 250 characters.' : '- Under 180 words. Short paragraphs.',
        '',
        'Write it now.',
    ].filter(Boolean).join('\n');

    const generated = await geminiWrite(prompt, touch.channel === 'sms' ? 200 : 600);
    const fb = fallbackContent(stepKey, lead, facts, senderName);

    let body = generated || fb.body;
    body = body.replace(/—|–/g, ',').replace(/!/g, '.').trim();
    if (touch.channel === 'sms' && body.length > 300) {
        body = body.slice(0, 297).replace(/\s+\S*$/, '') + '...';
    }

    let subject = null;
    if (touch.channel === 'email') {
        subject = fb.subject;
        const bizShort = (lead.name || '').slice(0, 40);
        if (stepKey === 'use_case' && bizShort) subject = 'What this looks like for ' + bizShort;
    }

    return { subject: subject, body: body, generated: !!generated, agent_key: key };
}

module.exports = {
    AGENT_FACTS, TOUCHES, agentKeyFrom, planFor, buildSchedule, generateTouch,
    fallbackContent, firstNameOf,
};
