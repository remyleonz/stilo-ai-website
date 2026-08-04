#!/usr/bin/env node
/**
 * scripts/audit_board_scripts.js
 *
 * Answers one question: does any lead currently on a rep's dial board render a
 * brief that pitches a RETIRED agent (AI Receptionist, Outbound, LCR, Website,
 * Lead Generator, SEO) instead of the current Booked Meetings offer?
 *
 * The queue filter in callable.js gates on leads.pitch_agent, which is a DB
 * column. The script a rep actually reads is a markdown file resolved at request
 * time by cold-call-script.js. Those two can disagree, and the failure mode is
 * silent: the board looks correct while the rep opens a script for a product we
 * retired.
 *
 * They can disagree for two reasons:
 *   1. findBriefInSupabase returns the first FOLDER that has a match, then the
 *      newest file within that folder. It is not a global newest-wins search, so
 *      an older brief in an earlier folder beats a newer brief in a later one.
 *   2. David's filenames carry the date he generated the brief, not the date he
 *      pushed it. rep-d's 178 files are all named 2026-06-27 but were uploaded
 *      2026-08-03, so name-sorting does not reliably mean "most recent push".
 *
 * Read-only. Prints a verdict and exits non-zero if anything is stale.
 *   node scripts/audit_board_scripts.js
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
const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

const BRIEFS_BUCKET = 'cold-call-briefs';
// Same order cold-call-script.js iterates when there is no rep hint.
const FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'rep-d', 'dc', 'rl'];
const CURRENT_OFFER = 'Booked Meetings';

function slugify(input) {
    return String(input || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Retired products. If a brief names one of these as the thing to pitch, a rep
// reading it would sell something we no longer offer.
const RETIRED = /(ai\s*)?receptionist|outbound agent|lead reply|lead response|\blcr\b|lost customer|reactivat|website builder|lead generator|\bb2b lead\b|ai seo|ontology|sales coach/i;

async function listFolder(folder, cache) {
    if (cache.has(folder)) return cache.get(folder);
    const out = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.storage.from(BRIEFS_BUCKET).list(folder, { limit: 1000, offset: off });
        if (error) break;
        if (!data || !data.length) break;
        out.push(...data.map(f => f.name));
        if (data.length < 1000) break;
    }
    cache.set(folder, out);
    return out;
}

// Mirrors findBriefInSupabase(): first folder with a match wins, newest name in
// that folder. Deliberately reproduces the bug surface rather than "fixing" it
// here, because the point is to see what a rep actually gets served.
async function resolveBrief(name, cache) {
    const slug = slugify(name);
    if (!slug) return null;
    for (const folder of FOLDERS) {
        const names = await listFolder(folder, cache);
        const matches = names
            .filter(n => n.toLowerCase().startsWith(slug + '-') && n.toLowerCase().endsWith('.md'))
            .sort((a, b) => b.localeCompare(a));
        if (matches.length) return { folder, file: matches[0], path: folder + '/' + matches[0] };
    }
    return null;
}

(async () => {
    const leads = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await pro.from('leads')
            .select('id,name,niche,assigned_to,pitch_agent,has_cold_call_script,owner_phone,phone,do_not_call,last_called_outcome')
            .eq('has_cold_call_script', true)
            .eq('pitch_agent', CURRENT_OFFER)
            .range(from, from + 999);
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        leads.push(...data);
        if (data.length < 1000) break;
    }
    const board = leads.filter(l => (l.owner_phone || l.phone) && !l.do_not_call);
    console.log(`${board.length} leads on the boards under "${CURRENT_OFFER}"\n`);

    const folderCache = new Map(), textCache = new Map();
    const stale = [], missing = [];
    let ok = 0, n = 0;

    for (const l of board) {
        const b = await resolveBrief(l.name, folderCache);
        if (!b) { missing.push(l); continue; }
        if (!textCache.has(b.path)) {
            const { data: blob, error } = await sb.storage.from(BRIEFS_BUCKET).download(b.path);
            textCache.set(b.path, (error || !blob) ? null : await blob.text());
        }
        const md = textCache.get(b.path);
        if (md == null) { missing.push(l); continue; }

        // What does this brief tell the rep to pitch?
        const prim = md.match(/^\s*[-*]?\s*\**Primary\**\s*:\**\s*([^\r\n*(|]+)/im);
        const legacy = md.match(/(?:PRODUCT TO PITCH|Meeting product|Product\s*\([^)\r\n]*\))[^\r\n]*?:\**\s*([^\r\n*(|]+)/i);
        const stated = (prim && prim[1] || legacy && legacy[1] || '').trim();

        if (stated && RETIRED.test(stated)) {
            stale.push({ ...l, brief: b.path, stated });
        } else if (!stated) {
            stale.push({ ...l, brief: b.path, stated: '(none stated)' });
        } else ok++;
        if (++n % 200 === 0) console.log(`  checked ${n}/${board.length}...`);
    }

    console.log(`\n  briefs pitching the current offer : ${ok}`);
    console.log(`  briefs pitching a RETIRED product : ${stale.filter(s => s.stated !== '(none stated)').length}`);
    console.log(`  briefs stating no product         : ${stale.filter(s => s.stated === '(none stated)').length}`);
    console.log(`  no brief file resolvable          : ${missing.length}`);

    if (stale.length) {
        console.log('\n--- leads whose script would pitch the wrong thing ---');
        const byStated = {};
        for (const s of stale) (byStated[s.stated] = byStated[s.stated] || []).push(s);
        for (const [k, v] of Object.entries(byStated).sort((a, b) => b[1].length - a[1].length)) {
            console.log(`\n  "${k}"  x${v.length}`);
            v.slice(0, 5).forEach(s => console.log(`     ${s.id}  ${s.name}  [${s.brief}]  -> ${s.assigned_to}`));
        }
    }
    if (missing.length) {
        console.log('\n--- on the board but no brief resolves (rep sees an empty script) ---');
        missing.slice(0, 10).forEach(m => console.log(`     ${m.id}  ${m.name}  -> ${m.assigned_to}`));
        if (missing.length > 10) console.log(`     ...and ${missing.length - 10} more`);
    }
    process.exit(stale.length || missing.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
