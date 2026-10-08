/**
 * scripts/find_lead_social.js
 *
 * Reads each lead's OWN website and picks up the Instagram handle and the
 * Facebook page they published there. No platform scraping, no login, no
 * automation of Instagram or Facebook. Writes straight to
 * prospecting.leads.instagram_handle / instagram_url / facebook_url (only
 * when the column is still null) so the DM queue builder and the drawer see
 * them. Resumable through the --out JSON.
 *
 *   node scripts/find_lead_social.js --client <uuid> [--limit N] [--out file.json]
 *   node scripts/find_lead_social.js --stilo --niche 'roof|pressure|freight' [--limit N]
 *
 * Successor of find_lead_instagram.js (same fetch + extraction, plus Facebook).
 */
const fs = require('fs'), path = require('path');
try { fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (l) { const m = l.match(/^([A-Z_]+)="?([^"\n]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (_) {}
const { createClient } = require('@supabase/supabase-js');
const args = process.argv.slice(2);
function arg(name, dflt) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; }
const STILO = args.includes('--stilo');
const CLIENT_ID = STILO ? null : arg('client', '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
const NICHE = arg('niche', null) ? new RegExp(arg('niche'), 'i') : null;
const LIMIT = parseInt(arg('limit', '3000'), 10);
const OUT = arg('out', path.join(__dirname, '..', '..', '..', STILO ? 'social_stilo.json' : 'social_blason.json'));
const CONCURRENCY = 16, TIMEOUT_MS = 12000;
const IG_RE = /(?:instagram\.com|instagr\.am)\/(?!p\/|reel\/|reels\/|explore\/|stories\/|accounts\/|tv\/|direct\/|share\/)([A-Za-z0-9._]{2,30})/gi;
const FB_RE = /facebook\.com\/(?!sharer|share\.php|dialog|plugins|login|tr\?|tr\/|policies|privacy|help|pages\/create|profile\.php\?id=\d+&?$)((?:pages\/[^\/"'?#\s]+\/\d+)|(?:people\/[^\/"'?#\s]+\/\d+)|(?:profile\.php\?id=\d+)|(?:[A-Za-z0-9.\-_]{3,80}))/gi;
const JUNK = new Set(['instagram', 'about', 'legal', 'privacy', 'developer', 'help', 'api', 'business', 'creators', 'blog', 'facebook', 'groups', 'events', 'marketplace', 'watch', 'gaming', 'home.php', 'hashtag', 'photo', 'photos', 'posts', 'videos', 'reel', 'story.php', 'stories', 'business', 'ads', 'messages', 'notifications']);

function db() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function normalizeUrl(raw) { if (!raw) return null; let u = String(raw).trim(); if (!u) return null; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; try { return new URL(u).toString(); } catch (e) { return null; } }
async function fetchText(url) {
    const ctrl = new AbortController(); const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' } });
        if (!res.ok) return { ok: false, reason: 'http_' + res.status };
        if (!/text|html/i.test(res.headers.get('content-type') || '')) return { ok: false, reason: 'not_html' };
        return { ok: true, body: (await res.text()).slice(0, 600000) };
    } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'fetch_error' }; } finally { clearTimeout(t); }
}
function top(re, html, clean) {
    const found = new Map(); let m; re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) { const h = clean(m[1]); if (!h) continue; found.set(h, (found.get(h) || 0) + 1); }
    if (!found.size) return null;
    return [...found.entries()].sort(function (a, b) { return b[1] - a[1]; })[0][0];
}
function extractIg(html) { return top(IG_RE, html, function (h) { h = h.replace(/[._]+$/, '').toLowerCase(); return (!h || JUNK.has(h) || h.length < 2) ? null : h; }); }
function extractFb(html) { return top(FB_RE, html, function (h) { h = h.replace(/[.\-_]+$/, ''); const k = h.split('/')[0].toLowerCase(); return (!h || JUNK.has(k) || h.length < 3 || /\.(png|jpg|svg|css|js)$/i.test(h)) ? null : h; }); }

(async function () {
    const sb = db();
    let done = {}; if (fs.existsSync(OUT)) { try { done = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { done = {}; } console.log('resuming, ' + Object.keys(done).length + ' already processed'); }
    let rows = [], off = 0;
    for (;;) {
        let q = sb.from('leads').select('id,name,website,niche,category,address,instagram_handle,facebook_url,do_not_call').not('website', 'is', null).order('id').range(off, off + 999);
        q = STILO ? q.is('client_id', null) : q.eq('client_id', CLIENT_ID);
        const { data, error } = await q; if (error) { console.error(error.message); process.exit(1); }
        rows = rows.concat(data || []); if (!data || data.length < 1000) break; off += 1000;
    }
    if (NICHE) rows = rows.filter(function (l) { return NICHE.test(l.niche || '') || NICHE.test(l.category || ''); });
    rows = rows.filter(function (l) { return !l.do_not_call && (!l.instagram_handle || !l.facebook_url); });
    const todo = rows.filter(function (l) { return !done[l.id]; }).slice(0, LIMIT);
    console.log(rows.length + ' leads with a website' + (NICHE ? ' in niche /' + NICHE.source + '/' : '') + ', ' + todo.length + ' to check');
    let i = 0, n = 0, igHits = 0, fbHits = 0; const t0 = Date.now();
    async function worker() {
        while (i < todo.length) {
            const lead = todo[i++]; const url = normalizeUrl(lead.website);
            let ig = null, fb = null, reason = 'no_url';
            if (url) { const r = await fetchText(url); if (r.ok) { ig = extractIg(r.body); fb = extractFb(r.body); reason = (ig || fb) ? 'ok' : 'no_social'; } else reason = r.reason; }
            done[lead.id] = { id: lead.id, name: lead.name, ig: ig, fb: fb, reason: reason, niche: lead.niche || lead.category, address: lead.address };
            const upd = {};
            if (ig && !lead.instagram_handle) { upd.instagram_handle = '@' + ig; upd.instagram_url = 'https://www.instagram.com/' + ig + '/'; igHits++; }
            if (fb && !lead.facebook_url) { upd.facebook_url = 'https://www.facebook.com/' + fb; fbHits++; }
            if (Object.keys(upd).length) await sb.from('leads').update(upd).eq('id', lead.id);
            n++;
            if (n % 25 === 0) { fs.writeFileSync(OUT, JSON.stringify(done)); console.log(n + '/' + todo.length + '  ig ' + igHits + '  fb ' + fbHits + '  (' + (n / ((Date.now() - t0) / 1000)).toFixed(1) + '/s)'); }
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    fs.writeFileSync(OUT, JSON.stringify(done));
    console.log('DONE ' + n + ' checked, ig ' + igHits + ', fb ' + fbHits + ' -> ' + OUT);
})().catch(function (e) { console.error(e); process.exit(1); });
