/**
 * GET /api/prospects/my-history?limit=200&offset=0&email=<override>
 *
 * Durable "every lead I've personally called" view. Source of truth is
 * `prospecting.lead_calls` (filled by both the admin's POST /log-call and
 * OpenPhone/Quo webhooks). We filter by logged_by = caller's email, group
 * by lead_id (keep the most recent call per lead), then join to leads for
 * the row display.
 *
 * Distinct from:
 *   - Calls Today (today only, any SDR)
 *   - Dead Pool   (terminal outcome OR call_attempts >= 3)
 *
 * Admin can override email via `?email=<other-sdr>` to inspect another rep's
 * history. The override is gated to the two admin SDRs server-side.
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
    const limit  = Math.min(parseInt(q.limit, 10) || 200, 500);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    try {
        // Pull lead_calls rows for this SDR, newest first. Cap generously —
        // we dedupe to one row per lead on the client side below.
        const { data: calls, error: callsErr } = await sb.from('lead_calls')
            .select('lead_id, called_at, outcome, notes, logged_by')
            .eq('logged_by', targetEmail)
            .order('called_at', { ascending: false })
            .limit(1000);
        if (callsErr) throw callsErr;

        if (!calls || !calls.length) {
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({
                results: [],
                email: targetEmail,
                note: 'No call history yet. Log a call from the lead drawer to populate this list.'
            });
        }

        // Keep the most recent call per lead.
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
        // for this SDR so the table can render Time / Outcome columns even
        // when the lead's last_called_outcome belongs to a different rep.
        const leadById = new Map((leads || []).map(l => [l.id, l]));
        const results = leadIds.map(id => {
            const lead = leadById.get(id);
            const call = latestByLead.get(id);
            if (!lead) return null;
            return {
                ...lead,
                // Override these for rendering — the calls-today row template
                // reads from these and we want the SDR's view, not the global one.
                last_called_at: call.called_at || lead.last_called_at,
                last_called_outcome: call.outcome || lead.last_called_outcome
            };
        }).filter(Boolean);

        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            results,
            email: targetEmail,
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
