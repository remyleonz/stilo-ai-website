/**
 * GET /api/prospects/lifecycle-stats
 *
 * Single endpoint that returns every count the prospecting tab needs:
 *   - tier_counts: { hot, warm, cool, dead }   (callable filter applied)
 *   - tab_badges:  { callbacks, booked }
 *   - activity:    { calls_today, booked_this_week, callbacks_due_today }
 *
 * "Callable" means the lead has owner_name AND owner_phone AND is not on the
 * do-not-call list AND has not already moved out of the cold-call lifecycle
 * (booked / DNC / wrong-number / disconnected). David's /stats endpoint
 * counts ALL leads (including unenriched) which doesn't match what's
 * actually callable, so we compute these directly against the prospecting
 * schema using the service-role key (server-side, bypasses RLS).
 *
 * Combining everything in one response shaves several roundtrips off the
 * first paint of the prospecting tab.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// Outcomes that take a lead OUT of the cold-call pipeline. Per
// FRONTEND_BRIEF.md §8: a HOT/WARM lead is only "ready to call" if it's
// not booked, not on DNC, not called in last 14 days.
const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];

// Fetches David's `/api/prospects/stats` so we can also surface his
// `callable_ready` (the strict-default count: HOT/WARM + strict-pass +
// real owner name + not on DNC + not called <14d + not booked). Per his
// brief: "Use callable_ready for the headline number." We use it for the
// "Cold call queue" display and as the canonical day-of-call count.
async function statsFromUpstream() {
    const r = await forwardToProspecting({ method: 'GET', path: '/api/prospects/stats' });
    if (r.status !== 200 || !r.json) {
        return { by_tier: {}, callable_ready: null, emailable_ready: null, _source: 'upstream_error', _detail: (r.json && r.json.error) || ('HTTP ' + r.status) };
    }
    return {
        by_tier: r.json.by_tier || {},
        callable_ready:  Number(r.json.callable_ready  || 0),
        emailable_ready: Number(r.json.emailable_ready || 0),
        _source: 'upstream_stats'
    };
}

// SDR key → owning email. Mirrors the frontend mapping in
// admin/index.html sdrFromEmail(). Used to scope every query when the
// caller passes ?assigned_to=remy or =david.
const SDR_EMAIL_BY_KEY = {
    remy:  'remyleon@stiloaipartners.com',
    david: 'davidcoira@stiloaipartners.com'
};
function sdrEmailFromKey(k) {
    const v = String(k || '').trim().toLowerCase();
    return SDR_EMAIL_BY_KEY[v] || null;
}

// Optional: when the prospecting schema IS exposed via PostgREST, we get
// exact callable + lifecycle-aware counts. Fails gracefully when not.
// Pass sdrEmail to scope every count to a single owner; pass null for the
// all-SDRs (agency-wide) view.
async function localStats(sdrEmail) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }, db: { schema: 'prospecting' }
        });
        const leads = function () { return sb.from('leads'); };

        const now = new Date();
        const startOfDay = new Date(now);  startOfDay.setUTCHours(0, 0, 0, 0);
        const startOfWeek = new Date(startOfDay);
        startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());
        const endOfDay = new Date(startOfDay);
        endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
        const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

        // Per-SDR scoping. The `assigned_to` column may not exist yet on
        // David's schema; if the .eq() throws PostgREST rejects the whole
        // query and we fall back to upstream. The frontend also applies a
        // client-side fallback (fallbackSdrFor) so the cards stay useful.
        const scope = function (q) {
            return sdrEmail ? q.eq('assigned_to', sdrEmail) : q;
        };

        // "Callable" = owner_name + owner_phone present + not on DNC list +
        // not in a terminal lifecycle outcome. Chained .or() calls confuse
        // supabase-js; expressing the do_not_call check as `.not('eq', true)`
        // (which translates to `not.eq.true`, including NULL rows) lets us
        // keep a single .or() for the outcome filter — the combo verified
        // against PostgREST directly with curl.
        const callable = function (q) {
            return scope(q)
                .not('owner_name', 'is', null).neq('owner_name', '')
                .not('owner_phone', 'is', null).neq('owner_phone', '')
                .not('do_not_call', 'eq', true)
                .or('last_called_outcome.is.null,last_called_outcome.not.in.(' + OUT_OF_PIPELINE.join(',') + ')');
        };
        const C = function () { return leads().select('id', { count: 'exact', head: true }); };

        // Dead Pool semantic per Remy's intent (2026-05-05): operator-Dead
        // means a lead has BEEN called and ended in a DNC-equivalent outcome,
        // OR has been dialed 3+ times with no logged outcome (auto-decay).
        // It does NOT include David's auto-classified `prospect_tier='dead'`
        // pool (those 4,768 leads were never called by us — they're David's
        // archive of unreachable / low-fit businesses). Different concept.

        const [hot, warm, cool, deadOut, cb, bk, ct, bw, cd, allLeads] = await Promise.all([
            callable(C()).eq('prospect_tier', 'hot'),
            callable(C()).eq('prospect_tier', 'warm'),
            callable(C()).eq('prospect_tier', 'cool'),
            scope(C()).or('last_called_outcome.in.(' + OUT_OF_PIPELINE.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null)'),
            scope(C()).or('next_action_type.eq.callback,last_called_outcome.in.(callback_requested,interested_followup)')
                .not('do_not_call', 'eq', true),
            scope(C()).eq('last_called_outcome', 'booked_meeting'),
            scope(C()).gte('last_called_at', startOfDay.toISOString()),
            scope(C()).eq('last_called_outcome', 'booked_meeting').gte('last_called_at', startOfWeek.toISOString()),
            scope(C()).eq('next_action_type', 'callback').lte('next_action_due_at', endOfDay.toISOString()),
            // All Leads card: callable today, scoped to the SDR. Same filter
            // as the upstream "callable_ready" headline so the card matches
            // what's actually in the Cold Call list (modulo upstream lag).
            callable(C())
        ]);

        // Any single failure means schema isn't exposed yet; bail to upstream fallback.
        if ([hot, warm, cool, deadOut, cb, bk, ct, bw, cd, allLeads].some(function (r) { return r.error; })) return null;

        return {
            tier_counts: {
                hot:  hot.count  || 0,
                warm: warm.count || 0,
                cool: cool.count || 0,
                dead: deadOut.count || 0
            },
            tab_badges: { callbacks: cb.count || 0, booked: bk.count || 0 },
            activity: {
                calls_today:         ct.count || 0,
                booked_this_week:    bw.count || 0,
                callbacks_due_today: cd.count || 0
            },
            // Workflow card counts (SDR-scoped). Frontend reads these first;
            // falls back to the legacy fields if absent.
            all_leads_count:            allLeads.count || 0,
            called_today_count:         ct.count || 0,
            callbacks_due_today_count:  cd.count || 0,
            dead_pool_count:            deadOut.count || 0,
            _source: 'supabase_local'
        };
    } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    // ?assigned_to=remy|david scopes every count. Omit (or pass an unknown
    // key) for the agency-wide All-SDRs view.
    const sdrKey = (req.query && req.query.assigned_to) ? String(req.query.assigned_to) : '';
    const sdrEmail = sdrEmailFromKey(sdrKey);

    try {
        // Two parallel sources: Supabase-direct callable-aware counts (per
        // tier, tab badges, activity strip) AND David's /stats for the
        // headline `callable_ready` number (the strict-default count he
        // publishes — his brief explicitly says use this for the queue).
        const [local, upstream] = await Promise.all([
            localStats(sdrEmail),
            statsFromUpstream()
        ]);

        let tier, badges, activity, source;
        if (local) {
            tier = local.tier_counts; badges = local.tab_badges; activity = local.activity;
            source = local._source;
        } else {
            // FALLBACK: David's /stats `by_tier` counts ALL leads in the table,
            // including ~4.7k auto-classified `prospect_tier='dead'` archive
            // rows that were NEVER called by us. These tier counts do NOT
            // reflect the callable pool. Callers that need badge math for the
            // cold-call view should compute tiers from the callable list itself
            // (see admin/index.html `applyTierBadgesFromRows`). Keep the field
            // here for diagnostic / total-pipeline visibility only.
            const byTier = upstream.by_tier || {};
            tier = {
                hot:  Number(byTier.hot  || 0),
                warm: Number(byTier.warm || 0),
                cool: Number(byTier.cool || 0),
                dead: Number(byTier.dead || 0)
            };
            badges = { callbacks: 0, booked: 0 };
            activity = { calls_today: 0, booked_this_week: 0, callbacks_due_today: 0 };
            source = upstream._source || 'upstream_stats';
        }

        const result = {
            tier_counts: tier,
            tab_badges:  badges,
            activity:    activity,
            // Headline "Cold call queue" number. callable_ready from David's
            // strict filter (HOT/WARM + strict-pass + real owner_name + not
            // DNC + not called <14d + not booked) — matches what's actually
            // shown in the cold-call list far better than the sum of tier
            // counts (which includes leads that don't pass strict checks).
            // When an SDR is selected, prefer the local SDR-scoped count
            // so the All Leads card reflects what's assigned to that SDR.
            callable_ready: (local && sdrEmail && local.all_leads_count != null)
                ? local.all_leads_count
                : (upstream.callable_ready != null ? upstream.callable_ready : ((tier.hot || 0) + (tier.warm || 0))),
            // Workflow card counts. Frontend reads these first.
            all_leads_count:           (local && local.all_leads_count != null)
                ? local.all_leads_count
                : (upstream.callable_ready != null ? upstream.callable_ready : ((tier.hot || 0) + (tier.warm || 0))),
            called_today_count:        local ? local.called_today_count : (activity.calls_today || 0),
            callbacks_due_today_count: local ? local.callbacks_due_today_count : (activity.callbacks_due_today || 0),
            dead_pool_count:           local ? local.dead_pool_count : (tier.dead || 0),
            scoped_to_sdr: sdrEmail || null,
            source: source
        };
        // Short edge cache, but vary by SDR so per-SDR views don't collide.
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        res.setHeader('Vary', 'Authorization');
        return res.status(200).json(result);
    } catch (e) {
        console.error('[lifecycle-stats]', e);
        return res.status(500).json({ error: 'lifecycle_stats_failed', detail: String(e.message || e) });
    }
};
