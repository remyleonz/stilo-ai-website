/**
 * sites/stilo-ai/api/openphone/_shared.js
 *
 * Shared helpers for the OpenPhone routes.
 *
 *   verifySignature(req, raw)  — HMAC-SHA256 verification of OpenPhone webhook
 *                                payloads using OPENPHONE_WEBHOOK_SIGNING_SECRET.
 *   openphoneFetch(...)        — small wrapper around fetch for the OpenPhone
 *                                REST API at https://api.openphone.com/v1.
 *   serviceClient()            — Supabase client using the service role key.
 *   readRawBody(req)           — buffer the request body before JSON.parse so
 *                                signature verification has the exact bytes.
 *   normalizePhone(s)          — strip non-digits, force E.164 if 10/11-digit US.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const OPENPHONE_API_BASE = 'https://api.openphone.com/v1';

function serviceClient() {
    // The openphone routes read/write the prospecting schema (David's lead
    // pipeline tables). Default schema is set explicitly so we don't rely on
    // the role's search_path.
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
}

async function readRawBody(req) {
    if (req.rawBody) return req.rawBody;
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Verify the HMAC-SHA256 signature header that OpenPhone (now Quo) attaches
 * to webhook deliveries. Canonical scheme per their reference impl:
 *
 *   header  = `openphone-signature: hmac;1;<timestamp>;<base64sig>`
 *   sig     = base64( HMAC_SHA256( base64decode(secret), `${ts}.${rawBody}` ) )
 *
 * Two non-obvious bits that we used to get wrong:
 *   1. The signing secret value Quo gives you is itself base64 — it must be
 *      base64-decoded before being used as the HMAC key. Using the raw string
 *      (which is what we did originally) silently produced a different MAC
 *      and 401'd every event.
 *   2. The separator between timestamp and body is `.`, not `:`.
 *
 * Returns true on match.
 */
function verifySignature(headerValue, rawBody) {
    const secret = process.env.OPENPHONE_WEBHOOK_SIGNING_SECRET;
    if (!secret) return false;
    if (!headerValue) return false;

    const keyBinary = Buffer.from(secret, 'base64');
    const bodyStr = rawBody.toString('utf8');

    const tryHmac = function (timestamp, expectedB64) {
        if (!expectedB64) return false;
        const payload = (timestamp ? timestamp + '.' : '') + bodyStr;
        const computed = crypto.createHmac('sha256', keyBinary).update(payload).digest('base64');
        if (computed.length !== expectedB64.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedB64));
        } catch (_) { return false; }
    };

    // Canonical: hmac;1;<ts>;<sig>
    if (headerValue.indexOf(';') !== -1) {
        const parts = headerValue.split(';').map(function (s) { return s.trim(); });
        if (parts.length >= 4) {
            const ts = parts[2];
            const sig = parts[3];
            if (tryHmac(ts, sig)) return true;
        }
    }
    // Stripe-style fallback: t=<ts>,v1=<sig>
    if (headerValue.indexOf('=') !== -1) {
        const fields = {};
        headerValue.split(',').forEach(function (chunk) {
            const eq = chunk.indexOf('=');
            if (eq < 0) return;
            fields[chunk.slice(0, eq).trim()] = chunk.slice(eq + 1).trim();
        });
        if (fields.t && fields.v1) {
            if (tryHmac(fields.t, fields.v1)) return true;
        }
    }
    // Last resort: raw signature only, no timestamp prefix.
    return tryHmac('', headerValue);
}

async function openphoneFetch(opts) {
    const apiKey = process.env.OPENPHONE_API_KEY;
    if (!apiKey) {
        return { status: 503, json: { error: 'openphone_not_configured' } };
    }
    const url = OPENPHONE_API_BASE + opts.path;
    const headers = {
        'Authorization': apiKey,
        'Accept': 'application/json'
    };
    const init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        return { status: 502, json: { error: 'openphone_unreachable', detail: String(e && e.message || e) } };
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { json = { raw: text }; }
    return { status: res.status, json: json };
}

function normalizePhone(s) {
    if (!s) return null;
    const digits = String(s).replace(/[^\d]/g, '');
    if (!digits) return null;
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    return '+' + digits;
}

function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return res.status(405).json({ error: 'method_not_allowed' });
}

module.exports = async function (_req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};
module.exports.serviceClient = serviceClient;
module.exports.verifySignature = verifySignature;
module.exports.openphoneFetch = openphoneFetch;
module.exports.readRawBody = readRawBody;
module.exports.normalizePhone = normalizePhone;
module.exports.methodNotAllowed = methodNotAllowed;
module.exports.OPENPHONE_API_BASE = OPENPHONE_API_BASE;
