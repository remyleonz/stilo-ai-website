/**
 * GET /api/prospects/lifecycle-stats?assigned_to=remy|david
 *
 * Single endpoint that returns every count the prospecting tab needs:
 *   - tier_counts: { hot, warm, cool, dead }   (callable filter applied)
 *   - tab_badges:  { callbacks, booked }
 *   - activity:    { calls_today, booked_this_week, callbacks_due_today }
 *   - all_leads_count / called_today_count / callbacks_due_today_count /
 *     dead_pool_count — the four workflow cards on the Leads tab
 *
 * SDR scoping (?assigned_to=remy|david) — TWO sources used in tandem:
 *   - leads.assigned_to for ownership-style counts (All Leads, Callbacks Due)
 *   - lead_calls.logged_by for action-style counts (Called Today, Dead Pool)
 *
 * "Callable" means the lead has owner_name AND owner_phone AND is not on the
 * do-not-call list AND has not already moved out of the cold-call lifecycle
 * (booked / DNC / wrong-number / disconnected).
 */
const { assertAdminOrSdr, scopedQuery, resolveAssignedTo, forwardToProspecting, methodNotAllowed, resolveClientScope } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];
const DEAD_OUTCOMES   = ['do_not_call', 'dnc_request', 'wrong_number', 'disconnected'];

// Legacy shim — kept for back-compat with the call site below. New code
// should use resolveAssignedTo() from _shared.js which is async and reads
// from sdr_users for every active SDR.
async function sdrEmailFromKey(k) {
    return await resolveAssignedTo(k);
}

async function statsFromUpstream() {
    const r = await forwardToProspecting({ method: 'GET', path: '/api/prospects/stats' });
    if (r.status !== 200 || !r.json) {
        return { by_tier: {}, callable_ready: null, emailable_ready: null, _source: 'upstream_error' };
    }
    return {
        by_tier: r.json.by_tier || {},
        callable_ready:  Number(r.json.callable_ready  || 0),
        emailable_ready: Number(r.json.emailable_ready || 0),
        _source: 'upstream_stats'
    };
}

// Distinct lead_ids from lead_calls for this SDR matching the predicate(qb).
// Returns -1 on error so callers can distinguish "no rows" from "query failed".
async function distinctLeadsByLoggedBy(sb, sdrEmail, predicate) {
    if (!sdrEmail) return -1;
    try {
        let q = sb.from('lead_calls')
            .select('lead_id', { count: 'exact', head: false })
            .eq('logged_by', sdrEmail);
        if (typeof predicate === 'function') q = predicate(q);
        const { data, error } = await q.limit(5000);
        if (error) return -1;
        const set = new Set();
        (data || []).forEach(r => { if (r.lead_id != null) set.add(r.lead_id); });
        return set.size;
    } catch (_) { return -1; }
}

