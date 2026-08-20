/**
 * POST /api/prospects/set-callback
 * Body: { id, action, when_iso? }
 *
 * The ONE write endpoint behind the editable Callbacks list in /admin/ and
 * /sdr/. Three actions:
 *
 *   reschedule  { id, action:'reschedule', when_iso }
 *       Moves the callback. Sets next_action_due_at + next_action_type and
 *       CLEARS the dismissal, so a lead that was removed comes back the moment
 *       someone re-schedules it.
 *   dismiss     { id, action:'dismiss' }
 *       Takes the lead off the list without touching call history.
 *   called      { id, action:'called' }
 *       Records the dial (same shape as log-dial.js: bump call_attempts, stamp
 *       last_called_at, leave last_called_outcome alone) and then dismisses it,
 *       because a callback that has been made should leave the queue. The rep
 *       still logs the outcome from the drawer as usual.
 *
 * Why a dismissal column and not a column reset:
 *
 * A lead is on the Callbacks list via EITHER of two paths (see callbacks.js):
 *   1. last_called_outcome IN ('callback_requested','interested_followup')
 *   2. next_action_type = 'callback' with a non-machine outcome
 * Clearing next_action_type only kills path 2, so a lead sitting there via
 * path 1 would stay put and the rep would call the prospect twice. Rewriting
 * last_called_outcome would kill path 1 too, but that column is the real call
 * history that team-analytics, the lifecycle stages and commission attribution
 * all read, so it is off limits. prospecting.leads.callback_dismissed_at is the
 * non-destructive answer: both read endpoints filter on it, nothing else does.
 *
 * SDR scoping: an SDR may only edit a lead in their own book. Admins may edit
 * any lead. Mirrors the read endpoints, which force assigned_to = caller email.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const ACTIONS = ['reschedule', 'dismiss', 'called'];

// A callback time has to be a real instant, and inside a window a human could
// plausibly mean. An unparseable string used to sail straight into a
// timestamp column as null and silently un-schedule the callback.
function parseWhen(raw) {
    if (raw == null || raw === '') return { error: 'missing_when_iso' };
    const s = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return { error: 'when_iso_not_iso8601' };
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : (s.replace(' ', 'T') + 'Z'));
    if (!Number.isFinite(ms)) return { error: 'when_iso_unparseable' };
    const year = new Date(ms).getUTCFullYear();
    if (year < 2020 || year > 2100) return { error: 'when_iso_out_of_range' };
    return { iso: new Date(ms).toISOString() };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const id = safeNumberId(body.id != null ? body.id : body.lead_id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const action = String(body.action || '').toLowerCase();
    if (ACTIONS.indexOf(action) === -1) {
        return res.status(400).json({ error: 'bad_action', allowed: ACTIONS });
    }

    let when = null;
    if (action === 'reschedule') {
        when = parseWhen(body.when_iso);
        if (when.error) return res.status(400).json({ error: when.error });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const { data: lead, error: rdErr } = await sb.from('leads')
        .select('id, name, assigned_to, call_attempts, last_called_at, next_action_due_at, next_action_type, callback_dismissed_at')
        .eq('id', id)
        .maybeSingle();
    if (rdErr) return res.status(500).json({ error: 'lead_read_failed', detail: rdErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // An SDR editing someone else's lead is a hard 403, not a quiet no-op: a
    // silent success would show the row leaving their calendar while the other
    // rep still has the callback on theirs.
    if (gate.isSdr && !gate.isAdmin) {
        const mine = String(lead.assigned_to || '').toLowerCase() === String(gate.email || '').toLowerCase();
        if (!mine) return res.status(403).json({ error: 'not_your_lead' });
    }

    const nowIso = new Date().toISOString();
    let update;
    let result = { ok: true, id: id, action: action };

    if (action === 'reschedule') {
        update = {
            next_action_due_at: when.iso,
            next_action_type: 'callback',
            callback_dismissed_at: null,
            callback_dismissed_by: null
        };
        result.next_action_due_at = when.iso;
    } else if (action === 'dismiss') {
        update = { callback_dismissed_at: nowIso, callback_dismissed_by: gate.email };
        result.callback_dismissed_at = nowIso;
    } else {
        const newAttempts = (lead.call_attempts || 0) + 1;
        update = {
            call_attempts: newAttempts,
            last_called_at: nowIso,
            callback_dismissed_at: nowIso,
            callback_dismissed_by: gate.email
        };
        result.call_attempts = newAttempts;
        result.last_called_at = nowIso;
        result.callback_dismissed_at = nowIso;
    }

    const { error: upErr } = await sb.from('leads').update(update).eq('id', id);
    if (upErr) return res.status(500).json({ error: 'lead_update_failed', detail: upErr.message });

    return res.status(200).json(result);
};
