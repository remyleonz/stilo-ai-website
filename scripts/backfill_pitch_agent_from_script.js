/**
 * scripts/backfill_pitch_agent_from_script.js
 *
 * Re-reads the CURRENT cold-call script for every scripted lead and corrects
 * leads.pitch_agent to whatever David's script says today.
 *
 * WHY THIS EXISTS
 *
 * agentFromScript() understood two headings ("PRODUCT TO PITCH", "Meeting
 * product") but David's 2026-07 generator emits a third:
 *
 *     **Product (named ONCE, in the close):** AI Receptionist
 *
 * The omission failed silently in the worst possible way. Those leads already
 * had a pitch_agent set from an OLDER script, so nothing looked broken on the
 * dashboard. But sync-scripts' re-push refresh pass could no longer parse the
 * current file, so the stored agent froze permanently at the previous value.
 * The chip, the rep's understanding of what to sell, and the follow-up email's
 * default agent all kept pointing at a product David had since changed.
 *
 * Measured on a 60-lead sample before the parser fix: 5 leads drifted, all five
 * with the DB holding an older agent while the live script said AI Receptionist.
 * That is ~8%, or roughly 165 of the 1,999 scripted leads.
 *
 * The hourly sync-scripts refresh only re-reads a lead when the manifest
 * FILENAME changes, so leads whose file name stayed the same would never
 * self-correct even with the parser fixed. Hence a one-time forced pass.
 *
 * Requires the GCS service account. Locally: pull it out of Vercel and point
 * GCP_SCRIPTS_SA_KEY at the parsed JSON (see --help note below), because the
 * copy in .env.local is stored double-quoted with unescaped inner quotes and
 * will not JSON.parse.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/backfill_pitch_agent_from_script.js --dry
 *   node sites/stilo-ai/scripts/backfill_pitch_agent_from_script.js
 *   node sites/stilo-ai/scripts/backfill_pitch_agent_from_script.js --limit=200
 */
const fs = require('fs');
const path = require('path');

try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

// Local escape hatch: a pre-parsed service account written to /tmp/sa.json wins
// over the mangled .env.local copy. Harmless in production where the file is
// absent and the real env var is already valid JSON.
try {
    const sa = fs.readFileSync('/tmp/sa.json', 'utf8');
    if (sa && sa.trim().startsWith('{')) process.env.GCP_SCRIPTS_SA_KEY = sa;
} catch (e) { /* not present, use the env var as-is */ }

const { createClient } = require('@supabase/supabase-js');
const cc = require('../api/prospects/cold-call-script');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 0);

function canonAgent(name) {
    const v = String(name || '').toLowerCase();
    if (!v.trim()) return null;
    if (/receptionist|\becho\b/.test(v)) return 'AI Receptionist';
    if (/outbound|lead reply|lead response|\bignite\b/.test(v)) return 'Outbound Agent';
    if (/\blcr\b|reactivat|lost customer|\brevive\b/.test(v)) return 'LCR';
    if (/lead gen|b2b|\bscout\b/.test(v)) return 'Lead Generator';
    if (/website|web build|\bforge\b/.test(v)) return 'Website Builder';
    if (/\bseo\b|\bgeo\b|\bsignal\b/.test(v)) return 'AI SEO';
    if (/ontology|\boracle\b/.test(v)) return 'Ontology';
    if (/sales coach|sales agent|\bpitch\b/.test(v)) return 'AI Sales Agent';
    if (/custom\s+(automation|workflow)|\bflux\b/.test(v)) return 'Custom Automations';
    return null;
}
function agentFromScript(md) {
    const m = String(md || '').match(
        /(?:PRODUCT TO PITCH|Meeting product|Product\s*\([^)\r\n]*\))[^\r\n]*?:\**\s*([A-Za-z][^\r\n*(|]*)/i
    );
    return m ? canonAgent(m[1]) : null;
}

(async () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
        process.exit(1);
    }
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });

    let token;
    try { token = await cc.getAccessToken(); }
    catch (e) { console.error('GCS auth failed: ' + e.message); process.exit(1); }

    let leads = [], from = 0;
    for (;;) {
        const { data, error } = await sb.from('leads')
            .select('id,name,pitch_agent').eq('has_cold_call_script', true)
            .order('id', { ascending: true }).range(from, from + 999);
        if (error) { console.error('leads read failed: ' + error.message); process.exit(1); }
        if (!data.length) break;
        leads = leads.concat(data);
        if (data.length < 1000) break;
        from += 1000;
    }
    console.log('scripted leads: ' + leads.length + (DRY ? '   (DRY RUN)' : ''));

    const stats = { checked: 0, unchanged: 0, corrected: 0, unreadable: 0, unparseable: 0, failed: 0 };
    const changes = [];

    for (const l of leads) {
        if (LIMIT && stats.checked >= LIMIT) break;
        let md = null;
        try {
            const it = await cc.findScriptByListing(token, cc.slugify(l.name));
            md = it ? await cc.readObject(token, it.name) : await cc.readGeneratedScript(cc.slugify(l.name));
        } catch (e) { /* fall through */ }
        if (!md) { stats.unreadable++; continue; }
        stats.checked++;

        const truth = agentFromScript(md);
        if (!truth) { stats.unparseable++; continue; }
        if (truth === l.pitch_agent) { stats.unchanged++; continue; }

        changes.push({ id: l.id, name: (l.name || '').slice(0, 34), was: l.pitch_agent, now: truth });
        if (!DRY) {
            const { error } = await sb.from('leads')
                .update({ pitch_agent: truth, updated_at: new Date().toISOString() }).eq('id', l.id);
            if (error) { stats.failed++; continue; }
        }
        stats.corrected++;
        if (stats.corrected % 25 === 0) console.log('  ...' + stats.corrected + ' corrected');
    }

    console.log('\n--- result ---');
    console.log(JSON.stringify(stats, null, 2));
    if (changes.length) {
        console.log('\nfirst 25 corrections:');
        console.table(changes.slice(0, 25));
        const moves = {};
        changes.forEach(c => { const k = (c.was || 'null') + ' -> ' + c.now; moves[k] = (moves[k] || 0) + 1; });
        console.log('\ncorrection shape:');
        Object.entries(moves).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k));
    }
    if (DRY) console.log('\nDry run. Nothing written.');
})().catch(e => { console.error(e); process.exit(1); });
