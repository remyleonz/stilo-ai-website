/**
 * POST /api/prospects/log-email
 * Body: { id, notes }
 * Manual one-off email log (Smartlead handles the bulk sends).
 * Forwards to upstream POST /api/prospects/{id}/log-email.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    const { status, json } = await forwardToProspecting({
        method: 'POST',
        path: '/api/prospects/' + id + '/log-email',
        body: {
            notes: body.notes || '',
            logged_by: gate.email
        }
    });
    return res.status(status).json(json);
};
