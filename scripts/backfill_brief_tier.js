/**
 * scripts/backfill_brief_tier.js
 *
 * David's CURRENT lead ranking lives in each cold-call brief header
 * ("**Tier:** N", 1=top/2/3) in the Supabase Storage bucket cold-call-briefs/
 * rep-{a,b,c}/<slug>-<date>.md — NOT in the prospect_tier DB column (which is
 * his older, incomplete scoring). This script reads every brief, parses the
 * Tier, and stamps prospecting.leads.brief_tier so the dashboards show David's
 * real ranking for every scripted lead.
 *
 * Re-run after each David brief push (same cadence as backfill_script_flag.js).
 *   node sites/stilo-ai/scripts/backfill_brief_tier.js
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Load .env.local
try {
    const envFile = path.join(__dirname, '..', '.env.local');
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const BUCKET = 'cold-call-briefs';
// rep-a/b/c are the SDR folders; dc/rl are David's owner-loan brief folders
// (David Coira / Remy Leon, added 2026-06-08). Owner folders are listed LAST so
// that when a lead is briefed in both a rep folder and an owner folder, the
// owner's tier wins (matching backfill_script_flag.js's owner-last assignment).
// Without dc/rl here, every owner-assigned scripted lead showed up untiered.
const FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'rep-d', 'dc', 'rl'];

function slugify(input) {
    if (!input) return '';
    return String(input).normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function mapLimit(items, limit, fn) {
    const out = []; let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

(async () => {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // 1. Build slug -> tier from every brief.
    const slugTier = {};
    for (const folder of FOLDERS) {
        const { data: items, error } = await storage.storage.from(BUCKET).list(folder, { limit: 2000 });
        if (error) { console.warn('list', folder, error.message); continue; }
        const briefs = (items || []).filter(it => it.name.endsWith('.md'));
        console.log(folder + ': ' + briefs.length + ' briefs');
        await mapLimit(briefs, 12, async function (it) {
            const slug = it.name.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').toLowerCase();
            try {
                const { data: blob } = await storage.storage.from(BUCKET).download(folder + '/' + it.name);
                const text = await blob.text();
                const m = text.match(/\*\*Tier:\*\*\s*(\d+)/i);
                if (m) {
                    const t = parseInt(m[1], 10);
                    if (t >= 1 && t <= 3) slugTier[slug] = t;
                }
            } catch (e) { /* skip unreadable */ }
        });
    }
    console.log('parsed tiers for ' + Object.keys(slugTier).length + ' briefs');

    // 2. Match scripted leads to a brief slug and stamp brief_tier.
    //    PostgREST caps a single response at ~1000 rows regardless of .limit(),
    //    which previously left every scripted lead past the 1000th untiered.
    //    Page through with .range() so all callable leads get stamped.
    const leads = [];
    for (let from = 0; ; from += 1000) {
        const { data, error: leadErr } = await sb.from('leads')
            .select('id, name, brief_tier').eq('has_cold_call_script', true)
            .order('id', { ascending: true }).range(from, from + 999);
        if (leadErr) { console.error('leads', leadErr.message); process.exit(1); }
        if (!data || !data.length) break;
        leads.push(...data);
        if (data.length < 1000) break;
    }
    console.log('scripted leads: ' + leads.length);

    let matched = 0, updated = 0, unmatched = 0;
    const updates = [];
    for (const l of (leads || [])) {
        const t = slugTier[slugify(l.name)];
        if (t == null) { unmatched++; continue; }
        matched++;
        if (l.brief_tier !== t) updates.push({ id: l.id, brief_tier: t });
    }
    // Batch the updates (one statement each via upsert on id).
    await mapLimit(updates, 12, async function (u) {
        const { error } = await sb.from('leads').update({ brief_tier: u.brief_tier }).eq('id', u.id);
        if (!error) updated++;
    });

    const dist = {};
    Object.values(slugTier).forEach(t => { dist[t] = (dist[t] || 0) + 1; });
    console.log('DONE — matched ' + matched + ' / unmatched ' + unmatched + ' / updated ' + updated);
    console.log('brief tier distribution:', JSON.stringify(dist));
})();
