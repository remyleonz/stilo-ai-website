/**
 * GET /api/prospects/dead?limit=200
 *
 * Dead pool: leads out of the cold-call lifecycle — a terminal outcome
 * (do_not_call / dnc_request / wrong_number / disconnected), OR dialed 3+
 * times with no result, OR retired in a named bulk batch (archived_batch).
 * Reads Supabase prospecting.leads directly (the old forward to David's Cloud
 * Run hangs under load).
 *
 * Archived batches are the "folder" case: a rep leaves and their untouched
 * board is retired as one named set (luke-huron-2026-08-06) rather than
 * disappearing into a rep account nobody logs into. They belong in this view
 * because they ARE out of the lifecycle, and keeping them findable is the whole
 * point of naming the batch. `?batch=<slug>` narrows to one, and
 * `?batch=none` excludes archived rows to get the old behaviour back.
 *
 * SDR scoping: SDR callers are force-scoped to their own email; admins may
 * pass ?assigned_to=<sdr_key|email>.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead, LEAD_LIST_COLUMNS } = require('./_shared');
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

    const batch = (req.query && req.query.batch) ? String(req.query.batch) : null;

    // List columns only. The dead pool renders the standard lead table, and
    // archived_batch is a filter here rather than something the table shows.
    let q = sb.from('leads').select(LEAD_LIST_COLUMNS);
    if (batch && batch !== 'none') {
        // One named batch, on its own. Nothing else applies.
        q = q.eq('archived_batch', batch);
    } else if (batch === 'none') {
        q = q.is('archived_batch', null)
             .or('last_called_outcome.in.(' + TERMINAL.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null)');
    } else {
        q = q.or('last_called_outcome.in.(' + TERMINAL.join(',') + '),and(call_attempts.gte.3,last_called_outcome.is.null),archived_batch.not.is.null');
    }
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
