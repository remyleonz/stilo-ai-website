#!/usr/bin/env node
/**
 * audit_david_artifacts.js
 *
 * One report answering the three questions that keep coming back about David's
 * pushes:
 *
 *   1. COVERAGE  - every brief he uploaded, did it match a lead? Every lead on a
 *                  rep's board, does it have a rep-facing script?
 *   2. FRESHNESS - are all reps seeing the same generation of script, or is one
 *                  rep on an older push?
 *   3. OWNER NAME- the briefs and scripts often name a person ("Ask for: Maria")
 *                  while prospecting.leads.owner_name is empty, so the dashboard
 *                  shows nobody. Is that a data gap or a UI gap?
 *
 * Reads the Supabase `cold-call-briefs` bucket (David's research) and the GCS
 * `stilo-cold-call-scripts` bucket (the rep-facing scripts), joins both to
 * prospecting.leads, and writes JSON + a printed summary.
 *
 *   node scripts/audit_david_artifacts.js
 *   node scripts/audit_david_artifacts.js --out /tmp/audit.json
 */
const fs = require('fs');
const path = require('path');

// Same hand-rolled .env.local read the sibling scripts use (no dotenv dep here).
fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)=([\s\S]*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BRIEF_BUCKET = 'cold-call-briefs';
const GCS_BUCKET = 'stilo-cold-call-scripts';
const GCS_PREFIX = 'cold-call/';

// 2026-08-20: rep-d points back at GEORGE. The 08-19 offboarding routing sent
// it to Remy (and this file still said Marcus), but rep-d was never Marcus's
// book: David created it FOR George on 2026-08-03 and Marcus held it eight days
// after the 08-11 swap. That detour left George's board at 53 dead leads with no
// brief file behind any of them. rep-a stays on George too; it is empty today.
// NEVER point a folder at an inactive rep: outbound-enqueue drops any lead whose
// assigned_to has no active sdr_users row, so the book silently stops being
// callable or textable. Keep in sync with prospecting.reconcile_brief_assignments().
const FOLDER_TO_REP = {
    'rep-a': 'georgegutierrez446@gmail.com',
    'rep-b': 'aleb1027@gmail.com',
    'rep-c': 'ayesjorge911@gmail.com',
    'rep-d': 'georgegutierrez446@gmail.com',
    'dc': 'davidcoira@stiloaipartners.com',
    'rl': 'remyleon@stiloaipartners.com'
};

// Mirrors slugify() in api/prospects/cold-call-script.js: strip punctuation
// first, THEN hyphenate. "T&S" -> ts, "Al's" -> als, "24/7" -> 247.
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/['’&/.,()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function sb(pathname, opts = {}) {
    const res = await fetch(SUPABASE_URL + pathname, {
        ...opts,
        headers: {
            apikey: SERVICE_KEY,
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        }
    });
    if (!res.ok) throw new Error(pathname + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return res;
}

async function listBriefs(folder) {
    // The storage list endpoint pages at 100 by default; these folders hold ~250.
    const out = [];
    for (let offset = 0; ; offset += 100) {
        const res = await sb('/storage/v1/object/list/' + BRIEF_BUCKET, {
            method: 'POST',
            body: JSON.stringify({ prefix: folder + '/', limit: 100, offset })
        });
        const page = await res.json();
        out.push(...page);
        if (page.length < 100) break;
    }
    return out.filter(o => o.name && o.name.endsWith('.md'));
}

async function readBrief(folder, name) {
    const res = await sb('/storage/v1/object/' + BRIEF_BUCKET + '/' + folder + '/' + encodeURIComponent(name));
    return res.text();
}

// ---- GCS (the rep-facing scripts) -----------------------------------------
// On Vercel this env var is clean JSON and JSON.parse works (that is what
// api/prospects/cold-call-script.js does). In .env.local it is stored on one
// line, wrapped in quotes, with literal \n escapes and UNESCAPED inner quotes,
// so it needs unwrapping: drop the wrapper quotes, turn \n into real newlines,
// then re-escape the newlines that live inside the private_key value.
function loadServiceAccount() {
    const raw = process.env.GCP_SCRIPTS_SA_KEY;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { /* local .env.local form */ }
    let s = raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    s = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
    s = s.replace(/("private_key"\s*:\s*")([\s\S]*?)("\s*,)/,
        (m, a, key, b) => a + key.replace(/\n/g, '\\n') + b);
    return JSON.parse(s);
}

async function gcsToken(sa) {
    const crypto = require('crypto');
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claim = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/devstorage.read_only',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600, iat: now
    });
    const sig = crypto.createSign('RSA-SHA256').update(claim).end()
        .sign(sa.private_key.replace(/\\n/g, '\n')).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: claim + '.' + sig
        })
    });
    const j = await res.json();
    if (!j.access_token) throw new Error('gcs token: ' + JSON.stringify(j).slice(0, 200));
    return j.access_token;
}

