/**
 * /api/client-leads/state — per-client CRM state for the leads dashboard.
 *
 * GET   ?client_id=<uuid>      → returns the stored state
 * PATCH ?client_id=<uuid>      → merges the body into the state
 *
 * Storage: client_agents.config.lead_state (JSONB) on the client's
 * lead_generator / scout agent row. Picked because:
 *   - No DDL needed (column already exists).
 *   - Naturally scoped to a single client+agent.
 *   - JSONB merge is a single round-trip.
 *
 * State shape (all keyed by lead_key = slug(business):last7(phone)):
 *   {
 *     tier_overrides: { '<lead_key>': 'hot'|'warm'|'cool'|'dead' },
 *     call_logs:      { '<lead_key>': [{ at, outcome, notes }] },
 *     callbacks:      { '<lead_key>': { at } },
 *     booked:         { '<lead_key>': { at } },
 *     signed:         { '<lead_key>': { at } }
 *   }
 *
 * Auth: same two-path gate as /api/client-leads — admin (impersonation)
 * or the client themselves (session.user.id === client_id).
 */
const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAILS = [
    'remyleon11@gmail.com',
    'stiloaiconsulting@gmail.com',
    'remyleon@stiloaipartners.com',
    'davidcoira@stiloaipartners.com'
];

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    try { return JSON.parse(raw); } catch { return {}; }
}

function emptyState() {
    return {
        tier_overrides: {},
        call_logs: {},
        callbacks: {},
        booked: {},
        signed: {}
    };
}

async function authGate(req, res, sb, clientId) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'missing_token' }); return null; }
    const { data: userData, error } = await sb.auth.getUser(token);
    const email = userData && userData.user && (userData.user.email || '').toLowerCase();
    const userId = userData && userData.user && userData.user.id;
    if (error || !email) { res.status(401).json({ error: 'invalid_token' }); return null; }
    const isAdmin = ADMIN_EMAILS.includes(email);
    const isSelf = userId && userId === clientId;
    if (!isAdmin && !isSelf) { res.status(403).json({ error: 'forbidden' }); return null; }
    return { email, userId, isAdmin };
}

async function loadAgentRow(sb, clientId) {
    // Pull the lead_generator/scout row plus its config. order(created_at)
    // picks the oldest one in the unlikely case there are duplicates.
    const { data, error } = await sb.from('client_agents')
        .select('id, agent_type, config, client_id')
        .eq('client_id', clientId)
        .in('agent_type', ['lead_generator', 'scout'])
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) throw new Error('agent_lookup_failed: ' + error.message);
    return data;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, PATCH, POST');
        return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }
    const clientId = (req.query.client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
    const gate = await authGate(req, res, sb, clientId);
    if (!gate) return;

    let agent;
    try { agent = await loadAgentRow(sb, clientId); }
    catch (e) { return res.status(500).json({ error: 'agent_lookup_failed', detail: String(e.message || e) }); }
    if (!agent) {
        // No lead_generator agent yet — return empty state but don't 404,
        // so the dashboard can still render and we can lazily provision.
        return res.status(200).json({ state: emptyState(), note: 'no_agent_row' });
    }

    if (req.method === 'GET') {
        const state = (agent.config && agent.config.lead_state) || emptyState();
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ state: state, agent_id: agent.id });
    }

    // PATCH / POST: merge the body into the existing state and write back.
    const body = await readJsonBody(req);
    const incoming = body && body.state ? body.state : body;
    if (!incoming || typeof incoming !== 'object') {
        return res.status(400).json({ error: 'invalid_body' });
    }
    const current = (agent.config && agent.config.lead_state) || emptyState();
    // Shallow merge per top-level key so the client can send a partial
    // update like { tier_overrides: { '<key>': 'dead' } } without
    // clobbering call_logs etc. Each top-level value gets shallow-merged
    // too so individual lead_key entries replace cleanly.
    const merged = Object.assign({}, current);
    for (const k of ['tier_overrides', 'call_logs', 'callbacks', 'booked', 'signed']) {
        if (incoming[k] && typeof incoming[k] === 'object') {
            merged[k] = Object.assign({}, current[k] || {}, incoming[k]);
        }
    }
    // Special: support deletions via tombstones — { tier_overrides: { '<key>': null } }
    // means remove that key. Lets the client revert a tier override etc.
    for (const k of ['tier_overrides', 'call_logs', 'callbacks', 'booked', 'signed']) {
        if (incoming[k] && typeof incoming[k] === 'object') {
            for (const lk in incoming[k]) {
                if (incoming[k][lk] === null) delete merged[k][lk];
            }
        }
    }

    const newConfig = Object.assign({}, agent.config || {}, { lead_state: merged, lead_state_updated_at: new Date().toISOString(), lead_state_updated_by: gate.email });
    const { error: upErr } = await sb.from('client_agents')
        .update({ config: newConfig })
        .eq('id', agent.id);
    if (upErr) return res.status(500).json({ error: 'state_write_failed', detail: upErr.message });

    return res.status(200).json({ ok: true, state: merged });
};
