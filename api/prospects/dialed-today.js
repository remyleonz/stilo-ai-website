/**
 * GET /api/prospects/dialed-today
 *
 * Leads that were dialed in the last 24 hours but have no logged outcome.
 * These fall out of David's callable API (which excludes recently-called
 * leads) but should stay visible in the Cold Call list, dimmed at the
 * bottom. This endpoint re-injects them after every page refresh.
 */
const { assertAdminOrSdr, scopedQuery, methodNotAllowed, LEAD_LIST_COLUMNS } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // List columns only. These rows get pushed into the same Cold Call table as
    // /callable, so they need exactly the same fields and nothing more.
    const { data, error } = await sb.from('leads')
        .select(LEAD_LIST_COLUMNS)
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
