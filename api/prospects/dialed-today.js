/**
 * GET /api/prospects/dialed-today
 *
 * Leads that were dialed in the last 24 hours but have no logged outcome.
 * These fall out of David's callable API (which excludes recently-called
 * leads) but should stay visible in the Cold Call list, dimmed at the
 * bottom. This endpoint re-injects them after every page refresh.
 */
const { assertAdmin, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await sb.from('leads')
        .select('id, name, owner_name, owner_phone, owner_email, phone, prospect_tier, prospect_score, niche, last_called_at, call_attempts, last_called_outcome, prospect_reasoning, matched_product_name')
        .gte('last_called_at', since)
        .is('last_called_outcome', null)
        .not('call_attempts', 'is', null)
        .gt('call_attempts', 0)
        .order('last_called_at', { ascending: false })
        .limit(50);

    if (error) {
        console.error('[dialed-today]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: data || [] });
};