async function listGcsScripts(token) {
    const out = [];
    let pageToken = '';
    do {
        const u = new URL('https://storage.googleapis.com/storage/v1/b/' + GCS_BUCKET + '/o');
        u.searchParams.set('prefix', GCS_PREFIX);
        u.searchParams.set('maxResults', '1000');
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const res = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
        const j = await res.json();
        (j.items || []).forEach(i => out.push(i));
        pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out.filter(o => o.name.endsWith('.md'));
}

async function readGcs(token, name) {
    const res = await fetch('https://storage.googleapis.com/storage/v1/b/' + GCS_BUCKET +
        '/o/' + encodeURIComponent(name) + '?alt=media',
        { headers: { Authorization: 'Bearer ' + token } });
    return res.text();
}

// ---- parsing ---------------------------------------------------------------
// A person's name, as opposed to the role text David writes when he could not
// find one ("ask for the owner", "Owner or practice manager", "verify on call").
const ROLE_WORDS = /\b(owner|manager|director|principal|president|decision|maker|verify|ask|front|desk|office|practice|whoever|receptionist|gatekeeper|n\/?a|none|unknown|team|staff|the)\b/i;
function looksLikeName(s) {
    const v = String(s || '').trim().replace(/^["'`]|["'`]$/g, '');
    if (!v || v.length < 3 || v.length > 40) return false;
    if (ROLE_WORDS.test(v)) return false;
    // Two capitalised words, or one capitalised word that is not a role noun.
    return /^[A-Z][a-zA-Z.'-]+(\s+[A-Z][a-zA-Z.'-]+){0,2}$/.test(v);
}

function parseBrief(md) {
    const grab = re => { const m = md.match(re); return m ? m[1].trim() : null; };
    return {
        business: grab(/^#\s*Lead Brief\s*[—-]\s*(.+)$/m),
        tier: grab(/\*\*Tier:\*\*\s*(\d)/),
        primary: grab(/\*\*Primary:\*\*\s*(.+)$/m),
        decisionMaker: grab(/\*\*Decision-maker:\*\*\s*(.+)$/m),
        askFor: grab(/\*\*Ask for:\*\*\s*(.+?)(?:\s*·|$)/m),
        firstNameSrc: grab(/\*\*Source for first name:\*\*\s*(.+)$/m),
        ownerEmail: grab(/\*\*Owner email[^:]*:\*\*\s*([^\s]+@[^\s]+)/),
        phone: grab(/\*\*Phone:\*\*\s*(.+)$/m)
    };
}

function parseScript(md) {
    const grab = re => { const m = md.match(re); return m ? m[1].trim() : null; };
    return {
        business: grab(/^#\s*Cold-Call Script:\s*(.+)$/m),
        rep: grab(/\*\*Rep:\*\*\s*([^·\n]+)/),
        askFor: grab(/\*\*Ask for:\*\*\s*([^·\n]+)/),
        arm: grab(/\*\*A\/B arm:\*\*\s*([^\n]+)/),
        product: grab(/\*\*Meeting product[^:]*:\*\*\s*([^\n—]+)/)
    };
}

(async () => {
    const outPath = (process.argv.includes('--out')
        ? process.argv[process.argv.indexOf('--out') + 1]
        : path.join(__dirname, '..', '..', '..', 'Strategy', 'david-artifact-audit.json'));

    // --- leads ---------------------------------------------------------------
    const leads = [];
    for (let from = 0; ; from += 1000) {
        const res = await sb('/rest/v1/leads?select=id,name,owner_name,owner_phone,phone,category,' +
            'assigned_to,has_cold_call_script,pitch_agent,archived_batch,brief_tier,owner_email,' +
            'deep_research_json&order=id.asc', {
            headers: { 'Accept-Profile': 'prospecting', Range: from + '-' + (from + 999) }
        });
        const page = await res.json();
        leads.push(...page);
        if (page.length < 1000) break;
    }
    const bySlug = new Map();
    leads.forEach(l => { const s = slugify(l.name); if (s && !bySlug.has(s)) bySlug.set(s, l); });
    console.log('leads loaded:', leads.length);

    // --- briefs --------------------------------------------------------------
    const briefs = [];
    for (const folder of Object.keys(FOLDER_TO_REP)) {
        const files = await listBriefs(folder);
        console.log('  ' + folder + ': ' + files.length + ' briefs');
        for (const f of files) {
            const slug = f.name.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
            briefs.push({ folder, file: f.name, slug, updated: f.updated_at || f.created_at });
        }
    }

    // Read every brief. Concurrency-limited so we do not hammer storage.
    const parsedBriefs = [];
    for (let i = 0; i < briefs.length; i += 20) {
        const chunk = briefs.slice(i, i + 20);
        const texts = await Promise.all(chunk.map(b =>
            readBrief(b.folder, b.file).catch(() => '')));
        chunk.forEach((b, j) => parsedBriefs.push({ ...b, ...parseBrief(texts[j]) }));
        process.stdout.write('\r  read ' + Math.min(i + 20, briefs.length) + '/' + briefs.length + ' briefs');
    }
    console.log('');

    // --- scripts (GCS) -------------------------------------------------------
    let scripts = [];
    const sa = loadServiceAccount();
    if (sa) {
        const token = await gcsToken(sa);
        const objs = await listGcsScripts(token);
        console.log('gcs scripts:', objs.length);
        for (let i = 0; i < objs.length; i += 20) {
            const chunk = objs.slice(i, i + 20);
            const texts = await Promise.all(chunk.map(o => readGcs(token, o.name).catch(() => '')));
            chunk.forEach((o, j) => {
                const base = o.name.replace(GCS_PREFIX, '');
                scripts.push({
                    file: base,
                    slug: base.replace(/-script-\d{4}-\d{2}-\d{2}\.md$/, ''),
                    updated: o.updated,
                    ...parseScript(texts[j])
                });
            });
            process.stdout.write('\r  read ' + Math.min(i + 20, objs.length) + '/' + objs.length + ' scripts');
        }
        console.log('');
    } else {
        console.warn('NO GCS SA KEY - script half of the audit skipped');
    }

    fs.writeFileSync(outPath, JSON.stringify({
        generated_at: new Date().toISOString(),
        leads: leads.length,
        briefs: parsedBriefs,
        scripts,
        lead_index: [...bySlug.keys()]
    }, null, 1));
    console.log('\nwrote', outPath);
})().catch(e => { console.error(e); process.exit(1); });
