/**
 * api/prospects/_outbound.js
 *
 * Shared engine for the Outbound SMS campaign: line resolution, send-window
 * math, per-line pacing, and per-lead message generation.
 *
 * ---------------------------------------------------------------------------
 * THE TWO LOCKS
 *
 * Nothing sends unless BOTH are open:
 *   1. campaign.status === 'running'
 *   2. process.env.OUTBOUND_SEND_ENABLED === 'true'
 *
 * Both default closed. Enqueueing a campaign, generating every message, and
 * previewing the whole board are all safe with the locks shut, which is the
 * point: you should be able to build and inspect an entire campaign the night
 * before without any chance of a message leaving.
 *
 * ---------------------------------------------------------------------------
 * WHY PER-LINE CAPS ARE THE ONES THAT MATTER
 *
 * Carriers score reputation per sending number, not per account. 500 messages
 * spread across six lines is six lines doing ~83. 500 down one line is a
 * number that gets filtered by lunchtime and takes the rep's real conversations
 * with it. daily_cap is the campaign's budget; per_line_daily_cap is the thing
 * that actually protects the phone system, so the worker enforces it per line
 * per calendar day in the campaign's timezone.
 */

const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('../openphone/_shared');
const scrub = require('./_scrub');

const SEND_ENABLED = String(process.env.OUTBOUND_SEND_ENABLED || '').toLowerCase() === 'true';

// Authored defaults. These identify the sender, because that is the only kind
// of opener this file ships with. A campaign row can override all three via
// step*_guidance, and whatever is in that column is what the generator follows.
const DEFAULT_GUIDANCE = {
    1: [
        'Goal: get a reply. Nothing else.',
        'This person already spoke with us on the phone once, so reference that lightly.',
        'Say who you are by first name and where you are from.',
        'Ask ONE short question they can answer in a few words.',
        'Do not pitch, do not list features, do not mention price.',
        'Two sentences maximum. Lowercase, texting register, no marketing voice.'
    ].join('\n'),
    2: [
        'They replied. Goal: state the offer plainly and find out if they want volume.',
        'One sentence on what we do for businesses like theirs, in their language, not ours.',
        'Then ask whether they could handle more of the specific work they do.',
        'No price. No feature list. Three sentences maximum.'
    ].join('\n'),
    3: [
        'Goal: get permission for a call in the next few minutes.',
        'Be direct, ask if it is okay to call from this number shortly.',
        'One or two sentences.'
    ].join('\n')
};

/**
 * Arm B of the opener test.
 *
 * Both arms use Cameron England's mechanics: two sentences, lowercase, texting
 * register, one low-commitment question, no pitch and no company name. They
 * differ on ONE variable, which is the whole point of an A/B test:
 *
 *   A asserts the prior call   -> "we spoke a while back about X"
 *   B invites them to place us -> "have we spoken before or am I misremembering?"
 *
 * B is Cameron's highest-rated pattern ("Have we spoken before or am I just
 * missing it"), and it works because an uncertain question is reflexively
 * answered where a statement can be ignored. Critically, for THIS audience it is
 * also literally true: every target has a 20s+ call on record, so the question
 * is honest rather than a pretext. That is the difference between running his
 * mechanics and running his fake-customer framing.
 *
 * Do NOT vary anything else between the arms. Changing length, whether the
 * sender is named, or whether a link is included at the same time makes the
 * result uninterpretable.
 */
const DEFAULT_GUIDANCE_B = [
    'Goal: get a reply. Nothing else.',
    'This person had a real phone conversation with one of our reps weeks ago.',
    'Open with genuine uncertainty that invites them to place you, e.g.',
    '"have we spoken before or am i misremembering" then confirm what they do.',
    'Give your first name. Do NOT name the company.',
    'Ask ONE question they can answer in a few words.',
    'Do not pitch, do not list features, do not mention price, no link.',
    'Two sentences maximum. Lowercase, texting register, no marketing voice.'
].join('\n');

function serviceClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}
function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
    });
}

/**
 * email -> { line, display_name, first_name } for every active rep.
 *
 * Read fresh rather than cached: David and George swapped numbers twice in four
 * days, and a cached map is how a rep's texts start going out from someone
 * else's number.
 */
