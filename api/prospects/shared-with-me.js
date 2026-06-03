/**
 * GET /api/prospects/shared-with-me
 *
 * Leads other users have shared with the caller. Powers the "Shared with me"
 * view on the SDR Leads tab and the admin prospects area. Returns full lead
 * rows (normalized like the other prospect lists) with a `_share` block
 * describing who shared it, when, and any note.
 */
const { assertAdminOrSdr, methodNotAllowed, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    // Admins can preview a specific recipient (impersonation passes ?assigned_to=).
    const q = req.query || {};
    const target = (gate.isAdmin && q.assigned_to) ? String(q.assigned_to).toLowerCase() : (gate.email || '').toLowerCase();
    if (!target) return res.status(200).json({ results: [] });

    const sb = publicClient();
    const { data: shares, error } = await sb.from('lead_shares')
        .select('lead_id, business_name, shared_by_email, note, created_at, updated_at')
        .ilike('shared_to_email', target)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) return res.status(500).json({ error: 'shares_read_failed', detail: error.message });
    if (!shares || !shares.length) return res.status(200).json({ results: [] });

    const ids = shares.map(function (s) { return s.lead_id; });
    let leadsById = {};
    try {
        const lc = leadsClient();
        const { data: leads } = await lc.from('leads').select('*').in('id', ids);
        (leads || []).forEach(function (l) { leadsById[l.id] = l; });
    } catch (_) { /* fall back to share stubs below */ }

    // Preserve share order (newest first). Build a lead row even if the lead
    // record vanished, so the recipient still sees the share.
    const results = shares.map(function (s) {
        const lead = leadsById[s.lead_id];
        const base = lead ? normalizeLead(lead) : { id: s.lead_id, business_name: s.business_name || ('Lead ' + s.lead_id), name: s.business_name };
        base._share = {
            shared_by: s.shared_by_email,
            note: s.note || null,
            at: s.created_at,
            missing: !lead
        };
        return base;
    });

    return res.status(200).json({ results: results });
};
