/**
 * POST /api/prospects/meeting-outcome
 * Body: { lead_id, outcome, notes? }
 *
 * Logs what happened in a booked sales meeting, the meeting analog of cold-call
 * logging. Writes a row to prospecting.lead_meetings so it shows in the lead's
 * meeting history, and moves the lifecycle stage when the outcome is terminal
 * (closed_won / closed_lost). Non-terminal outcomes (interested, needs_time,
 * no_show, rescheduled) keep the lead in MEETING_BOOKED.
 *
 * Reschedule itself is handled by /api/prospects/book-meeting (it rewrites the
 * meeting time + calendar event); this endpoint just records the outcome.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const OUTCOMES = {
    interested:  { label: 'Interested, moving forward', stage: null },
    needs_time:  { label: 'Needs time to think',        stage: null },
    rescheduled: { label: 'Rescheduled',                stage: null },
    no_show:     { label: 'No-show',                    stage: null },
    closed_won:  { label: 'Closed won',                 stage: 'CLOSED_WON' },
    closed_lost: { label: 'Closed lost',                stage: 'CLOSED_LOST' }
};

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.lead_id);
    const outcome = String(body.outcome || '');
    if (leadId == null) return res.status(400).json({ error: 'missing_lead_id' });
    const def = OUTCOMES[outcome];
    if (!def) return res.status(400).json({ error: 'invalid_outcome', allowed: Object.keys(OUTCOMES) });

    const notes = (body.notes && String(body.notes).trim()) || null;
    const sb = leadsClient();

    // Record the outcome as a meeting record (newest first in the lead's history).
    const { error: insErr } = await sb.from('lead_meetings').insert({
        lead_id: leadId,
        source: 'manual',
        title: 'Meeting outcome: ' + def.label,
        occurred_at: new Date().toISOString(),
        summary: 'Meeting outcome: ' + def.label + (notes ? '\n\n' + notes : ''),
        created_by: gate.email || null
    });
    if (insErr) return res.status(500).json({ error: 'log_failed', detail: insErr.message });

    // Terminal outcomes move the lifecycle stage. Others stay MEETING_BOOKED.
    let stageUpdated = null;
    if (def.stage) {
        const { error: updErr } = await sb.from('leads')
            .update({ stage: def.stage, updated_at: new Date().toISOString() })
            .eq('id', leadId);
        if (!updErr) stageUpdated = def.stage;
    }

    return res.status(200).json({ ok: true, outcome: outcome, label: def.label, stage: stageUpdated });
};
