/**
 * sites/stilo-ai/api/sdr/_shared.js
 *
 * Auth helpers for /api/sdr/* endpoints. Mirrors api/prospects/_shared.js
 * but accepts either:
 *   - role='admin' (admins see/manage all SDRs)
 *   - role='sdr'   (SDRs see only their own scope)
 *
 * Returns a `caller` object with the resolved SDR identity so handlers
 * don't have to re-query sdr_users themselves.
 */

const { createClient } = require('@supabase/supabase-js');

function admin() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
    });
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

/**
 * Validate the bearer token and resolve the caller.
 *
 * On success returns:
 *   { ok: true, sb, userId, email, isAdmin, sdr: { id, sdr_key, ... } | null }
 *
 * `sdr` is populated when the caller has a sdr_users row (whether they're
 * also an admin or not). Admins without a sdr_users row still pass through
 * with sdr=null and full access to ?sdr_id=...
 *
 * On failure writes a 401/403 to `res` and returns { ok: false }.
 */
async function authSdr(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
        res.status(401).json({ error: 'missing_token' });
        return { ok: false };
    }

    const sb = admin();
    const { data: userData, error } = await sb.auth.getUser(token);
    if (error || !userData || !userData.user) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    const user = userData.user;
    const userId = user.id;
    const email = (user.email || '').toLowerCase();
    const role = (user.app_metadata && user.app_metadata.role) || 'client';
    const isAdmin = role === 'admin';
    const isSdr = role === 'sdr';

    if (!isAdmin && !isSdr) {
        res.status(403).json({ error: 'not_sdr_or_admin' });
        return { ok: false };
    }

    // Resolve sdr_users row for this user (if any)
    const { data: sdrRow } = await sb
        .from('sdr_users')
        .select('id, email, sdr_key, display_name, initials, avatar_color, commission_pct, commission_mrr_pct, active, daily_call_quota, openphone_number, hired_at')
        .eq('auth_user_id', userId)
        .maybeSingle();

    return {
        ok: true,
        sb,
        userId,
        email,
        isAdmin,
        isSdr,
        sdr: sdrRow || null
    };
}

/**
 * Resolve which SDR's data the request is asking about.
 *
 *   - SDR caller: always their own sdr_users row. ?sdr_id is ignored.
 *   - Admin caller: ?sdr_id=<uuid> picks a specific SDR. Omit for all SDRs.
 *
 * Returns { sdrId, isAllScope } where isAllScope is true when an admin
 * didn't pin a specific SDR.
 */
async function resolveScope(req, caller) {
    if (caller.isSdr && caller.sdr) {
        return { sdrId: caller.sdr.id, isAllScope: false, sdr: caller.sdr };
    }
    // Admin path
    const sdrId = (req.query && req.query.sdr_id) || null;
    if (!sdrId) return { sdrId: null, isAllScope: true, sdr: null };
    const { data: sdr } = await caller.sb
        .from('sdr_users')
        .select('id, email, sdr_key, display_name, initials, avatar_color, commission_pct, commission_mrr_pct, daily_call_quota')
        .eq('id', sdrId)
        .maybeSingle();
    return { sdrId, isAllScope: false, sdr: sdr || null };
}

function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return res.status(405).json({ error: 'method_not_allowed' });
}

module.exports = async function (req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};
module.exports.authSdr = authSdr;
module.exports.resolveScope = resolveScope;
module.exports.readJsonBody = readJsonBody;
module.exports.methodNotAllowed = methodNotAllowed;
