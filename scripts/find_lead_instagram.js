/**
 * scripts/find_lead_instagram.js
 *
 * Finds the Instagram handle for each lead by reading the handle off their own
 * website. No Instagram API, no scraping of instagram.com, no login, no
 * automation of the platform itself. We only fetch the business's public
 * homepage, which they published, and read the social link they put there.
 *
 * WHY THIS EXISTS
 *
 * 60% of cold calls to med spas die between 30 and 89 seconds, which is the
 * gatekeeper wall. A med spa's Instagram is almost always run by the owner or
 * the marketing person, so a DM has no gatekeeper in front of it at all. The
 * handles are already sitting on 948 of the 1,001 Blason leads' websites.
 *
 * Deliberately NOT automated past this point: this script finds handles and
 * builds a worklist. Sending the DMs is manual, one at a time, from a real
 * account. Bulk DM automation gets accounts banned and is against Instagram's
 * terms.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/find_lead_instagram.js --client <uuid> [--limit N]
 *   node sites/stilo-ai/scripts/find_lead_instagram.js --client <uuid> --out handles.json
 *
 * Resumable: re-running skips leads already present in the output file.
 */
const fs = require('fs');
const path = require('path');

try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
function arg(name, dflt) {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const CLIENT_ID = arg('client', '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
const LIMIT = parseInt(arg('limit', '2000'), 10);
const OUT = arg('out', path.join(__dirname, '..', '..', '..', 'ig_handles.json'));
const CONCURRENCY = 20;
const TIMEOUT_MS = 12000;

// instagram.com/<handle> but not the platform's own routes.
const IG_RE = /(?:instagram\.com|instagr\.am)\/(?!p\/|reel\/|reels\/|explore\/|stories\/|accounts\/|tv\/|direct\/|share\/)([A-Za-z0-9._]{2,30})/gi;
const JUNK = new Set(['instagram', 'about', 'legal', 'privacy', 'developer', 'help', 'api', 'business', 'creators', 'blog']);

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
        process.exit(1);
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}

function normalizeUrl(raw) {
    if (!raw) return null;
    let u = String(raw).trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { return new URL(u).toString(); } catch (e) { return null; }
}

async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
                // A real UA. Some hosts (Cloudflare) hard-block default fetch agents.
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) return { ok: false, reason: 'http_' + res.status };
        const ct = res.headers.get('content-type') || '';
        if (!/text|html/i.test(ct)) return { ok: false, reason: 'not_html' };
        const body = await res.text();
        return { ok: true, body: body.slice(0, 600000) };
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch_error' };
    } finally {
        clearTimeout(t);
    }
}

function extractHandles(html) {
    const found = new Map();
    let m;
    IG_RE.lastIndex = 0;
    while ((m = IG_RE.exec(html)) !== null) {
        const h = m[1].replace(/[._]+$/, '');
        if (!h || JUNK.has(h.toLowerCase()) || h.length < 2) continue;
        found.set(h.toLowerCase(), (found.get(h.toLowerCase()) || 0) + 1);
    }
    if (!found.size) return null;
    // Most-repeated handle wins; site chrome repeats the real account.
    return [...found.entries()].sort(function (a, b) { return b[1] - a[1]; })[0][0];
}

async function main() {
    const db = sb();

    let done = {};
    if (fs.existsSync(OUT)) {
        try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { done = {}; }
        console.log('resuming, ' + Object.keys(done).length + ' leads already processed');
    }

    const { data, error } = await db
        .from('leads')
        .select('id,name,website,owner_name,owner_email,primary_language,address,phone,stage,last_called_outcome,assigned_to,niche,rating,reviews')
        .eq('client_id', CLIENT_ID)
        .not('website', 'is', null)
        .limit(LIMIT);

    if (error) { console.error(error); process.exit(1); }

    const todo = data.filter(function (l) { return !done[l.id]; });
    console.log(data.length + ' leads with a website, ' + todo.length + ' still to check');

    let i = 0, hits = 0, n = 0;
    const t0 = Date.now();

    async function worker() {
        while (i < todo.length) {
            const lead = todo[i++];
            const url = normalizeUrl(lead.website);
            let handle = null, reason = 'no_url';
            if (url) {
                const r = await fetchText(url);
                if (r.ok) { handle = extractHandles(r.body); reason = handle ? 'ok' : 'no_ig_link'; }
                else reason = r.reason;
            }
            done[lead.id] = {
                id: lead.id, name: lead.name, handle: handle, reason: reason,
                website: lead.website, owner_name: lead.owner_name, owner_email: lead.owner_email,
                lang: lead.primary_language, address: lead.address, phone: lead.phone,
                stage: lead.stage, outcome: lead.last_called_outcome,
                assigned_to: lead.assigned_to, niche: lead.niche,
                rating: lead.rating, reviews: lead.reviews,
            };
            if (handle) hits++;
            n++;
            if (n % 25 === 0) {
                fs.writeFileSync(OUT, JSON.stringify(done, null, 0));
                const rate = n / ((Date.now() - t0) / 1000);
                console.log(n + '/' + todo.length + '  handles: ' + hits + '  (' + rate.toFixed(1) + '/s)');
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    fs.writeFileSync(OUT, JSON.stringify(done, null, 0));

    const all = Object.values(done);
    const withHandle = all.filter(function (r) { return r.handle; });
    console.log('\nDONE. ' + all.length + ' checked, ' + withHandle.length + ' handles found (' +
        (100 * withHandle.length / all.length).toFixed(1) + '%)');
    const reasons = {};
    all.forEach(function (r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
    console.log(JSON.stringify(reasons, null, 2));
    console.log('written to ' + OUT);
}

main().catch(function (e) { console.error(e); process.exit(1); });
