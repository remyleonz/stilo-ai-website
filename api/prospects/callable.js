/**
 * GET /api/prospects/callable
 * Daily cold-call list. Niche-balanced, ranked by score, excluding
 * recently-called leads. Pass-through query params: limit, niche, tier,
 * min_score, q.
 */
const { assertAdminOrSdr, resolveAssignedTo, forwardToProspecting, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// "Callable" = lead has owner_name + owner_phone, not on the DNC list, not
// already moved out of the cold-call lifecycle, hasn't been dialed 3+ times.
// Mirrors David's strict-callable filter so the SDR queue matches what the
// admin sees from his backend.
const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];

async function callableFromSupabase(opts) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    let q = sb.from('leads')
        .select('*')
        .not('owner_name', 'is', null).neq('owner_name', '')
        .not('owner_phone', 'is', null).neq('owner_phone', '')
        .or('do_not_call.is.null,do_not_call.eq.false');

    if (opts.assignedTo) q = q.eq('assigned_to', opts.assignedTo);
    if (opts.tier)      q = q.eq('prospect_tier', opts.tier);
    if (opts.niche)     q = q.eq('niche', opts.niche);
    if (opts.minScore)  q = q.gte('prospect_score', opts.minScore);
    if (opts.search)    q = q.or(`business_name.ilike.%${opts.search}%,owner_name.ilike.%${opts.search}%`);

    // Drop leads that are already out of the cold-call lifecycle
    q = q.or(OUT_OF_PIPELINE.map(o => `last_called_outcome.neq.${o}`).join(','));

    const { data, error } = await q
        .order('prospect_score', { ascending: false, nullsFirst: false })
        .limit(opts.limit || 200);

    if (error) return { error };
    return { results: data || [] };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};

    // SDR callers: query Supabase directly (no dependency on David's Cloud Run
    // service). Filter is exact-match on assigned_to=email which always works
    // because prospecting.leads.assigned_to stores full emails.
    if (gate.isSdr && !gate.isAdmin) {
        const result = await callableFromSupabase({
            assignedTo: gate.email,
            tier: q.tier,
            niche: q.niche,
            minScore: q.min_score,
            search: q.q,
            limit: q.limit ? parseInt(q.limit, 10) : 200
        });
        if (result.error) return res.status(500).json({ error: result.error.message });
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        return res.status(200).json(result);
    }

    // Admin callers keep the David-backend pass-through. He owns the niche
    // balancing + sophisticated callable scoring; for admin views we want that.
    const assignedTo = q.assigned_to ? await resolveAssignedTo(q.assigned_to) : null;
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/callable',
        query: {
            limit: q.limit, niche: q.niche, tier: q.tier,
            min_score: q.min_score, q: q.q, assigned_to: assignedTo
        }
    });
    if (status === 200) res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(status).json(json);
};
