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
const { assertAdminOrSdr, scopedQuery, resolveAssignedTo, forwardToProspecting, methodNotAllowed } = require('./_shared');
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

        // assigned_to-based scoping for all lead-table counts. The column was
        // backfilled via parity (even IDs → Remy, odd → David) matching the
        // callable batch split. lead_calls.logged_by is NOT used for counts
        // because it is sparse (old calls updated leads directly, not lead_calls).
        const scope = function (q) {
            return sdrEmail ? q.eq('assigned_to', sdrEmail) : q;
        };

        const callable = function (q) {
            // Callable = has a David-written cold-call script AND a dialable
            // phone, not DNC, still in the cold-call lifecycle. (The scripted
            // set is the callable queue; owner name not required.)
            return scope(q)
                .eq('has_cold_call_script', true)
                .or('owner_phone.not.is.null,phone.not.is.null')
                .or('do_not_call.is.null,do_not_call.eq.false')
                .or('last_called_outcome.is.null,last_called_outcome.not.in.(' + OUT_OF_PIPELINE.join(',') + ')');
        };
        const C = function () { return leads().select('id', { count: 'exact', head: true }); };

        const [hot, warm, cool, deadOut, cb, bk, ct, bw, cd, allLeads] = await Promise.all([
            callable(C()).eq('prospect_tier', 'hot'),
            callable(C()).eq('prospect_tier', 'warm'),
            callable(C()).eq('prospect_tier', 'cool'),
            scope(C()).or('last_called_outcome.in.(' + OUT_OF_PIPELINE.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null)'),
            scope(C()).or('next_action_type.eq.callback,last_called_outcome.in.(callback_requested,interested_followup)')
                .or('do_not_call.is.null,do_not_call.eq.false'),
            scope(C()).eq('last_called_outcome', 'booked_meeting'),
            scope(C()).gte('last_called_at', startOfDay.toISOString()),
            scope(C()).eq('last_called_outcome', 'booked_meeting').gte('last_called_at', startOfWeek.toISOString()),
            scope(C()).eq('next_action_type', 'callback').lte('next_action_due_at', endOfDay.toISOString()),
            callable(C())
        ]);

        // If ANY scope-query failed (most likely cause: assigned_to column
        // doesn't exist yet), retry the lead-side queries without scoping
        // so we at least return global counts. The SDR-action counts below
        // (lead_calls.logged_by) still scope correctly.
        const anyError = [hot, warm, cool, deadOut, cb, bk, ct, bw, cd, allLeads]
            .some(r => r && r.error);
        let scopedHot = hot, scopedWarm = warm, scopedCool = cool, scopedDeadOut = deadOut,
            scopedCb = cb, scopedBk = bk, scopedCt = ct, scopedBw = bw, scopedCd = cd, scopedAll = allLeads;
        let scoping_applied = !!sdrEmail;
        if (anyError && sdrEmail) {
            scoping_applied = false;
            const callableNoScope = function (q) {
                return q
                    .eq('has_cold_call_script', true)
                    .or('owner_phone.not.is.null,phone.not.is.null')
                    .or('do_not_call.is.null,do_not_call.eq.false')
                    .or('last_called_outcome.is.null,last_called_outcome.not.in.(' + OUT_OF_PIPELINE.join(',') + ')');
            };
            const Cu = () => leads().select('id', { count: 'exact', head: true });
            [scopedHot, scopedWarm, scopedCool, scopedDeadOut, scopedCb, scopedBk, scopedCt, scopedBw, scopedCd, scopedAll] = await Promise.all([
                callableNoScope(Cu()).eq('prospect_tier', 'hot'),
                callableNoScope(Cu()).eq('prospect_tier', 'warm'),
                callableNoScope(Cu()).eq('prospect_tier', 'cool'),
                Cu().or('last_called_outcome.in.(' + OUT_OF_PIPELINE.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null)'),
                Cu().or('next_action_type.eq.callback,last_called_outcome.in.(callback_requested,interested_followup)').or('do_not_call.is.null,do_not_call.eq.false'),
                Cu().eq('last_called_outcome', 'booked_meeting'),
                Cu().gte('last_called_at', startOfDay.toISOString()),
                Cu().eq('last_called_outcome', 'booked_meeting').gte('last_called_at', startOfWeek.toISOString()),
                Cu().eq('next_action_type', 'callback').lte('next_action_due_at', endOfDay.toISOString()),
                callableNoScope(Cu())
            ]);
            // If even the unscoped retries failed, bail to upstream fallback.
            if ([scopedHot, scopedWarm, scopedCool, scopedDeadOut, scopedCb, scopedBk, scopedCt, scopedBw, scopedCd, scopedAll].some(r => r && r.error)) {
                return null;
            }
        } else if (anyError) {
            return null;
        }

        return {
            tier_counts: {
                hot:  scopedHot.count  || 0,
                warm: scopedWarm.count || 0,
                cool: scopedCool.count || 0,
                dead: scopedDeadOut.count || 0
            },
            tab_badges: { callbacks: scopedCb.count || 0, booked: scopedBk.count || 0 },
            activity: {
                calls_today:         scopedCt.count || 0,
                booked_this_week:    scopedBw.count || 0,
                callbacks_due_today: scopedCd.count || 0
            },
            all_leads_count:            scopedAll.count || 0,
            called_today_count:         scopedCt.count || 0,
            callbacks_due_today_count:  scopedCd.count || 0,
            dead_pool_count:            scopedDeadOut.count || 0,
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

    try {
        const [local, upstream] = await Promise.all([
            localStats(sdrEmail),
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
