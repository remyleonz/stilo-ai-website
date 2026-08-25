/**
 * GET /api/prospects/callable
 * Daily cold-call list. Niche-balanced, ranked by score, excluding
 * recently-called leads. Pass-through query params: limit, niche, tier,
 * min_score, q.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead, gateToCurrentOffer, resolveClientScope, LEAD_LIST_COLUMNS } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// "Callable" = lead has owner_name + owner_phone, not on the DNC list, not
// already moved out of the cold-call lifecycle, hasn't been dialed 3+ times.
// Mirrors David's strict-callable filter so the SDR queue matches what the
// admin sees from his backend.
const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];

// ---- Niche GROUPS (what the Leads dropdown filters by) ----------------------
//
// leads.category is a raw Google Maps category, so the pool holds ~750 distinct
// values. The dropdown offers six: the five niches we sell to, plus Other. This
// is the server side of that collapse.
//
// The terms and their ORDER are copied from agentKey() in _vsl.js and
// nicheSlug() in assets/vsl-agents.js, which are already required to stay
// identical to each other. The exclusions come from the campaign ICP regex in
// prospecting.outbound_campaigns.icp_pattern: a pool service, a dry cleaner and
// a carpet cleaner all contain "clean" and none of them is a commercial
// cleaning company. Exclusions win over every include term.
//
// The ICP regex spells some terms with an optional space ("house ?clean").
// PostgREST filters here with ILIKE, not a regex, so both spellings are listed.
//
// MUST stay identical to NICHE_GROUP_EXCLUDE / NICHE_GROUPS in
// assets/vsl-agents.js, which classifies the same strings in the browser to
// label each option with a count. Drift means the count disagrees with the rows.
const NICHE_GROUP_EXCLUDE = [
    'pool', 'maid', 'house clean', 'houseclean', 'carpet',
    'pressure wash', 'pressurewash', 'car wash', 'carwash',
    'laundry', 'dry clean', 'dryclean', 'alteration'
];

// PRECEDENCE order, not display order. "Janitorial equipment supplier" matches
// both 'janitor' and 'equipment' and must resolve to cleaning, the same way
// agentKey() resolves it. Reordering silently reclassifies leads.
const NICHE_GROUPS = [
    { slug: 'commercial-cleaning', terms: ['clean', 'janitor'] },
    { slug: 'commercial-roofing', terms: ['roof'] },
    { slug: 'staffing', terms: ['staff', 'recruit', 'employment', 'temp agency', 'talent', 'nursing agency', 'executive search', 'headhunt'] },
    { slug: 'freight', terms: ['freight', 'truck', 'logistic', 'carrier', '3pl', 'shipping'] },
    { slug: 'industrial-supplies', terms: ['equipment', 'forklift', 'industrial', 'suppl', 'material handling', 'crane'] }
];

// One leaf of a PostgREST logic tree. `*` is PostgREST's ILIKE wildcard.
function likeTerm(col, term, negate) {
    return col + (negate ? '.not' : '') + '.ilike.*' + term + '*';
}

// "this column resolves to NICHE_GROUPS[i]": no exclusion hit, no
// higher-precedence group's term, and at least one of this group's terms.
function groupClause(col, i) {
    const parts = NICHE_GROUP_EXCLUDE.map(t => likeTerm(col, t, true));
    for (let j = 0; j < i; j++) {
        for (const t of NICHE_GROUPS[j].terms) parts.push(likeTerm(col, t, true));
    }
    parts.push('or(' + NICHE_GROUPS[i].terms.map(t => likeTerm(col, t, false)).join(',') + ')');
    return 'and(' + parts.join(',') + ')';
}

// "this column resolves to no group at all": it is NULL, or it hits an
// exclusion, or it matches none of the five groups' terms. NULL has to be
// listed on its own because `NOT (NULL ILIKE '%x%')` is NULL, not true, so a
// lead with no category would otherwise fall out of every option including
// Other. Returns the inside of an or(...), for q.or().
function otherClause(col) {
    const alts = [col + '.is.null'];
    for (const t of NICHE_GROUP_EXCLUDE) alts.push(likeTerm(col, t, false));
    const none = [];
    for (const g of NICHE_GROUPS) for (const t of g.terms) none.push(likeTerm(col, t, true));
    alts.push('and(' + none.join(',') + ')');
    return alts.join(',');
}

/**
 * Apply the Leads niche filter to a leads query.
 *
 * `value` is normally a GROUP slug. Filtering has to happen here rather than in
 * the browser because the board caps its response, so a client-side filter of
 * an already-truncated page silently hides leads.
 *
 * Both columns are checked. leads.niche is David's field and leads.category is
 * the older Google-Places string, and canonically nicheForLead() reads niche
 * first and falls back to category. Measured 2026-08-14 across the 21,611 active
 * leads: the two are byte-identical in all 21,447 rows where niche is set, and
 * the other 164 have neither, so an OR over both is exactly that fallback and
 * no lead can land in two groups. If David ever starts writing one without the
 * other, this needs the explicit "niche resolves to nothing" guard instead.
 *
 * Anything that is not a group slug is treated as a raw category for
 * back-compat, which is the behavior this filter had before.
 */
