/**
 * POST /api/admin/clients/set-agent-status
 * Body: { agent_id?: uuid, client_id?: uuid, agent_type?: string, status: string }
 *
 * Flips a client_agents row's status. Two ways to target the row:
 *   - by agent_id (preferred — explicit row id)
 *   - by (client_id + agent_type) — convenient for the admin UI button
 *
 * Auth: admin-only (ADMIN_EMAILS via assertAdmin). Used by the admin
 * client drawer's "Mark active" button to move a friends-and-family
 * client out of "pending" without a code push.
 *
 * Returns the updated row.
 */
const { assertAdmin, methodNotAllowed, readJsonBody } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_STATUSES = ['active', 'pending', 'paused', 'onboarding', 'pending_admin_review', 'cancelled'];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const body = await readJsonBody(req);
    const status = (body.status || '').trim().toLowerCase();
    if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'invalid_status', detail: 'Allowed: ' + ALLOWED_STATUSES.join(', ') });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    let q = sb.from('client_agents').update({ status: status, activated_at: status === 'active' ? new Date().toISOString() : null }).select().maybeSingle();
    if (body.agent_id) {
        q = sb.from('client_agents')
            .update({ status: status, activated_at: status === 'active' ? new Date().toISOString() : null })
            .eq('id', body.agent_id)
            .select().maybeSingle();
    } else if (body.client_id && body.agent_type) {
        q = sb.from('client_agents')
            .update({ status: status, activated_at: status === 'active' ? new Date().toISOString() : null })
            .eq('client_id', body.client_id)
            .eq('agent_type', body.agent_type)
            .select().maybeSingle();
    } else {
        return res.status(400).json({ error: 'missing_target', detail: 'Pass agent_id OR (client_id + agent_type)' });
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });
    if (!data) return res.status(404).json({ error: 'agent_not_found' });
    return res.status(200).json({ ok: true, agent: data, updated_by: gate.email });
};
