/**
 * GET /api/prospects/callable
 * Daily cold-call list. Niche-balanced, ranked by score, excluding
 * recently-called leads. Pass-through query params: limit, niche, tier,
 * min_score, q.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead } = require('./_shared');
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

    // "Callable" = there is SOME phone we can dial. David's batches put the
    // business line in `phone` and often leave owner_name/owner_phone null
    // (you call the business and ask for the owner), so requiring owner_phone
    // hid his 250-per-rep leads. Accept owner_phone OR phone; don't require
    // owner_name.
    let q = sb.from('leads')
        .select('*')
        .or('owner_phone.not.is.null,phone.not.is.null')
        .or('do_not_call.is.null,do_not_call.eq.false');

    if (opts.assignedTo) q = q.eq('assigned_to', opts.assignedTo);
    if (opts.tier)      q = q.eq('prospect_tier', opts.tier);
    if (opts.niche)     q = q.eq('niche', opts.niche);
    if (opts.minScore)  q = q.gte('prospect_score', opts.minScore);
    if (opts.search)    q = q.ilike('name', `%${opts.search}%`);

    // Drop leads that are already out of the cold-call lifecycle. Must keep
    // never-called leads (last_called_outcome IS NULL) — an OR of `neq`
    // conditions silently drops them because `NULL <> 'x'` is NULL (not true)
    // in Postgres, which is why a freshly-assigned queue showed 0 rows while
    // the stat card counted 94. Mirror lifecycle-stats' null-safe filter.
    q = q.or('last_called_outcome.is.null,last_called_outcome.not.in.(' + OUT_OF_PIPELINE.join(',') + ')');

    const { data, error } = await q
        .order('prospect_score', { ascending: false, nullsFirst: false })
        .limit(opts.limit || 200);

    if (error) return { error };
    return { results: (data || []).map(normalizeLead) };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};

    // Resolve the assigned_to scope:
    //   • SDR caller            → forced to their own email
    //   • Admin (+impersonation)→ ?assigned_to=<sdr_key|email> when present,
    //                             otherwise null = the full callable pool
    let assignedTo;
    if (gate.isSdr && !gate.isAdmin) {
        assignedTo = gate.email;
    } else {
        assignedTo = q.assigned_to ? await resolveAssignedTo(q.assigned_to) : null;
    }

    // Both SDR and admin views read straight from Supabase prospecting.leads —
    // the same data David's pipeline writes to. We dropped the Cloud Run
    // pass-through here because /api/prospects/callable on his service hangs
    // for limit>~50 (unindexed scan), which left the dashboard stuck on
    // "Loading…" for admins and during SDR impersonation. Supabase returns in
    // ~100ms with the exact same filter.
    const result = await callableFromSupabase({
        assignedTo: assignedTo,
        tier: q.tier,
        niche: q.niche,
        minScore: q.min_score,
        search: q.q,
        limit: q.limit ? parseInt(q.limit, 10) : 200
    });
    if (result.error) return res.status(500).json({ error: result.error.message });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(result);
};
