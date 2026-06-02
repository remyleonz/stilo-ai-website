#!/usr/bin/env node
/**
 * scripts/backfill_script_flag.js
 *
 * David's cold-call briefs (cold-call-briefs/rep-{a,b,c}/<slug>-<date>.md) ARE
 * the callable set: 250 per rep (rep-a=Jack, rep-b=Luke, rep-c=Alejandro).
 * This matches every brief to its lead (by slugified business name), sets
 * prospecting.leads.has_cold_call_script=true, and assigns the lead to the
 * rep whose folder the brief is in. The SDR dashboard then shows exactly these
 * leads as callable (phone required; owner name optional).
 *
 * Idempotent: resets the flag for everyone first, then re-applies.
 * Run from sites/stilo-ai/:  node scripts/backfill_script_flag.js
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (!m) return;
    let v = m[2].trim(); if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
});
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const leads = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

// rep-a = Luke, rep-b = Alejandro, rep-c = Jack. (Corrected 2026-06-01 after two
// swaps: rep-a -> Luke, rep-c -> Jack.)
const REP_EMAIL = { 'rep-a': 'huronfire5@gmail.com', 'rep-b': 'aleb1027@gmail.com', 'rep-c': 'jacksonmaguire0@gmail.com' };
function slugify(s) {
    // Standard Python slugify (matches David's brief filenames): delete
    // punctuation, then hyphenate whitespace/underscores/hyphens.
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}
const hasPhone = l => !!((l.owner_phone && l.owner_phone.trim()) || (l.phone && l.phone.trim()));
const hasName = l => !!(l.owner_name && l.owner_name.trim());

async function main() {
    // 1. Load all leads → slug map (prefer a lead WITH a phone on slug collisions).
    const bySlug = {};
    let from = 0;
    for (;;) {
        const { data, error } = await leads.from('leads')
            .select('id,name,assigned_to,owner_phone,phone,owner_name')
            .range(from, from + 999);
        if (error) throw error;
        if (!data || !data.length) break;
        for (const l of data) {
            const s = slugify(l.name); if (!s) continue;
            if (!bySlug[s] || (hasPhone(l) && !hasPhone(bySlug[s]))) bySlug[s] = l;
        }
        if (data.length < 1000) break; from += 1000;
    }

    // 2. Walk the brief folders, match to leads.
    const report = {};
    const updates = { 'rep-a': [], 'rep-b': [], 'rep-c': [] };
    const unmatched = [];
    for (const folder of Object.keys(REP_EMAIL)) {
        report[folder] = { briefs: 0, matched: 0, with_phone: 0, missing_phone: [], with_name: 0, missing_name: [] };
        let offset = 0;
        for (;;) {
            const { data, error } = await sb.storage.from('cold-call-briefs').list(folder, { limit: 1000, offset });
            if (error) { console.error('list err', folder, error.message); break; }
            if (!data || !data.length) break;
            for (const o of data) {
                if (!o.name.endsWith('.md')) continue;
                report[folder].briefs++;
                const slug = o.name.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').toLowerCase();
                const lead = bySlug[slug];
                if (!lead) { unmatched.push(folder + '/' + o.name); continue; }
                report[folder].matched++;
                if (hasPhone(lead)) report[folder].with_phone++; else report[folder].missing_phone.push(lead.name);
                if (hasName(lead)) report[folder].with_name++; else report[folder].missing_name.push(lead.name);
                updates[folder].push(lead.id);
            }
            if (data.length < 1000) break; offset += 1000;
        }
    }

    // 3. Reset flag, then apply per rep folder (flag + assignment).
    await leads.from('leads').update({ has_cold_call_script: false }).gte('id', 0);
    for (const folder of Object.keys(updates)) {
        const ids = updates[folder]; const email = REP_EMAIL[folder];
        for (let i = 0; i < ids.length; i += 200) {
            const batch = ids.slice(i, i + 200);
            const { error } = await leads.from('leads')
                .update({ has_cold_call_script: true, assigned_to: email, updated_at: new Date().toISOString() })
                .in('id', batch);
            if (error) console.error('update err', folder, error.message);
        }
    }

    // 4. Report.
    for (const folder of Object.keys(report)) {
        const r = report[folder];
        console.log('\n=== ' + folder + ' (' + REP_EMAIL[folder] + ') ===');
        console.log('  briefs: ' + r.briefs + ' | matched to a lead: ' + r.matched + ' | unmatched: ' + (r.briefs - r.matched));
        console.log('  with phone (callable): ' + r.with_phone + ' | MISSING PHONE (flag): ' + r.missing_phone.length);
        if (r.missing_phone.length) console.log('    no-phone: ' + r.missing_phone.slice(0, 20).join(' | '));
        console.log('  with owner name: ' + r.with_name + ' | no owner name (ok, flagged): ' + r.missing_name.length);
    }
    console.log('\nTotal unmatched briefs (slug had no lead): ' + unmatched.length);
    if (unmatched.length) console.log(unmatched.slice(0, 30).join('\n'));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
