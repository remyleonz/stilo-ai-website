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
const AGENTS = {
    'receptionist': { name: 'Receptionist' },
    'lead-reply':   { name: 'Outbound Lead Reply' },
    'reactivation': { name: 'Lost Customer Reactivation' },
    'prospecting':  { name: 'B2B Lead Generator' },
    'website':      { name: 'Website' },
    'sales-agent':  { name: 'Sales Coach' }
};
const DEFAULT_AGENT = 'receptionist';

// Accept a few friendly aliases (dashboard codenames / product ids) so the SDR
// or lead.matched_product can pass whatever it has and still resolve a slug.
const ALIASES = {
    echo: 'receptionist', ignite: 'lead-reply', revive: 'reactivation', lcr: 'reactivation',
    scout: 'prospecting', forge: 'website',
    pitch: 'sales-agent', sales: 'sales-agent', web: 'website'
};

function isEnabled() {
    return process.env.VSL_FLOW_ENABLED === 'true';
}

function agentKey(a) {
    const k = String(a || '').toLowerCase().trim();
    if (AGENTS[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    return DEFAULT_AGENT;
}

function baseUrl() {
    return (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
}

function landingUrl(slug, leadId) {
    var url = baseUrl() + '/agents/' + agentKey(slug);
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
function buildConfirmEmailHtml(opts) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'America/New_York'
    });
    const whenStr = opts.whenIso ? fmt.format(new Date(opts.whenIso)) : 'the time we set';
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const confirmUrl = baseUrl() + '/api/prospects/confirm-meeting?token=' + encodeURIComponent(opts.token);
    const a = AGENTS[agentKey(opts.agent)];
    return [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;font-size:15px;line-height:1.55;">',
        '<p>Hi ' + escapeHtml(opts.firstName || 'there') + ',</p>',
        '<p>Great talking with you. I have us down for <strong>' + escapeHtml(whenStr) + '</strong> to walk through how the <strong>' + escapeHtml(a.name) + '</strong> agent would work for ' + escapeHtml(opts.businessName || 'your business') + '.</p>',
        '<p>One quick thing so I know you are still good for it: hit the button below to confirm. It also pulls up a short walkthrough of exactly what I will show you on the call.</p>',
        '<div style="text-align:center;margin:28px 0;">',
        '<a href="' + escapeHtml(confirmUrl) + '" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;">Confirm my meeting</a>',
        '</div>',
        '<p style="color:#374151;font-size:13px;">Cannot make it anymore? Just reply and we will find a better time.</p>',
        '<p>Talk soon,<br/>' + escapeHtml(senderName) + '</p>',
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" />',
        '<div style="font-size:13px;color:#374151;"><strong style="color:#111;">' + escapeHtml(senderName) + '</strong><br/>STILO AI Partners<br/><a href="' + baseUrl() + '" style="color:#2563EB;text-decoration:none;">stiloaipartners.com</a></div>',
        '</div>'
    ].join('');
}

async function sendConfirmEmail(opts) {
    // opts: { toEmail, firstName, businessName, whenIso, agent, leadId }
    if (!isEnabled()) return { skipped: 'vsl_flow_disabled' };
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    if (!opts.toEmail) return { skipped: 'no_lead_email' };
    const token = signConfirmToken({
        lead: opts.leadId,
        a: agentKey(opts.agent),
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 // 30 days
    });
    const fromName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remy@stiloaipartners.com';
    const replyTo = process.env.STILO_REPLY_TO || fromEmail;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: [opts.toEmail],
            reply_to: replyTo,
            subject: 'Quick confirm for our call, ' + (opts.firstName || 'there'),
            html: buildConfirmEmailHtml({ ...opts, token: token })
        })
    });
    const json = await r.json().catch(function () { return {}; });
    return { status: r.status, id: json.id, error: r.ok ? null : (json.message || 'send_failed') };
}

module.exports = {
    AGENTS, isEnabled, agentKey, landingUrl,
    signConfirmToken, verifyConfirmToken,
    buildConfirmEmailHtml, sendConfirmEmail, baseUrl, escapeHtml
};
