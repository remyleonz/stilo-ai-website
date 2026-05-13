/**
 * GET /api/prospects/my-history?limit=200&offset=0&email=<override>&all=1&since=<iso>&until=<iso>
 *
 * Durable per-SDR call history. Source of truth is `prospecting.lead_calls`
 * (filled by both the admin's POST /log-call and OpenPhone/Quo webhooks).
 *
 * Scoping:
 *   - default          → calls logged by the JWT user
 *   - ?email=<sdr>     → calls logged by another admin SDR (allowlisted)
 *   - ?all=1           → calls logged by anyone (drops the logged_by filter
 *                        so the admin can see the agency-wide call log)
 *
 * Date range (optional, applied to lead_calls.called_at):
 *   - ?since=<iso>     → inclusive lower bound
 *   - ?until=<iso>     → inclusive upper bound
 *
 * Distinct from:
 *   - Calls Today (today only, any SDR)
 *   - Dead Pool   (terminal outcome OR call_attempts >= 3)
 */
const { assertAdmin, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const ADMIN_SDRS = ['remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

const LEAD_SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts',
    'next_action_due_at', 'next_action_type', 'assigned_to'
].join(',');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    const q = req.query || {};
    const rawOverride = q.email && String(q.email).trim().toLowerCase();
    // Only honor overrides for the two admin SDRs.
    const targetEmail = (rawOverride && ADMIN_SDRS.includes(rawOverride))
        ? rawOverride
        : gate.email;
    const allSdrs = q.all === '1' || q.all === 'true' || q.all === 1 || q.all === true;
    const limit  = Math.min(parseInt(q.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    // Date range — accept ISO timestamps OR YYYY-MM-DD. We pass through to
    // .gte() / .lte() which Supabase will coerce against the timestamptz
    // column. Invalid values silently fall through (no filter).
    const sinceRaw = q.since && String(q.since).trim();
    const untilRaw = q.until && String(q.until).trim();
    const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : null;
    const until = untilRaw && !Number.isNaN(Date.parse(untilRaw)) ? untilRaw : null;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    try {
        // Pull lead_calls rows for the chosen scope, newest first. Cap
        // generously — we dedupe to one row per lead on the client side
        // below. When all=1 the cap caps the pool size, not per-SDR rows.
        let query = sb.from('lead_calls')
            .select('lead_id, called_at, outcome, notes, logged_by')
            .order('called_at', { ascending: false })
            .limit(1000);
        if (!allSdrs) query = query.eq('logged_by', targetEmail);
        if (since)   query = query.gte('called_at', since);
        if (until)   query = query.lte('called_at', until);
        const { data: calls, error: callsErr } = await query;
        if (callsErr) throw callsErr;

        if (!calls || !calls.length) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({
                results: [],
                email: allSdrs ? null : targetEmail,
                scope: allSdrs ? 'all' : 'sdr',
                since: since || null,
                until: until || null,
                note: 'No call history yet. Log a call from the lead drawer to populate this list.'
            });
        }

        // Keep the most recent call per lead. (In the all-SDRs view, that
        // means whichever rep called the lead most recently is the one shown
        // in the Logged By column.)
        const latestByLead = new Map();
        for (const c of calls) {
            if (!latestByLead.has(c.lead_id)) latestByLead.set(c.lead_id, c);
        }
        const leadIds = Array.from(latestByLead.keys()).slice(offset, offset + limit);

        const { data: leads, error: leadsErr } = await sb.from('leads')
            .select(LEAD_SELECT_COLS)
            .in('id', leadIds);
        if (leadsErr) throw leadsErr;

        // Merge: stamp the lead row with the most-recent-call outcome + time
        // for this scope so the table can render Time / Outcome / Logged By
        // columns directly without an extra join client-side.
        const leadById = new Map((leads || []).map(l => [l.id, l]));
        const results = leadIds.map(id => {
            const lead = leadById.get(id);
            const call = latestByLead.get(id);
            if (!lead) return null;
            return {
                ...lead,
                // Override these for rendering — the calls-today / my-history
                // row template reads from these and we want the call's view,
                // not the global one.
                last_called_at: call.called_at || lead.last_called_at,
                last_called_outcome: call.outcome || lead.last_called_outcome,
                logged_by: call.logged_by || null
            };
        }).filter(Boolean);

        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            results,
            email: allSdrs ? null : targetEmail,
            scope: allSdrs ? 'all' : 'sdr',
            since: since || null,
            until: until || null,
            count: results.length,
            total: latestByLead.size
        });
    } catch (e) {
        console.error('[my-history] query failed', e);
        return res.status(200).json({
            results: [],
            note: 'Could not load call history: ' + (e.message || 'unknown')
        });
    }
};
