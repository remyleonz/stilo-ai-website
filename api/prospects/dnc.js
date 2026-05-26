/**
 * POST /api/prospects/dnc
 * Body: { id }
 * Marks a lead as do-not-call. Forwards to upstream POST
 * /api/prospects/{id}/dnc.
 */
const { assertAdminOrSdr, scopedQuery, forwardToProspecting, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    const { status, json } = await forwardToProspecting({
        method: 'POST',
        path: '/api/prospects/' + id + '/dnc',
        body: { logged_by: gate.email }
    });
    return res.status(status).json(json);
};
