/**
 * POST /api/admin/clients/upsert
 * Body: { business_name, contact_name?, email, phone?, business_type?, city?,
 *         status?, agent_type, agent_status? }
 *
 * Idempotent admin-only insert for the clients + client_agents tables.
 * Needed because there's no UI "Create client" flow today — clients
 * normally land via the Stripe webhook on first paid purchase. Friends-
 * and-family clients (Marcus) come in through here instead.
 *
 * Schema (verified 2026-05-11 against loadClientsGrid in admin/index.html):
 *   clients: { id, business_name, contact_name, email, phone, business_type,
 *              status, created_at }
 *   client_agents: { client_id, agent_type, status, ... }
 *
 * Returns:
 *   { ok: true, client: {...}, agent: {...} } on success
 *   400/500 with explicit error + the payload we attempted on failure
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
    if (!body || !body.email || !body.business_name) {
        return res.status(400).json({ error: 'missing_fields', detail: 'email and business_name are required' });
    }
    const agentType = body.agent_type || 'lead_generator';
    const agentStatus = body.agent_status || 'pending';

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    // 1. UPSERT into clients keyed by email. Column names match the
    //    production schema verified 2026-05-11 via PostgREST error:
    //    business_name, contact_name, email, phone, business_type, status.
    //    NO `city` column — caller can pass it but we drop it before insert.
    const clientPayload = {
        business_name: body.business_name,
        email: body.email,
        contact_name: body.contact_name || null,
        phone: body.phone || null,
        business_type: body.business_type || null,
        status: body.status || 'active'
    };
    const { data: existing, error: lookupErr } = await sb.from('clients')
        .select('*').eq('email', body.email).maybeSingle();
    if (lookupErr) {
        return res.status(500).json({ error: 'client_lookup_failed', detail: lookupErr.message });
    }

    let client;
    if (existing) {
        // Patch any new fields the caller supplied but don't blow away
        // existing values they didn't pass.
        const patch = {};
        for (const k of ['business_name', 'contact_name', 'phone', 'business_type', 'status']) {
            if (clientPayload[k] != null && clientPayload[k] !== existing[k]) patch[k] = clientPayload[k];
        }
        if (Object.keys(patch).length) {
            const { data: upd, error: upErr } = await sb.from('clients')
                .update(patch).eq('id', existing.id).select().maybeSingle();
            if (upErr) return res.status(500).json({ error: 'client_update_failed', detail: upErr.message, attempted: patch });
            client = upd;
        } else {
            client = existing;
        }
    } else {
        // Strip null fields the schema may not accept — some Supabase tables
        // reject explicit nulls on NOT NULL columns even if you have a default.
        const insertPayload = {};
        for (const k in clientPayload) {
            if (clientPayload[k] != null) insertPayload[k] = clientPayload[k];
        }
        const { data: ins, error: insErr } = await sb.from('clients')
            .insert(insertPayload).select().maybeSingle();
        if (insErr) {
            return res.status(500).json({ error: 'client_insert_failed', detail: insErr.message, attempted: insertPayload });
        }
        client = ins;
    }

    // 2. UPSERT client_agents row keyed by (client_id, agent_type).
    let agent = null;
    let agentError = null;
    try {
        const { data: ex, error: lookErr } = await sb.from('client_agents')
            .select('*').eq('client_id', client.id).eq('agent_type', agentType).maybeSingle();
        if (lookErr) {
            agentError = lookErr.message;
        } else if (ex) {
            agent = ex;
            if (agentStatus && ex.status !== agentStatus) {
                const { data: upd, error: upErr } = await sb.from('client_agents')
                    .update({ status: agentStatus }).eq('id', ex.id).select().maybeSingle();
                if (!upErr) agent = upd;
                else agentError = upErr.message;
            }
        } else {
            const { data: ins, error: insErr } = await sb.from('client_agents')
                .insert({ client_id: client.id, agent_type: agentType, status: agentStatus })
                .select().maybeSingle();
            if (insErr) agentError = insErr.message;
            else agent = ins;
        }
    } catch (e) { agentError = String(e.message || e); }

    return res.status(200).json({
        ok: true,
        client: client,
        agent: agent,
        agent_error: agentError,
        notes: 'Idempotent — safe to re-run.'
    });
};
