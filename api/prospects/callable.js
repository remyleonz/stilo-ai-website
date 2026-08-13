/**
 * GET /api/prospects/callable
 * Daily cold-call list. Niche-balanced, ranked by score, excluding
 * recently-called leads. Pass-through query params: limit, niche, tier,
 * min_score, q.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead, gateToCurrentOffer, LEAD_LIST_COLUMNS } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// "Callable" = lead has owner_name + owner_phone, not on the DNC list, not
// already moved out of the cold-call lifecycle, hasn't been dialed 3+ times.
// Mirrors David's strict-callable filter so the SDR queue matches what the
// admin sees from his backend.
const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];

// The board shows ONLY leads briefed under the offer we currently sell.
// CURRENT_OFFER / gateToCurrentOffer live in _shared.js so the dial board and the
// callback queue cannot drift apart. See the comment there for the full reasoning.

async function callableFromSupabase(opts) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    // "Callable" = the lead David wrote a cold-call script for (the ~750 briefs,
    // ~250 per rep) AND a phone we can dial. Per Remy, the scripted set IS the
    // callable queue; owner name is NOT required (David often leaves it for the
    // rep to confirm on the call). Phone may live in owner_phone OR `phone`.
    // The two owners get scripted leads on loan from the SDRs (see the
    // owner_lead_loan tracking), so they run through this exact same path.
    // Explicit column list, never select('*'). This is the board a rep reloads
    // dozens of times a day, so it was the single biggest Supabase egress line
    // item: 200 full rows weighed 377 kB, 44% of it deep_research_json that
    // nothing on this screen renders. See LEAD_LIST_COLUMNS in _shared.js.
    let q = sb.from('leads')
        .select(LEAD_LIST_COLUMNS)
        .eq('has_cold_call_script', true)
        // A lead is only dial-ready if David actually stated an agent to pitch
        // (pitch_agent, set at ingest from his script). No agent = the rep would
        // be dialing with nothing to sell, so it drops from the queue until David
        // briefs it. Self-healing: sync-scripts sets pitch_agent when he does, and
        // the lead reappears. This is what keeps un-briefed leads off the boards.
        .not('pitch_agent', 'is', null)
        .or('owner_phone.not.is.null,phone.not.is.null')
        .or('do_not_call.is.null,do_not_call.eq.false')
        // Bulk-retired leads never come back into a dial queue on their own.
        // archived_batch names WHY a batch was retired (e.g. luke-huron-2026-08-06),
        // and it is checked here rather than relying on stage, because this query
        // does not filter on stage at all. Reviving a batch is a deliberate
        // UPDATE that clears the column, not an accident of reassignment.
        .is('archived_batch', null);

    q = gateToCurrentOffer(q);

    if (opts.assignedTo) q = q.eq('assigned_to', opts.assignedTo);
    // Tier filter must match what the dashboard DISPLAYS: brief_tier first
    // (1=hot,2=warm,3=cool), falling back to the legacy prospect_tier when a
    // lead has no brief tier. Keeps the Hot/Warm/Cool chips consistent with the
    // badges.
    if (opts.tier) {
        const briefN = { hot: 1, warm: 2, cool: 3 }[String(opts.tier).toLowerCase()];
        if (briefN) {
            q = q.or('brief_tier.eq.' + briefN + ',and(brief_tier.is.null,prospect_tier.eq.' + opts.tier + ')');
        } else {
            q = q.eq('prospect_tier', opts.tier);
        }
    }
    if (opts.niche)     q = q.eq('category', opts.niche); // leads has `category`, not `niche` — filtering on niche 400s
    if (opts.minScore)  q = q.gte('prospect_score', opts.minScore);
    if (opts.search)    q = q.ilike('name', `%${opts.search}%`);

    // Drop leads that are already out of the cold-call lifecycle. Must keep
    // never-called leads (last_called_outcome IS NULL) — an OR of `neq`
    // conditions silently drops them because `NULL <> 'x'` is NULL (not true)
    // in Postgres, which is why a freshly-assigned queue showed 0 rows while
    // the stat card counted 94. Mirror lifecycle-stats' null-safe filter.
    q = q.or('last_called_outcome.is.null,last_called_outcome.not.in.(' + OUT_OF_PIPELINE.join(',') + ')');

    const { data, error } = await q
        // Flow-state ordering (per Remy / the Connor Murray batching idea):
        // cluster by niche so a rep runs all same-type calls back-to-back in one
        // script headspace, fresh never-called leads first within each niche,
        // then hottest brief Tier (1→2→3→untiered), then score. When a rep filters
        // to a single niche this collapses to "newest-first, hottest-first".
        .order('category', { ascending: true, nullsFirst: false })
        .order('last_called_at', { ascending: true, nullsFirst: true })
        .order('brief_tier', { ascending: true, nullsFirst: false })
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
