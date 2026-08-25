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
const { assertAdmin, resolveAssignedTo, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts', 'call_notes',
    'next_action_due_at', 'next_action_type', 'owner_phone_strict_pass',
    'do_not_call', 'assigned_to'
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

    // Scope to one rep's callbacks when the admin has an SDR selected. Without
    // this the pool returned every rep's callbacks regardless of the selected
    // SDR (Remy showed 8 callbacks that were actually his SDRs'). Accepts a
    // sdr_key ('remy'/'david'/<key>) or an email; resolves to the email stored
    // in leads.assigned_to.
    const assignedTo = (req.query && req.query.assigned_to)
        ? await resolveAssignedTo(req.query.assigned_to)
        : null;

    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        // NOTE: booked meetings are NOT merged in here. The callbacks calendar
        // plots them as a separate layer from /api/prospects/list-booked, so
        // adding them would double-draw every meeting.
        // Human-scheduled callbacks only — same filter as callbacks.js. A bare
        // next_action_type='callback' doesn't qualify when the last outcome was
        // a machine one (voicemail / no_answer / missed_inbound): those stamps
        // came from auto-retry scheduling, not a rep promising a callback.
        // Dismissed callbacks are hidden, never deleted — same filter as
        // callbacks.js, and it has to be here too or a lead removed in /sdr/
        // would still show in /admin/. See set-callback.js for why a dismissal
        // column is the only safe way off this list.
        let q = sb.from('leads')
            .select(SELECT_COLS)
            .or('last_called_outcome.in.(callback_requested,interested_followup),and(next_action_type.eq.callback,or(last_called_outcome.is.null,last_called_outcome.not.in.(voicemail,no_answer,missed_inbound)))')
            .is('callback_dismissed_at', null)
            // do_not_call is a nullable boolean and most rows are NULL, not
            // false. PostgREST's neq drops NULL rows (NULL != true is NULL, not
            // true), so the old .neq('do_not_call', true) hid every callback
            // that had never been explicitly marked callable: the admin tab
            // showed 4 of 20 while /sdr/ showed all of them. Match callbacks.js,
            // which always used the null-safe form.
            .or('do_not_call.is.null,do_not_call.eq.false');
        // Same offer/client gate as callbacks.js: STILO reps see current-offer
        // callbacks, a client-account rep sees their client's. Keep in sync.
        const shared = require('./_shared');
        q = shared.gateToCurrentOffer(q, await shared.resolveClientScope(assignedTo));
        if (assignedTo) q = q.eq('assigned_to', assignedTo);
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
