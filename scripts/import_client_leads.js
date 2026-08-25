/**
 * scripts/import_client_leads.js
 *
 * Import a CLIENT's lead list (e.g. David's medspa list for Blason) into
 * prospecting.leads with client_id set, so the leads land on the client-account
 * rep's board and inside the admin Client CRM — and NOWHERE near STILO's own
 * boards, crons, or email sequences (everything STILO-facing filters
 * client_id IS NULL).
 *
 * Usage:
 *   node sites/stilo-ai/scripts/import_client_leads.js <client_id> <csv_path> [--assign rep@email] [--niche medspa] [--dry]
 *
 * Blason example:
 *   node sites/stilo-ai/scripts/import_client_leads.js \
 *     2efae6bf-69d8-4c4d-ac25-6a693db50f8b medspa-leads.csv \
 *     --assign aleb1027@gmail.com --niche medspa
 *
 * CSV columns (header row required; extra columns ignored; case-insensitive):
 *   name (required) — the business
 *   phone, owner_name, owner_phone, owner_email, email, address, website,
 *   category, primary_language ('en'/'es'), notes
 *
 * What it does per row:
 *   - dedupes against existing leads for THIS client by phone digits (both
 *     phone columns), then by lower(name); skips matches (safe to re-run)
 *   - inserts with: client_id, assigned_to (--assign), niche (--niche),
 *     stage 'NEW', lead_source 'client_import', do_not_call false
 *   - does NOT set pitch_agent or has_cold_call_script — client boards
 *     deliberately don't gate on either (see api/prospects/callable.js)
 *
 * IMPORTANT: run the litigator/DNC scrub over the batch before reps dial
 * (same rule as every David push — scrub_status starts NULL here).
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

try {
    const envFile = path.join(__dirname, '..', '.env.local');
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const args = process.argv.slice(2);
const clientId = args[0];
const csvPath = args[1];
const dry = args.includes('--dry');
function flag(name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const assignTo = flag('--assign', null);
const niche = flag('--niche', null);

if (!clientId || !/^[0-9a-f-]{36}$/.test(clientId) || !csvPath) {
    console.error('Usage: node import_client_leads.js <client_id uuid> <csv_path> [--assign rep@email] [--niche medspa] [--dry]');
    process.exit(1);
}

// Minimal CSV parser that survives quoted fields with commas. No deps.
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQ = false;
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(f => f.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(f => f.trim() !== '')) rows.push(row); }
    return rows;
}

const digits = s => String(s || '').replace(/\D/g, '').slice(-10);

(async () => {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });

    const raw = fs.readFileSync(csvPath, 'utf8');
    const rows = parseCsv(raw);
    if (rows.length < 2) { console.error('CSV has no data rows.'); process.exit(1); }
    const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const col = name => header.indexOf(name);
    if (col('name') < 0) { console.error('CSV needs a "name" column (the business).'); process.exit(1); }

    // Existing pool for dedupe (phones + names), scoped to this client only.
    const existingPhones = new Set(), existingNames = new Set();
    for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('leads')
            .select('name, phone, owner_phone').eq('client_id', clientId).range(from, from + 999);
        if (error) { console.error('read existing failed:', error.message); process.exit(1); }
        for (const l of (data || [])) {
            if (digits(l.phone)) existingPhones.add(digits(l.phone));
            if (digits(l.owner_phone)) existingPhones.add(digits(l.owner_phone));
            if (l.name) existingNames.add(l.name.trim().toLowerCase());
        }
        if (!data || data.length < 1000) break;
    }

    const get = (r, name) => { const i = col(name); return i >= 0 ? (r[i] || '').trim() : ''; };
    let inserted = 0, skippedDupe = 0, skippedNoContact = 0;
    const batch = [];

    for (const r of rows.slice(1)) {
        const name = get(r, 'name');
        if (!name) continue;
        const phone = get(r, 'phone'), ownerPhone = get(r, 'owner_phone');
        if (!phone && !ownerPhone) { skippedNoContact++; continue; }
        const pd = digits(phone), od = digits(ownerPhone);
        if ((pd && existingPhones.has(pd)) || (od && existingPhones.has(od)) || existingNames.has(name.toLowerCase())) {
            skippedDupe++; continue;
        }
        if (pd) existingPhones.add(pd);
        if (od) existingPhones.add(od);
        existingNames.add(name.toLowerCase());

        batch.push({
            name: name,
            phone: phone || null,
            owner_name: get(r, 'owner_name') || null,
            owner_phone: ownerPhone || null,
            owner_email: get(r, 'owner_email') || null,
            email: get(r, 'email') || null,
            address: get(r, 'address') || null,
            website: get(r, 'website') || null,
            category: get(r, 'category') || niche || null,
            niche: niche || get(r, 'category') || null,
            primary_language: get(r, 'primary_language') || null,
            call_notes: get(r, 'notes') || null,
            client_id: clientId,
            assigned_to: assignTo,
            stage: 'NEW',
            lead_source: 'client_import',
            do_not_call: false
        });
    }

    console.log('parsed=' + (rows.length - 1) + ' toInsert=' + batch.length
        + ' dupes=' + skippedDupe + ' noPhone=' + skippedNoContact + (dry ? ' [DRY RUN]' : ''));
    if (dry || !batch.length) return;

    for (let i = 0; i < batch.length; i += 200) {
        const chunk = batch.slice(i, i + 200);
        const { error } = await sb.from('leads').insert(chunk);
        if (error) { console.error('insert failed at chunk ' + i + ':', error.message); process.exit(1); }
        inserted += chunk.length;
        console.log('inserted ' + inserted + '/' + batch.length);
    }
    console.log('Done. Reminder: scrub the batch (litigator/DNC) before anyone dials.');
})();
