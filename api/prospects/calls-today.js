/**
 * GET /api/prospects/calls-today
 *
 * All leads with last_called_at >= start of today (America/New_York),
 * any outcome. Powers the "Calls Today" tab — a permanent record of
 * every lead touched today regardless of what happened on the call.
 *
 * Day boundary is ET (Miami), not UTC, so an 8pm call doesn't roll
 * out of the tab at 7-8pm local. DST handled by startOfDayET().
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, startOfDayET, normalizeLead } = require('./_shared');
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

    const startOfDay = startOfDayET();

    // SDR scoping. SDR callers are force-scoped to their own email;
    // admins can pass ?assigned_to=<sdr_key|email>.
    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) {
        sdrEmail = gate.email;
    } else if (req.query && req.query.assigned_to) {
        sdrEmail = await resolveAssignedTo(req.query.assigned_to);
    }

    let q = sb.from('leads')
        .select('*')
        .gte('last_called_at', startOfDay.toISOString());
    if (sdrEmail) q = q.eq('assigned_to', sdrEmail);
    const { data, error } = await q
        .order('last_called_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error('[calls-today]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
