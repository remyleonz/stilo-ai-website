/**
 * GET /api/prospects/callable
 * Daily cold-call list. Niche-balanced, ranked by score, excluding
 * recently-called leads. Pass-through query params: limit, niche, tier,
 * min_score, q.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/callable',
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
