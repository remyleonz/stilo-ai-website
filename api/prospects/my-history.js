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
const { assertAdminOrSdr, scopedQuery, resolveAssignedTo, methodNotAllowed } = require('./_shared');
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
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    const q = req.query || {};
    // Scope target. Admins (including the admin→SDR impersonation flow, which
    // sends ?assigned_to=<sdr email>) may view ANY rep's history; a plain SDR is
    // always locked to their own. Previously only remy/david were honorable, so
    // impersonating any other SDR silently showed the admin's own calls — which
    // is why a rep's Call History looked nearly empty.
    let targetEmail = gate.email;
    if (gate.isAdmin) {
        const override = q.assigned_to
            ? await resolveAssignedTo(q.assigned_to)
            : (q.email ? String(q.email).trim().toLowerCase() : null);
        if (override) targetEmail = override;
    }
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
        // Two-stage query so we don't lose leads when the most-recent
        // lead_calls row has logged_by=null (e.g. webhook race where the
        // OpenPhone push lands AFTER the admin's manual log). Stage 1: find
        // every lead_id where ANY call in the date range is attributable to
        // the SDR (or any SDR if all=1). Stage 2: pull the most recent call
        // per lead, regardless of who logged it, so the table renders the
        // freshest outcome/time.
        let scopeQuery = sb.from('lead_calls')
            .select('lead_id')
            .not('lead_id', 'is', null)
            .order('called_at', { ascending: false })
            .limit(2000);
        if (!allSdrs) scopeQuery = scopeQuery.eq('logged_by', targetEmail);
        if (since)    scopeQuery = scopeQuery.gte('called_at', since);
        if (until)    scopeQuery = scopeQuery.lte('called_at', until);
        const { data: scopeRows, error: scopeErr } = await scopeQuery;
        if (scopeErr) throw scopeErr;

        const scopedLeadIds = Array.from(new Set((scopeRows || []).map(r => r.lead_id)));
        if (scopedLeadIds.length === 0) {
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

        // Stage 2: pull the freshest call per scoped lead (any logger).
        let detailQuery = sb.from('lead_calls')
            .select('lead_id, called_at, outcome, notes, logged_by, transcript, transcript_summary, recording_url, duration_seconds')
            .in('lead_id', scopedLeadIds)
            .order('called_at', { ascending: false })
            .limit(2000);
        if (since) detailQuery = detailQuery.gte('called_at', since);
        if (until) detailQuery = detailQuery.lte('called_at', until);
        const { data: calls, error: callsErr } = await detailQuery;
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
                logged_by: call.logged_by || null,
                // Carry the call's transcript/summary/recording so the Call
                // History tab can show them inline (parity with admin).
                transcript: call.transcript || null,
                transcript_summary: call.transcript_summary || null,
                recording_url: call.recording_url || null,
                duration_seconds: call.duration_seconds || null
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
