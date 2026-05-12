/**
 * GET /api/admin/gcs-explore?prefix=<prefix>&bucket=<bucket>&fetch=<path>
 *
 * Admin-only utility for exploring GCS buckets we have read access to.
 * Reuses the same service account that powers /api/prospects/cold-call-script
 * (env var GCP_SCRIPTS_SA_KEY) so no extra creds setup.
 *
 * Modes:
 *   ?prefix=<prefix>  → list objects (name, size, updated). Default bucket =
 *                       stilo-cold-call-scripts. Pass &bucket=<name> to query
 *                       a different bucket that the SA has access to.
 *   ?fetch=<name>     → return the raw content of one object as text. Capped
 *                       to 2 MB so we don't blow the response budget on a
 *                       fat dump file.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const cc = require('../prospects/cold-call-script');

const DEFAULT_BUCKET = 'stilo-cold-call-scripts';
// Hard allowlist so a leaked admin token can't browse arbitrary GCS
// buckets the service account happens to have access to. Add new
// buckets here only if intentional.
const ALLOWED_BUCKETS = new Set(['stilo-cold-call-scripts']);

async function listObjects(token, bucket, prefix, maxResults) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
        '/o?fields=items(name,size,updated,contentType),nextPageToken' +
        (prefix ? '&prefix=' + encodeURIComponent(prefix) : '') +
        '&maxResults=' + (maxResults || 200);
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('list_failed_' + r.status + ': ' + text.slice(0, 400));
    }
    return await r.json();
}

async function readObject(token, bucket, name, maxBytes) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
        '/o/' + encodeURIComponent(name) + '?alt=media';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('read_failed_' + r.status + ': ' + text.slice(0, 400));
    }
    const buf = await r.arrayBuffer();
    const text = Buffer.from(buf).toString('utf8');
    if (maxBytes && text.length > maxBytes) {
        return { truncated: true, bytes: text.length, content: text.slice(0, maxBytes) };
    }
    return { truncated: false, bytes: text.length, content: text };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const bucket = (req.query.bucket && String(req.query.bucket).trim()) || DEFAULT_BUCKET;
    if (!ALLOWED_BUCKETS.has(bucket)) {
        return res.status(403).json({ error: 'bucket_not_allowed', detail: 'Allowed: ' + Array.from(ALLOWED_BUCKETS).join(', ') });
    }
    const prefix = req.query.prefix ? String(req.query.prefix) : '';
    const fetchPath = req.query.fetch ? String(req.query.fetch) : '';

    let token;
    try { token = await cc.getAccessToken(); }
    catch (e) {
        return res.status(503).json({ error: 'gcs_not_configured', detail: String(e.message || e) });
    }

    try {
        if (fetchPath) {
            const out = await readObject(token, bucket, fetchPath, 2 * 1024 * 1024);
            res.setHeader('Cache-Control', 'no-store');
            return res.status(200).json({ bucket, name: fetchPath, ...out });
        }
        const list = await listObjects(token, bucket, prefix, 500);
        const items = (list.items || []).map(it => ({
            name: it.name,
            size: Number(it.size || 0),
            updated: it.updated,
            content_type: it.contentType
        }));
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            bucket,
            prefix,
            count: items.length,
            next_page_token: list.nextPageToken || null,
            items
        });
    } catch (e) {
        return res.status(502).json({ error: 'gcs_call_failed', detail: String(e.message || e) });
    }
};
