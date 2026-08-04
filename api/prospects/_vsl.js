/**
 * Shared VSL (video sales letter) confirmation plumbing.
 *
 * The flow (see book-meeting.js + confirm-meeting.js):
 *   1. SDR books the closing meeting  -> Google sends its own invite
 *   2. We send a second, STILO-branded "confirm your meeting" email (Resend)
 *   3. Prospect clicks "Confirm my meeting" -> /api/prospects/confirm-meeting
 *   4. We mark the meeting confirmed and redirect them to the EXISTING VSL
 *      landing page for the agent we agreed to sell them: /agents/<slug>
 *      (those pages already exist: autoplay Loom hero + book button + FAQ).
 *
 * IMPORTANT: the whole flow is gated behind VSL_FLOW_ENABLED === 'true'.
 * While some VSL videos are still being filmed we build and preview everything
 * but never send the confirm email to a real prospect. Flip the env var to go
 * live. Nothing here changes existing booking behavior when the flag is off.
 */
const crypto = require('crypto');

// The six live VSL landing pages under /agents/<slug>.html, keyed by slug.
// `name` is only used in the email copy. Slugs must match sites/stilo-ai/agents/.
//
// ai-seo and ontology were retired 2026-07-15: neither VSL was ever filmed, so
// both pages sat on an ambient autoplay <video> with nothing to watch. They are
// redirected to / in vercel.json. Their old aliases (signal/oracle/seo) now
// resolve to the default so no email can link to a retired page. To bring one
// back: re-add it here, drop its redirect, and give it a Loom + poster.
// The five niche VSL landing pages under /vsl/<slug>.html. Slugs must match
// sites/stilo-ai/vsl/ and scripts/build_vsl_pages.py.
//
// 2026-08 pivot: these replaced the eight per-AGENT pages. We sell one offer now
// (booked qualified meetings), so the page a prospect sees is chosen by their
// INDUSTRY, not by which product we picked for them. The old /agents/* slugs are
// redirected in vercel.json so links already sitting in inboxes still resolve.
const AGENTS = {
    'commercial-cleaning':  { name: 'Commercial Cleaning' },
    'commercial-roofing':   { name: 'Commercial Roofing' },
    'staffing':             { name: 'Staffing' },
    'freight':              { name: 'Freight' },
    'industrial-supplies':  { name: 'Industrial Supplies & Equipment' }
};
// No safe default. Sending a roofer the cleaning video is worse than sending
// nothing, so callers that cannot resolve a niche must skip (see sendConfirmEmail).
const DEFAULT_AGENT = null;

// Accept a few friendly aliases (dashboard codenames / product ids) so the SDR
// or lead.matched_product can pass whatever it has and still resolve a slug.
// 'prospecting' is the old slug for b2bleadgen (renamed 2026-07-15). Keep it as an
// alias: emails already in inboxes carry /agents/prospecting links, and vercel.json
// redirects the page, but anything resolving the slug in code still needs it.
const ALIASES = {
    // David's leads.niche / category values, lowercased.
    'janitorial service': 'commercial-cleaning', 'cleaning service': 'commercial-cleaning',
    'house cleaning service': 'commercial-cleaning', 'janitorial equipment supplier': 'commercial-cleaning',
    'commercial cleaning': 'commercial-cleaning', 'cleaning': 'commercial-cleaning',
    'roofing contractor': 'commercial-roofing', 'roofing supply store': 'commercial-roofing',
    'commercial roofing': 'commercial-roofing', 'roofing': 'commercial-roofing', 'roofer': 'commercial-roofing',
    'employment agency': 'staffing', 'temp agency': 'staffing', 'recruiter': 'staffing',
    'executive search firm': 'staffing', 'staffing agency': 'staffing',
    'trucking company': 'freight', 'freight forwarding service': 'freight',
    'logistics service': 'freight', 'logistics': 'freight', 'carrier': 'freight',
    'forklift dealer': 'industrial-supplies', 'industrial equipment supplier': 'industrial-supplies',
    'construction equipment supplier': 'industrial-supplies', 'equipment supplier': 'industrial-supplies',
    'material handling equipment supplier': 'industrial-supplies', 'crane service': 'industrial-supplies',
    'forklift rental service': 'industrial-supplies', 'industrial equipment': 'industrial-supplies',
    'supplies': 'industrial-supplies', 'equipment': 'industrial-supplies'
};

function isEnabled() {
    return process.env.VSL_FLOW_ENABLED === 'true';
}

// The 2026-08 pivot sells booked qualified meetings, not an agent. Leads briefed
// under the new offer carry pitch_agent='Booked Meetings', which matches no slug
// here, so agentKey() would quietly resolve it to DEFAULT_AGENT and mail a
// commercial roofer the retired AI Receptionist VSL. isBookedMeetings() lets the
// send path skip instead of sending the wrong product. Remove this once the
// Pipeline System VSL page exists at /agents/pipeline-system and is added to
// AGENTS above.
function isBookedMeetings(a) {
    return /booked meeting|qualified meeting|pipeline system/i.test(String(a || ''));
}

