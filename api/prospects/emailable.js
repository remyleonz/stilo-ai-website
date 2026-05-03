/**
 * GET /api/prospects/emailable
 * Cold email queue: leads with owner_email on file. Same query
 * params as callable.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/emailable',
        query: {
            limit: q.limit,
            niche: q.niche,
            tier: q.tier,
            min_score: q.min_score,
            q: q.q
        }
    });
    return res.status(status).json(json);
};
