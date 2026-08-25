/**
 * GET /api/admin/clients/crm-leads?client_id=<uuid>[&q=][&only=booked|called][&limit=]
 *
 * The client CRM's lead list: EVERY lead in the client's pool, with no
 * callable-gating at all — the CRM answers "what do we have and where is it",
 * the dial board answers "what do I call next". List columns only (same egress
 * rule as every other list endpoint; the drawer fetches full rows one at a
 * time through detail.js).
 */
const { assertAdmin, methodNotAllowed, normalizeLead, LEAD_LIST_COLUMNS } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    if (!q.client_id) return res.status(400).json({ error: 'missing_client_id' });
    const limit = Math.min(Math.max(parseInt(q.limit || '500', 10), 1), 1000);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    let sel = sb.from('leads')
        .select(LEAD_LIST_COLUMNS)
        .eq('client_id', q.client_id);
    if (q.q) sel = sel.ilike('name', '%' + q.q + '%');
    if (q.only === 'booked') sel = sel.not('meeting_scheduled_at', 'is', null);
    if (q.only === 'called') sel = sel.not('last_called_at', 'is', null);

    const { data, error } = await sel
        .order('meeting_scheduled_at', { ascending: false, nullsFirst: false })
        .order('last_called_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(limit);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
