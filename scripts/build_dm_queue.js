/**
 * scripts/build_dm_queue.js [--apply]
 *
 * Builds the Instagram + Facebook DM queues (prospecting.ig_dm_queue) from
 * every source we have, and gives each rep ONE territory so a rep DMs and
 * dials the same clinics (Remy, 2026-10-08: "synergy between them all").
 *
 *   Blason territories (zip3 of the lead address):
 *     Ale    331            Miami-Dade core
 *     Jorge  330 333 334 339 Broward, Palm Beach, Naples
 *     George 328 327 347 322 Orlando, central, Jacksonville
 *     Remy   336 337 335 346 Tampa Bay (+ anything unplaced)
 *   STILO (new clients): David.
 *
 * Steps:
 *   1. Scraped clinics CSV (ig_laser_clinics_sfl_2026-09-28.csv) not in the
 *      CRM -> create Blason leads (name, phone, website, address, instagram).
 *   2. Unassigned Blason leads -> assigned_to by territory.
 *   3. Instagram queue: every Blason lead with instagram_handle, not DNC, not
 *      closed, not already in the queue -> queued row, arm alternating per
 *      rep, copy from _dm_copy. Existing queued rows are re-assigned to the
 *      lead's territory rep (sent/replied rows keep their sender).
 *   4. Facebook queue: every Blason lead with facebook_url -> queued row.
 *   5. STILO: leads with instagram_handle / facebook_url in the ICP niches ->
 *      queued rows for David with the STILO copy.
 * Dry run by default.
 */
const fs = require('fs'), path = require('path');
fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (l) { const m = l.match(/^([A-Z_]+)="?([^"\n]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
const { createClient } = require('@supabase/supabase-js');
const { dmCopy, stiloDmCopy } = require('../api/prospects/_dm_copy');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
const APPLY = process.argv.includes('--apply');
const BLASON = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const CSV = '/Users/remyleon/Desktop/AI Agency/ig_laser_clinics_sfl_2026-09-28.csv';
const REP = { ale: 'aleb1027@gmail.com', jorge: 'ayesjorge911@gmail.com', george: 'georgegutierrez446@gmail.com', remy: 'remyleon@stiloaipartners.com', david: 'davidcoira@stiloaipartners.com' };
const TERR = { '331': REP.ale, '330': REP.jorge, '333': REP.jorge, '334': REP.jorge, '339': REP.jorge, '328': REP.george, '327': REP.george, '347': REP.george, '322': REP.george, '336': REP.remy, '337': REP.remy, '335': REP.remy, '346': REP.remy };
const COUNTY_ZIP = { 'Miami-Dade': '331', 'Broward': '330', 'Palm Beach': '334' };
const STILO_NICHE = /medical equipment|medical supply|trucking|freight|employment agency|staffing|roofing|industrial|pressure wash|equipment supplier|machinery/i;

function parse(t) { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; } if (f || row.length) { row.push(f); rows.push(row); } return rows; }
const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
const hk = function (h) { h = String(h || '').toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/^@/, '').replace(/\/.*$/, ''); return h ? '@' + h : null; };
const zip3 = function (addr) { const m = String(addr || '').match(/FL\s*(\d{3})/); return m ? m[1] : null; };
const cityOf = function (addr) { const m = String(addr || '').match(/,\s*([^,]+),\s*FL\b/i); return m ? m[1].trim() : ''; };
const terr = function (lead) { return TERR[zip3(lead.address)] || REP.remy; };
const pretty = function (p) { const d = String(p || '').replace(/\D/g, ''); const m = (d.length === 11 && d[0] === '1' ? d.slice(1) : d).match(/^(\d{3})(\d{3})(\d{4})$/); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (p || null); };
async function all(q) { let out = [], off = 0; for (;;) { const { data, error } = await q.range(off, off + 999); if (error) throw new Error(error.message); out = out.concat(data || []); if (!data || data.length < 1000) break; off += 1000; } return out; }