async function localStats(sdrEmail, clientIdOverride) {
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

        // assigned_to-based scoping for all lead-table counts. The column was
        // backfilled via parity (even IDs → Remy, odd → David) matching the
        // callable batch split. lead_calls.logged_by is NOT used for counts
        // because it is sparse (old calls updated leads directly, not lead_calls).
        //
        // Client-account reps: every lead-table count additionally scopes to
        // the client's pool, and the per-lead script gate is dropped (client
        // campaigns run ONE shared script) — mirroring callable.js client
        // mode. Without this the tiles counted the rep's whole historical
        // STILO book while the list below showed only the client pool
        // (the 1,590 / 1,663 counter incident, 2026-08-27).
        const clientId = clientIdOverride || await resolveClientScope(sdrEmail);
        // ONE round trip for all ten counters.
        //
        // This used to be ten parallel PostgREST `count=exact, head=true`
        // requests. None of them can use an index (every one carries an
        // OR-chain), so each was a full scan of prospecting.leads, and the
        // admin Leads tab calls this endpoint on mount — so one page load
        // asked for ten whole-table scans at once.
        //
        // Each count takes 86 ms inside Postgres. Ten in parallel stalled the
        // PostgREST layer roughly every other attempt, hanging past 30 s with
        // the database completely idle: pg_stat_activity showed no active
        // query and no lock wait. The request never returned and never failed,
        // so the client sat on "Loading prospects..." and the four workflow
        // cards sat on their em-dashes indefinitely. A 15-second edge cache was
        // the only reason the tab ever rendered (2026-08-29).
        //
        // prospecting.lead_lifecycle_counts does the same work in one scan and
        // one round trip. See api/migrations/lifecycle_counts_rpc.sql.
        const { data: rpcCounts, error: rpcError } = await sb.rpc('lead_lifecycle_counts', {
            p_sdr_email:  sdrEmail || null,
            p_client_id:  clientId || null,
            p_start_day:  startOfDay.toISOString(),
            p_start_week: startOfWeek.toISOString(),
            p_end_day:    endOfDay.toISOString()
        });
        if (rpcError || !rpcCounts) {
            // Missing function or a bad scope value. Fall through to the
            // upstream /stats fallback rather than serving zeroes as if they
            // were real counts.
            console.error('[lifecycle-stats] rpc failed:', rpcError && rpcError.message);
            return null;
        }
        const n = function (k) { return Number(rpcCounts[k] || 0); };
        const scoping_applied = !!sdrEmail;

        // Leads assigned to the rep but hidden from the call list because David
        // hasn't shipped their sales script yet (snapshotted by the script sync).
        // sb is the prospecting-scoped client created at the top of localStats.
        const awaitingQ = (function () {
            let aq = sb.from('awaiting_script').select('lead_id', { count: 'exact', head: true });
            if (sdrEmail) aq = aq.eq('assigned_to', sdrEmail);
            return aq;
        })();

        // True dials today: lead_calls rows logged by this rep (scoped when
        // sdrEmail is set). The Leads tab "Called today" card uses this so it
        // matches the Team tab's dial count, instead of the distinct-leads-by-
        // assignment count (called_today_count) which reads lower.
        const dialsQ = (function () {
            let dq = sb.from('lead_calls').select('id', { count: 'exact', head: true })
                .gte('called_at', startOfDay.toISOString());
            if (sdrEmail) dq = dq.eq('logged_by', sdrEmail);
            return dq;
        })();

        // Two cheap indexed counts, together. Neither is allowed to fail the
        // response: a missing snapshot table just means zero awaiting scripts.
        let awaitingCount = 0, dialsToday = 0;
        try {
            const [aRes, dRes] = await Promise.all([awaitingQ, dialsQ]);
            awaitingCount = (aRes && aRes.count) || 0;
            dialsToday    = (dRes && dRes.count) || 0;
        } catch (_) { /* leave both at zero */ }

        return {
            tier_counts: {
                hot:  n('hot'),
                warm: n('warm'),
                cool: n('cool'),
                dead: n('dead_pool')
            },
            tab_badges: { callbacks: n('callbacks'), booked: n('booked') },
            activity: {
                calls_today:         n('called_today'),
                booked_this_week:    n('booked_week'),
                callbacks_due_today: n('callbacks_due')
            },
            all_leads_count:            n('all_callable'),
            called_today_count:         n('called_today'),
            dials_today_count:          dialsToday,
            callbacks_due_today_count:  n('callbacks_due'),
            dead_pool_count:            n('dead_pool'),
            awaiting_script_count:      awaitingCount,
            _scoping_applied: scoping_applied,
            _source: 'supabase_local'
        };
    } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    // SDR scoping: SDR caller is force-scoped to their own email; admin
    // can pass ?assigned_to=<sdr_key|email> explicitly.
    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) {
        sdrEmail = gate.email;
    } else if (req.query && req.query.assigned_to) {
        sdrEmail = await resolveAssignedTo(req.query.assigned_to);
    }

    // Admin master view: ?client_id=<uuid> scopes every count to that
    // client's pool (with or without a rep filter) — same override
    // callable.js honors for the admin Account filter.
    const clientIdOverride = (gate.isAdmin && req.query && req.query.client_id)
        ? String(req.query.client_id) : null;

    try {
        const [local, upstream] = await Promise.all([
            localStats(sdrEmail, clientIdOverride),
            statsFromUpstream()
        ]);

        let tier, badges, activity, source;
        if (local) {
            tier = local.tier_counts; badges = local.tab_badges; activity = local.activity;
            source = local._source;
        } else {
            // Final fallback: David's /stats by_tier — note this includes the
            // ~4.7k auto-classified `prospect_tier='dead'` archive that was
            // never called by us. The workflow cards intentionally do NOT
            // expose this number to dead_pool_count (we'd rather show 0 than
            // a misleading 4,767), only kept for legacy diagnostic display.
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

        // Headline number. SDR-scoped takes the local count (matches the
        // table). Global view falls back to David's strict callable_ready.
        const callableReady = (local && sdrEmail)
            ? local.all_leads_count
            : (upstream.callable_ready != null ? upstream.callable_ready : ((tier.hot || 0) + (tier.warm || 0)));

        const result = {
            tier_counts: tier,
            tab_badges:  badges,
            activity:    activity,
            callable_ready: callableReady,
            // Workflow cards. Dead Pool intentionally NEVER inherits
            // tier.dead (David's archive) — must come from the explicit
            // OUT_OF_PIPELINE query so we don't show 4,767 by accident.
            all_leads_count:           local ? local.all_leads_count : callableReady,
            awaiting_script_count:     local ? local.awaiting_script_count : 0,
            called_today_count:        local ? local.called_today_count : 0,
            callbacks_due_today_count: local ? local.callbacks_due_today_count : 0,
            dead_pool_count:           local ? local.dead_pool_count : 0,
            scoped_to_sdr: sdrEmail || null,
            scoping_applied: !!(local && local._scoping_applied),
            source: source
        };
        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
        res.setHeader('Vary', 'Authorization');
        return res.status(200).json(result);
    } catch (e) {
        console.error('[lifecycle-stats]', e);
        return res.status(500).json({ error: 'lifecycle_stats_failed', detail: String(e.message || e) });
    }
};
