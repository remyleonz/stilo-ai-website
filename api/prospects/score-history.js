/**
 * GET /api/prospects/score-history?id=<lead_id>
 *   → { history: [{ old_score, new_score, scored_by, reason, scored_at }] }
 */
const { assertAdmin, methodNotAllowed, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ history: [] });
    }
    const id = safeNumberId(req.query && (req.query.id || req.query.lead_id));
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const { data, error } = await sb.from('lead_score_history')
        .select('old_score, new_score, scored_by, reason, scored_at')
        .eq('lead_id', id)
        .order('scored_at', { ascending: false })
        .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ history: data || [] });
};
