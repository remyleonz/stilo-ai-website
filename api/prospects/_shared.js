/**
 * sites/stilo-ai/api/prospects/_shared.js
 *
 * Shared helpers for the prospecting proxy endpoints. The leading
 * underscore is conventional only — the local serve.js router maps
 * /api/<dir>/<name> straight to the file, so anyone calling
 * /api/prospects/_shared would get 405. The handler at the bottom
 * makes that explicit.
 *
 * Two responsibilities:
 *
 *   1. assertAdmin(req, res) — verify the request comes from an
 *      authenticated admin (mirrors the pattern in api/admin/impersonate.js).
 *   2. forwardToProspecting({...}) — proxy the request to David's
 *      Python backend at PROSPECTING_API_URL with a server-side bearer
 *      token. Browsers never see the URL or the token.
 *
 * Required env vars (validated at call time, not module load):
 *   - SUPABASE_URL, SUPABASE_SERVICE_KEY (admin gate)
 *   - PROSPECTING_API_URL                (upstream base URL)
 *   - PROSPECTING_API_TOKEN              (upstream bearer)
 */

const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAILS = [
    'remyleon11@gmail.com',
    'stiloaiconsulting@gmail.com',
    'remyleon@stiloaipartners.com',
    'davidcoira@stiloaipartners.com'
];

function adminClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    try { return JSON.parse(raw); } catch { return {}; }
}

async function assertAdmin(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
        res.status(401).json({ error: 'missing_token' });
        return { ok: false };
    }
    const sb = adminClient();
    const { data: userData, error } = await sb.auth.getUser(token);
    const email = userData && userData.user && userData.user.email;
    if (error || !email) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    if (!ADMIN_EMAILS.includes(email)) {
        res.status(403).json({ error: 'not_admin' });
        return { ok: false };
    }
    return { ok: true, email: email };
}

function shouldUseShim() {
    const base = process.env.PROSPECTING_API_URL;
    if (!base) return true;
    const lower = String(base).toLowerCase().trim();
    return lower === 'local' || lower === 'shim' || lower === 'supabase';
}

/**
 * Forward a request to PROSPECTING_API_URL.
 *
 * If PROSPECTING_API_URL is missing or set to "local"/"shim"/"supabase", the
 * call is dispatched to the in-process Supabase shim instead (see
 * shim_dispatcher.js). The shim mimics David's API contract one-for-one so
 * the existing route files don't need to know whether they're hitting the
 * real upstream or the local shim.
 *
 * @param {object} opts
 * @param {string} opts.method   'GET' | 'POST' (others rejected upstream)
 * @param {string} opts.path     starts with '/', e.g. '/api/prospects/stats'
 * @param {object} [opts.query]  key/value query params (string or array)
 * @param {object} [opts.body]   JSON body for POST
 * @returns {Promise<{status:number, json:any}>}
 */
async function forwardToProspecting(opts) {
    if (shouldUseShim()) {
        try {
            const dispatcher = require('./shim_dispatcher');
            return await dispatcher.dispatch(opts);
        } catch (e) {
            return { status: 500, json: { error: 'shim_dispatch_failed', detail: String(e.message || e) } };
        }
    }
    const base = process.env.PROSPECTING_API_URL;
    const token = process.env.PROSPECTING_API_TOKEN;
    if (!base) {
        return { status: 503, json: { error: 'prospecting_url_not_configured' } };
    }
    let url = base.replace(/\/+$/, '') + opts.path;
    if (opts.query) {
        const parts = [];
        for (const k in opts.query) {
            const v = opts.query[k];
            if (v == null || v === '') continue;
            const arr = Array.isArray(v) ? v : [v];
            for (const item of arr) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(item)));
            }
        }
        if (parts.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
    }
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const init = { method: opts.method, headers: headers };
    if (opts.body !== undefined && opts.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        return { status: 502, json: { error: 'prospecting_unavailable', detail: String(e && e.message || e) } };
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { json = { raw: text }; }
    return { status: res.status, json: json };
}

function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return res.status(405).json({ error: 'method_not_allowed' });
}

function safeNumberId(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n;
}

module.exports = async function (req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};

module.exports.assertAdmin = assertAdmin;
module.exports.forwardToProspecting = forwardToProspecting;
module.exports.readJsonBody = readJsonBody;
module.exports.methodNotAllowed = methodNotAllowed;
module.exports.safeNumberId = safeNumberId;
