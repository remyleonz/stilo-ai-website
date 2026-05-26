/**
 * api/admin/deals/_shared.js
 *
 * Auth + helpers for /api/admin/deals/* endpoints.
 * Admin-only — SDRs never touch any of these.
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

async function assertAdmin(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'missing_token' }); return { ok: false }; }
    const sb = admin();
    const { data: userData, error } = await sb.auth.getUser(token);
    if (error || !userData || !userData.user) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    const user = userData.user;
    const role = (user.app_metadata && user.app_metadata.role) || null;
    const isAdmin = role === 'admin';
    if (!isAdmin) {
        res.status(403).json({ error: 'admin_only' });
        return { ok: false };
    }
    return { ok: true, sb, user, userId: user.id, email: user.email };
}

function logEvent(sb, dealId, eventType, opts) {
    return sb.from('deal_events').insert({
        deal_id: dealId,
        event_type: eventType,
        from_value: opts && opts.fromValue || null,
        to_value: opts && opts.toValue || null,
        body: opts && opts.body || null,
        attachments: (opts && opts.attachments) || [],
        actor_user_id: opts && opts.actorUserId || null,
        actor_role: (opts && opts.actorRole) || 'admin'
    });
}

function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return res.status(405).json({ error: 'method_not_allowed' });
}

module.exports = async function (req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};
module.exports.assertAdmin = assertAdmin;
module.exports.readJsonBody = readJsonBody;
module.exports.logEvent = logEvent;
module.exports.methodNotAllowed = methodNotAllowed;
