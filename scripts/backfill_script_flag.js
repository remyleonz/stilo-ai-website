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
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const leads = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

// ── David's GCS sales-script manifest ────────────────────────────────────────
// A lead is "callable" only if it ALSO has an actual script (not just a brief).
// We read gs://stilo-cold-call-scripts/cold-call/manifest.json and flag
// has_cold_call_script=true only for leads in it; briefed-but-unscripted leads
// are assigned but hidden (tracked in prospecting.awaiting_script) until David
// ships their script, at which point re-running this re-adds them automatically.
const GCS_BUCKET = 'stilo-cold-call-scripts', GCS_PREFIX = 'cold-call/';
// The SA key in .env.local is double-quoted pretty-printed JSON with literal \n.
// Turn formatting \n into real newlines but keep \n inside strings (private_key).
function fixSaJson(s) {
    let out = '', inStr = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') { inStr = !inStr; out += c; continue; }
        if (c === '\\' && s[i + 1] === 'n') { out += inStr ? '\\n' : '\n'; i++; continue; }
        out += c;
    }
    return out;
}
function loadSA() {
    const raw = process.env.GCP_SCRIPTS_SA_KEY || '';
    try { return JSON.parse(raw); } catch (_) {}
    return JSON.parse(fixSaJson(raw));
}
function b64url(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function gcsToken() {
    const sa = loadSA();
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
    const c = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = b64url(crypto.createSign('RSA-SHA256').update(h + '.' + c).sign(sa.private_key));
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: h + '.' + c + '.' + sig }) });
    const j = await r.json(); if (!j.access_token) throw new Error('gcs token fail: ' + JSON.stringify(j).slice(0, 160)); return j.access_token;
}
async function loadManifest() {
    const tok = await gcsToken();
    const r = await fetch('https://storage.googleapis.com/storage/v1/b/' + GCS_BUCKET + '/o/' + encodeURIComponent(GCS_PREFIX + 'manifest.json') + '?alt=media', { headers: { Authorization: 'Bearer ' + tok } });
    if (!r.ok) throw new Error('manifest read failed: ' + r.status);
    const man = JSON.parse(await r.text()); const scripts = man.scripts || [];
    const names = new Set(scripts.map(e => String(e.business_name || '').trim().toLowerCase()).filter(Boolean));
    const slugs = new Set(scripts.map(e => String(e.lead_id || '').replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase()).filter(Boolean));
    return { count: scripts.length, has: nm => { const ln = String(nm || '').trim().toLowerCase(); return names.has(ln) || slugs.has(slugify(nm)); } };
}

// rep-a = Luke, rep-b = Alejandro, rep-c = Jack. (Corrected 2026-06-01 after two
// swaps: rep-a -> Luke, rep-c -> Jack.) 2026-06-08: David added owner folders
// dc = David Coira, rl = Remy Leon. Owner folders are processed LAST so they win
// the handful of leads David placed in both an owner and his own folder.
const REP_EMAIL = {
    'rep-a': 'huronfire5@gmail.com',
    'rep-b': 'aleb1027@gmail.com',
    'rep-c': 'jacksonmaguire0@gmail.com',
    'dc':    'davidcoira@stiloaipartners.com',
    'rl':    'remyleon@stiloaipartners.com'
};
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

    // 1b. Load David's sales-script manifest (decides which leads are callable).
    const manifest = await loadManifest();
    console.log('Manifest sales scripts:', manifest.count);

    // 2. Walk the brief folders, match to leads, note whether a SCRIPT exists.
    const report = {};
    const updates = {};
    Object.keys(REP_EMAIL).forEach(f => { updates[f] = []; });
    const unmatched = [];
    for (const folder of Object.keys(REP_EMAIL)) {
        report[folder] = { briefs: 0, matched: 0, scripted: 0, awaiting: 0 };
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
                const scripted = manifest.has(lead.name);
                if (scripted) report[folder].scripted++; else report[folder].awaiting++;
                updates[folder].push({ id: lead.id, name: lead.name, scripted: scripted });
            }
            if (data.length < 1000) break; offset += 1000;
        }
    }

    // 3. Reset, then per folder: assign EVERY briefed lead to the rep, but only
    //    flag has_cold_call_script=true for leads that actually have a SCRIPT.
    //    Briefed-but-unscripted leads stay assigned + hidden, snapshotted into
    //    prospecting.awaiting_script (re-run after David ships to add them back).
    await leads.from('leads').update({ has_cold_call_script: false }).gte('id', 0);
    const awaitingRows = [];
    for (const folder of Object.keys(updates)) {
        const email = REP_EMAIL[folder];
        const all = updates[folder];
        const allIds = all.map(x => x.id);
        const scriptedIds = all.filter(x => x.scripted).map(x => x.id);
        for (let i = 0; i < allIds.length; i += 200) {
            const { error } = await leads.from('leads')
                .update({ assigned_to: email, updated_at: new Date().toISOString() })
                .in('id', allIds.slice(i, i + 200));
            if (error) console.error('assign err', folder, error.message);
        }
        for (let i = 0; i < scriptedIds.length; i += 200) {
            const { error } = await leads.from('leads')
                .update({ has_cold_call_script: true, updated_at: new Date().toISOString() })
                .in('id', scriptedIds.slice(i, i + 200));
            if (error) console.error('flag err', folder, error.message);
        }
        all.filter(x => !x.scripted).forEach(x => awaitingRows.push({ lead_id: x.id, assigned_to: email, business_name: x.name }));
    }
    // Refresh the awaiting-script snapshot.
    await leads.from('awaiting_script').delete().gte('lead_id', 0);
    for (let i = 0; i < awaitingRows.length; i += 200) {
        const { error } = await leads.from('awaiting_script').insert(awaitingRows.slice(i, i + 200));
        if (error) console.error('awaiting insert err', error.message);
    }

    // 4. Report.
    let totScripted = 0, totAwaiting = 0;
    for (const folder of Object.keys(report)) {
        const r = report[folder];
        totScripted += r.scripted; totAwaiting += r.awaiting;
        console.log('\n=== ' + folder + ' (' + REP_EMAIL[folder] + ') ===');
        console.log('  briefs: ' + r.briefs + ' | matched: ' + r.matched + ' | unmatched: ' + (r.briefs - r.matched));
        console.log('  CALLABLE (has script): ' + r.scripted + ' | AWAITING script (hidden): ' + r.awaiting);
    }
    console.log('\nTOTAL callable (phone+script flagged): ' + totScripted + ' | TOTAL awaiting David\'s script (hidden): ' + totAwaiting);
    console.log('Total unmatched briefs (slug had no lead): ' + unmatched.length);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
