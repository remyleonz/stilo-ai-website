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
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
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
 * Verify the HMAC-SHA256 signature header that OpenPhone attaches to webhook
 * deliveries. OpenPhone sends `openphone-signature` of the form
 *   `hmac;1;<timestamp>;<base64(hmac_sha256(secret, timestamp + ":" + body))>`
 * (their docs use a semicolon-delimited scheme — we tolerate either that or a
 * plain `t=...,v1=...` style, since both have shipped). Returns true on match.
 */
function verifySignature(headerValue, rawBody) {
    const secret = process.env.OPENPHONE_WEBHOOK_SIGNING_SECRET;
    if (!secret) return false;
    if (!headerValue) return false;

    const tryHmac = function (timestamp, expectedB64) {
        const payload = (timestamp ? timestamp + ':' : '') + rawBody.toString('utf8');
        const computed = crypto.createHmac('sha256', secret).update(payload).digest('base64');
        if (computed.length !== expectedB64.length) return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedB64));
        } catch (_) { return false; }
    };

    if (headerValue.indexOf(';') !== -1) {
        const parts = headerValue.split(';').map(function (s) { return s.trim(); });
        if (parts.length >= 4) {
            const ts = parts[2];
            const sig = parts[3];
            if (tryHmac(ts, sig)) return true;
        }
    }
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
