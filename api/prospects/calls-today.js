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
const { assertAdmin, methodNotAllowed, startOfDayET } = require('./_shared');
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

    const startOfDay = startOfDayET();

    // ?assigned_to=remy|david — restrict to leads this SDR called today,
    // sourced from lead_calls.logged_by (same source as My Call History).
    const SDR_EMAIL_BY_KEY = {
        remy:  'remyleon@stiloaipartners.com',
        david: 'davidcoira@stiloaipartners.com'
    };
    const sdrEmail = SDR_EMAIL_BY_KEY[String((req.query && req.query.assigned_to) || '').toLowerCase()] || null;

    let leadIds = null;
    if (sdrEmail) {
        try {
            const { data: calls } = await sb.from('lead_calls')
                .select('lead_id')
                .eq('logged_by', sdrEmail)
                .gte('called_at', startOfDay.toISOString())
                .limit(2000);
            leadIds = Array.from(new Set((calls || []).map(r => r.lead_id).filter(x => x != null)));
        } catch (_) {}
        if (leadIds && !leadIds.length) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ results: [] });
        }
    }

    let q = sb.from('leads')
        .select('*')
        .gte('last_called_at', startOfDay.toISOString());
    if (leadIds) q = q.in('id', leadIds);
    const { data, error } = await q
        .order('last_called_at', { ascending: false })
        .limit(200);

    if (error) {
        console.error('[calls-today]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: data || [] });
};
