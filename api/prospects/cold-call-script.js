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
// rep-a/b/c/d are the SDR folders; dc/rl are David's owner brief folders (David
// Coira / Remy Leon), added 2026-06-08. All are searched for a lead's brief.
// rep-d (George Gutierrez) added 2026-08-04 with his first brief push. A folder
// missing from this map is invisible: the lookup never lists it, so the rep sees
// "no script" on a lead David actually briefed.
const REP_FOLDERS = { a: 'rep-a', b: 'rep-b', c: 'rep-c', d: 'rep-d', e: 'rep-e', dc: 'dc', rl: 'rl' };

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
    // Match David's filename convention (standard Python slugify): lowercase,
    // strip accents, DELETE punctuation that isn't a separator (so "T&S" -> "ts",
    // "Al's" -> "als", "24/7" -> "247", "Dr." -> "dr"), THEN collapse whitespace/
    // underscores/hyphens to a single hyphen. The old version turned & ' / into
    // hyphens, which mismatched ~40 brief filenames.
    return String(input)
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
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
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function findScriptByListing(token, slug) {
    // List everything under the slug, then keep only dedicated SCRIPT files.
    // David uses two filename conventions:
    //   <slug>-script-<YYYY-MM-DD>.md              (older)
    //   <slug>-<YYYY-MM-DD>-script-<YYYY-MM-DD>.md  (newer, doubled date)
    // The old prefix `<slug>-script-` missed the newer doubled-date names.
    const url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET +
        '/o?prefix=' + encodeURIComponent(PREFIX + slug + '-') +
        '&fields=items(name,timeCreated,updated,size)';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('gcs_list_failed: ' + text.slice(0, 240));
    }
    const j = await r.json();
    const re = new RegExp('^' + escapeRe(PREFIX) + escapeRe(slug) + '(?:-\\d{4}-\\d{2}-\\d{2})?-script-\\d{4}-\\d{2}-\\d{2}\\.md$', 'i');
    const items = (j.items || []).filter(function (it) { return re.test(it.name); });
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

// David's manifest (cold-call/manifest.json) is the source of truth: one entry
// per lead { lead_id, business_name, filename, generated_at }. Keying off the
// manifest filename means we can never grab the wrong file — the brief never has
// "-script-" in its name. Cached at module scope (warm instances) for 5 min.
let _manifest = null, _manifestAt = 0;
async function loadManifest(token) {
    if (_manifest && (Date.now() - _manifestAt) < 5 * 60 * 1000) return _manifest;
    const raw = await readObject(token, PREFIX + 'manifest.json');
    const j = JSON.parse(raw);
    const scripts = Array.isArray(j) ? j : (j.scripts || []);
    const byName = {}, bySlug = {};
    for (const e of scripts) {
        if (!e || !e.filename) continue;
        if (e.business_name) byName[String(e.business_name).trim().toLowerCase()] = e;
        // lead_id is the filename minus "-script-<date>.md"; strip a trailing
        // date so it matches slugify(business_name).
        const base = String(e.lead_id || e.filename.replace(/-script-\d{4}-\d{2}-\d{2}\.md$/i, ''))
            .replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase();
        if (base) bySlug[base] = e;
    }
    _manifest = { byName: byName, bySlug: bySlug };
    _manifestAt = Date.now();
    return _manifest;
}

