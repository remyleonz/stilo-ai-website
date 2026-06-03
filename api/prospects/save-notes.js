/**
 * POST /api/prospects/save-notes
 * Body: { id, notes }
 *
 * Persists the SDR's free-text notes for a lead to prospecting.leads.call_notes.
 * Called on autosave (debounced) + when the lead drawer closes, so notes never
 * get lost if the rep doesn't formally log a call. Survives across sessions.
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
    const notes = (body.notes == null ? '' : String(body.notes)).slice(0, 10000);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const { error } = await sb.from('leads')
        .update({ call_notes: notes, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, saved_len: notes.length });
};