function applyNicheFilter(q, value) {
    const v = String(value || '').trim();
    if (!v) return q;
    if (v === 'other') {
        // Neither column may resolve to a group. Two or= params AND together.
        return q.or(otherClause('niche')).or(otherClause('category'));
    }
    const i = NICHE_GROUPS.findIndex(g => g.slug === v);
    if (i === -1) return q.eq('category', v);
    return q.or(groupClause('niche', i) + ',' + groupClause('category', i));
}

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
        .or('owner_phone.not.is.null,phone.not.is.null')
        .or('do_not_call.is.null,do_not_call.eq.false')
        // Bulk-retired leads never come back into a dial queue on their own.
        // archived_batch names WHY a batch was retired (e.g. luke-huron-2026-08-06),
        // and it is checked here rather than relying on stage, because this query
        // does not filter on stage at all. Reviving a batch is a deliberate
        // UPDATE that clears the column, not an accident of reassignment.
        .is('archived_batch', null);

    // STILO mode keeps the per-lead script + pitch gates: a lead is only
    // dial-ready once David briefed it (has_cold_call_script, set at ingest,
    // self-healing via sync-scripts) AND stated an agent to pitch (pitch_agent).
    // Client-account mode drops BOTH on purpose — a client campaign runs one
    // shared script for the whole pool, so the per-lead flag would blank the
    // board exactly like the George cleaning-leads incident (250 briefs, 0
    // scripts, "missing" queue). The client gate lives in gateToCurrentOffer.
    if (!opts.clientId) {
        q = q.eq('has_cold_call_script', true).not('pitch_agent', 'is', null);
    }
    q = gateToCurrentOffer(q, opts.clientId);

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
    // Group slug ('staffing', 'other', ...) or, for back-compat, a raw category.
    if (opts.niche)     q = applyNicheFilter(q, opts.niche);
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

    // Client-account scope: a rep flagged sdr_type='client_account' dials their
    // client's pool, not STILO's. Resolved from the EFFECTIVE rep so admin
    // impersonation lands on the same board the rep sees. Admins can also ask
    // for a client pool directly with ?client_id=<uuid> (the client CRM does).
    let clientId = await resolveClientScope(assignedTo);
    if (!clientId && gate.isAdmin && q.client_id) clientId = String(q.client_id);

    // Both SDR and admin views read straight from Supabase prospecting.leads —
    // the same data David's pipeline writes to. We dropped the Cloud Run
    // pass-through here because /api/prospects/callable on his service hangs
    // for limit>~50 (unindexed scan), which left the dashboard stuck on
    // "Loading…" for admins and during SDR impersonation. Supabase returns in
    // ~100ms with the exact same filter.
    const result = await callableFromSupabase({
        assignedTo: assignedTo,
        clientId: clientId,
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

// Exported for reuse and for the parity test against assets/vsl-agents.js.
module.exports.NICHE_GROUPS = NICHE_GROUPS;
module.exports.NICHE_GROUP_EXCLUDE = NICHE_GROUP_EXCLUDE;
module.exports.applyNicheFilter = applyNicheFilter;
