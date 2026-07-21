/**
 * GET /api/prospects/list-booked?limit=400
 *
 * Server-side query against prospecting.leads using the service-role key.
 * Returns leads with last_called_outcome='booked_meeting', ordered by
 * last_called_at desc (most recently booked first).
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts', 'call_notes',
    'next_action_due_at', 'owner_phone_strict_pass', 'assigned_to',
    'meeting_event_id', 'meeting_event_link', 'meeting_meet_link',
    'meeting_scheduled_at', 'meeting_duration_min', 'meeting_booked_by_sdr',
    'nurture_stage',
    // Which agent the meeting was booked for. The Booked tab shows this so a
    // rep walking into a call knows what they are selling without opening the
    // lead. matched_product_name is the older derived fallback.
    'pitch_agent', 'matched_product_name',
    // Drives the "needs a triage call" flag on the callback calendar: a meeting
    // the prospect never confirmed is the one the rep has to phone.
    'meeting_confirmed_at', 'meeting_confirmation_sent_at',
    'vsl_followup_sms_sent_at', 'day_before_sms_sent_at'
].join(',');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '400', 10), 1), 1000);

    // Scope, mirroring callable/callbacks. This endpoint previously returned
    // EVERY rep's booked meetings to every caller, which leaked other reps'
    // meetings onto an SDR's callback calendar and Booked tab.
    //   - real SDR  -> forced to their own book
    //   - admin     -> honors ?assigned_to (impersonation + the admin rep filter),
    //                  and returns everything when no rep is selected.
    // A rep "owns" a meeting if the lead is assigned to them OR they booked it.
    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) {
        sdrEmail = gate.email;
    } else if (req.query && req.query.assigned_to) {
        sdrEmail = await resolveAssignedTo(req.query.assigned_to);
    }

    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        let q = sb.from('leads')
            .select(SELECT_COLS)
            .not('meeting_scheduled_at', 'is', null);
        if (sdrEmail) {
            q = q.or('assigned_to.eq.' + sdrEmail + ',meeting_booked_by_sdr.eq.' + sdrEmail);
        }
        const resp = await q
            .order('meeting_scheduled_at', { ascending: true, nullsFirst: false })
            .limit(limit);
        if (resp.error) throw resp.error;
        return res.status(200).json({ results: resp.data || [] });
    } catch (e) {
        console.error('[list-booked]', e);
        return res.status(500).json({ error: 'list_booked_failed', detail: String(e.message || e) });
    }
};
