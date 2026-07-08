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
    const notes = (body.notes && String(body.notes).trim()) || null;
    // Outcome is OPTIONAL. A rep can save a plain note ("client wants pricing,
    // follow up Friday") without picking a terminal outcome, and it still lands
    // as a meeting-history row that shows on re-open. If an outcome IS given it
    // must be one we know. A save with neither an outcome nor a note is a no-op.
    const def = outcome ? OUTCOMES[outcome] : null;
    if (outcome && !def) return res.status(400).json({ error: 'invalid_outcome', allowed: Object.keys(OUTCOMES) });
    if (!def && !notes) return res.status(400).json({ error: 'nothing_to_log', detail: 'Pick an outcome or write a note.' });

    const sb = leadsClient();
    const title = def ? ('Meeting outcome: ' + def.label) : 'Note';
    const summary = def ? ('Meeting outcome: ' + def.label + (notes ? '\n\n' + notes : '')) : notes;

    // Record it as a meeting-history row (newest first in the lead's history).
    const { error: insErr } = await sb.from('lead_meetings').insert({
        lead_id: leadId,
        source: 'manual',
        outcome: def ? outcome : null, // structured outcome drives KPIs; null for a plain note
        title: title,
        occurred_at: new Date().toISOString(),
        summary: summary,
        created_by: gate.email || null
    });
    if (insErr) return res.status(500).json({ error: 'log_failed', detail: insErr.message });

    // Terminal outcomes move the lifecycle stage. Others (and plain notes) stay put.
    let stageUpdated = null;
    if (def && def.stage) {
        const { error: updErr } = await sb.from('leads')
            .update({ stage: def.stage, updated_at: new Date().toISOString() })
            .eq('id', leadId);
        if (!updErr) stageUpdated = def.stage;
    }

    return res.status(200).json({ ok: true, outcome: outcome || null, label: def ? def.label : 'Note', stage: stageUpdated });
};