async function loadReps() {
    const pub = publicClient();
    const { data, error } = await pub.from('sdr_users')
        .select('email, display_name, openphone_number')
        .eq('active', true).not('openphone_number', 'is', null);
    if (error) throw new Error('sdr_users read failed: ' + error.message);
    const byEmail = {};
    for (const r of (data || [])) {
        const line = normalizePhone(r.openphone_number);
        if (!line) continue;
        byEmail[r.email] = {
            line: line,
            display_name: r.display_name || '',
            first_name: String(r.display_name || '').trim().split(/\s+/)[0] || 'me',
        };
    }
    return byEmail;
}

// ---------------------------------------------------------------------------
// Send window. Computed in the campaign's timezone, not the server's, because
// Vercel runs UTC and a 09:00-19:00 window read in UTC texts people at 4am.
// ---------------------------------------------------------------------------
function localParts(now, timezone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
    return {
        ymd: p.year + '-' + p.month + '-' + p.day,
        minutes: Number(p.hour) * 60 + Number(p.minute),
    };
}
function hhmmToMinutes(t) {
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function windowState(campaign, now) {
    const tz = campaign.timezone || 'America/New_York';
    const { ymd, minutes } = localParts(now || new Date(), tz);
    const start = hhmmToMinutes(campaign.send_window_start);
    const end = hhmmToMinutes(campaign.send_window_end);
    return { localDate: ymd, localMinutes: minutes, open: minutes >= start && minutes < end, start: start, end: end };
}

/**
 * How many messages each line has already sent today, for this campaign.
 * Counted off the step*_sent_at stamps rather than a counter column, so it stays
 * correct after a manual DB edit, a resume, or a re-run.
 */
async function sentTodayByLine(sb, campaign, now) {
    const tz = campaign.timezone || 'America/New_York';
    const today = localParts(now || new Date(), tz).ymd;
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    const { data, error } = await sb.from('outbound_targets')
        .select('from_line, step1_sent_at, step2_sent_at, step3_sent_at')
        .eq('campaign_id', campaign.id)
        .or('step1_sent_at.gte.' + since + ',step2_sent_at.gte.' + since + ',step3_sent_at.gte.' + since);
    if (error) throw new Error('pacing read failed: ' + error.message);
    const counts = {};
    for (const r of (data || [])) {
        for (const stamp of [r.step1_sent_at, r.step2_sent_at, r.step3_sent_at]) {
            if (!stamp) continue;
            if (localParts(new Date(stamp), tz).ymd !== today) continue;
            counts[r.from_line] = (counts[r.from_line] || 0) + 1;
        }
    }
    return counts;
}

/**
 * Newest send stamp per line for a campaign, as epoch ms: { '+1786...': ms }.
 *
 * Read across ALL targets of the campaign, not just the due subset the worker
 * happens to be iterating. A target that was just sent leaves the queued/replied
 * stages immediately, so a "due rows only" computation forgot every recent send
 * the moment it happened and the drip interval never actually held.
 *
 * Bounded to stamps in the last 24h: the drip is minutes, so anything older
 * cannot gate a send, and the bound keeps the row count under PostgREST's
 * 1000-row default even on a large campaign.
 */
async function lastSendByLine(sb, campaign, now) {
    const since = new Date((now ? now.getTime() : Date.now()) - 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb.from('outbound_targets')
        .select('from_line, step1_sent_at, step2_sent_at, step3_sent_at')
        .eq('campaign_id', campaign.id)
        .or('step1_sent_at.gte.' + since + ',step2_sent_at.gte.' + since + ',step3_sent_at.gte.' + since);
    if (error) throw new Error('drip pacing read failed: ' + error.message);
    const newest = {};
    for (const r of (data || [])) {
        for (const stamp of [r.step1_sent_at, r.step2_sent_at, r.step3_sent_at]) {
            if (!stamp) continue;
            const ms = new Date(stamp).getTime();
            if (!newest[r.from_line] || ms > newest[r.from_line]) newest[r.from_line] = ms;
        }
    }
    return newest;
}

// ---------------------------------------------------------------------------
// Message generation
// ---------------------------------------------------------------------------
function firstNameOf(full) {
    const f = String(full || '').trim().split(/\s+/)[0];
    if (!f || /^(owner|the|practice|office|manager|front|personal|commercial)$/i.test(f)) return '';
    return f;
}

/**
 * Internal product codename -> what a prospect would actually recognise.
 * "LCR" means nothing to a dentist. "winning back past patients" does.
 */
function plainAgent(pitchAgent) {
    const v = String(pitchAgent || '').toLowerCase();
    if (/receptionist|echo/.test(v)) return 'answering the calls you miss after hours';
    if (/lcr|reactivat|lost customer|revive/.test(v)) return 'winning back customers who stopped coming';
    if (/outbound|lead reply|lead response|ignite/.test(v)) return 'calling new enquiries back faster';
    if (/lead gen|scout|generator/.test(v)) return 'finding new customers for you';
    if (/website|forge/.test(v)) return 'your website turning visitors into booked jobs';
    if (/seo|geo|signal/.test(v)) return 'getting found when people search';
    if (/ontology|oracle/.test(v)) return 'reporting on your numbers';
    return 'the AI side of your business';
}

/**
 * Reject generated copy that would embarrass us or ruin the experiment.
 *
 * The model follows a brief most of the time, which is exactly the problem: a
 * 10% violation rate across 274 sends is 27 bad texts to real business owners,
 * and if the violations cluster in one arm they also silently confound the A/B.
 * Measured on the first batch: arm A named the company in 29% of messages and
 * arm B in 4%, so the two arms differed on framing AND on company naming, and
 * any result would have been uninterpretable. A prompt cannot guarantee this.
 * A check can.
 */
const BANNED = [
    { re: /\b(hey|hi|hello)\s+(name|there,\s*name)\b|\[name\]|\bfirst_?name\b/i, why: 'placeholder_name' },
    { re: /\b(lcr|gmb|vsl|echo|ignite|revive|scout|forge|signal|oracle|flux)\b/i, why: 'internal_jargon' },
    { re: /\bstilo\b/i, why: 'names_company' },
    { re: /https?:\/\//i, why: 'contains_link' },
];
function validateBody(text, senderFirstName) {
    const t = String(text || '').trim();
    if (t.length < 15) return { ok: false, why: 'too_short' };
    if (t.length > 320) return { ok: false, why: 'too_long' };
    for (const b of BANNED) if (b.re.test(t)) return { ok: false, why: b.why };

    // The sender MUST identify themselves. Without this the model drops its own
    // name whenever the lead has no owner_name, producing "hey, have we spoken
    // before or am i misremembering? i think you run Miller CPA" — an anonymous
    // text asking a stranger to place you, which is the exact ambiguous-identity
    // pattern this campaign refuses to send. 8 of 581 came out that way.
    //
    // Matched on a 3-char prefix so a legitimate short form passes: Alejandro
    // Barrios signs "ale here", which is his actual name, not a violation.
    if (senderFirstName) {
        const n = String(senderFirstName).toLowerCase();
        const stem = n.slice(0, 3);
        if (stem && !t.toLowerCase().includes(stem)) return { ok: false, why: 'sender_not_named' };
    }
    return { ok: true };
}

function leadFacts(lead, campaign) {
    const bits = [];
    if (lead.name) bits.push('Business: ' + lead.name);
    const who = firstNameOf(lead.owner_name);
    if (who) bits.push('Owner first name: ' + who);
    if (lead.niche || lead.category) bits.push('Industry: ' + (lead.niche || lead.category));
    if (lead.address) bits.push('Location: ' + lead.address);
    // The topic. A campaign-level topic_override wins over the lead's own
    // pitch_agent, because pitch_agent records what we pitched them under the
    // OLD offer. Without the override, a warm re-touch in Aug 2026 asks a
    // dentist about "attracting new patients", a product we no longer sell.
    const override = campaign && String(campaign.topic_override || '').trim();
    if (override) {
        bits.push('The topic we discussed (describe in PLAIN WORDS): ' + override);
    } else if (lead.pitch_agent) {
        // Translate the internal codename into plain language. Feeding the raw value
        // in leaked "LCR" and "GMB" straight into 13 of 120 generated texts, which
        // reads as gibberish to a prospect who has never heard our product names.
        bits.push('The topic we discussed (describe in PLAIN WORDS, never by this name): ' + plainAgent(lead.pitch_agent));
    }
    if (lead.last_called_outcome) bits.push('Outcome of our last call with them: ' + lead.last_called_outcome);
    if (lead.website) bits.push('They already have a website: ' + lead.website);
    return bits.join('\n');
}

/**
 * Deterministic fallback used when Gemini is unavailable or returns junk.
 * Deliberately plain: a boring message that sends beats a clever one that
 * doesn't, and a silent generation failure that emits an empty string would
 * text someone a blank message.
 */
/**
 * Deterministic fallback, used when the model fails validation twice.
 *
 * MUST ITSELF PASS validateBody(). An earlier version opened with
 * "<name> here from stilo", so every rejected message fell back onto copy that
 * broke the very rule that rejected it. Because fallbacks are not evenly
 * distributed across arms, that also reintroduced the A/B confound: 3 of 3
 * fallbacks landed in arm A, so arm A named the company 27% of the time and arm
 * B never did. A fallback that violates the rules is worse than no fallback,
 * because it looks like it worked.
 */
function fallbackBody(lead, step, sender, variant, campaign) {
    const who = firstNameOf(lead.owner_name);
    const hi = who ? 'hey ' + who : 'hey';
    const override = campaign && String(campaign.topic_override || '').trim();
    const topic = override || (lead.pitch_agent ? plainAgent(lead.pitch_agent) : 'your business');
    if (step === 1) {
        // Fallback must match the arm it is standing in for, or it silently
        // contaminates the experiment with the other arm's framing.
        return variant === 'B'
            ? hi + ', ' + sender.first_name + ' here. have we spoken before or am i misremembering? was about ' + topic + '.'
            : hi + ', ' + sender.first_name + ' here. we spoke a little while back about ' + topic + '. still worth a quick chat?';
    }
    // Step 2 states the CURRENT offer in plain words. The old version said "we
    // build and run the AI that brings local businesses more booked work", which
    // is both the retired offer and the AI framing we no longer use with clients.
    if (step === 2) return 'appreciate you getting back. short version: we find the companies in your market that need what you do and put the ready ones on your calendar as booked meetings. you just show up and close. could you handle more work right now if it came in?';
    return 'perfect. ok if i give you a quick call from this number in a few minutes?';
}

async function geminiSms(prompt) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 9000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
            }),
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const j = await r.json();
        const t = j && j.candidates && j.candidates[0] && j.candidates[0].content
            && j.candidates[0].content.parts && j.candidates[0].content.parts[0]
            && j.candidates[0].content.parts[0].text;
        if (!t || t.trim().length < 8) return null;
        return t.trim().replace(/^["']|["']$/g, '');
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

/**
 * Generate one personalized message for one lead at one step.
 *
 * The campaign's step guidance is passed through as the authoring brief. The
 * lead's own record supplies the personalization. Length is hard-capped at 320
 * chars: past that a carrier splits it into multiple segments, which costs more
 * and reads as bulk.
 */
async function generateStepBody(lead, campaign, step, sender, variant) {
    // Arm B only exists for step 1: the opener is what the test is about, and
    // splitting later steps too would confound the result (you could no longer
    // tell whether the opener or the pitch moved the number).
    let guidance;
    if (step === 1 && campaign.ab_enabled && variant === 'B') {
        guidance = (campaign.step1_guidance_b || '').trim() || DEFAULT_GUIDANCE_B;
    } else {
        guidance = (campaign['step' + step + '_guidance'] || '').trim() || DEFAULT_GUIDANCE[step];
    }
    const prompt = [
        'Write ONE outbound SMS. Output only the message text, nothing else.',
        '',
        'Who is sending: ' + sender.first_name + ' at STILO AI Partners, a small Miami team.',
        '',
        'About the recipient:',
        leadFacts(lead, campaign),
        '',
        'What this message must do:',
        guidance,
        '',
        'Hard rules:',
        '- Under 320 characters. Shorter is better.',
        '- No em dashes anywhere. Use commas or periods.',
        '- No exclamation points.',
        '- Never use: leverage, utilize, streamline, seamless, robust, cutting-edge, innovative, holistic, elevate, unlock.',
        '- Do not write a signature, a company footer, or a link.',
        '- NEVER write the company name "STILO". Give your first name only.',
        '- NEVER write internal product names: LCR, GMB, VSL, ECHO, IGNITE, REVIVE,',
        '  SCOUT, FORGE, SIGNAL, ORACLE, FLUX. Describe the topic in plain words.',
        '- If you do not know their first name, do NOT write the word "name".',
        '  Just open with "hey" and no name at all.',
        '- Sound like a person typing on a phone, not a brochure.',
        '',
        'Write the message now.',
    ].join('\n');

    // Generate, validate, retry once, then fall back. The retry is cheap and
    // catches most one-off violations; the deterministic fallback guarantees we
    // never emit a message that failed the check.
    let body = null, generated = false, rejected = null;
    for (let attempt = 0; attempt < 2 && !body; attempt++) {
        const out = await geminiSms(attempt === 0 ? prompt : prompt + '\n\nYour previous attempt broke a hard rule. Re-read the hard rules and try again.');
        if (!out) continue;
        let cleaned = out.replace(/—|–/g, ',').replace(/!/g, '.').trim();
        const v = validateBody(cleaned, sender && sender.first_name);
        if (v.ok) { body = cleaned; generated = true; }
        else rejected = v.why;
    }
    if (!body) {
        body = fallbackBody(lead, step, sender, variant, campaign).replace(/—|–/g, ',').replace(/!/g, '.').trim();
        if (body.length > 320) body = body.slice(0, 317).replace(/\s+\S*$/, '') + '...';
    }
    return { body: body, generated: generated, rejected: rejected };
}

/**
 * Final pre-send gate for a single target. Everything that could make this send
 * wrong, checked in one place immediately before the API call.
 */
function preSendCheck(campaign, target, lead) {
    if (!SEND_ENABLED) return { ok: false, reason: 'send_disabled_env' };
    if (campaign.status !== 'running') return { ok: false, reason: 'campaign_' + campaign.status };
    if (!target.from_line) return { ok: false, reason: 'no_from_line' };
    if (!target.to_phone) return { ok: false, reason: 'no_to_phone' };
    if (['blocked', 'opted_out', 'dead', 'booked'].includes(target.stage)) {
        return { ok: false, reason: 'stage_' + target.stage };
    }

    // A lead we could not read is a lead we cannot clear. Every check below
    // (do_not_call, scrub verdict, phone match) reads off the lead row, and a
    // null lead used to sail through all of them: a transient read failure was
    // indistinguishable from a clean lead, and the scrub exemption could waive
    // a scrub for a lead nobody had actually looked at. Hard-fail instead.
    if (!lead) return { ok: false, reason: 'lead_read_failed' };

    // do_not_call is NEVER waivable. It carries actual opt-outs, DNC requests,
    // and confirmed scrub blocks, and no campaign setting may override it.
    if (lead.do_not_call) return { ok: false, reason: 'do_not_call' };

    // A confirmed litigator match is also never waivable. The exemption below
    // covers "we have no scrub answer", not "the scrub said no".
    if (lead.scrub_status === 'blocked') return { ok: false, reason: 'scrub_blocked' };

    const s = scrub.assertScrubbedForSms(lead, target.to_phone);
    if (!s.ok) {
        // Both conditions required: the campaign opted in AND this specific
        // target has a real prior phone conversation on record. A cold lead can
        // never satisfy the second, so an exempt campaign still cannot cold-text.
        const exempt = campaign.scrub_exempt_prior_contact === true && target.prior_contact === true;
        if (!exempt) return { ok: false, reason: s.reason };
        return { ok: true, waived: s.reason };
    }
    return { ok: true };
}

module.exports = {
    SEND_ENABLED, DEFAULT_GUIDANCE, DEFAULT_GUIDANCE_B,
    serviceClient, publicClient, loadReps,
    windowState, localParts, sentTodayByLine, lastSendByLine,
    generateStepBody, fallbackBody, firstNameOf, leadFacts, validateBody, plainAgent,
    preSendCheck,
};