// STILO-generated scripts. When David has briefed a lead but not yet shipped a
// GCS script, we generate one from his Sage brief and store it in the Supabase
// Storage bucket below as `<slug>.md`. This is the LAST fallback (GCS always
// wins) and is keyed by the same slug, so David's official script supersedes it
// the moment it lands. NOT the cold-call-briefs bucket — that's raw research.
const GENERATED_BUCKET = 'cold-call-scripts-generated';
async function readGeneratedScript(slug) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data, error } = await sb.storage.from(GENERATED_BUCKET).download(slug + '.md');
        if (error || !data) return null;
        return await data.text();
    } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const slug = (q.slug && String(q.slug).trim()) || slugify(q.business_name);
    if (!slug) return res.status(400).json({ error: 'missing_slug', detail: 'Pass ?slug=<lead-slug> or ?business_name=<name>.' });

    // The dedicated cold-call SCRIPT lives in GCS
    // (stilo-cold-call-scripts/cold-call/<filename>, always ending -script-<date>.md).
    // Per David: render that file ONLY. NEVER read the Supabase cold-call-briefs
    // bucket — those are his SAGE agent's internal RESEARCH (lead flags, objection
    // lists), not the rep script. Showing the brief was the bug.
    let token = null;
    try { token = await getAccessToken(); }
    catch (e) {
        // No GCS service account, or an auth blip: don't 404 yet. Fall through
        // to the STILO-generated Supabase fallback at the bottom.
        if (e.code !== 'NO_SA') console.warn('[cold-call-script] gcs auth failed, will try generated fallback:', e.message);
    }

    // 1) PRIMARY: the manifest maps business_name → exact script filename, so we
    //    can never grab the wrong file.
    if (token) try {
        const man = await loadManifest(token);
        const entry = (q.business_name && man.byName[String(q.business_name).trim().toLowerCase()])
            || man.bySlug[slug];
        if (entry && entry.filename) {
            const content = await readObject(token, PREFIX + entry.filename);
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
            return res.status(200).json({
                slug: slug,
                filename: PREFIX + entry.filename,
                generated_at: entry.generated_at || null,
                content_md: content,
                source: 'gcs-manifest'
            });
        }
    } catch (e) {
        console.warn('[cold-call-script] manifest lookup failed, trying listing:', e.message);
    }

    // 2) SECONDARY: prefix-list for <slug>...-script-<date>.md (a lead not yet in
    //    the manifest). Still GCS scripts only — no brief fallback, ever.
    if (token) try {
        const item = await findScriptByListing(token, slug);
        if (item) {
            const content = await readObject(token, item.name);
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
            return res.status(200).json({
                slug: slug,
                filename: item.name,
                generated_at: item.updated || item.timeCreated || null,
                size: item.size,
                content_md: content,
                source: 'gcs-listing'
            });
        }
    } catch (e) {
        console.error('[cold-call-script] listing failed:', e.message);
    }

    // 3) FALLBACK: a STILO-generated script from David's Sage brief.
    //    DISABLED 2026-08-11. Every one of the 609 files in that bucket was
    //    written before the 2026-08-02 pivot (newest is 2026-07-27) and pitches
    //    the retired AI receptionist: "a receptionist that answers 24/7", "no
    //    booking widget", "We don't need automation". A rep opening one of these
    //    reads a product we do not sell to a prospect, in the exact category the
    //    market already rejected. No script is strictly better than the wrong
    //    script, so we now 404 and the drawer shows nothing.
    //    To re-enable: regenerate the bucket against the current Booked Meetings
    //    offer, then restore the block below. Gate it on the content actually
    //    naming the current offer rather than trusting the bucket.
    //
    //    2026-08-27: re-enabled with exactly that content gate. The Blason
    //    campaign scripts (982 files, generated from David's 2026-08-26
    //    BLASON-COLDCALL-SKELETON) each carry a "Campaign: ... Blason Spa
    //    Equipment" header line, so we serve a generated script ONLY when its
    //    content names that campaign. The 609 pre-pivot receptionist scripts
    //    in the same bucket never mention Blason and stay dead. David's
    //    official GCS script still supersedes (paths 1 and 2 above win).
    try {
        const gen = await readGeneratedScript(slug);
        const isCurrentCampaign = gen && /Campaign:.*Blason Spa Equipment/i.test(gen);
        if (gen && (isCurrentCampaign || process.env.ALLOW_LEGACY_GENERATED_SCRIPTS === '1')) {
            res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
            return res.status(200).json({
                slug: slug,
                filename: GENERATED_BUCKET + '/' + slug + '.md',
                generated_at: null,
                content_md: gen,
                source: 'stilo-generated'
            });
        }
    } catch (e) {
        console.error('[cold-call-script] generated fallback failed:', e.message);
    }

    return res.status(404).json({ error: 'script_not_found', slug: slug });
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
module.exports.readGeneratedScript = readGeneratedScript;
module.exports.GENERATED_BUCKET = GENERATED_BUCKET;
