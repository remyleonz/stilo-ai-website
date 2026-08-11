#!/usr/bin/env node
/**
 * check_script_coverage.js
 *
 * For a rep's live board, check EVERY lead against EVERY place a rep-facing
 * script can come from, in the same order api/prospects/cold-call-script.js
 * resolves them:
 *
 *   1. GCS manifest        cold-call/manifest.json  (byName, bySlug)
 *   2. GCS prefix listing   cold-call/<slug>...-script-<date>.md
 *   3. Supabase fallback    cold-call-scripts-generated/<slug>.md
 *
 * Use before moving a board between reps: "no scripts" has to mean no scripts
 * ANYWHERE, not just a missing manifest entry.
 *
 *   node scripts/check_script_coverage.js <email> [<email> ...]
 */
const fs = require('fs');
const path = require('path');

fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)=([\s\S]*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});

const GCS_BUCKET = 'stilo-cold-call-scripts';
const GCS_PREFIX = 'cold-call/';
const GEN_BUCKET = 'cold-call-scripts-generated';

function slugify(s) {
    return String(s || '').toLowerCase()
        .replace(/['’&/.,()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadServiceAccount() {
    const raw = process.env.GCP_SCRIPTS_SA_KEY;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { /* local .env.local form */ }
    let s = raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    s = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
    s = s.replace(/("private_key"\s*:\s*")([\s\S]*?)("\s*,)/,
        (m, a, k, b) => a + k.replace(/\n/g, '\\n') + b);
    return JSON.parse(s);
}

async function gcsToken(sa) {
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claim = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
        iss: sa.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only',
        aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
    });
    const sig = crypto.createSign('RSA-SHA256').update(claim).end()
        .sign(sa.private_key.replace(/\\n/g, '\n')).toString('base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: claim + '.' + sig
        })
    });
    const j = await r.json();
    if (!j.access_token) throw new Error('gcs token: ' + JSON.stringify(j).slice(0, 200));
    return j.access_token;
}

async function sbJson(p, headers) {
    const r = await fetch(process.env.SUPABASE_URL + p, {
        headers: {
            apikey: process.env.SUPABASE_SERVICE_KEY,
            Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, ...headers
        }
    });
    return r.json();
}

(async () => {
    const emails = process.argv.slice(2);
    if (!emails.length) { console.error('pass at least one rep email'); process.exit(1); }

    const token = await gcsToken(loadServiceAccount());

    // 1. manifest
    const manRes = await fetch('https://storage.googleapis.com/storage/v1/b/' + GCS_BUCKET +
        '/o/' + encodeURIComponent(GCS_PREFIX + 'manifest.json') + '?alt=media',
        { headers: { Authorization: 'Bearer ' + token } });
    const manifest = await manRes.json();
    const entries = Array.isArray(manifest) ? manifest : (manifest.entries || manifest.scripts || []);
    const manByName = new Set(), manBySlug = new Set();
    entries.forEach(e => {
        if (e.business_name) manByName.add(String(e.business_name).trim().toLowerCase());
        if (e.lead_id) manBySlug.add(slugify(String(e.lead_id)));
        if (e.filename) manBySlug.add(e.filename.replace(/-script-\d{4}-\d{2}-\d{2}\.md$/i, ''));
    });

    // 2. full GCS listing
    const listed = new Set();
    let pt = '';
    do {
        const u = new URL('https://storage.googleapis.com/storage/v1/b/' + GCS_BUCKET + '/o');
        u.searchParams.set('prefix', GCS_PREFIX); u.searchParams.set('maxResults', '1000');
        if (pt) u.searchParams.set('pageToken', pt);
        const j = await (await fetch(u, { headers: { Authorization: 'Bearer ' + token } })).json();
        (j.items || []).forEach(i => {
            if (!i.name.endsWith('.md')) return;
            listed.add(i.name.replace(GCS_PREFIX, '').replace(/-script-\d{4}-\d{2}-\d{2}\.md$/i, ''));
        });
        pt = j.nextPageToken || '';
    } while (pt);

    // 3. generated fallback bucket
    const generated = new Set();
    for (let off = 0; ; off += 1000) {
        const r = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/list/' + GEN_BUCKET, {
            method: 'POST',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_KEY,
                Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefix: '', limit: 1000, offset: off })
        });
        let page = [];
        try { page = await r.json(); } catch (_) { break; }
        if (!Array.isArray(page) || !page.length) break;
        page.forEach(o => { if (o.name && o.name.endsWith('.md')) generated.add(o.name.replace(/\.md$/, '')); });
        if (page.length < 1000) break;
    }

    console.log('script sources: manifest=' + (manByName.size + manBySlug.size) +
        ' gcs_files=' + listed.size + ' generated=' + generated.size + '\n');

    for (const email of emails) {
        const leads = await sbJson('/rest/v1/leads?select=id,name,category,has_cold_call_script' +
            '&assigned_to=eq.' + encodeURIComponent(email) +
            '&archived_batch=is.null&has_cold_call_script=is.true&pitch_agent=eq.Booked%20Meetings&limit=2000',
            { 'Accept-Profile': 'prospecting' });

        let none = 0; const hits = { manifest: 0, listing: 0, generated: 0 };
        const missingByCat = {};
        for (const l of leads) {
            const s = slugify(l.name);
            const inMan = manByName.has(String(l.name).trim().toLowerCase()) || manBySlug.has(s);
            const inList = listed.has(s) || [...listed].some(x => x.startsWith(s + '-2'));
            const inGen = generated.has(s);
            if (inMan) hits.manifest++;
            else if (inList) hits.listing++;
            else if (inGen) hits.generated++;
            else { none++; missingByCat[l.category] = (missingByCat[l.category] || 0) + 1; }
        }
        console.log('=== ' + email + ' — board ' + leads.length + ' ===');
        console.log('  has a script via manifest :', hits.manifest);
        console.log('  via GCS listing only      :', hits.listing);
        console.log('  via generated fallback    :', hits.generated);
        console.log('  NO SCRIPT ANYWHERE        :', none);
        if (none) console.log('    missing by category:', missingByCat);
        console.log('');
    }
})().catch(e => { console.error(e); process.exit(1); });
