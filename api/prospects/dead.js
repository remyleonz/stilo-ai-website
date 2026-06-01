/**
 * GET /api/prospects/dead?limit=200
 *
 * Dead pool: leads out of the cold-call lifecycle — a terminal outcome
 * (do_not_call / dnc_request / wrong_number / disconnected) OR dialed 3+
 * times with no result. Reads Supabase prospecting.leads directly (the old
 * forward to David's Cloud Run hangs under load).
 *
 * SDR scoping: SDR callers are force-scoped to their own email; admins may
 * pass ?assigned_to=<sdr_key|email>.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const TERMINAL = ['do_not_call', 'dnc_request', 'wrong_number', 'disconnected'];

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) sdrEmail = gate.email;
    else if (req.query && req.query.assigned_to) sdrEmail = await resolveAssignedTo(req.query.assigned_to);

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '200', 10), 1), 500);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    let q = sb.from('leads')
        .select('*')
        .or('last_called_outcome.in.(' + TERMINAL.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null)');
    if (sdrEmail) q = q.eq('assigned_to', sdrEmail);

    const { data, error } = await q
        .order('last_called_at', { ascending: false, nullsFirst: false })
        .limit(limit);

    if (error) {
        console.error('[dead]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
