/**
 * POST /api/prospects/set-nurture-stage
 * Body: { id, stage }
 *
 * Persists an operator override for where a booked lead sits in the pre-meeting
 * NURTURE sequence (prospecting.leads.nurture_stage). Pass stage=null (or "")
 * to clear the override and let the dashboard derive the stage again.
 *
 * The nurture email automation isn't built yet, so today the admin drawer
 * derives the stage from existing signals (meeting_scheduled_at, an outbound
 * value email in lead_messages, a lead_meetings outcome). This endpoint is the
 * manual escape hatch — and the column the future automation will write.
 *
 * Mirrors save-notes.js: nurture_stage is written ONLY here (plus the future
 * automation), never by any call-logging path, so it survives every state
 * change.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const STAGES = ['booked', 'vsl_sent', 'value', 'triaged', 'confirmed', 'showed'];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    // Empty / null clears the override (derive again). Otherwise it must be a
    // known stage key.
    let stage = body.stage == null ? null : String(body.stage).trim();
    if (stage === '') stage = null;
    if (stage != null && STAGES.indexOf(stage) === -1) {
        return res.status(400).json({ error: 'invalid_stage', allowed: STAGES });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const { error } = await sb.from('leads')
        .update({ nurture_stage: stage, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, nurture_stage: stage });
};
