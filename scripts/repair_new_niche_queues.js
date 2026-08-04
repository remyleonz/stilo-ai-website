#!/usr/bin/env node
/**
 * scripts/repair_new_niche_queues.js
 *
 * One-off repair for the 2026-08-04 incident: David pushed briefs and scripts
 * for the five new sales-agency niches, and none of them reached a rep's queue.
 *
 * Two independent causes, both fixed in code alongside this script:
 *
 *   1. rep-d (George Gutierrez, hired 2026-07-24) did not exist in ANY folder
 *      list. sync-scripts.js, cold-call-script.js, backfill_brief_tier.js,
 *      backfill_script_flag.js and reconcile_brief_assignments() each had their
 *      own hardcoded ['rep-a','rep-b','rep-c',...]. His 178 briefs were invisible.
 *
 *   2. The pivot changed David's brief format. He no longer writes
 *      "**Meeting product:** <agent>"; he writes "- **Primary:** Booked Meetings".
 *      agentFromScript() could not read it, so pitch_agent stayed NULL, and
 *      callable.js filters on `pitch_agent IS NOT NULL`. 572 briefed, scripted,
 *      dialable leads were therefore on nobody's board.
 *
 * WHY NOT backfill_script_flag.js: that one resets has_cold_call_script to false
 * for all ~26k leads and re-applies from the CURRENT folders. David's folders are
 * not cumulative, so the reset silently yanks older still-good leads out of live
 * queues. This script is ENABLE-ONLY, the same guarantee sync-scripts.js makes:
 * it never clears a flag and never overwrites a non-null pitch_agent.
 *
 *   node scripts/repair_new_niche_queues.js            # dry run, writes nothing
 *   node scripts/repair_new_niche_queues.js --apply    # commit
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

const APPLY = process.argv.includes('--apply');
const BRIEFS_BUCKET = 'cold-call-briefs';
const FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'rep-d', 'rl', 'dc'];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Mirrors canonAgent() in api/prospects/sync-scripts.js. Kept deliberately short:
// this repair only needs to recognise the values David is currently writing.
function canonAgent(name) {
    const v = String(name || '').toLowerCase();
    if (!v.trim()) return null;
    if (/booked meeting|qualified meeting|pipeline system/.test(v)) return 'Booked Meetings';
    if (/receptionist|\becho\b/.test(v)) return 'AI Receptionist';
    if (/outbound|lead reply|lead response|\bignite\b/.test(v)) return 'Outbound Agent';
    if (/\blcr\b|reactivat|lost customer|\brevive\b/.test(v)) return 'LCR';
    if (/lead gen|b2b|\bscout\b/.test(v)) return 'Lead Generator';
    if (/website|\bforge\b/.test(v)) return 'Website';
    if (/\bseo\b|\bgeo\b|\bsignal\b/.test(v)) return 'AI SEO';
    if (/ontology|\boracle\b/.test(v)) return 'Ontology';
    if (/sales coach|sales agent|\bpitch\b/.test(v)) return 'AI Sales Agent';
    return null;
}
function agentFromScript(md) {
    const s = String(md || '');
    const m = s.match(/(?:PRODUCT TO PITCH|Meeting product|Product\s*\([^)\r\n]*\))[^\r\n]*?:\**\s*([A-Za-z][^\r\n*(|]*)/i);
    if (m) { const a = canonAgent(m[1]); if (a) return a; }
    const p = s.match(/^\s*[-*]?\s*\**Primary\**\s*:\**\s*([A-Za-z][^\r\n*(|]*)/im);
    return p ? canonAgent(p[1]) : null;
}

async function listAll(folder) {
    const out = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.storage.from(BRIEFS_BUCKET).list(folder, { limit: 1000, offset: off });
        if (error) throw new Error(folder + ': ' + error.message);
        if (!data || !data.length) break;
        out.push(...data.map(f => f.name));
        if (data.length < 1000) break;
    }
    return out;
}

(async () => {
    // newest brief per business key, across every folder
    const briefs = new Map(); // norm_key -> { folder, file }
    for (const folder of FOLDERS) {
        const names = await listAll(folder);
        console.log(`  ${folder}: ${names.length} briefs`);
        for (const n of names) {
            if (!n.toLowerCase().endsWith('.md')) continue;
            const key = norm(n.replace(/-\d{4}-\d{2}-\d{2}\.md$/i, ''));
            const prev = briefs.get(key);
            if (!prev || n.localeCompare(prev.file) > 0) briefs.set(key, { folder, file: n });
        }
    }
    console.log(`\n${briefs.size} distinct briefed businesses\n`);

    // every lead that is briefed and currently missing either flag
    const leads = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await pro.from('leads')
            .select('id,name,assigned_to,has_cold_call_script,pitch_agent,owner_phone,phone,do_not_call')
            .range(from, from + 999);
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        leads.push(...data);
        if (data.length < 1000) break;
    }
    console.log(`${leads.length} leads scanned\n`);

    const needFlag = [], needAgent = [];
    const cache = new Map();
    for (const l of leads) {
        const b = briefs.get(norm(l.name));
        if (!b) continue;
        if (!l.has_cold_call_script) needFlag.push({ l, b });
        if (!l.pitch_agent) needAgent.push({ l, b });
    }
    console.log(`briefed leads missing has_cold_call_script : ${needFlag.length}`);
    console.log(`briefed leads missing pitch_agent          : ${needAgent.length}\n`);

    // resolve pitch_agent from the brief text (download each brief once)
    const agentFor = new Map();
    let read = 0;
    for (const { b } of needAgent) {
        const p = b.folder + '/' + b.file;
        if (cache.has(p)) continue;
        const { data: blob, error } = await sb.storage.from(BRIEFS_BUCKET).download(p);
        if (error || !blob) { cache.set(p, null); continue; }
        cache.set(p, agentFromScript(await blob.text()));
        if (++read % 100 === 0) console.log(`  read ${read} briefs...`);
    }
    const tally = {};
    for (const { l, b } of needAgent) {
        const a = cache.get(b.folder + '/' + b.file);
        if (!a) continue;
        agentFor.set(l.id, a);
        tally[a] = (tally[a] || 0) + 1;
    }
    console.log('\nresolved pitch_agent values:', JSON.stringify(tally, null, 2));

    if (!APPLY) {
        console.log('\nDRY RUN. Nothing written. Re-run with --apply to commit.');
        console.log(`would set has_cold_call_script on ${needFlag.length} leads`);
        console.log(`would set pitch_agent on ${agentFor.size} leads`);
        return;
    }

    const chunk = (arr, n) => arr.reduce((a, x, i) => (i % n ? a[a.length - 1].push(x) : a.push([x]), a), []);
    let flagged = 0;
    for (const ids of chunk(needFlag.map(x => x.l.id), 200)) {
        const { error } = await pro.from('leads')
            .update({ has_cold_call_script: true, updated_at: new Date().toISOString() }).in('id', ids);
        if (error) { console.error('flag error', error.message); continue; }
        flagged += ids.length;
    }
    // pitch_agent varies per lead, so these go one at a time. Guarded with
    // .is('pitch_agent', null) so a concurrent sync-scripts run cannot be clobbered.
    let agented = 0;
    for (const [id, agent] of agentFor) {
        const { error } = await pro.from('leads').update({ pitch_agent: agent }).eq('id', id).is('pitch_agent', null);
        if (!error) agented++;
    }
    console.log(`\nAPPLIED. has_cold_call_script set on ${flagged}, pitch_agent set on ${agented}.`);
})().catch(e => { console.error(e); process.exit(1); });
