/**
 * GET /api/prospects/detail?id=42
 * GET /api/prospects/detail?phone=...
 * GET /api/prospects/detail?business_name=...
 *
 * Lookup by id (primary) or by phone / business_name (used when the
 * Clients page wants to surface a prospect record for an existing
 * client). Forwards to the upstream `/api/prospects/{id}` route when an
 * id is provided; otherwise forwards the lookup query to a generic
 * detail endpoint and lets the upstream resolve.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed, safeNumberId } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const id = safeNumberId(q.id);
    let upstreamPath;
    let query;
    if (id != null) {
        upstreamPath = '/api/prospects/' + id;
        query = undefined;
    } else if (q.phone || q.business_name || q.email) {
        upstreamPath = '/api/prospects/detail';
        query = { phone: q.phone, business_name: q.business_name, email: q.email };
    } else {
        return res.status(400).json({ error: 'missing_lookup_key' });
    }
    const { status, json } = await forwardToProspecting({
        method: 'GET',
        path: upstreamPath,
        query: query
    });
    return res.status(status).json(json);
};
