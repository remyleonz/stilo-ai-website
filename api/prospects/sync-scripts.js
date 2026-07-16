/**
 * GET /api/prospects/sync-scripts   (Vercel cron, hourly)
 *
 * Closes the last manual step in the David-push -> SDR-dashboard pipeline.
 *
 * David ships two things on his own schedule: research BRIEFS (Supabase Storage
 * cold-call-briefs/rep-{a,b,c},rl,dc) and rep-facing SCRIPTS (GCS
 * stilo-cold-call-scripts, listed in cold-call/manifest.json). A lead is
 * dial-ready only when it is BOTH briefed (in a folder) AND scripted (in the
 * manifest, or we generated one). Assignment already self-heals via the pg_cron
 * `reconcile-brief-assignments` (hourly). The ONLY remaining manual step was
 * running scripts/backfill_script_flag.js to flip has_cold_call_script after a
 * script push. This endpoint does exactly that flip, automatically.
 *
 * ENABLE-ONLY BY DESIGN. backfill_script_flag.js resets the flag false on all
 * ~20k leads then re-flags from the CURRENT brief folders. But David's folders
 * are not fully cumulative: a lead he briefed three weeks ago can drop out of the
 * folder while its script still exists and it's still a perfectly good lead. A
 * full reset would silently yank those older leads out of every rep's queue. An
 * unattended cron must never do that. So this only ever turns a lead's flag ON
 * (a newly-scripted briefed lead David just pushed), never OFF. Removing stale
 * leads stays a deliberate, reviewed action: run this with ?prune=1, or use
 * scripts/backfill_script_flag.js.
 *
 * It does NOT touch assignment (that's the reconcile cron's job) and never
 * reassigns a lead, so it can't fight the other cron or yank an active call.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or admin JWT. ?dry=1 previews the diff.
 * ?prune=1 additionally disables leads no longer briefed-and-scripted.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const cc = require('./cold-call-script'); // reuse getAccessToken/readObject/slugify

module.exports.maxDuration = 60;

const BRIEFS_BUCKET = 'cold-call-briefs';
const BRIEF_FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'rl', 'dc'];
const GENERATED_BUCKET = 'cold-call-scripts-generated';

// David's manifest maps business_name/lead_id -> script filename. A lead counts
// as scripted if its name or slug is in there. Mirrors backfill_script_flag.js.
async function loadManifestSlugs(token) {
    const raw = await cc.readObject(token, 'cold-call/manifest.json');
    const man = JSON.parse(raw);
    const scripts = Array.isArray(man) ? man : (man.scripts || []);
    const slugs = new Set();
    for (const e of scripts) {
        if (!e) continue;
        if (e.business_name) slugs.add(cc.slugify(e.business_name));
        if (e.lead_id) slugs.add(String(e.lead_id).replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase());
    }
    return slugs;
}

async function listAll(bucket, folder, sb) {
    const out = [];
    let offset = 0;
    for (;;) {
        const { data, error } = await sb.storage.from(bucket).list(folder, { limit: 1000, offset });
        if (error || !data || !data.length) break;
        out.push(...data);
        if (data.length < 1000) break; offset += 1000;
    }
    return out;
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const prune = String((req.query && req.query.prune) || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    let token;
    try { token = await cc.getAccessToken(); }
    catch (e) { return res.status(503).json({ error: 'gcs_unavailable', detail: e.message }); }

    // --- the scripted universe: manifest + our generated fallbacks -----------
    let scripted;
    try { scripted = await loadManifestSlugs(token); }
    catch (e) { return res.status(502).json({ error: 'manifest_read_failed', detail: e.message }); }
    for (const o of await listAll(GENERATED_BUCKET, '', sb)) {
        if (o.name.endsWith('.md')) scripted.add(o.name.replace(/\.md$/, '').toLowerCase());
    }

    // --- the briefed universe: every slug David placed in a rep folder -------
    const briefed = new Set();
    for (const folder of BRIEF_FOLDERS) {
        for (const o of await listAll(BRIEFS_BUCKET, folder, sb)) {
            if (o.name.endsWith('.md')) briefed.add(o.name.replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').replace(/\.md$/, '').toLowerCase());
        }
    }

    // --- leads: one per slug (prefer a lead with a phone, like the backfill) -
    const hasPhone = l => !!((l.owner_phone && l.owner_phone.trim()) || (l.phone && l.phone.trim()));
    const bySlug = {};
    let from = 0;
    for (;;) {
        const { data, error } = await pro.from('leads')
            .select('id,name,owner_phone,phone,assigned_to,has_cold_call_script').range(from, from + 999);
        if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });
        if (!data || !data.length) break;
        for (const l of data) {
            const s = cc.slugify(l.name); if (!s) continue;
            if (!bySlug[s] || (hasPhone(l) && !hasPhone(bySlug[s]))) bySlug[s] = l;
        }
        if (data.length < 1000) break; from += 1000;
    }

    // --- target callable = briefed AND scripted ------------------------------
    const targetCallable = new Set();
    const awaiting = []; // briefed but no script yet -> assigned+hidden
    for (const slug of briefed) {
        const lead = bySlug[slug];
        if (!lead) continue;
        if (scripted.has(slug)) targetCallable.add(lead.id);
        else awaiting.push({ lead_id: lead.id, assigned_to: lead.assigned_to, business_name: lead.name });
    }

    // --- diff against the DB: only write leads whose flag actually flips ------
    const toEnable = [], toDisable = [];
    for (const slug in bySlug) {
        const l = bySlug[slug];
        const want = targetCallable.has(l.id);
        if (want && !l.has_cold_call_script) toEnable.push(l.id);
        else if (!want && l.has_cold_call_script) toDisable.push(l.id);
    }

    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, prune: prune,
            briefed: briefed.size, scripted: scripted.size,
            target_callable: targetCallable.size, awaiting: awaiting.length,
            would_enable: toEnable.length,
            would_disable: prune ? toDisable.length : 0,
            stale_not_pruned: prune ? 0 : toDisable.length,
        });
    }

    const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
    let enabled = 0, disabled = 0;
    for (const ids of chunk(toEnable, 200)) {
        const { error } = await pro.from('leads').update({ has_cold_call_script: true, updated_at: new Date().toISOString() }).in('id', ids);
        if (!error) enabled += ids.length;
    }
    // Only prune when explicitly asked. The default cron path never disables.
    if (prune) {
        for (const ids of chunk(toDisable, 200)) {
            const { error } = await pro.from('leads').update({ has_cold_call_script: false, updated_at: new Date().toISOString() }).in('id', ids);
            if (!error) disabled += ids.length;
        }
    }

    // Refresh the awaiting-script snapshot (PK on lead_id; owner folders appended
    // last so they win a collision, matching the backfill's dedupe).
    const seen = new Set(), awaitingDedup = [];
    for (const row of awaiting) { if (!targetCallable.has(row.lead_id) && !seen.has(row.lead_id)) { seen.add(row.lead_id); awaitingDedup.push(row); } }
    await pro.from('awaiting_script').delete().gte('lead_id', 0);
    for (const rows of chunk(awaitingDedup, 200)) {
        await pro.from('awaiting_script').upsert(rows, { onConflict: 'lead_id', ignoreDuplicates: true });
    }

    return res.status(200).json({
        ok: true, prune: prune,
        briefed: briefed.size, scripted: scripted.size,
        target_callable: targetCallable.size,
        enabled: enabled, disabled: disabled,
        stale_left: prune ? 0 : toDisable.length,
        awaiting: awaitingDedup.length,
    });
};
