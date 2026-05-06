/**
 * GET /api/prospects/calls-today
 *
 * All leads with last_called_at >= start of today (UTC), any outcome.
 * Powers the "Calls Today" tab — a permanent record of every lead
 * touched today regardless of what happened on the call.
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

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const { data, error } = await sb.from('leads')
        .select('*')
        .gte('last_called_at', startOfDay.toISOString())
        .order('last_called_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error('[calls-today]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: data || [] });
};
