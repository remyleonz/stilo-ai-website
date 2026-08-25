#!/usr/bin/env node
/**
 * audit_board_contamination.js
 *
 * Answers: is each rep working the niche and the leads David actually intended?
 *
 * David's intent lives in the brief FOLDER a lead was researched into
 * (cold-call-briefs/rep-a|rep-b|rep-c|rep-d|rl|dc). The rep who actually holds
 * the lead is prospecting.leads.assigned_to. Those two can drift apart, and
 * nothing surfaces it, because reconcile_brief_assignments() only re-points
 * leads that are still stage='NEW' with zero call attempts.
 *
 * Reports five kinds of contamination:
 *   1. WRONG REP     lead sits with rep X, briefed into rep Y's folder
 *   2. NO BRIEF      lead is on a board but was never briefed in any folder
 *   3. OFF NICHE     lead's category is outside the rep's two intended niches
 *   4. DUPLICATE     the same business briefed into two different rep folders
 *   5. SPLIT NICHE   a rep carrying more than two meaningful niches
 *
 *   node scripts/audit_board_contamination.js [--json out.json]
 */
const fs = require('fs');
const path = require('path');

fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(l => {
    const m = l.match(/^([A-Z0-9_]+)=([\s\S]*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});

// 2026-08-20: rep-d points back at GEORGE. The 08-19 offboarding routing sent
// it to Remy (and this file still said Marcus), but rep-d was never Marcus's
// book: David created it FOR George on 2026-08-03 and Marcus held it eight days
// after the 08-11 swap. That detour left George's board at 53 dead leads with no
// brief file behind any of them. rep-a stays on George too; it is empty today.
// NEVER point a folder at an inactive rep: outbound-enqueue drops any lead whose
// assigned_to has no active sdr_users row, so the book silently stops being
// callable or textable. Keep in sync with prospecting.reconcile_brief_assignments().
const FOLDER_TO_REP = {
    'rep-a': 'georgegutierrez446@gmail.com',
    'rep-b': 'aleb1027@gmail.com',
    'rep-c': 'ayesjorge911@gmail.com',
    'rep-d': 'georgegutierrez446@gmail.com',
    'rep-e': 'melanyealtuve12@gmail.com',
    'rl': 'remyleon@stiloaipartners.com',
    'dc': 'davidcoira@stiloaipartners.com'
};
const NAME = {
    'georgegutierrez446@gmail.com': 'George',
    'aleb1027@gmail.com': 'Alejandro',
    'ayesjorge911@gmail.com': 'Jorge',
    'melanyealtuve12@gmail.com': 'Melanye',
    'remyleon@stiloaipartners.com': 'Remy',
    'davidcoira@stiloaipartners.com': 'David'
};

// The five niches we sell, mapped from the Google Places category on the lead.
function niche(cat) {
    const c = String(cat || '').toLowerCase();
    if (/roofing/.test(c)) return 'roofing';
    if (/janitor|cleaning|cleaners|maid|custodial/.test(c)) return 'cleaning';
    if (/employment|temp agency|staffing|executive search|nursing agency|recruit/.test(c)) return 'staffing';
    if (/truck|freight|logistic|cargo|shipping|courier|haul/.test(c)) return 'freight';
    if (/equipment|forklift|machin|crane|industrial|compressor|hydraulic|tool/.test(c)) return 'equipment';
    return 'other:' + (cat || 'blank');
}

// Normalisation used by reconcile_brief_assignments(): strip every non
// alphanumeric, lowercase. Matching the pg function exactly matters, because a
// looser match here would invent drift the cron would never actually act on.
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
    const auditPath = path.join(__dirname, '..', '..', '..', 'Strategy', 'david-artifact-audit.json');
    if (!fs.existsSync(auditPath)) {
        console.error('Run audit_david_artifacts.js first (needs the brief index).');
        process.exit(1);
    }
    const briefs = JSON.parse(fs.readFileSync(auditPath, 'utf8')).briefs;

    // business key -> set of folders it was briefed into
    const briefFolders = new Map();
    for (const b of briefs) {
        const k = norm(b.business || b.slug);
        if (!k) continue;
        if (!briefFolders.has(k)) briefFolders.set(k, new Set());
        briefFolders.get(k).add(b.folder);
        const k2 = norm(b.slug);
        if (k2 && k2 !== k) {
            if (!briefFolders.has(k2)) briefFolders.set(k2, new Set());
            briefFolders.get(k2).add(b.folder);
        }
    }

    const leads = [];
    for (let from = 0; ; from += 1000) {
        const r = await fetch(process.env.SUPABASE_URL +
            '/rest/v1/leads?select=id,name,category,assigned_to,has_cold_call_script,pitch_agent,' +
            'archived_batch,last_called_at,call_attempts,stage&order=id.asc', {
            headers: {
                apikey: process.env.SUPABASE_SERVICE_KEY,
                Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
                'Accept-Profile': 'prospecting', Range: from + '-' + (from + 999)
            }
        });
        const page = await r.json();
        leads.push(...page);
        if (page.length < 1000) break;
    }

    // A "board" lead is what callable.js will actually serve to a rep.
    const board = leads.filter(l => l.assigned_to && !l.archived_batch &&
        l.has_cold_call_script && l.pitch_agent === 'Booked Meetings');

    const byRep = {};
    for (const l of board) {
        const rep = l.assigned_to;
        byRep[rep] = byRep[rep] || {
            total: 0, niches: {}, wrongRep: [], noBrief: 0, folders: {}, stuck: 0
        };
        const R = byRep[rep];
        R.total++;
        const n = niche(l.category);
        R.niches[n] = (R.niches[n] || 0) + 1;

        const folders = briefFolders.get(norm(l.name));
        if (!folders) { R.noBrief++; continue; }
        for (const f of folders) R.folders[f] = (R.folders[f] || 0) + 1;

        const intended = [...folders].map(f => FOLDER_TO_REP[f]).filter(Boolean);
        if (intended.length && !intended.includes(rep)) {
            R.wrongRep.push({
                id: l.id, name: l.name, category: l.category,
                intended: intended.map(e => NAME[e] || e).join('/'),
                folders: [...folders].join('/'),
                // The cron only re-points untouched leads, so anything dialled
                // or moved out of NEW is drift that will never self-heal.
                selfHeals: l.stage === 'NEW' && !l.last_called_at && !(l.call_attempts > 0)
            });
        }
    }

    console.log('=== BOARD CONTAMINATION AUDIT ===');
    console.log('board leads (callable, current offer):', board.length, '\n');

    for (const [rep, R] of Object.entries(byRep).sort((a, b) => b[1].total - a[1].total)) {
        const top = Object.entries(R.niches).sort((a, b) => b[1] - a[1]);
        const real = top.filter(([n]) => !n.startsWith('other:'));
        console.log('--- ' + (NAME[rep] || rep) + '  (' + R.total + ' leads) ---');
        console.log('  niches   :', top.map(([n, c]) => n + '=' + c).join('  '));
        console.log('  from folders:', Object.entries(R.folders).map(([f, c]) => f + '=' + c).join('  ') || 'none');
        console.log('  no brief anywhere :', R.noBrief);
        console.log('  WRONG REP         :', R.wrongRep.length +
            (R.wrongRep.length ? '  (' + R.wrongRep.filter(w => !w.selfHeals).length + ' will NOT self-heal)' : ''));
        if (R.wrongRep.length) {
            for (const w of R.wrongRep.slice(0, 8)) {
                console.log('      #' + w.id, w.name.slice(0, 40), '| ' + w.category +
                    ' | David meant: ' + w.intended + (w.selfHeals ? '' : '  [STUCK]'));
            }
            if (R.wrongRep.length > 8) console.log('      ... and ' + (R.wrongRep.length - 8) + ' more');
        }
        if (real.length > 2) {
            console.log('  SPLIT NICHE: carrying ' + real.length + ' niches, should be 2');
        }
        console.log('');
    }

    // Businesses briefed into more than one rep folder = two reps could dial them.
    const dupes = [...briefFolders.entries()].filter(([, f]) =>
        [...f].filter(x => x.startsWith('rep-')).length > 1);
    console.log('=== DUPLICATE BRIEFS (same business in 2+ rep folders) ===');
    console.log('  count:', dupes.length);
    dupes.slice(0, 12).forEach(([k, f]) => console.log('   ', k.slice(0, 42), '->', [...f].join(', ')));

    if (process.argv.includes('--json')) {
        const out = process.argv[process.argv.indexOf('--json') + 1];
        fs.writeFileSync(out, JSON.stringify({ byRep, dupes: dupes.map(([k, f]) => ({ key: k, folders: [...f] })) }, null, 1));
        console.log('\nwrote', out);
    }
})().catch(e => { console.error(e); process.exit(1); });
