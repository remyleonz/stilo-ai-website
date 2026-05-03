/**
 * GET /api/prospects/stats
 * Returns bucket counts for the prospecting tab (HOT/WARM/COOL/DEAD,
 * strict-pass phone count, owner email count, by-niche breakdown).
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: '/api/prospects/stats'
    });
    return res.status(status).json(json);
};
