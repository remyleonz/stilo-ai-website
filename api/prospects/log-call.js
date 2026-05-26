/**
 * POST /api/prospects/log-call
 * Body: { id, outcome, notes, next_callback_at?, logged_by_override? }
 * Forwards to upstream POST /api/prospects/{id}/log-call.
 *
 * David's API expects `callback_at` (per FRONTEND_BRIEF.md), not the
 * `next_callback_at` the frontend was sending. We accept either name from
 * the client and forward as `callback_at` so the backend's auto-scheduling
 * (next_action_due_at, next_action_type) kicks in for callback_requested.
 *
 * Dual-writes:
 *   1. INSERT into prospecting.lead_calls with the SDR's email in
 *      `logged_by`. This is the source of truth for My Call History and
 *      per-SDR action counts (Called Today, Dead Pool by SDR).
 *   2. UPDATE prospecting.leads.last_called_at + last_called_outcome so the
 *      row reflects the call immediately even if the upstream lags.
 *
 * Both writes use the service-role key and are best-effort — the upstream
 * forward is still the source of truth for lifecycle state (auto-decay,
 * callback scheduling, etc.).
 */
const { assertAdminOrSdr, scopedQuery, forwardToProspecting, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    if (!body.outcome) return res.status(400).json({ error: 'missing_outcome' });
    const callbackAt = body.callback_at || body.next_callback_at || null;
    // Default to the caller's email. Allow override only between admin SDRs
    // (Remy logging David's call or vice versa). Any other override falls back
    // to the JWT email so we never trust an arbitrary client value.
    const ADMIN_SDRS = ['remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];
    const override = body.logged_by_override && String(body.logged_by_override).trim().toLowerCase();
    const loggedBy = (override && ADMIN_SDRS.includes(override)) ? override : gate.email;

    const upstream = await forwardToProspecting({
        method: 'POST',
        path: '/api/prospects/' + id + '/log-call',
        body: {
            outcome: body.outcome,
            notes: body.notes || '',
            callback_at: callbackAt,
            logged_by: loggedBy
        }
    });

    const calledAtIso = new Date().toISOString();
    const client = sb();

    // 1. Write to prospecting.lead_calls — the table the detail drawer
    //    + My Call History both read from. `logged_by` is what scopes
    //    per-SDR queries server-side, so this is the load-bearing write
    //    for SDR attribution.
    //
    //    Merge rule: find the most recent Quo-side row for THIS lead that
    //    hasn't been dispositioned by a human yet. "Human outcome" =
    //    anything other than what the Quo webhook auto-derives from the
    //    call status (answered / voicemail / no_answer / missed_inbound).
    //    If such a row exists, UPDATE it with the human outcome + notes.
    //    Otherwise INSERT a new row.
    //
    //    Why this is the right key (not a time window):
    //      - Tied to the actual call event, not a guess at "how long ago
    //        was the last call." Calling back a lead a week later won't
    //        accidentally merge onto the prior call — the prior call's
    //        outcome was already a human value (booked_meeting / dnc /
    //        etc.) so it's filtered out as a merge candidate.
    //      - The Quo row for the new call (still 'answered' from auto-
    //        derivation) IS picked up as the target.
    //      - If the SDR logs WAY later (next day) and the new Quo row
    //        is still 'answered', the merge still works — there's no
    //        artificial time bound to miss.
    //
    //    Safety floor: only consider rows from the last 7 days. Prevents
    //    merging onto an ancient un-dispositioned call where the SDR
    //    forgot to log months ago.
    const AUTO_OUTCOMES = new Set(['answered', 'voicemail', 'no_answer', 'missed_inbound']);
    let callInsert = { skipped: 'no_service_key' };
    if (client) {
        try {
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const { data: candidates } = await client.from('lead_calls')
                .select('id, openphone_call_id, called_at, outcome, transcript')
                .eq('lead_id', id)
                .not('openphone_call_id', 'is', null)
                .gte('called_at', sevenDaysAgo)
                .order('called_at', { ascending: false })
                .limit(5);

            // Pick the most recent Quo row whose outcome is still auto-derived
            // (or null), meaning "not yet human-dispositioned."
            const target = (candidates || []).find(r => r.outcome == null || AUTO_OUTCOMES.has(r.outcome));

            if (target) {
                const update = {
                    outcome: body.outcome,
                    logged_by: loggedBy
                };
                if (body.notes && body.notes.trim()) {
                    update.notes = body.notes;
                }
                const { error } = await client.from('lead_calls').update(update).eq('id', target.id);
                callInsert = error
                    ? { error: error.message, merge_target: target.id }
                    : { ok: true, merged: true, call_id: target.id, prior_outcome: target.outcome, had_transcript: !!target.transcript };
            } else {
                const { error } = await client.from('lead_calls').insert({
                    lead_id: id,
                    direction: 'outbound',
                    called_at: calledAtIso,
                    outcome: body.outcome,
                    notes: body.notes || '',
                    logged_by: loggedBy
                });
                callInsert = error ? { error: error.message } : { ok: true, merged: false };
            }
        } catch (e) {
            callInsert = { error: String(e.message || e) };
        }
    }

    // 2. Safety write: stamp last_called_at + last_called_outcome on the
    //    lead row + derive the new lifecycle stage. The trigger on leads
    //    auto-writes a row to lead_stage_history when stage actually changes.
    //    The workflow cards and Cold Call sort rely on these, and silently
    //    dropping the write is what makes "I logged a call but it doesn't
    //    show up anywhere" happen.
    const STAGE_FOR_OUTCOME = {
        booked_meeting:        'MEETING_BOOKED',
        callback_requested:    'ENGAGED',
        interested_followup:   'ENGAGED',
        answered:              'CONTACTED',
        voicemail:             'CONTACTED',
        no_answer:             null,
        not_interested:        'CLOSED_LOST',
        owner_uninterested:    'CLOSED_LOST',
        wrong_number:          'CLOSED_LOST',
        do_not_call:           'CLOSED_LOST',
        dnc_request:           'CLOSED_LOST'
    };
    const nextStage = STAGE_FOR_OUTCOME[body.outcome];
    let leadUpdate = { skipped: 'no_service_key' };
    if (client) {
        try {
            const update = {
                last_called_at: calledAtIso,
                last_called_outcome: body.outcome
            };
            if (nextStage) update.stage = nextStage;
            const { error } = await client.from('leads').update(update).eq('id', id);
            leadUpdate = error ? { error: error.message } : { ok: true, stage: nextStage || 'unchanged' };
        } catch (e) {
            leadUpdate = { error: String(e.message || e) };
        }
    }

    return res.status(upstream.status).json({
        ...(upstream.json || {}),
        _stilo_call_insert: callInsert,
        _stilo_lead_update: leadUpdate
    });
};
