/**
 * POST /api/prospects/add-callback
 * Body: { id, when?, reason? }
 *
 * Manually flag a prospect for callback without logging a specific call
 * outcome. Used by the drawer "Add to callback list" button.
 *
 * Writes Supabase prospecting.leads directly. It used to forward to David's
 * Cloud Run POST /api/prospects/{id}/callback, which is the same fragility we
 * pulled out of emailable.js and out of the callbacks read path: that service
 * hangs under load and left the caller staring at a spinner. The stamp it made
 * upstream is two columns we can set ourselves.
 *
 * Adding a lead back also CLEARS callback_dismissed_at, so a lead someone
 * removed from the Callbacks list reappears the moment it is re-added. See
 * set-callback.js for why the dismissal column exists at all.
 *
 * SDR scoping: an SDR may only touch a lead in their own book.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// Default when the caller sends no time: four hours out, same as the drawer's
// own blank-input default. Callbacks are reminders, not calendar events.
const DEFAULT_LEAD_MS = 4 * 60 * 60 * 1000;

function parseWhen(raw) {
    if (raw == null || raw === '') return { iso: new Date(Date.now() + DEFAULT_LEAD_MS).toISOString() };
    const s = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return { error: 'when_not_iso8601' };
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : (s.replace(' ', 'T') + 'Z'));
    if (!Number.isFinite(ms)) return { error: 'when_unparseable' };
    const year = new Date(ms).getUTCFullYear();
    if (year < 2020 || year > 2100) return { error: 'when_out_of_range' };
    return { iso: new Date(ms).toISOString() };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const id = safeNumberId(body.id != null ? body.id : body.lead_id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const when = parseWhen(body.when);
    if (when.error) return res.status(400).json({ error: when.error });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const { data: lead, error: rdErr } = await sb.from('leads')
        .select('id, assigned_to')
        .eq('id', id)
        .maybeSingle();
    if (rdErr) return res.status(500).json({ error: 'lead_read_failed', detail: rdErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    if (gate.isSdr && !gate.isAdmin) {
        const mine = String(lead.assigned_to || '').toLowerCase() === String(gate.email || '').toLowerCase();
        if (!mine) return res.status(403).json({ error: 'not_your_lead' });
    }

    const { error: upErr } = await sb.from('leads').update({
        next_action_type: 'callback',
        next_action_due_at: when.iso,
        callback_dismissed_at: null,
        callback_dismissed_by: null
    }).eq('id', id);
    if (upErr) return res.status(500).json({ error: 'lead_update_failed', detail: upErr.message });

    return res.status(200).json({
        ok: true,
        id: id,
        next_action_due_at: when.iso,
        reason: body.reason || 'manual',
        logged_by: gate.email
    });
};
