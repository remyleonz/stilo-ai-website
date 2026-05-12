/**
 * POST /api/prospects/log-call
 * Body: { id, outcome, notes, next_callback_at? }
 * Forwards to upstream POST /api/prospects/{id}/log-call.
 *
 * David's API expects `callback_at` (per FRONTEND_BRIEF.md), not the
 * `next_callback_at` the frontend was sending. We accept either name from
 * the client and forward as `callback_at` so the backend's auto-scheduling
 * (next_action_due_at, next_action_type) kicks in for callback_requested.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// Direct dual-write to prospecting.leads.call_history so we own the SDR
// attribution end-to-end. David's backend may or may not persist the
// logged_by field we send him; this write guarantees the entry lands
// in the leads.call_history JSONB array regardless. My Call History
// reads from this same array, so the loop is closed without depending
// on David.
async function appendCallHistory(id, entry) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return { skipped: 'no_service_key' };
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
    // Read-modify-write. Cheap because we own the call. Avoids needing a
    // Postgres function we can't deploy ourselves.
    const { data: lead, error: rdErr } = await sb.from('leads')
        .select('id, call_history').eq('id', id).maybeSingle();
    if (rdErr) return { error: 'read_failed', detail: rdErr.message };
    if (!lead) return { error: 'lead_not_found' };
    const history = Array.isArray(lead.call_history) ? lead.call_history.slice() : [];
    history.unshift(entry);
    const { error: upErr } = await sb.from('leads')
        .update({ call_history: history }).eq('id', id);
    if (upErr) return { error: 'write_failed', detail: upErr.message };
    return { ok: true, count: history.length };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
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

    // Dual-write to leads.call_history with our own attribution row. This
    // is what My Call History queries against, so we don't have to wait
    // on David to add a column. Best-effort — the upstream forward is the
    // source of truth for lifecycle state.
    const calledAtIso = new Date().toISOString();
    const historyResult = await appendCallHistory(id, {
        called_at: calledAtIso,
        outcome: body.outcome,
        notes: body.notes || '',
        logged_by: loggedBy,
        source: 'stilo_admin'
    });

    // Safety net: write last_called_at + last_called_outcome directly so the
    // row reflects the latest call even if the upstream fails or lags. The
    // workflow cards (Called Today / Dead Pool) read these columns, and My
    // Call History sorts on last_called_at — silently dropping the write
    // here is what makes "I called X but it didn't show up" happen.
    let lastCallSync = { skipped: true };
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
            const sb2 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
                auth: { persistSession: false }, db: { schema: 'prospecting' }
            });
            const { error: lcErr } = await sb2.from('leads').update({
                last_called_at: calledAtIso,
                last_called_outcome: body.outcome
            }).eq('id', id);
            lastCallSync = lcErr ? { error: lcErr.message } : { ok: true };
        } catch (e) {
            lastCallSync = { error: String(e.message || e) };
        }
    }

    return res.status(upstream.status).json({
        ...(upstream.json || {}),
        _stilo_history: historyResult,
        _stilo_last_call_sync: lastCallSync
    });
};
