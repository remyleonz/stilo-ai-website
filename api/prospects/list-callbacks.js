/**
 * GET /api/prospects/list-callbacks?limit=400
 *
 * Server-side query against prospecting.leads using the service-role key.
 * Returns leads scheduled for callback or with a "callback_requested" /
 * "interested_followup" outcome, ordered by next_action_due_at asc.
 *
 * Why server-side: the Supabase JS anon client throws "Invalid schema:
 * prospecting" when the schema isn't on the project's PostgREST allowlist.
 * Routing through Vercel with the service-role key sidesteps that —
 * service role can read any schema regardless of API exposure.
 */
const { assertAdmin, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts', 'call_notes',
    'next_action_due_at', 'next_action_type', 'owner_phone_strict_pass',
    'do_not_call'
].join(',');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '400', 10), 1), 1000);
    // ?due=today narrows to callbacks scheduled for today (and overdue,
    // since those still need calling). The full Call Back sub-tab in the
    // admin omits this param so it remains the future-callback directory.
    const dueToday = String((req.query && req.query.due) || '').toLowerCase() === 'today';
    const now = new Date();
    const endOfDay = new Date(now); endOfDay.setUTCHours(23, 59, 59, 999);

    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        let q = sb.from('leads')
            .select(SELECT_COLS)
            .or('next_action_type.eq.callback,last_called_outcome.in.(callback_requested,interested_followup)')
            .neq('do_not_call', true);
        if (dueToday) {
            q = q.lte('next_action_due_at', endOfDay.toISOString());
        }
        const resp = await q
            .order('next_action_due_at', { ascending: true, nullsFirst: false })
            .limit(limit);
        if (resp.error) throw resp.error;
        return res.status(200).json({ results: resp.data || [], due_filter: dueToday ? 'today' : null });
    } catch (e) {
        console.error('[list-callbacks]', e);
        return res.status(500).json({ error: 'list_callbacks_failed', detail: String(e.message || e) });
    }
};
