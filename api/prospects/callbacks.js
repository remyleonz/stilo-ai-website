/**
 * GET /api/prospects/callbacks
 *
 * Leads that need a follow-up call: an explicit callback scheduled
 * (next_action_type='callback') or a call outcome that asks for follow-up
 * (callback_requested / interested_followup), excluding DNC.
 *
 * Reads Supabase prospecting.leads directly (service-role key). We dropped
 * the forward to David's Cloud Run /api/prospects/callbacks because that
 * endpoint hangs under load and left the Callbacks subtab stuck on "Loading…".
 *
 * SDR scoping: SDR callers are force-scoped to their own email; admins may
 * pass ?assigned_to=<sdr_key|email>.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) {
        sdrEmail = gate.email;
    } else if (req.query && req.query.assigned_to) {
        sdrEmail = await resolveAssignedTo(req.query.assigned_to);
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '200', 10), 1), 500);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    let q = sb.from('leads')
        .select('*')
        .or('next_action_type.eq.callback,last_called_outcome.in.(callback_requested,interested_followup)')
        .not('do_not_call', 'eq', true);
    if (sdrEmail) q = q.eq('assigned_to', sdrEmail);

    const { data, error } = await q
        .order('next_action_due_at', { ascending: true, nullsFirst: false })
        .limit(limit);

    if (error) {
        console.error('[callbacks]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
