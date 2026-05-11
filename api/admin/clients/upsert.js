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
const crypto = require('crypto');

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
        // Strip null fields the schema may not accept.
        const insertPayload = {};
        for (const k in clientPayload) {
            if (clientPayload[k] != null) insertPayload[k] = clientPayload[k];
        }

        // clients.id has a FK to auth.users.id (verified via PostgREST error
        // "violates foreign key constraint clients_id_fkey"). So a client row
        // IS a Supabase auth user. We must mint the auth user first, then use
        // that user's id as clients.id. The Stripe webhook does the same thing
        // implicitly when it provisions the auth account at purchase time.
        //
        // Strategy:
        //   1. Look up existing auth user by email (via admin listUsers, no
        //      direct getUserByEmail in the JS SDK). If found, reuse their id.
        //   2. Otherwise inviteUserByEmail — sends a magic-link signup email
        //      and creates the auth row. Returns the new user.
        //   3. Insert clients with id = auth_user_id.
        let authUserId = null;
        try {
            // Page through admin.listUsers (no direct email filter in JS SDK).
            // The expected universe is small (single-digit thousands at most),
            // so paging until we find the email is fine.
            let page = 1;
            const perPage = 1000;
            while (page < 20) {
                const { data: listed, error: listErr } = await sb.auth.admin.listUsers({ page, perPage });
                if (listErr) {
                    return res.status(500).json({ error: 'auth_list_failed', detail: listErr.message });
                }
                const match = (listed && listed.users || []).find(u => (u.email || '').toLowerCase() === body.email.toLowerCase());
                if (match) { authUserId = match.id; break; }
                if (!listed || !listed.users || listed.users.length < perPage) break;
                page++;
            }
        } catch (e) {
            return res.status(500).json({ error: 'auth_lookup_threw', detail: String(e.message || e) });
        }

        if (!authUserId) {
            try {
                // inviteUserByEmail sends a magic-link signup. Friendly for
                // friends-and-family onboarding. If you'd rather not send the
                // invite email (e.g. you'll hand over credentials manually),
                // switch to createUser({ email, email_confirm: true }).
                const { data: invite, error: invErr } = await sb.auth.admin.inviteUserByEmail(body.email, {
                    data: { business_name: body.business_name, source: 'admin_upsert' }
                });
                if (invErr) {
                    // Fall back to createUser if invite path is blocked (some
                    // Supabase projects disable invites for security).
                    const { data: created, error: createErr } = await sb.auth.admin.createUser({
                        email: body.email,
                        email_confirm: true,
                        user_metadata: { business_name: body.business_name, source: 'admin_upsert' }
                    });
                    if (createErr) {
                        return res.status(500).json({ error: 'auth_create_failed', detail: createErr.message + ' | invite_error: ' + invErr.message });
                    }
                    authUserId = created.user && created.user.id;
                } else {
                    authUserId = invite && invite.user && invite.user.id;
                }
            } catch (e) {
                return res.status(500).json({ error: 'auth_create_threw', detail: String(e.message || e) });
            }
        }

        if (!authUserId) {
            return res.status(500).json({ error: 'auth_no_user_id', detail: 'Created or found auth user but no id returned' });
        }

        insertPayload.id = authUserId;

        // Belt-and-suspenders: a clients row may already exist for this auth
        // user even though our by-email lookup didn't find it (e.g. the email
        // field is null on a row created by a Supabase trigger that fires on
        // auth.users insert). Look up by id before inserting — if it's there,
        // update; otherwise insert.
        const { data: byId, error: byIdErr } = await sb.from('clients')
            .select('*').eq('id', authUserId).maybeSingle();
        if (byIdErr) {
            return res.status(500).json({ error: 'client_by_id_lookup_failed', detail: byIdErr.message });
        }
        if (byId) {
            const patch = {};
            for (const k of ['business_name', 'contact_name', 'phone', 'business_type', 'email', 'status']) {
                if (insertPayload[k] != null && insertPayload[k] !== byId[k]) patch[k] = insertPayload[k];
            }
            if (Object.keys(patch).length) {
                const { data: upd, error: upErr } = await sb.from('clients')
                    .update(patch).eq('id', authUserId).select().maybeSingle();
                if (upErr) return res.status(500).json({ error: 'client_update_by_id_failed', detail: upErr.message, attempted: patch });
                client = upd;
            } else {
                client = byId;
            }
        } else {
            const { data: ins, error: insErr } = await sb.from('clients')
                .insert(insertPayload).select().maybeSingle();
            if (insErr) {
                return res.status(500).json({ error: 'client_insert_failed', detail: insErr.message, attempted: insertPayload });
            }
            client = ins;
        }
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
