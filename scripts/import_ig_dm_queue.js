/**
 * scripts/import_ig_dm_queue.js <csv> [--sent-through N] [--per-rep 100] [--apply]
 *
 * Loads an Instagram DM worklist CSV (the ig_dm_sfl_final_* files) into
 * prospecting.ig_dm_queue, the table behind the Instagram tab on the SDR
 * dashboard and the Outbound tab on /admin/. Replaces the weekly spreadsheet.
 *
 *   - Rows 1..N (--sent-through) are the ones Remy already sent by hand from
 *     the sheet: imported as status=sent (step 1, arm B, the laser question)
 *     so replies can be logged on them. The rest are queued.
 *   - Queued rows alternate arm A ("hey", then the $80,000 line + video) and
 *     arm B (which laser do you run, then the same-factories line + video).
 *     One sentence per message, nobody introduces themselves by name: they can
 *     see the profile. Blason appears once, in message two.
 *   - lead_id: the signed lid inside vsl_link when present, else a name match
 *     against the Blason pool. Matched leads get instagram_handle / url.
 *   - --per-rep N hands the first N queued rows to each active Blason rep in
 *     round robin; the rest stay unassigned (the pool the admin button draws
 *     from). The sent rows belong to Remy.
 *
 * Dry run by default. --apply writes.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (l) { const m = l.match(/^([A-Z_]+)="?([^"\n]*)"?$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const CSV = args.find(function (a) { return !a.startsWith('--'); });
const APPLY = args.includes('--apply');
const SENT_THROUGH = Number((args.find(function (a) { return a.startsWith('--sent-through='); }) || '--sent-through=0').split('=')[1]);
const PER_REP = Number((args.find(function (a) { return a.startsWith('--per-rep='); }) || '--per-rep=100').split('=')[1]);
const BLASON = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const VSL = 'https://blasononline.stiloaipartners.com';
if (!CSV) { console.error('usage: node scripts/import_ig_dm_queue.js <csv> [--sent-through=197] [--per-rep=100] [--apply]'); process.exit(1); }

function parse(t) { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; } if (f || row.length) { row.push(f); rows.push(row); } return rows; }
const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
const hk = function (h) { return '@' + String(h || '').toLowerCase().replace(/^@/, '').replace(/\/$/, '').split('/').pop(); };

function copyFor(r, arm) {
    const es = r.lang === 'es', fn = (r.first_name || '').trim(), biz = (r.business || '').trim();
    const link = r.vsl_link || (VSL + '?utm_source=instagram&utm_campaign=vsl' + (es ? '&lang=es' : ''));
    if (arm === 'A') return {
        m1: es ? (fn ? 'hola ' + fn : 'hola') : (fn ? 'hey ' + fn : 'hey'),
        m2: es ? 'una rápida, la mayoría de las clínicas en Miami pagaron dos veces por su láser, una por la máquina y otra por el logo, yo le digo el error de $80,000. 4 min de cómo evitarlo: ' + link
               : 'quick one, most clinics in Miami paid twice for their laser, once for the machine and once for the logo, I call it the $80,000 mistake. 4 min on how to skip it: ' + link,
    };
    return {
        m1: es ? '¿qué láser están usando en ' + biz + ' para depilación?' : 'which laser is ' + biz + ' using for hair removal right now?',
        m2: es ? 'ese sale de las mismas fábricas que los nuestros, solo que se paga dos veces, una por la máquina y otra por el logo. el error de $80,000, 4 min de cómo evitarlo: ' + link
               : 'that one comes out of the same factories as ours, you just pay twice, once for the machine and once for the logo. the $80,000 mistake, 4 min on how to skip it: ' + link,
    };
}

(async function () {
    const t = parse(fs.readFileSync(CSV, 'utf8')); const hd = t[0];
    const rows = t.slice(1).filter(function (r) { return r.length > 5; }).map(function (r) { return Object.fromEntries(hd.map(function (h, i) { return [h, r[i] || '']; })); });
    let leads = [], off = 0;
    for (;;) { const { data } = await sb.from('leads').select('id,name,assigned_to,instagram_handle').eq('client_id', BLASON).range(off, off + 999); leads = leads.concat(data || []); if (!data || data.length < 1000) break; off += 1000; }
    const byName = {}; leads.forEach(function (l) { byName[norm(l.name)] = l; });
    const { data: reps } = await pub.from('sdr_users').select('email,display_name').eq('active', true).eq('client_account', 'Blason Spa Equipment');
    const repEmails = (reps || []).map(function (r) { return r.email.toLowerCase(); }).filter(function (e) { return !/^davidcoira/.test(e); });
    const remy = repEmails.find(function (e) { return /^remyleon/.test(e); }) || 'remyleon@stiloaipartners.com';
    const batch = path.basename(CSV).replace(/\.csv$/, '');

    const out = []; let queuedIdx = 0; const seen = new Set();
    rows.forEach(function (r, i) {
        const handle = hk(r.handle); if (!handle || handle === '@' || seen.has(handle)) return; seen.add(handle);
        const lidM = String(r.vsl_link || '').match(/[?&]lid=(\d+)/);
        const lead = lidM ? { id: Number(lidM[1]) } : byName[norm(r.business)];
        const sent = i < SENT_THROUGH;
        const arm = sent ? 'B' : (queuedIdx++ % 2 === 0 ? 'A' : 'B');
        const c = copyFor(r, arm);
        let assigned = null;
        if (sent) assigned = remy;
        else if (queuedIdx - 1 < PER_REP * repEmails.length) assigned = repEmails[(queuedIdx - 1) % repEmails.length];
        out.push({
            client_id: BLASON, lead_id: lead ? lead.id : null, handle: handle, instagram_url: r.instagram_url || ('https://www.instagram.com/' + handle.slice(1) + '/'),
            business: r.business || null, first_name: r.first_name || null, city: r.city || null, lang: r.lang === 'es' ? 'es' : 'en', arm: arm,
            message_1: sent ? (r.message || c.m1) : c.m1, message_2: c.m2, vsl_link: r.vsl_link || null,
            assigned_to: assigned, status: sent ? 'sent' : 'queued', step: sent ? 1 : 0,
            sent_at: sent ? '2026-10-05T16:00:00Z' : null, sent_by: sent ? remy : null, last_step_at: sent ? '2026-10-05T16:00:00Z' : null, batch: batch,
        });
    });
    const byRep = {}; out.forEach(function (r) { const k = r.assigned_to || 'pool'; byRep[k] = (byRep[k] || 0) + 1; });
    console.log('rows', rows.length, '-> import', out.length, '| sent', out.filter(function (r) { return r.status === 'sent'; }).length, '| queued', out.filter(function (r) { return r.status === 'queued'; }).length, '| matched leads', out.filter(function (r) { return r.lead_id; }).length);
    console.log('assignment', JSON.stringify(byRep)); console.log('arms', JSON.stringify(out.reduce(function (a, r) { a[r.arm] = (a[r.arm] || 0) + 1; return a; }, {})));
    console.log('sample A:', JSON.stringify(out.find(function (r) { return r.arm === 'A' && r.status === 'queued'; }).message_1), '\nsample B:', JSON.stringify(out.find(function (r) { return r.arm === 'B' && r.status === 'queued'; }).message_1));
    if (!APPLY) { console.log('DRY RUN. Add --apply to write.'); return; }
    let n = 0, dup = 0;
    for (let i = 0; i < out.length; i += 200) {
        const chunk = out.slice(i, i + 200);
        const { error, data } = await sb.from('ig_dm_queue').upsert(chunk, { onConflict: 'handle,client_id', ignoreDuplicates: true }).select('id');
        if (error) { console.error('insert failed', error.message); process.exit(2); }
        n += (data || []).length; dup += chunk.length - (data || []).length;
    }
    console.log('inserted', n, 'skipped as duplicates', dup);
    // Stamp the handle on the CRM lead so the drawer and the pipeline show it.
    const matched = out.filter(function (r) { return r.lead_id; });
    let stamped = 0;
    for (const r of matched) { const { error } = await sb.from('leads').update({ instagram_handle: r.handle, instagram_url: r.instagram_url }).eq('id', r.lead_id).is('instagram_handle', null); if (!error) stamped++; }
    console.log('stamped instagram_handle on', stamped, 'leads');
})();
