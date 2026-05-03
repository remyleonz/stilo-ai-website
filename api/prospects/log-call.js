/**
 * POST /api/prospects/log-call
 * Body: { id, outcome, notes, next_callback_at? }
 * Forwards to upstream POST /api/prospects/{id}/log-call.
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
    const { status, json } = await forwardToProspecting({
        method: 'POST',
        path: '/api/prospects/' + id + '/log-call',
        body: {
            outcome: body.outcome,
            notes: body.notes || '',
            next_callback_at: body.next_callback_at || null,
            logged_by: gate.email
        }
    });
    return res.status(status).json(json);
};
