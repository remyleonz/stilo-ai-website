/**
 * Transactional email send, Gmail first with a Resend fallback.
 *
 * WHY GMAIL FOR TRANSACTIONAL. Confirmations and reminders go to people who
 * just booked a meeting and know Remy by name. Sending those through the actual
 * Google Workspace mailbox they already correspond with gets near-perfect inbox
 * placement, threads replies into the real inbox, and is completely insulated
 * from cold-email reputation.
 *
 * Cold outreach (vsl-campaign.js) deliberately stays on Resend. That is the
 * whole point of the split: a cold blast at 100-250/day can no longer damage
 * the deliverability of the emails a BOOKED prospect has to see. Before this,
 * both shared one identity, which is why the 2026-07-01 DNS fix did not hold
 * and why Max Bertrand found his confirmation in spam on 2026-07-20.
 *
 * FALLS BACK, NEVER FAILS CLOSED. If the Gmail grant is missing or the token is
 * dead, this silently uses Resend. A deliverability upgrade must not be able to
 * stop a prospect being told their meeting is confirmed.
 *
 * Requires the 'gmail' oauth provider (gmail.send scope) authorized as
 * remyleon@stiloaipartners.com:
 *   /api/oauth?provider=gmail&action=start
 */
const { createClient } = require('@supabase/supabase-js');

const SENDER_EMAIL = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
const SENDER_NAME = process.env.STILO_SENDER_NAME || 'Remy Leon';
const GMAIL_REAUTH_URL = '/api/oauth?provider=gmail&action=start';

async function getGmailRefreshToken() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data } = await sb.from('oauth_tokens')
            .select('refresh_token').eq('provider', 'gmail').maybeSingle();
        return (data && data.refresh_token) || process.env.GMAIL_REFRESH_TOKEN || null;
    } catch (_) {
        return process.env.GMAIL_REFRESH_TOKEN || null;
    }
}

async function gmailAccessToken(refreshToken) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });
    if (!r.ok) throw new Error('gmail_refresh_failed: ' + (await r.text()).slice(0, 160));
    return (await r.json()).access_token;
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 for non-ASCII subjects. Without this an accented business name turns
// into mojibake in the subject line.
function encodeHeader(v) {
    const s = String(v == null ? '' : v);
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// Header injection guard: a newline in a subject or address would let caller
// data forge extra headers.
function sanitizeHeader(v) {
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

function buildRaw(opts) {
    const lines = [
        'From: ' + encodeHeader(SENDER_NAME) + ' <' + SENDER_EMAIL + '>',
        'To: ' + sanitizeHeader(opts.to),
        'Subject: ' + encodeHeader(sanitizeHeader(opts.subject)),
        'Reply-To: ' + sanitizeHeader(opts.replyTo || SENDER_EMAIL),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
    ];
    const h = opts.headers || {};
    Object.keys(h).forEach(function (k) {
        if (h[k]) lines.push(sanitizeHeader(k) + ': ' + sanitizeHeader(h[k]));
    });
    lines.push('');
    lines.push(String(opts.text || ''));
    return b64url(Buffer.from(lines.join('\r\n'), 'utf8'));
}

async function sendViaGmail(opts) {
    const refresh = await getGmailRefreshToken();
    if (!refresh) return { skip: 'no_gmail_token', reauth: GMAIL_REAUTH_URL };
    const token = await gmailAccessToken(refresh);
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: buildRaw(opts) })
    });
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error('gmail_send_failed_' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
    return { status: 200, id: j.id, err: null, via: 'gmail' };
}

async function sendViaResend(opts) {
    if (!process.env.RESEND_API_KEY) return { skip: 'no_email_or_key' };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: SENDER_NAME + ' <' + SENDER_EMAIL + '>',
            to: [opts.to],
            reply_to: opts.replyTo || SENDER_EMAIL,
            subject: opts.subject,
            text: opts.text,          // plain text only: no html part, no pixel
            headers: opts.headers,
        })
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, err: r.ok ? null : (j.message || 'fail'), via: 'resend' };
}

/**
 * sendTransactional({ to, subject, text, replyTo?, headers? })
 * Gmail if authorized, otherwise Resend. Returns { status, id, err, via }.
 */
async function sendTransactional(opts) {
    if (!opts || !opts.to) return { skip: 'no_email' };
    try {
        const g = await sendViaGmail(opts);
        if (!g.skip) return g;
        // No grant yet: fall through quietly, this is the expected state until
        // someone authorizes the gmail provider.
    } catch (e) {
        console.error('[transactional] Gmail send failed, falling back to Resend:', (e && e.message) || e);
    }
    return await sendViaResend(opts);
}

module.exports = { sendTransactional, sendViaGmail, sendViaResend, gmailAccessToken, GMAIL_REAUTH_URL, SENDER_EMAIL, SENDER_NAME };
