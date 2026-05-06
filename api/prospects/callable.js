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
    if (status === 200) {
        // Match lifecycle-stats: 30s edge cache, 60s SWR. Leads only change
        // when a call lands or the hourly pipeline runs, so a brief stale
        // window is fine and saves a Cloud Run cold hit on every paint.
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    }
    return res.status(status).json(json);
};