function agentKey(a) {
    const k = String(a || '').toLowerCase().trim();
    if (!k) return DEFAULT_AGENT;
    if (AGENTS[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    // Loose match. David's niche values have a long tail ("Farm equipment
    // supplier", "Hydraulic equipment supplier", "Crane rental agency", ...) that
    // an exact alias table will never keep up with. This MUST stay identical to
    // nicheSlug() in assets/vsl-agents.js: when the client resolves a niche the
    // server cannot, the rep sees a video selected in the dropdown and the
    // prospect receives no link at all.
    if (/clean|janitor/.test(k)) return 'commercial-cleaning';
    if (/roof/.test(k)) return 'commercial-roofing';
    if (/staff|recruit|employment|temp agency|talent|nursing agency/.test(k)) return 'staffing';
    if (/freight|truck|logistic|carrier|3pl|shipping/.test(k)) return 'freight';
    if (/equipment|forklift|industrial|suppl|material handling|crane/.test(k)) return 'industrial-supplies';
    return DEFAULT_AGENT;   // null. Callers MUST handle it; see sendConfirmEmail.
}

// Resolve a lead to its niche page. leads.niche is the value David sets; category
// is the older Google-Places string. Try both before giving up.
function nicheForLead(lead) {
    const d = lead || {};
    return agentKey(d.niche) || agentKey(d.category) || null;
}

function baseUrl() {
    return (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
}

function landingUrl(slug, leadId) {
    var slugKey = agentKey(slug);
    if (!slugKey) return baseUrl() + '/';   // never guess a niche
    var url = baseUrl() + '/vsl/' + slugKey;
    // When we know the lead, sign an attribution token onto the link so a
    // booking from the landing-page slot picker writes straight to that lead
    // (auto-appears in the admin dashboard, no fuzzy matching). Best-effort.
    if (leadId != null) {
        try {
            var t = require('../public/_token').signLead(leadId);
            if (t) url += '?lid=' + encodeURIComponent(leadId) + '&t=' + encodeURIComponent(t);
        } catch (e) { /* attribution is a nice-to-have; never break the redirect */ }
    }
    return url;
}

function confirmationUrl(leadId) {
    var url = baseUrl() + '/vsl/confirmation';
    if (leadId != null) {
        try {
            var t = require('../public/_token').signLead(leadId);
            if (t) url += '?lid=' + encodeURIComponent(leadId) + '&t=' + encodeURIComponent(t);
        } catch (e) { /* attribution is a nice-to-have */ }
    }
    return url;
}

// ---- signed confirm token (HMAC, verify without a DB round-trip) ----
// Reuses a server-only secret so no new env var is required in prod.
function tokenSecret() {
    return process.env.VSL_TOKEN_SECRET
        || process.env.SUPABASE_SERVICE_KEY
        || process.env.STRIPE_WEBHOOK_SECRET
        || 'stilo-vsl-dev-secret';
}
function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}
function signConfirmToken(payload) {
    // payload: { lead, a (slug), exp (unix seconds) }
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', tokenSecret()).update(body).digest());
    return body + '.' + sig;
}
function verifyConfirmToken(token) {
    if (!token || String(token).indexOf('.') === -1) return null;
    const parts = String(token).split('.');
    const body = parts[0], sig = parts[1];
    const expected = b64url(crypto.createHmac('sha256', tokenSecret()).update(body).digest());
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(body)); } catch (e) { return null; }
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// The second, STILO-branded confirmation email. Light theme (Gmail dark-mode
// inverts light emails cleanly). One clear CTA: confirm the meeting, which also
// drops them on the VSL landing page for the agent we're selling them.
// PLAIN TEXT. No button, no card, no footer table, no brand-coloured links.
// Same reasoning as send-confirmations.js: every one of those is a Promotions
// signal, and this email goes to someone who just booked a call and needs to
// actually see it. Kept the name buildConfirmEmailHtml -> buildConfirmEmailText
// so nothing silently keeps passing HTML.
function buildConfirmEmailText(opts) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York'
    });
    const whenStr = opts.whenIso ? fmt.format(new Date(opts.whenIso)) : 'the time we set';
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const confirmUrl = baseUrl() + '/api/prospects/confirm-meeting?token=' + encodeURIComponent(opts.token);
    return [
        'Hi ' + (opts.firstName || 'there') + ',',
        '',
        'Good talking with you. I have us down for ' + whenStr + '.',
        '',
        'One quick thing so I know you are still good for it. Confirm here, and the same page has a '
            + 'short video of me running through exactly what happens on the call, how we charge, and '
            + 'who you are actually dealing with:',
        confirmUrl,
        '',
        'Worth three minutes before we talk. It means we can skip the background and spend our time on '
            + (opts.businessName || 'your business') + '.',
        '',
        'Cannot make it anymore? Just reply and we will find a better time.',
        '',
        'Talk soon,',
        senderName,
        'STILO AI Partners',
    ].join('\n');
}

async function sendConfirmEmail(opts) {
    // opts: { toEmail, firstName, businessName, whenIso, agent, leadId }
    if (!isEnabled()) return { skipped: 'vsl_flow_disabled' };
    if (!opts.toEmail) return { skipped: 'no_lead_email' };
    // The confirmation video is the same for every prospect (who I am / how we
    // charge / what happens on the call), so unlike the niche VSLs it never needs
    // a niche to resolve. The old guard that skipped 'Booked Meetings' is gone
    // because /vsl/confirmation now exists.
    const token = signConfirmToken({
        lead: opts.leadId,
        a: agentKey(opts.agent) || 'confirmation',
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 // 30 days
    });
    // Gmail first, Resend fallback. Transactional mail to a booked prospect
    // must not ride the same reputation as the cold campaign.
    const { sendTransactional } = require('./_gmail_send');
    const replyTo = process.env.STILO_REPLY_TO || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const r = await sendTransactional({
        to: opts.toEmail,
        subject: 'Quick confirm for our call, ' + (opts.firstName || 'there'),
        text: buildConfirmEmailText({ ...opts, token: token }),
        replyTo: replyTo,
    });
    return { status: r.status, id: r.id, error: r.err || null, via: r.via };
}

module.exports = {
    isBookedMeetings, nicheForLead, confirmationUrl,
    AGENTS, isEnabled, agentKey, landingUrl,
    signConfirmToken, verifyConfirmToken,
    buildConfirmEmailText, sendConfirmEmail, baseUrl, escapeHtml
};
