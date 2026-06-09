/**
 * sites/stilo-ai/api/prospects/_email_kit.js
 *
 * Shared building blocks for the SDR follow-up email feature (the "Email"
 * button in the lead drawer). Two endpoints use this:
 *   - draft-email.js  → generates the personalized message (Gemini, with a
 *                        deterministic template fallback)
 *   - send-email.js   → wraps the message in a light-mode HTML shell, appends
 *                        the sender's footer + a calendar CTA, sends via Resend
 *
 * Writing rules (CLAUDE.md / humanizer): no em dashes, no AI buzzwords,
 * contractions, specific numbers. The booking link and footer are appended
 * server-side at send time so they're always correct no matter how the rep
 * edits the body.
 */

const { createClient } = require('@supabase/supabase-js');

// The one booking link the whole team sends. Lives here so a future change is
// one edit. Provided by Remy 2026-06-02.
const CALENDAR_LINK = 'https://calendar.app.google/qW5iT5kYeK5EipA9A';
const MARKETING_SITE = 'stiloaipartners.com';
const BLUE = '#2563EB';

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// Strip em/en dashes (the #1 AI tell, banned agency-wide) and a few buzzwords
// that can slip in when the model drafts. Conservative: only touches dashes
// and whole-word buzzwords, never mangles the rep's real content.
function sanitizeCopy(text) {
    let t = String(text || '');
    t = t.replace(/\s*[—–]\s*/g, ', ');   // — / – → ", "
    t = t.replace(/\bleverage\b/gi, 'use')
         .replace(/\butilize\b/gi, 'use')
         .replace(/\bstreamline\b/gi, 'simplify')
         .replace(/\bseamless(ly)?\b/gi, 'easy')
         .replace(/\bcutting-edge\b/gi, 'modern');
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Niche → which agent to lead with + the pain line + a one-line "what it does".
// Keyword match against the lead's niche/category. Default is the AI
// Receptionist (ECHO): it fits almost any phone-dependent local business and
// is our cheapest entry point.
// Each playbook carries: `pain` (full, for the long variant), `painShort` (one
// punchy sentence, for the short variant), `oneLiner` (what the agent does), and
// `subjectTag` (a short value phrase the value-led subject line interpolates).
const PLAYBOOKS = {
    receptionist: {
        agent: 'AI Receptionist',
        pain: "Most calls that come in after you close, or while your team is with a customer, never get answered. For local businesses that's roughly 62% of calls going to voicemail, and a lot of those callers just dial the next place on the list.",
        painShort: "Right now a chunk of your calls after hours or during busy stretches go unanswered, and those callers just dial the next place on the list.",
        oneLiner: "a 24/7 voice agent that answers every call, books appointments, and captures the lead, in English and Spanish, so nothing slips after hours.",
        subjectTag: "the calls you're missing"
    },
    lead_response: {
        agent: 'Outbound Lead Response agent',
        pain: "When a new lead comes in from your site or an ad, the first business to call back almost always wins the job. Most shops take hours to respond. By then the customer has already booked someone else.",
        painShort: "When a new lead comes in, whoever calls back first usually wins the job, and most shops take hours to respond.",
        oneLiner: "an agent that replies to every new lead by email and a callback within minutes, qualifies them, and pushes them to book, in English and Spanish.",
        subjectTag: "calling new leads back first"
    },
    reactivation: {
        agent: 'Lost Customer Reactivation agent',
        pain: "You've got hundreds of past customers sitting in your records who just stopped coming back. That's revenue you already earned once, going untouched every month.",
        painShort: "You've got hundreds of past customers who quietly stopped coming back, revenue you already earned once.",
        oneLiner: "an agent that finds the customers who went quiet and wins them back with personalized email and text offers, on autopilot.",
        subjectTag: "winning back past customers"
    },
    lead_gen: {
        agent: 'Lead Generator agent',
        pain: "Finding new customers by hand is slow and hit or miss, and most cold outreach gets ignored because it isn't personalized.",
        painShort: "Finding new customers by hand is slow, and generic cold outreach mostly gets ignored.",
        oneLiner: "an agent that finds businesses matching your ideal customer, researches each one, and sends personalized outreach, so your pipeline keeps filling itself.",
        subjectTag: "filling your pipeline"
    }
};

// David's scoring engine records the product to sell in `prospect_reasoning`
// (e.g. "product=LCR(28)"). THIS is what's on the cold-call script, so the
// email must pitch the same agent. Map his product label → our playbook.
const PRODUCT_TO_PLAYBOOK = {
    'lcr': 'reactivation',
    'ai receptionist': 'receptionist',
    'outbound agent': 'lead_response',
    'outbound lead response': 'lead_response',
    'lead generator': 'lead_gen'
};

function pickPlaybook(niche) {
    const n = String(niche || '').toLowerCase();
    if (/(roof|plumb|hvac|contract|landscap|electric|garage|remodel|construction|trade|paving|fence|pool)/.test(n)) return PLAYBOOKS.lead_response;
    if (/(gym|fitness|membership|yoga|pilates|crossfit|studio)/.test(n)) return PLAYBOOKS.reactivation;
    return PLAYBOOKS.receptionist;
}

// Choose the playbook for a lead. Priority:
//   1. explicit agent key (composer override)
//   2. the product David's engine picked (prospect_reasoning "product=...") —
//      this is what the rep pitched on the call, so the email must match it.
//   3. niche fallback.
function pickPlaybookForLead(opts) {
    opts = opts || {};
    if (opts.agentKey && PLAYBOOKS[opts.agentKey]) return PLAYBOOKS[opts.agentKey];
    const reasoning = String(opts.prospectReasoning || '');
    const m = reasoning.match(/product=([^(]+)\(/i);
    if (m) {
        const pb = PRODUCT_TO_PLAYBOOK[m[1].trim().toLowerCase()];
        if (pb && PLAYBOOKS[pb]) return PLAYBOOKS[pb];
    }
    // Keyword fallback — also catches matched_product_name strings that don't
    // use the "product=" format, or product codes not in the map above.
    const lc = reasoning.toLowerCase();
    if (/\blcr\b|reactivat|lapsed/.test(lc)) return PLAYBOOKS.reactivation;
    if (/receptionist/.test(lc)) return PLAYBOOKS.receptionist;
    if (/outbound|lead response/.test(lc)) return PLAYBOOKS.lead_response;
    if (/lead gen/.test(lc)) return PLAYBOOKS.lead_gen;
    return pickPlaybook(opts.niche);
}

// Reverse lookup: playbook object → its key (for returning to the composer).
function playbookKey(pb) {
    for (const k in PLAYBOOKS) { if (PLAYBOOKS[k] === pb) return k; }
    return null;
}

function firstName(full) {
    const f = String(full || '').trim().split(/\s+/)[0];
    if (!f || /^(owner|the|practice|office|manager|front)$/i.test(f)) return '';
    return f;
}

// E.164 (+17869819302) → "(786) 981-9302" for the footer. Leaves anything
// non-standard untouched.
function formatPhone(raw) {
    if (!raw) return '';
    const d = String(raw).replace(/\D/g, '');
    const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : (d.length === 10 ? d : null);
    if (!ten) return String(raw);
    return '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6);
}

// Resolve who's sending — name + phone for the footer + a reply-to. SDRs are
// in public.sdr_users; admins (Remy) fall back to the STILO defaults.
async function getSenderIdentity(callerEmail) {
    const fallback = {
        name: process.env.STILO_SENDER_NAME || 'Remy Leon',
        phone: '(786) 876-8677',
        replyTo: callerEmail || process.env.STILO_REPLY_TO || 'remy@stiloaipartners.com'
    };
    if (!callerEmail || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return fallback;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data } = await sb.from('sdr_users')
            .select('display_name, openphone_number, email')
            .ilike('email', callerEmail)
            .maybeSingle();
        if (data && data.display_name) {
            return {
                name: data.display_name,
                phone: data.openphone_number ? formatPhone(data.openphone_number) : fallback.phone,
                replyTo: data.email || callerEmail
            };
        }
    } catch (_) { /* fall through to default */ }
    return fallback;
}

// Deterministic fallback body (used when Gemini is unavailable or slow). Short,
// inviting, humanizer-clean. The booking line + footer are appended at send.
function templateBody(opts) {
    const greet = opts.firstName ? ('Hi ' + opts.firstName + ',') : 'Hi there,';
    const sdrFirst = firstName(opts.senderName) || 'the STILO team';
    const business = opts.business || 'your business';
    const pb = opts.playbook;
    return [
        greet,
        '',
        "This is " + sdrFirst + " from STILO AI Partners. I reached out to " + business + " earlier and wanted to put something in writing so you can look when you have a minute.",
        '',
        pb.pain,
        '',
        "We build and run AI agents for Miami businesses that fix exactly that. For " + business + ", the one I'd start with is " + pb.agent + ": " + pb.oneLiner,
        '',
        "We're a small Miami team. We design it, build it, and run it for you, so you get the result without it becoming another thing on your plate. Most clients see the difference inside the first 30 days, and there's no long contract.",
        '',
        "If it's worth a closer look, you can grab a 15-minute call with us here:",
        CALENDAR_LINK,
        '',
        "No pressure either way. If now isn't the right time, just let me know."
    ].join('\n');
}

// ── A/B template variants ────────────────────────────────────────────────
// Two arms, deliberately different in BOTH subject and body so the test
// isolates framing (the agent + pain content is identical, set by the
// playbook). A re-send to the same lead always lands the same arm.
//   A · Direct — short, casual subject, gets to the point
//   B · Value  — longer, value-led subject, leads with the cost of the problem
//                (this is the proven baseline templateBody)
// Assignment is deterministic by lead id (even→A, odd→B) so re-opening or
// re-drafting a lead never flips its arm: the body shown is the body sent.
const VARIANT_KEYS = ['A', 'B'];
const VARIANT_LABELS = { A: 'A · Direct', B: 'B · Value' };

function pickVariant(leadId) {
    const n = parseInt(leadId, 10);
    if (!isFinite(n)) return 'B';
    return (n % 2 === 0) ? 'A' : 'B';
}

function variantLabel(v) { return VARIANT_LABELS[v] || ('Variant ' + v); }

// Subject line per arm. A = casual follow-up, B = value-led with the playbook tag.
function buildSubject(variant, opts) {
    const business = opts.business || 'your business';
    const first = opts.firstName;
    const pb = opts.playbook || {};
    if (variant === 'A') {
        return first ? (first + ', quick follow-up from STILO') : ('Quick follow-up from STILO, ' + business);
    }
    return 'An idea for ' + business + ': ' + (pb.subjectTag || 'a quick idea');
}

// Short, direct body (Variant A). Same playbook content as B, tighter framing.
function directBody(opts) {
    const greet = opts.firstName ? ('Hi ' + opts.firstName + ',') : 'Hi there,';
    const sdrFirst = firstName(opts.senderName) || 'the STILO team';
    const business = opts.business || 'your business';
    const pb = opts.playbook;
    return [
        greet,
        '',
        "This is " + sdrFirst + " from STILO AI Partners, following up on my call to " + business + " earlier.",
        '',
        "Short version: " + (pb.painShort || pb.pain),
        '',
        "We build an AI agent that fixes that, " + pb.agent + ": " + pb.oneLiner,
        '',
        "We're a small Miami team. We build it and run it for you, most clients see a difference inside 30 days, and there's no long contract.",
        '',
        "Worth 15 minutes to see if it fits?",
        CALENDAR_LINK,
        '',
        "If now isn't the time, no problem, just say the word."
    ].join('\n');
}

// Body for a given arm. B is the proven long template (templateBody).
function buildVariantBody(variant, opts) {
    return variant === 'A' ? directBody(opts) : templateBody(opts);
}

// Guarantee the booking link is in the body exactly once. If the model dropped
// it, append a clean booking line.
function ensureBookingLink(body) {
    if (body.indexOf(CALENDAR_LINK) !== -1) return body.trim();
    return body.trim() + '\n\n' + "Grab a 15-minute call with us here:\n" + CALENDAR_LINK;
}

// Plain-text footer the rep sees previewed in the composer. Identical content
// to the HTML footer below.
function footerText(sender) {
    return [sender.name, 'STILO AI Partners', sender.phone, MARKETING_SITE].filter(Boolean).join('\n');
}

// Light-mode HTML email. Authored LIGHT on purpose: Gmail's iPhone app force
// inverts dark emails into washed-out gray, while light emails invert cleanly
// (see memory: email-light-for-dark-mode). White bg, near-black text, blue
// accents. Inline CSS only. Body paragraphs come from the rep's editable text;
// the calendar URL becomes a button + link, and the footer is appended here.
function buildEmailHtml(opts) {
    const sender = opts.sender;
    const ctaButton = '<p style="margin:22px 0;"><a href="' + CALENDAR_LINK + '" '
        + 'style="display:inline-block;background:' + BLUE + ';color:#ffffff;text-decoration:none;'
        + 'font-weight:700;font-size:15px;padding:13px 22px;border-radius:8px;">Book a 15-minute call</a></p>';
    const paras = ensureBookingLink(sanitizeCopy(opts.bodyText))
        .split(/\n{2,}/)
        .map(function (block) {
            // Walk lines so a line that is exactly the calendar URL becomes the
            // CTA button (even when it sits one line under the booking sentence,
            // which is how the model usually writes it). Other lines stay text.
            var out = '', buf = [];
            var flush = function () {
                if (buf.length) { out += '<p style="margin:14px 0;">' + buf.join('<br>') + '</p>'; buf = []; }
            };
            block.split('\n').forEach(function (line) {
                if (line.trim() === CALENDAR_LINK) { flush(); out += ctaButton; return; }
                buf.push(escapeHtml(line).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:' + BLUE + ';">$1</a>'));
            });
            flush();
            return out;
        }).join('');

    return [
        '<div style="background:#f4f5f7;padding:24px 0;">',
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:30px 34px;color:#1a1a1a;font-size:15px;line-height:1.6;">',
        paras,
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:26px 0 14px;" />',
        '<table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#4b5563;line-height:1.5;"><tr><td>',
        '<strong style="color:#111111;">' + escapeHtml(sender.name) + '</strong><br>',
        'STILO AI Partners<br>',
        (sender.phone ? escapeHtml(sender.phone) + '<br>' : ''),
        '<a href="https://stiloaipartners.com" style="color:' + BLUE + ';text-decoration:none;">' + MARKETING_SITE + '</a>',
        '</td></tr></table>',
        '</div></div>'
    ].join('');
}

module.exports = {
    CALENDAR_LINK, MARKETING_SITE, PLAYBOOKS, VARIANT_KEYS, VARIANT_LABELS,
    escapeHtml, sanitizeCopy, pickPlaybook, pickPlaybookForLead, playbookKey, firstName, formatPhone,
    getSenderIdentity, templateBody, pickVariant, variantLabel, buildSubject, buildVariantBody,
    ensureBookingLink, footerText, buildEmailHtml
};
