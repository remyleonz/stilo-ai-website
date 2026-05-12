/**
 * POST /api/admin/clients/set-lead-source
 * Body: { client_id: uuid, gcs_prefix: string | null }
 *
 * Sets (or clears) the GCS object prefix this client's leads dashboard
 * pulls from. Storage location: Supabase auth.users.user_metadata.
 * lead_source_gcs_prefix — chosen specifically because it requires no
 * schema migration (David doesn't have to do anything on his side) and
 * service role can read/write it through the admin auth API.
 *
 * GET /api/admin/clients/set-lead-source?client_id=<uuid>
 *   → returns the currently-stored prefix for the client.
 *
 * Auth: admin JWT (ADMIN_EMAILS).
 */
const { assertAdmin, methodNotAllowed, readJsonBody } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

function admin() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed(res, 'POST, GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const sb = admin();

    if (req.method === 'GET') {
        const clientId = (req.query.client_id || '').trim();
        if (!clientId) return res.status(400).json({ error: 'missing_client_id' });
        try {
            const { data, error } = await sb.auth.admin.getUserById(clientId);
            if (error) return res.status(500).json({ error: 'auth_get_failed', detail: error.message });
            if (!data || !data.user) return res.status(404).json({ error: 'auth_user_not_found' });
            const meta = data.user.user_metadata || {};
            return res.status(200).json({
                client_id: clientId,
                gcs_prefix: meta.lead_source_gcs_prefix || null,
                metadata: meta
            });
        } catch (e) {
            return res.status(500).json({ error: 'lookup_threw', detail: String(e.message || e) });
        }
    }

    // POST: set the prefix
    const body = await readJsonBody(req);
    const clientId = (body.client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });
    const prefix = body.gcs_prefix === null || body.gcs_prefix === undefined
        ? null
        : String(body.gcs_prefix).trim();

    try {
        // Fetch current metadata so we don't blow away other keys (Supabase
        // admin.updateUserById merges shallowly — passing user_metadata
        // replaces the entire object).
        const { data: cur, error: curErr } = await sb.auth.admin.getUserById(clientId);
        if (curErr) return res.status(500).json({ error: 'auth_get_failed', detail: curErr.message });
        if (!cur || !cur.user) return res.status(404).json({ error: 'auth_user_not_found' });

        const merged = Object.assign({}, cur.user.user_metadata || {});
        const oldPrefix = merged.lead_source_gcs_prefix || null;
        if (prefix === null || prefix === '') {
            delete merged.lead_source_gcs_prefix;
        } else {
            merged.lead_source_gcs_prefix = prefix;
        }
        merged.lead_source_updated_by = gate.email;
        merged.lead_source_updated_at = new Date().toISOString();
        // Append to an in-metadata audit log so we can see who set what
        // when without a separate audit table. Capped at the last 20
        // entries so this doesn't grow unbounded.
        const history = Array.isArray(merged.lead_source_history) ? merged.lead_source_history.slice(-19) : [];
        history.push({
            at: merged.lead_source_updated_at,
            by: gate.email,
            from: oldPrefix,
            to: prefix || null
        });
        merged.lead_source_history = history;

        const { data: upd, error: upErr } = await sb.auth.admin.updateUserById(clientId, {
            user_metadata: merged
        });
        if (upErr) return res.status(500).json({ error: 'auth_update_failed', detail: upErr.message });

        return res.status(200).json({
            ok: true,
            client_id: clientId,
            gcs_prefix: merged.lead_source_gcs_prefix || null,
            updated_at: merged.lead_source_updated_at,
            updated_by: merged.lead_source_updated_by
        });
    } catch (e) {
        return res.status(500).json({ error: 'set_threw', detail: String(e.message || e) });
    }
};
