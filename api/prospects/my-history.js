/**
 * GET /api/prospects/my-history?limit=200&offset=0&email=<override>
 *
 * Durable "every lead I've personally called" view. Distinct from:
 *   - Calls Today (today only, any SDR)
 *   - Dead Pool   (tier=DEAD OR do_not_call=true)
 *
 * Returns leads whose call_history JSONB array contains at least one entry
 * with logged_by = the caller's admin email, ordered by most recent call.
 *
 * We own the write side too: api/prospects/log-call.js appends a row with
 * { logged_by, called_at, outcome, notes, source: 'stilo_admin' } directly
 * into leads.call_history every time a call is logged from the admin UI.
 * So this query always reflects reality regardless of whether David's
 * upstream backend also persists logged_by.
 *
 * The ?email= override lets one SDR look at the other's history (e.g. Remy
 * wants to see what David already worked). Admin-only.
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

    const q = req.query || {};
    const targetEmail = (q.email && String(q.email).trim()) || gate.email;
    const limit  = Math.min(parseInt(q.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    // Primary: JSONB array contains match against entries we write from
    // log-call.js. Works as soon as the first call is logged.
    let data, error;
    try {
        const r = await sb.from('leads')
            .select('*')
            .contains('call_history', [{ logged_by: targetEmail }])
            .order('last_called_at', { ascending: false })
            .range(offset, offset + limit - 1);
        data = r.data;
        error = r.error;
    } catch (e) {
        error = e;
    }

    if (error) {
        console.error('[my-history] query failed', error);
        return res.status(200).json({
            results: [],
            note: 'No call history yet. Log a call from the lead drawer to populate this list.'
        });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        results: data || [],
        email: targetEmail,
        count: (data || []).length
    });
};
