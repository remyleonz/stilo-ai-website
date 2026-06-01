/**
 * GET /api/prospects/cold-call-script?slug=<business-slug>
 * GET /api/prospects/cold-call-script?business_name=<name>
 *
 * Server-side proxy to David's `stilo-cold-call-scripts` GCS bucket.
 * Per his email (2026-05-05):
 *
 *   gs://stilo-cold-call-scripts/cold-call/<lead-slug>-script-<YYYY-MM-DD>.md
 *
 * The bucket is private (uniform bucket-level access, public access
 * prevention enforced). We authenticate with a Google service account
 * granted `roles/storage.objectViewer` on the bucket. The full service-
 * account JSON lives in the Vercel env var GCP_SCRIPTS_SA_KEY.
 *
 * Auth: standard admin JWT gate (same as every other /api/prospects/*).
 *
 * Returns 200 with `{ slug, filename, generated_at, content_md }` on hit,
 * 404 when no script exists for the slug, 503 when the service account
 * isn't configured (e.g., before David grants IAM access).
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const BUCKET = 'stilo-cold-call-scripts';
const PREFIX = 'cold-call/';
const SCOPE  = 'https://www.googleapis.com/auth/devstorage.read_only';

// David's live cold-call briefs (the "scripts") land in a Supabase Storage
// bucket, foldered by rep: cold-call-briefs/rep-{a,b,c}/<slug>-<YYYY-MM-DD>.md
// (A=jack, B=luke, C=alejandro). This is the current source of truth; the GCS
// path below is kept as a fallback for older scripts.
const BRIEFS_BUCKET = 'cold-call-briefs';
const REP_FOLDERS = { a: 'rep-a', b: 'rep-b', c: 'rep-c' };

// Find the newest brief for a slug in Supabase Storage. Searches the rep folder
// matching the tag hint first (fast), then the others. Returns
// { name, folder, content_md, generated_at } or null.
async function findBriefInSupabase(slug, repHint) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const hint = repHint && REP_FOLDERS[String(repHint).toLowerCase()];
    const folders = hint ? [hint, ...Object.values(REP_FOLDERS).filter(f => f !== hint)] : Object.values(REP_FOLDERS);
    for (const folder of folders) {
        const { data: items, error } = await sb.storage.from(BRIEFS_BUCKET).list(folder, { search: slug, limit: 100 });
        if (error || !items || !items.length) continue;
        const matches = items
            .filter(it => it.name.toLowerCase().startsWith(slug + '-') && it.name.toLowerCase().endsWith('.md'))
            .sort((a, b) => b.name.localeCompare(a.name)); // YYYY-MM-DD suffix => newest first
        if (!matches.length) continue;
        const name = folder + '/' + matches[0].name;
        const { data: blob, error: dlErr } = await sb.storage.from(BRIEFS_BUCKET).download(name);
        if (dlErr || !blob) continue;
        const content_md = await blob.text();
        const updated = matches[0].updated_at || (matches[0].created_at) || null;
        return { name: name, folder: folder, content_md: content_md, generated_at: updated };
    }
    return null;
}

// Module-level token cache. Vercel re-uses warm function instances across
// invocations within a region for ~5-15 minutes, so this avoids minting a
// fresh JWT on every page load. Tokens themselves last ~1h.
let cachedToken = null; // { access_token, expires_at }

function base64UrlEncode(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function slugify(input) {
    if (!input) return '';
    // Match David's filename convention: lowercase ASCII, hyphenated.
    // Combining-mark range ̀-ͯ covers the diacritics produced by
    // NFKD normalization, so "Café" → "cafe", "Ñ" → "n", etc.
    return String(input)
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function loadServiceAccount() {
    const raw = process.env.GCP_SCRIPTS_SA_KEY;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

async function getAccessToken() {
    if (cachedToken && cachedToken.expires_at > Date.now() + 60_000) {
        return cachedToken.access_token;
    }
    const sa = loadServiceAccount();
    if (!sa || !sa.client_email || !sa.private_key) {
        const err = new Error('gcp_service_account_not_configured');
        err.code = 'NO_SA';
        throw err;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
    const claim  = {
        iss: sa.client_email,
        scope: SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    };
    const signingInput = base64UrlEncode(Buffer.from(JSON.stringify(header))) + '.' +
                         base64UrlEncode(Buffer.from(JSON.stringify(claim)));
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    const sig = signer.sign(sa.private_key);
    const jwt = signingInput + '.' + base64UrlEncode(sig);

    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        })
    });
    if (!r.ok) {
        const text = await r.text();
        const err = new Error('gcp_token_failed: ' + text.slice(0, 240));
        err.code = 'TOKEN_FAIL';
        throw err;
    }
    const j = await r.json();
    cachedToken = {
        access_token: j.access_token,
        expires_at: Date.now() + ((j.expires_in || 3600) - 120) * 1000
    };
    return cachedToken.access_token;
}

// David's hourly sync writes a manifest.json on each run mapping
// { lead_id, business_name, filename, generated_at }. When it lands we can
// look up by business_name → exact filename in one fetch. Until then, we
// fall back to listing the prefix and picking the newest match by slug.
async function findScriptByListing(token, slug) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET +
        '/o?prefix=' + encodeURIComponent(PREFIX + slug + '-script-') +
        '&fields=items(name,timeCreated,updated,size)';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('gcs_list_failed: ' + text.slice(0, 240));
    }
    const j = await r.json();
    const items = (j.items || []).filter(function (it) {
        // Defensive: prefix match isn't enough if slug is a substring of another.
        return it.name.startsWith(PREFIX + slug + '-script-') && it.name.endsWith('.md');
    });
    if (!items.length) return null;
    // Pick the most recent by `updated` (falls back to lexicographic, which
    // also works because the date suffix is YYYY-MM-DD).
    items.sort(function (a, b) {
        const ta = a.updated || a.timeCreated || '';
        const tb = b.updated || b.timeCreated || '';
        if (ta && tb) return tb.localeCompare(ta);
        return b.name.localeCompare(a.name);
    });
    return items[0];
}

async function readObject(token, name) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET +
        '/o/' + encodeURIComponent(name) + '?alt=media';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('gcs_read_failed: ' + text.slice(0, 240));
    }
    return await r.text();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const slug = (q.slug && String(q.slug).trim()) || slugify(q.business_name);
    if (!slug) return res.status(400).json({ error: 'missing_slug', detail: 'Pass ?slug=<lead-slug> or ?business_name=<name>.' });

    // 1) Primary source: David's Supabase Storage briefs (cold-call-briefs).
    // ?rep=a|b|c (from the lead's tentative_rep_assignment) speeds the lookup.
    try {
        const brief = await findBriefInSupabase(slug, q.rep);
        if (brief) {
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
            return res.status(200).json({
                slug: slug,
                filename: brief.name,
                generated_at: brief.generated_at,
                content_md: brief.content_md,
                source: 'supabase'
            });
        }
    } catch (e) {
        console.warn('[cold-call-script] supabase lookup failed, trying GCS:', e.message);
    }

    // 2) Fallback: legacy GCS bucket (older scripts).
    let token;
    try { token = await getAccessToken(); }
    catch (e) {
        if (e.code === 'NO_SA') {
            // Supabase (primary) had no brief and the legacy GCS fallback isn't
            // configured — treat as "no script yet" rather than a server error.
            return res.status(404).json({ error: 'script_not_found', slug: slug });
        }
        return res.status(502).json({ error: 'gcs_auth_failed', detail: String(e.message || e) });
    }

    try {
        const item = await findScriptByListing(token, slug);
        if (!item) return res.status(404).json({ error: 'script_not_found', slug: slug });
        const content = await readObject(token, item.name);

        // Short edge cache so repeated drawer opens for the same lead don't
        // hit GCS every time. David's hourly sync makes 5min staleness fine.
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
        return res.status(200).json({
            slug: slug,
            filename: item.name,
            generated_at: item.updated || item.timeCreated || null,
            size: item.size,
            content_md: content
        });
    } catch (e) {
        console.error('[cold-call-script]', e);
        return res.status(502).json({ error: 'gcs_fetch_failed', detail: String(e.message || e) });
    }
};

// Re-export helpers so other endpoints (e.g. openphone/sync-from-supabase)
// can fetch a script for a lead without re-implementing the JWT/GCS dance.
// Vercel routes files under api/ as serverless functions, so attaching to
// module.exports keeps the handler as the default while still letting
// require('../prospects/cold-call-script').slugify work.
module.exports.slugify = slugify;
module.exports.getAccessToken = getAccessToken;
module.exports.findScriptByListing = findScriptByListing;
module.exports.readObject = readObject;
module.exports.BUCKET = BUCKET;
