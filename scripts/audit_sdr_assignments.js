#!/usr/bin/env node
/**
 * scripts/audit_sdr_assignments.js  (read-only)
 *
 * Verifies each SDR actually owns the leads + scripts David put in THEIR folder,
 * and surfaces the cross-folder contamination that made Ale see Luke's leads:
 * a lead whose brief David dropped into two SDR folders gets assigned to whichever
 * folder backfill_script_flag.js processes LAST (rep-c > rep-b > rep-a), so Ale
 * (rep-b) silently absorbs leads that are also Luke's (rep-a).
 *
 * Prints, per rep: callable count, tier mix, niche mix, agents pitched, plus a
 * global list of cross-folder briefs and any lead assigned to the "wrong" rep.
 * Mutates nothing.
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
const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const leadsDb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

const REP_EMAIL = { 'rep-a': 'huronfire5@gmail.com', 'rep-b': 'aleb1027@gmail.com', 'rep-c': 'jacksonmaguire0@gmail.com', 'dc': 'davidcoira@stiloaipartners.com', 'rl': 'remyleon@stiloaipartners.com' };
const REP_NAME = { 'rep-a': 'Luke', 'rep-b': 'Alejandro', 'rep-c': 'Jack', 'dc': 'David', 'rl': 'Remy' };
const NAME_BY_EMAIL = {}; Object.keys(REP_EMAIL).forEach(f => NAME_BY_EMAIL[REP_EMAIL[f]] = REP_NAME[f]);
const SDR_FOLDERS = ['rep-a', 'rep-b', 'rep-c'];
const ALL_FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'dc', 'rl'];

function slugify(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function cleanAgent(s) { return String(s || '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, ''); }
function isJunk(v) { return !v || /^(unknown|none|n\/?a|tbd)$/i.test(v); }
// Same precedence as api/prospects/_script_agent.js resolveScriptAgentName.
function resolveAgent(md) {
    const src = String(md || '');
    let m = src.match(/PRODUCT TO PITCH[^\r\n]*?:\**\s*([A-Za-z][^\r\n*]*)/i);
    if (m) { const v = cleanAgent(m[1]); if (!isJunk(v)) return v; }
    const sec = src.match(/#{1,6}\s*Recommended STILO agent\s*\r?\n([\s\S]*?)(?=\r?\n#{1,6}\s|$)/i);
    if (sec) { for (const line of sec[1].split(/\r?\n/)) { const raw = line.replace(/^[-*]\s*/, '').replace(/[*`]/g, '').trim(); if (!raw || /^secondary/i.test(raw)) continue; const pm = raw.match(/^(?:primary|lead with)\s*:\s*(.+)$/i); const v = cleanAgent(pm ? pm[1] : raw); if (!isJunk(v)) return v; } }
    let t = src.match(/\*\*Top solution[s]?:\*\*\s*([^\r\n⭐]+)/i);
    if (t) { const v = cleanAgent(t[1]); if (!isJunk(v)) return v; }
    let f = src.match(/likely fit:\s*([^\r\n]+)/i);
    if (f) { const v = cleanAgent(f[1].replace(/[·*].*$/, '')); if (!isJunk(v)) return v; }
    const rec = src.match(/#{1,6}\s*Recommendation\s*\r?\n([\s\S]*?)(?=\r?\n#{1,6}\s|$)/i);
    if (rec) { const pm = rec[1].replace(/[*`]/g, '').match(/primary\s*:\s*([^\r\n]+)/i); if (pm) { const v = cleanAgent(pm[1]); if (!isJunk(v)) return v; } }
    return null;
}
async function mapLimit(items, limit, fn) { const out = []; let i = 0; async function w() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } } await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w)); return out; }