(async function () {
    const leads = await all(sb.from('leads').select('id,name,address,assigned_to,instagram_handle,instagram_url,facebook_url,phone,owner_phone,owner_name,owner_name_verify_status,primary_language,do_not_call,stage,client_id,niche,category').eq('client_id', BLASON).order('id'));
    const byName = {}; leads.forEach(function (l) { byName[norm(l.name)] = l; });
    const byHandle = {}; leads.forEach(function (l) { if (l.instagram_handle) byHandle[l.instagram_handle.toLowerCase()] = l; });
    const queue = await all(sb.from('ig_dm_queue').select('id,lead_id,handle,channel,status,assigned_to,client_id').order('id'));
    const qKey = new Set(queue.map(function (r) { return r.channel + '|' + r.handle.toLowerCase() + '|' + (r.client_id || ''); }));
    const stats = { leads_created: 0, leads_assigned: 0, ig_new: 0, fb_new: 0, reassigned: 0, stilo_ig: 0, stilo_fb: 0 };

    // 1. scraped clinics not in the CRM -> new leads
    const csv = parse(fs.readFileSync(CSV, 'utf8')); const hd = csv[0];
    const clinics = csv.slice(1).filter(function (r) { return r.length > 5; }).map(function (r) { return Object.fromEntries(hd.map(function (h, i) { return [h, r[i] || '']; })); });
    const newLeads = [];
    clinics.forEach(function (c) {
        const h = hk(c.handle || c.instagram_url); if (!h) return;
        if (byName[norm(c.business)] || byHandle[h]) return;
        const z = c.zip || COUNTY_ZIP[c.county] || '';
        const address = [c.city ? c.city : '', 'FL ' + z].filter(Boolean).join(', ');
        const row = { name: c.business, phone: pretty(c.phone), owner_phone: pretty(c.phone), owner_phone_e164: c.phone && /^\+/.test(c.phone) ? c.phone : null, website: c.website || null, address: address, instagram_handle: h, instagram_url: c.instagram_url || ('https://www.instagram.com/' + h.slice(1) + '/'),
            owner_name: c.owner_first_name || null, owner_name_verify_status: c.owner_first_name ? 'proposed' : null, primary_language: c.lang === 'es' ? 'es' : 'en', niche: c.category || 'Medical spa', category: c.category || 'Medical spa',
            client_id: BLASON, assigned_to: TERR[z.slice(0, 3)] || REP.remy, stage: 'NEW', lead_source: 'google_maps_ig_2026-09-28', do_not_call: false };
        byName[norm(c.business)] = row; byHandle[h] = row; newLeads.push(row);
    });
    stats.leads_created = newLeads.length;
    if (APPLY && newLeads.length) {
        for (let i = 0; i < newLeads.length; i += 200) { const { data, error } = await sb.from('leads').insert(newLeads.slice(i, i + 200)).select('id,name,address,assigned_to,instagram_handle,instagram_url,primary_language,owner_name,owner_name_verify_status'); if (error) { console.error('lead insert failed', error.message); process.exit(2); } (data || []).forEach(function (l) { l.client_id = BLASON; leads.push(l); }); }
    }

    // 2. territories for unassigned Blason leads
    const toAssign = leads.filter(function (l) { return !l.assigned_to; });
    const byRep = {}; toAssign.forEach(function (l) { const r = terr(l); byRep[r] = (byRep[r] || []); byRep[r].push(l.id); l.assigned_to = r; });
    stats.leads_assigned = toAssign.length;
    if (APPLY) for (const r of Object.keys(byRep)) for (let i = 0; i < byRep[r].length; i += 300) await sb.from('leads').update({ assigned_to: r }).in('id', byRep[r].slice(i, i + 300)).is('assigned_to', null);

    // 3 + 4. Blason queues
    const perRepArm = {};
    const armFor = function (rep) { perRepArm[rep] = (perRepArm[rep] || 0) + 1; return perRepArm[rep] % 2 === 1 ? 'A' : 'B'; };
    const TITLE = /^(dr|dra|mr|mrs|ms|doctor|md|np|pa|rn)\.?$/i;
    const fn = function (l) { if (['verified', 'rep_confirmed'].indexOf(l.owner_name_verify_status) < 0) return ''; const parts = String(l.owner_name || '').trim().split(/\s+/).filter(function (p) { return !TITLE.test(p); }); return parts[0] || ''; };
    const inserts = [];
    leads.forEach(function (l) {
        if (l.do_not_call || /CLOSED/.test(l.stage || '')) return;
        const rep = l.assigned_to || terr(l);
        const base = { client_id: BLASON, lead_id: l.id, business: l.name, first_name: fn(l) || null, city: cityOf(l.address), lang: l.primary_language === 'es' ? 'es' : 'en', assigned_to: rep, status: 'queued', step: 0, batch: 'build_dm_queue 2026-10-08' };
        if (l.instagram_handle && !qKey.has('instagram|' + l.instagram_handle.toLowerCase() + '|' + BLASON)) {
            const arm = armFor(rep + ':ig'); const c = dmCopy(Object.assign({ channel: 'instagram' }, base), arm, base.lang);
            inserts.push(Object.assign({}, base, { channel: 'instagram', handle: l.instagram_handle.toLowerCase(), instagram_url: l.instagram_url || ('https://www.instagram.com/' + l.instagram_handle.slice(1) + '/'), arm: arm, message_1: c.message_1, message_2: c.message_2 })); stats.ig_new++;
            qKey.add('instagram|' + l.instagram_handle.toLowerCase() + '|' + BLASON);
        }
        if (l.facebook_url && !qKey.has('facebook|' + l.facebook_url.toLowerCase() + '|' + BLASON)) {
            const arm = armFor(rep + ':fb'); const c = dmCopy(Object.assign({ channel: 'facebook' }, base), arm, base.lang);
            inserts.push(Object.assign({}, base, { channel: 'facebook', handle: l.facebook_url.toLowerCase(), instagram_url: l.facebook_url, arm: arm, message_1: c.message_1, message_2: c.message_2 })); stats.fb_new++;
            qKey.add('facebook|' + l.facebook_url.toLowerCase() + '|' + BLASON);
        }
    });
    // re-assign existing QUEUED Blason rows to the lead's territory rep
    const leadById = {}; leads.forEach(function (l) { leadById[l.id] = l; });
    const reassign = [];
    queue.forEach(function (r) { if (r.status !== 'queued' || r.client_id !== BLASON) return; const l = r.lead_id && leadById[r.lead_id]; const rep = l ? (l.assigned_to || terr(l)) : null; if (rep && rep !== r.assigned_to) reassign.push({ id: r.id, rep: rep }); });
    stats.reassigned = reassign.length;

    // 5. STILO for David
    const stilo = await all(sb.from('leads').select('id,name,address,instagram_handle,instagram_url,facebook_url,primary_language,owner_name,owner_name_verify_status,do_not_call,stage,niche,category').is('client_id', null).or('instagram_handle.not.is.null,facebook_url.not.is.null').order('id'));
    stilo.forEach(function (l) {
        if (l.do_not_call || /CLOSED/.test(l.stage || '')) return;
        if (!STILO_NICHE.test(l.niche || '') && !STILO_NICHE.test(l.category || '')) return;
        const base = { client_id: null, lead_id: l.id, business: l.name, first_name: fn(l) || null, city: cityOf(l.address), lang: l.primary_language === 'es' ? 'es' : 'en', assigned_to: REP.david, status: 'queued', step: 0, batch: 'build_dm_queue stilo 2026-10-08' };
        if (l.instagram_handle && !qKey.has('instagram|' + l.instagram_handle.toLowerCase() + '|')) { const arm = armFor('david:ig'); const c = stiloDmCopy(base, arm, base.lang); inserts.push(Object.assign({}, base, { channel: 'instagram', handle: l.instagram_handle.toLowerCase(), instagram_url: l.instagram_url || ('https://www.instagram.com/' + l.instagram_handle.slice(1) + '/'), arm: arm, message_1: c.message_1, message_2: c.message_2 })); stats.stilo_ig++; qKey.add('instagram|' + l.instagram_handle.toLowerCase() + '|'); }
        if (l.facebook_url && !qKey.has('facebook|' + l.facebook_url.toLowerCase() + '|')) { const arm = armFor('david:fb'); const c = stiloDmCopy(base, arm, base.lang); inserts.push(Object.assign({}, base, { channel: 'facebook', handle: l.facebook_url.toLowerCase(), instagram_url: l.facebook_url, arm: arm, message_1: c.message_1, message_2: c.message_2 })); stats.stilo_fb++; qKey.add('facebook|' + l.facebook_url.toLowerCase() + '|'); }
    });

    console.log(JSON.stringify(stats));
    const per = {}; inserts.forEach(function (r) { const k = (r.assigned_to || 'pool').split('@')[0] + '/' + r.channel; per[k] = (per[k] || 0) + 1; }); console.log('new rows per rep/channel', JSON.stringify(per));
    const terrCount = {}; leads.forEach(function (l) { const k = (l.assigned_to || 'none').split('@')[0]; terrCount[k] = (terrCount[k] || 0) + 1; }); console.log('Blason leads per rep after', JSON.stringify(terrCount));
    if (!APPLY) { console.log('DRY RUN'); return; }
    for (let i = 0; i < inserts.length; i += 200) { const { error } = await sb.from('ig_dm_queue').upsert(inserts.slice(i, i + 200), { onConflict: 'channel,handle,client_id', ignoreDuplicates: true }); if (error) { console.error('queue insert failed', error.message); process.exit(2); } }
    for (const r of reassign) await sb.from('ig_dm_queue').update({ assigned_to: r.rep, updated_at: new Date().toISOString() }).eq('id', r.id);
    console.log('applied');
})().catch(function (e) { console.error(e); process.exit(1); });
