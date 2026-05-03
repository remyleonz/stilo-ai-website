/**
 * GET /api/prospects/dead?page=1&limit=50
 * Paginated archive of leads with no contact path or hard nos.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/dead',
        query: { page: q.page || 1, limit: q.limit || 50 }
    });
    return res.status(status).json(json);
};
