/**
 * GET /api/prospects/recent-runs
 * Returns the last N pipeline runs from David's backend so the admin can
 * show a "Recent generations" panel with live status, lead counts, and
 * elapsed time.
 *
 * Query: limit (default 10, max 50)
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 50);
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/pipeline/runs',
        query: { limit: limit }
    });
    return res.status(status).json(json);
};