(async () => {
    // 1. List + read every brief, per folder.
    const slugInfo = {}; // slug -> { folders: { folder: {tier, agent, filename} } }
    const folderBriefCount = {};
    for (const folder of ALL_FOLDERS) {
        const items = [];
        let offset = 0;
        for (;;) {
            const { data, error } = await storage.storage.from('cold-call-briefs').list(folder, { limit: 1000, offset });
            if (error) { console.error('list', folder, error.message); break; }
            if (!data || !data.length) break;
            items.push(...data.filter(o => o.name.endsWith('.md')));
            if (data.length < 1000) break; offset += 1000;
        }
        folderBriefCount[folder] = items.length;
        await mapLimit(items, 16, async (o) => {
            const slug = o.name.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').toLowerCase();
            let tier = null, agent = null;
            try {
                const { data: blob } = await storage.storage.from('cold-call-briefs').download(folder + '/' + o.name);
                const text = await blob.text();
                const tm = text.match(/\*\*Tier:\*\*\s*(\d+)/i); if (tm) tier = parseInt(tm[1], 10);
                agent = resolveAgent(text);
            } catch (e) { /* skip */ }
            if (!slugInfo[slug]) slugInfo[slug] = { folders: {} };
            slugInfo[slug].folders[folder] = { tier, agent, filename: o.name };
        });
        process.stderr.write(`listed ${folder}: ${items.length} briefs\n`);
    }

    // 2. Cross-folder contamination among the 3 SDR folders.
    const crossSdr = [];
    for (const slug of Object.keys(slugInfo)) {
        const f = Object.keys(slugInfo[slug].folders).filter(x => SDR_FOLDERS.includes(x));
        if (f.length >= 2) crossSdr.push({ slug, folders: f.map(x => REP_NAME[x]) });
    }

    // 3. Load all scripted (callable) leads.
    const leads = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await leadsDb.from('leads')
            .select('id,name,assigned_to,category,brief_tier,owner_phone,phone')
            .eq('has_cold_call_script', true).order('id').range(from, from + 999);
        if (error) throw error;
        if (!data || !data.length) break;
        leads.push(...data); if (data.length < 1000) break;
    }

    // 4. Per-rep aggregation + misassignment detection.
    const reps = {};
    Object.values(REP_EMAIL).forEach(e => reps[e] = { callable: 0, tier: { 1: 0, 2: 0, 3: 0, null: 0 }, niche: {}, agent: {}, noScriptFile: 0, misassigned: [] });
    const expectedFolderForEmail = {}; Object.keys(REP_EMAIL).forEach(f => expectedFolderForEmail[REP_EMAIL[f]] = f);

    for (const l of leads) {
        const r = reps[l.assigned_to]; if (!r) continue; // ignore any non-roster assignee
        r.callable++;
        r.tier[l.brief_tier == null ? 'null' : l.brief_tier] = (r.tier[l.brief_tier == null ? 'null' : l.brief_tier] || 0) + 1;
        const niche = l.category || '(none)'; r.niche[niche] = (r.niche[niche] || 0) + 1;
        const slug = slugify(l.name);
        const info = slugInfo[slug];
        const myFolder = expectedFolderForEmail[l.assigned_to];
        if (!info) { r.noScriptFile++; r.agent['(no brief matched)'] = (r.agent['(no brief matched)'] || 0) + 1; continue; }
        const foldersFor = Object.keys(info.folders);
        // agent pitched = the agent named in THIS rep's folder brief if present, else any.
        const briefHere = info.folders[myFolder] || info.folders[foldersFor[0]];
        const ag = (briefHere && briefHere.agent) || '(unspecified)';
        r.agent[ag] = (r.agent[ag] || 0) + 1;
        // Misassigned: this rep's folder has NO brief for the lead, but another SDR's folder does.
        if (!info.folders[myFolder]) {
            const otherSdr = foldersFor.filter(x => SDR_FOLDERS.includes(x)).map(x => REP_NAME[x]);
            const owners = foldersFor.map(x => REP_NAME[x]);
            r.misassigned.push({ id: l.id, name: l.name, briefIn: owners, sdrOwners: otherSdr });
        }
    }

    const out = { folderBriefCount, crossSdr, reps, totals: { scriptedLeads: leads.length, distinctSlugs: Object.keys(slugInfo).length } };
    console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
