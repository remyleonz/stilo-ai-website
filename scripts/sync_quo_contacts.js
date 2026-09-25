/**
 * scripts/sync_quo_contacts.js
 *
 * Every lead becomes a named Quo contact so no callback ever shows as
 * "unknown" (Remy, 2026-09-25). First-name field = "<Owner first> <Company>",
 * or just the company; both the business line and the owner number on the
 * contact. Label rule: quoContactFields() in api/openphone/_shared.js (the same
 * one the hot-lead trigger now uses).
 *
 *   node scripts/sync_quo_contacts.js --scope touched   Blason pool + every lead we dialed/texted/emailed
 *   node scripts/sync_quo_contacts.js --scope all       every lead with a phone
 *   node scripts/sync_quo_contacts.js --scope missing   only leads with no quo_contact_id (daily top-up)
 *   node scripts/sync_quo_contacts.js --ids <file>      only these lead ids (e.g. after the name finder)
 *   add --dry to print without writing, --limit N to cap
 *
 * Idempotent: PATCHes the existing contact (leads.quo_contact_id, else Quo
 * externalId stilo_lead_<id> / stilo_prospect_<id>), creates otherwise and
 * writes the id back. Quo allows 10 req/s; this runs at ~7 with 429 backoff.
 */
const fs = require('fs'), path = require('path');
fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z_]+)="?([^"\n]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
});
const { quoContactFields } = require('../api/openphone/_shared');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCOPE = arg('--scope', 'touched'), DRY = process.argv.includes('--dry'), LIMIT = Number(arg('--limit', 0)) || Infinity;
const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY, QK = process.env.OPENPHONE_API_KEY;
const SH = { apikey: K, Authorization: 'Bearer ' + K, 'Accept-Profile': 'prospecting', 'Content-Profile': 'prospecting', 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastQ = 0, stats429 = 0;
async function quo(method, p, body) {
    for (let attempt = 0; attempt < 6; attempt++) {
        const wait = 145 - (Date.now() - lastQ); if (wait > 0) await sleep(wait); lastQ = Date.now();
        const r = await fetch('https://api.openphone.com/v1' + p, { method, headers: { Authorization: QK, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'curl/8.4' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }).catch(e => ({ status: 599, json: async () => ({ error: String(e.message) }) }));
        if (r.status === 429 || r.status >= 500) { stats429++; await sleep(1000 * (attempt + 1)); continue; }
        let j = null; try { j = await r.json(); } catch (_) {}
        return { status: r.status, json: j };
    }
    return { status: 429, json: { error: 'rate_limited' } };
}
async function pageAll(table, select, filter) {
    let out = [], off = 0;
    for (;;) {
        const r = await fetch(`${U}/rest/v1/${table}?select=${select}${filter || ''}&order=id&limit=1000&offset=${off}`, { headers: SH });
        const d = await r.json(); if (!Array.isArray(d)) throw new Error(JSON.stringify(d).slice(0, 200));
        out = out.concat(d); if (d.length < 1000) break; off += 1000;
    }
    return out;
}
(async () => {
    const t0 = Date.now();
    // Existing Quo contacts by externalId, so we patch instead of duplicating.
    const byExt = {}; let token = null, pages = 0;
    do {
        const r = await quo('GET', '/contacts?maxResults=50' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
        (r.json && r.json.data || []).forEach(c => { if (c.externalId) byExt[c.externalId] = c.id; });
        token = r.json && r.json.nextPageToken; pages++;
    } while (token && pages < 2000);
    console.log('quo contacts indexed:', Object.keys(byExt).length);

    const cols = 'id,name,owner_name,address,phone,owner_phone,owner_email,email,quo_contact_id,client_id';
    let leads = await pageAll('leads', cols, '');
    leads = leads.filter(l => (l.phone || l.owner_phone));
    const IDS = arg('--ids', null);
    if (IDS) { const want = new Set(fs.readFileSync(IDS, 'utf8').split(/\s+/).filter(Boolean).map(Number)); leads = leads.filter(l => want.has(l.id)); }
    else if (SCOPE === 'missing') leads = leads.filter(l => !l.quo_contact_id && !byExt['stilo_lead_' + l.id] && !byExt['stilo_prospect_' + l.id]);
    if (!IDS && SCOPE === 'touched') {
        const calls = await pageAll('lead_calls', 'id,lead_id', '&direction=eq.outbound');
        const msgs = await pageAll('lead_messages', 'id,lead_id', '&direction=eq.outbound');
        const touched = new Set(calls.concat(msgs).map(x => x.lead_id));
        leads = leads.filter(l => l.client_id || touched.has(l.id));
    }
    // Blason first, then STILO, newest-touched order doesn't matter beyond that.
    leads.sort((a, b) => (b.client_id ? 1 : 0) - (a.client_id ? 1 : 0));
    leads = leads.slice(0, LIMIT);
    console.log('scope', SCOPE, '| leads to sync', leads.length, DRY ? '(dry)' : '');

    const st = { patched: 0, created: 0, failed: 0, relinked: 0 }; const errs = [];
    for (let i = 0; i < leads.length; i++) {
        const l = leads[i]; const f = quoContactFields(l);
        if (!f.phoneNumbers.length) { st.failed++; continue; }
        const fields = { firstName: f.firstName, lastName: f.lastName, company: f.company, phoneNumbers: f.phoneNumbers, emails: f.emails };
        if (DRY) { if (i < 25) console.log(l.id, '->', f.firstName, '|', f.phoneNumbers.map(p => p.value).join(' ')); continue; }
        let id = l.quo_contact_id || byExt['stilo_lead_' + l.id] || byExt['stilo_prospect_' + l.id] || null;
        let ok = false;
        if (id) {
            const r = await quo('PATCH', '/contacts/' + id, { defaultFields: fields });
            if (r.status >= 200 && r.status < 300) { st.patched++; ok = true; }
            else if (r.status !== 404) { errs.push([l.id, r.status, JSON.stringify(r.json).slice(0, 160)]); }
        }
        if (!ok) {
            const r = await quo('POST', '/contacts', { externalId: 'stilo_lead_' + l.id, defaultFields: fields });
            const newId = r.json && r.json.data && r.json.data.id;
            if (newId) { st.created++; ok = true; id = newId; }
            else { st.failed++; errs.push([l.id, r.status, JSON.stringify(r.json).slice(0, 160)]); }
        }
        if (ok && id && id !== l.quo_contact_id) {
            await fetch(`${U}/rest/v1/leads?id=eq.${l.id}`, { method: 'PATCH', headers: SH, body: JSON.stringify({ quo_contact_id: id }) });
            st.relinked++;
        }
        if ((i + 1) % 50 === 0) console.log(new Date().toISOString().slice(11, 19), i + 1, '/', leads.length, JSON.stringify(st), 'retries', stats429);
        if (st.failed > 50 && st.failed > (st.patched + st.created)) { console.log('ABORT: failure rate too high', JSON.stringify(errs.slice(0, 5))); break; }
    }
    console.log('DONE', JSON.stringify(st), 'in', Math.round((Date.now() - t0) / 1000) + 's');
    if (errs.length) console.log('first errors', JSON.stringify(errs.slice(0, 8)));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
