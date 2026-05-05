/**
 * POST /api/prospects/run-pipeline
 * Body: { targets: [{ niche: string, location: string, target_count?: number }], target_count?: number }
 *
 * Kicks off David's lead-generation pipeline (scraper → researcher →
 * matcher → outreach). The pipeline runs async on his Cloud Run service;
 * this returns immediately with a run_id (or run_ids when multiple targets).
 *
 * Watch progress live by subscribing to prospecting.pipeline_runs via
 * Supabase Realtime, or polling /api/prospects/recent-runs.
 */
const { assertAdmin, forwardToProspecting, methodNotAllowed, readJsonBody } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    if (!body.targets || !Array.isArray(body.targets) || body.targets.length === 0) {
        return res.status(400).json({ error: 'missing_targets', detail: 'Body must include `targets: [{ niche, location, target_count? }]`' });
    }
    for (const t of body.targets) {
        if (!t.niche || !t.location) {
            return res.status(400).json({ error: 'invalid_target', detail: 'Each target needs both niche and location' });
        }
    }

    const { status, json } = await forwardToProspecting({
        method: 'POST',
        path: '/api/pipeline/run',
        body: {
            targets: body.targets.map(function (t) {
                return {
                    niche: String(t.niche).trim(),
                    location: String(t.location).trim(),
                    target_count: t.target_count != null ? Number(t.target_count) : undefined
                };
            }),
            target_count: body.target_count != null ? Number(body.target_count) : undefined
        }
    });
    return res.status(status).json(json);
};
