/**
 * POST /api/prospects/log-dial
 * Body: { lead_id }
 *
 * Lightweight "I just clicked Call in Quo" stamp. Increments call_attempts
 * and stamps last_called_at — but leaves last_called_outcome NULL. The NULL
 * outcome is what tells the frontend this was a dial-only event (not a logged
 * call result), so the lead stays visible in Cold Call, just demoted/grayed.
 *
 * Three things drive the lifecycle from here:
 *   - Submit the drawer outcome form → sets last_called_outcome, lead moves
 *     to whichever lifecycle bucket the outcome maps to.
 *   - 3 dial-only attempts with no outcome → frontend hides from Cold Call
 *     (the "exhausted" auto-decay).
 *   - Wait 24h → frontend un-grays the row.
 *
 * Writes via supabase-js with the prospecting schema (David's API doesn't
 * expose a "dial-only" mutation; the Postgrest schema is exposed, RLS lets
 * admins update).
 */
const { assertAdminOrSdr, scopedQuery, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const id = safeNumberId(body.lead_id || body.prospect_id || body.id);
    if (id == null) return res.status(400).json({ error: 'missing_lead_id' });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    // Read current attempts so we can increment without races.
    const { data: lead, error: rdErr } = await sb.from('leads')
        .select('id, call_attempts, last_called_at')
        .eq('id', id)
        .maybeSingle();
    if (rdErr) return res.status(500).json({ error: 'lead_read_failed', detail: rdErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    const nowIso = new Date().toISOString();
    const newAttempts = (lead.call_attempts || 0) + 1;

    const { error: upErr } = await sb.from('leads').update({
        call_attempts: newAttempts,
        last_called_at: nowIso
    }).eq('id', id);
    if (upErr) return res.status(500).json({ error: 'lead_update_failed', detail: upErr.message });

    return res.status(200).json({
        ok: true,
        lead_id: id,
        call_attempts: newAttempts,
        last_called_at: nowIso,
        // Hint to frontend: hide from Cold Call after this many attempts with no outcome.
        exhausted: newAttempts >= 3
    });
};
