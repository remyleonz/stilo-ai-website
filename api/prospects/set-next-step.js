/**
 * POST /api/prospects/set-next-step
 * Body: { id, next_step, next_step_due }
 *
 * Persists the CRM next step shown on the Sales tab booked-meetings panel.
 * next_step is free text ("Send the proposal, then call Thursday"), next_step_due
 * is an optional YYYY-MM-DD date. Both live on prospecting.leads (migration:
 * api/migrations/leads_next_step.sql) and are written ONLY here, so nothing in
 * the call-logging or nurture paths can wipe them. Clearing both fields is how
 * the UI marks a step done.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const step = (body.next_step == null ? '' : String(body.next_step)).trim().slice(0, 500) || null;
    let due = null;
    if (body.next_step_due) {
        const d = String(body.next_step_due).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'bad_due_date' });
        due = d;
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const { error } = await sb.from('leads')
        .update({ next_step: step, next_step_due: due, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, next_step: step, next_step_due: due });
};
