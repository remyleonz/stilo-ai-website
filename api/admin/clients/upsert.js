/**
 * POST /api/admin/clients/upsert
 * Body: { name, email, city?, tier?, agent_type, agent_status? }
 *
 * Idempotent admin-only insert for the clients + client_agents tables.
 * Needed because there's no UI "Create client" flow today — clients
 * normally land via the Stripe webhook on first paid purchase. Friends-
 * and-family clients (Marcus) come in through here instead.
 *
 * Returns:
 *   { ok: true, client: {...}, agent: {...} }
 *   { ok: false, error: '...' } on failure
 */
const { assertAdmin, methodNotAllowed, readJsonBody } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const body = await readJsonBody(req);
    if (!body || !body.email || !body.name) {
        return res.status(400).json({ error: 'missing_fields', detail: 'email and name are required' });
    }
    const agentType = body.agent_type || 'lead_generator';
    const agentStatus = body.agent_status || 'pending';

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    // 1. UPSERT into clients keyed by email. We use email as the natural
    //    dedup key because two friends-and-family clients with the same
    //    name would be a collision, but two with the same email never are.
    const clientPayload = {
        name: body.name,
        email: body.email,
        city: body.city || null,
        tier: body.tier || 'standard',
        status: body.status || 'active'
    };
    const { data: existing, error: lookupErr } = await sb.from('clients')
        .select('*').eq('email', body.email).maybeSingle();
    if (lookupErr) {
        return res.status(500).json({ error: 'client_lookup_failed', detail: lookupErr.message });
    }

    let client;
    if (existing) {
        // Patch in any new fields the caller supplied but don't blow away
        // existing values they didn't pass.
        const patch = {};
        for (const k of ['name', 'city', 'tier', 'status']) {
            if (body[k] != null && body[k] !== existing[k]) patch[k] = body[k];
        }
        if (Object.keys(patch).length) {
            const { data: upd, error: upErr } = await sb.from('clients')
                .update(patch).eq('id', existing.id).select().maybeSingle();
            if (upErr) return res.status(500).json({ error: 'client_update_failed', detail: upErr.message });
            client = upd;
        } else {
            client = existing;
        }
    } else {
        const { data: ins, error: insErr } = await sb.from('clients')
            .insert(clientPayload).select().maybeSingle();
        if (insErr) {
            return res.status(500).json({ error: 'client_insert_failed', detail: insErr.message, attempted: clientPayload });
        }
        client = ins;
    }

    // 2. UPSERT client_agents row keyed by (tenant_id, agent_type).
    //    Tolerate column-name drift: David's schema may use `tenant_id` or `client_id`.
    let agent = null;
    let agentError = null;
    for (const tenantCol of ['tenant_id', 'client_id']) {
        try {
            const filter = {};
            filter[tenantCol] = client.id;
            filter.agent_type = agentType;
            const { data: ex, error: lookErr } = await sb.from('client_agents')
                .select('*').match(filter).maybeSingle();
            if (lookErr) { agentError = lookErr.message; continue; }
            if (ex) {
                agent = ex;
                if (agentStatus && ex.status !== agentStatus) {
                    const { data: upd, error: upErr } = await sb.from('client_agents')
                        .update({ status: agentStatus }).eq('id', ex.id).select().maybeSingle();
                    if (!upErr) agent = upd;
                }
                break;
            }
            const insertPayload = { agent_type: agentType, status: agentStatus };
            insertPayload[tenantCol] = client.id;
            const { data: ins, error: insErr } = await sb.from('client_agents')
                .insert(insertPayload).select().maybeSingle();
            if (insErr) { agentError = insErr.message; continue; }
            agent = ins;
            break;
        } catch (e) { agentError = String(e.message || e); }
    }

    return res.status(200).json({
        ok: true,
        client: client,
        agent: agent,
        agent_error: agent ? null : agentError,
        notes: 'Idempotent — safe to re-run.'
    });
};
