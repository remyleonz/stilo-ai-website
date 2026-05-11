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

    // Strategy 1: JSONB array contains match. Works if call_history is JSONB
    // and each entry has a logged_by string. If the column doesn't exist yet
    // (David hasn't shipped the schema change), Strategy 1 errors and we fall
    // back to Strategy 2.
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
        // Strategy 2 fallback: query last_logged_by scalar column. If that
        // doesn't exist either, return empty with a hint so the UI can show
        // a "schema not ready" placeholder instead of crashing.
        try {
            const r2 = await sb.from('leads')
                .select('*')
                .eq('last_logged_by', targetEmail)
                .order('last_called_at', { ascending: false })
                .range(offset, offset + limit - 1);
            if (r2.error) {
                console.error('[my-history] both strategies failed', error, r2.error);
                return res.status(200).json({
                    results: [],
                    note: 'schema_not_ready: David needs to expose call_history.logged_by or last_logged_by on prospecting.leads'
                });
            }
            data = r2.data;
        } catch (e2) {
            console.error('[my-history] fallback threw', e2);
            return res.status(200).json({ results: [], note: 'schema_not_ready' });
        }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        results: data || [],
        email: targetEmail,
        count: (data || []).length
    });
};
