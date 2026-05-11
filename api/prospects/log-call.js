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
    const { status, json } = await forwardToProspecting({
        method: 'POST',
        path: '/api/prospects/' + id + '/log-call',
        body: {
            outcome: body.outcome,
            notes: body.notes || '',
            callback_at: callbackAt,
            logged_by: loggedBy
        }
    });
    return res.status(status).json(json);
};
