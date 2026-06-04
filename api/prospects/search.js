/**
 * GET /api/prospects/search?q=<text>
 *
 * Fast lead lookup for the SDR dashboard search bar. Matches business name,
 * owner name, or phone (digit-normalized, so formatting doesn't matter).
 * Scoped to the caller's own leads (SDR); admins may pass ?assigned_to.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = ((req.query && req.query.q) || '').toString().trim();
    if (q.length < 2) return res.status(200).json({ results: [] });

    let assignedTo;
    if (gate.isSdr && !gate.isAdmin) assignedTo = gate.email;
    else assignedTo = req.query.assigned_to ? await resolveAssignedTo(req.query.assigned_to) : null;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });

    const { data, error } = await sb.rpc('search_sdr_leads', { p_assigned: assignedTo, p_q: q });
    if (error) return res.status(500).json({ error: 'search_failed', detail: error.message });
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
