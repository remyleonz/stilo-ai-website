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
    const role = (userData.user.app_metadata && userData.user.app_metadata.role) || null;
    const isAdmin = role === 'admin' || ADMIN_EMAILS.includes(email);
    if (!isAdmin) {
        res.status(403).json({ error: 'not_admin' });
        return { ok: false };
    }
    return { ok: true, email: email };
}

/**
 * Like assertAdmin but accepts admin OR sdr roles. Returns caller details so
 * the handler can scope queries (e.g. force ?assigned_to=email for SDRs).
 */
async function assertAdminOrSdr(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'missing_token' }); return { ok: false }; }

    const sb = adminClient();
    const { data: userData, error } = await sb.auth.getUser(token);
    const user = userData && userData.user;
    if (error || !user || !user.email) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    const email = user.email;
    const role = (user.app_metadata && user.app_metadata.role) || null;
    const isAdmin = role === 'admin' || ADMIN_EMAILS.includes(email);
    const isSdr = role === 'sdr';
    if (!isAdmin && !isSdr) {
        res.status(403).json({ error: 'not_admin_or_sdr' });
        return { ok: false };
    }
    return { ok: true, email: email, role: role, isAdmin: isAdmin, isSdr: isSdr };
}

/**
 * Force-scope a query object to the SDR's email when the caller is an SDR.
 * Admins can pass ?assigned_to=... explicitly. SDRs always have their own
 * email injected and cannot view another SDR's data even if they try.
 */
function scopedQuery(caller, q) {
    const out = Object.assign({}, q || {});
    if (caller && caller.isSdr && !caller.isAdmin) {
        out.assigned_to = caller.email;
    }
    return out;
}

/**
 * Forward a request to PROSPECTING_API_URL (David's FastAPI Cloud Run service
 * at stilo-api-...run.app). The shim_dispatcher fallback was removed when
 * David's service went live — there's no in-process stand-in anymore.
 *
 * @param {object} opts
 * @param {string} opts.method   'GET' | 'POST' (others rejected upstream)
 * @param {string} opts.path     starts with '/', e.g. '/api/prospects/stats'
 * @param {object} [opts.query]  key/value query params (string or array)
 * @param {object} [opts.body]   JSON body for POST
 * @returns {Promise<{status:number, json:any}>}
 */
async function forwardToProspecting(opts) {
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

// Start of "today" in America/New_York, returned as a Date (UTC instant).
// We're on ET (Miami) and the calling day should end at midnight ET, not UTC,
// so an evening call doesn't roll out of "Calls Today" at 7pm. DST-aware via
// Intl.DateTimeFormat — no extra dependency.
function startOfDayET() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const utcWall = now.toLocaleString('sv-SE', { timeZone: 'UTC' });                    // YYYY-MM-DD HH:mm:ss
    const etWall  = now.toLocaleString('sv-SE', { timeZone: 'America/New_York' });
    const utcMs = new Date(utcWall.replace(' ', 'T') + 'Z').getTime();
    const etMs  = new Date(etWall.replace(' ', 'T') + 'Z').getTime();
    const offsetMs = utcMs - etMs; // positive in ET (UTC-5 / UTC-4)
    const etMidnightUtc = new Date(etDateStr + 'T00:00:00Z').getTime();
    return new Date(etMidnightUtc + offsetMs);
}

module.exports = async function (req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};

/**
 * Resolve a `?assigned_to=` parameter into an email. Accepts:
 *   - A full email (returned as-is, lowercased)
 *   - An sdr_key (looked up against sdr_users via a 60s memoized cache)
 *   - null/empty (returns null)
 *
 * The lookup-cache means high-throughput endpoints (lifecycle-stats,
 * callable) don't hit the DB per request. Cache invalidates after 60s
 * so newly-hired SDRs become resolvable within a minute.
 */
let _sdrKeyCache = null;
let _sdrKeyCacheAt = 0;
async function loadSdrKeyMap() {
    const now = Date.now();
    if (_sdrKeyCache && (now - _sdrKeyCacheAt) < 60_000) return _sdrKeyCache;
    try {
        const sb = adminClient();
        const { data } = await sb.from('sdr_users').select('sdr_key, email').eq('active', true);
        const m = {};
        (data || []).forEach(r => { if (r.sdr_key && r.email) m[r.sdr_key.toLowerCase()] = r.email.toLowerCase(); });
        // Legacy aliases (Remy + David sometimes referenced as sdr_keys in callers)
        if (!m.remy)  m.remy  = 'remyleon@stiloaipartners.com';
        if (!m.david) m.david = 'davidcoira@stiloaipartners.com';
        _sdrKeyCache = m;
        _sdrKeyCacheAt = now;
        return m;
    } catch (e) {
        // On DB error fall back to legacy map so prod doesn't 500
        return { remy: 'remyleon@stiloaipartners.com', david: 'davidcoira@stiloaipartners.com' };
    }
}

async function resolveAssignedTo(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (v.indexOf('@') > 0) return v;
    const map = await loadSdrKeyMap();
    return map[v] || null;
}

module.exports.assertAdmin = assertAdmin;
module.exports.assertAdminOrSdr = assertAdminOrSdr;
module.exports.scopedQuery = scopedQuery;
module.exports.resolveAssignedTo = resolveAssignedTo;
module.exports.loadSdrKeyMap = loadSdrKeyMap;
module.exports.forwardToProspecting = forwardToProspecting;
module.exports.readJsonBody = readJsonBody;
module.exports.methodNotAllowed = methodNotAllowed;
module.exports.safeNumberId = safeNumberId;
module.exports.startOfDayET = startOfDayET;
