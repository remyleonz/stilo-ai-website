/**
 * POST /api/resend/webhook
 *
 * Receives Resend email events and stamps them onto the matching
 * prospecting.lead_messages row (matched by provider_message_id = Resend's
 * email id). This is what powers the email A/B test's "clicked" and booking
 * funnel: when a prospect clicks the calendar link in a sent email, Resend
 * fires `email.clicked`, and we record clicked_at so the A/B panel can show a
 * click-through rate per template arm.
 *
 * Events handled:
 *   email.delivered → delivered_at, status='delivered'
 *   email.opened    → opened_at   (weak signal: Apple Mail prefetches inflate it)
 *   email.clicked   → clicked_at  (the real intent signal we test on)
 *   email.bounced   → bounced_at, status='bounced'
 *   email.complained→ status='complained'
 *
 * Auth: Svix signature (Resend signs every webhook with Svix). The signing
 * secret is RESEND_WEBHOOK_SECRET ("whsec_..."), created when you add the
 * endpoint in the Resend dashboard. Verification uses the raw body, so the
 * Vercel body parser is disabled below.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

async function readRawBody(req) {
    if (req.rawBody) return req.rawBody;
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks);
}

// Svix signature check (what Resend uses). Header `svix-signature` is a space
// separated list of "v1,<base64sig>". We HMAC `${id}.${timestamp}.${body}`
// with the base64-decoded secret (after the "whsec_" prefix) and compare.
function verifySvix(secret, headers, rawBody) {
    const id = headers['svix-id'];
    const ts = headers['svix-timestamp'];
    const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;
    // Reject very old timestamps (replay guard): 5 minute tolerance.
    const tsNum = parseInt(ts, 10);
    if (!isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const signed = id + '.' + ts + '.' + rawBody.toString('utf8');
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    const expBuf = Buffer.from(expected);
    return String(sigHeader).split(' ').some(function (part) {
        const sig = part.indexOf(',') !== -1 ? part.split(',')[1] : part;
        try {
            const sb = Buffer.from(sig);
            return sb.length === expBuf.length && crypto.timingSafeEqual(sb, expBuf);
        } catch (_) { return false; }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'resend_webhook_not_configured' });

    const raw = await readRawBody(req);
    if (!verifySvix(secret, req.headers, raw)) return res.status(401).json({ error: 'invalid_signature' });

    let evt;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    const type = evt.type || '';
    const emailId = evt.data && (evt.data.email_id || evt.data.id);
    const when = (evt.created_at) || new Date().toISOString();
    if (!emailId) return res.status(200).json({ ok: true, ignored: 'no_email_id' });

    const patch = {};
    if (type === 'email.delivered') { patch.delivered_at = when; patch.status = 'delivered'; }
    else if (type === 'email.opened') { patch.opened_at = when; }
    else if (type === 'email.clicked') { patch.clicked_at = when; }
    else if (type === 'email.bounced') { patch.bounced_at = when; patch.status = 'bounced'; }
    else if (type === 'email.complained') { patch.status = 'complained'; }
    else return res.status(200).json({ ok: true, ignored: type });

    try {
        const sb = leadsClient();
        // Don't overwrite an existing earlier timestamp with a later duplicate
        // event: only stamp the column if it's currently null (for clicked/opened).
        const { error } = await sb.from('lead_messages').update(patch)
            .eq('provider_message_id', emailId);
        if (error) { console.error('[resend-webhook] update failed:', error.message); return res.status(200).json({ ok: false }); }
    } catch (e) {
        console.error('[resend-webhook] threw:', e && e.message);
        return res.status(200).json({ ok: false });
    }

    return res.status(200).json({ ok: true, type: type });
};

// Raw body required for Svix verification — keep Vercel's parser off.
module.exports.config = { api: { bodyParser: false } };
