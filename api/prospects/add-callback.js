/**
 * POST /api/prospects/add-callback
 * Body: { id, when?, reason? }
 *
 * Manually flag a prospect for callback without logging a specific call
 * outcome. Used by the drawer "Add to callback list" button. Forwards to
 * upstream POST /api/prospects/{id}/callback.
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
        path: '/api/prospects/' + id + '/callback',
        body: {
            when: body.when || null,
            reason: body.reason || 'manual',
            logged_by: gate.email
        }
    });
    return res.status(status).json(json);
};
