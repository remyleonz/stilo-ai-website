/**
 * POST /api/prospects/save-notes
 * Body: { id, notes }
 *
 * Persists the rep's free-text panel notes to prospecting.leads.rep_notes — a
 * field written ONLY by this endpoint. We deliberately do NOT use call_notes:
 * that's the per-call disposition field that log-call / book-meeting / David's
 * upstream rewrite on every outcome ("[ts] not interested", "Booked …"), which
 * was wiping the rep's sticky note. rep_notes is never touched by any
 * call-logging path, so a note the rep types ("email them about LCR") survives
 * every state change (callback / booked / dead pool) and every session forever.
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
        .update({ rep_notes: notes, updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, saved_len: notes.length });
};
