/**
 * GET /api/prospects/callbacks
 *
 * List prospects scheduled for callback or with a recent missed-inbound call.
 * Forwards to upstream GET /api/prospects/callbacks (or shim).
 *
 * Query: limit, due_before (ISO timestamp; defaults to now+24h on the
 * upstream side).
 */
const { assertAdminOrSdr, scopedQuery, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/callbacks',
        query: {
            limit: q.limit,
            due_before: q.due_before
        }
    });
    return res.status(status).json(json);
};
