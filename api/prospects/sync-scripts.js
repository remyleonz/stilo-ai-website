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
const scrub = require('./_scrub');

module.exports.maxDuration = 60;

// Litigator/DNC scrub budget per run. Each lookup is a network round trip, so
// this is bounded by maxDuration, not by taste. The pass is self-healing rather
// than incremental: it targets every scripted lead that still has no verdict,
// not just the ones enabled this run, so anything that hit the cap (or failed
// against a flaky provider) is retried on the next hourly tick until the
// backlog is zero. scripts/backfill_litigator_scrub.js exists to clear a large
// historical backlog faster than hourly convergence would.
const SCRUB_CAP = Number(process.env.SCRUB_CAP_PER_RUN || 60);

const BRIEFS_BUCKET = 'cold-call-briefs';
// rep-d added 2026-08-04: George Gutierrez was hired 2026-07-24 and David pushed
// his first 178 briefs on 2026-08-03 into a folder no code knew existed. Every
// consumer of this bucket had a hardcoded folder list, so his leads were never
// flagged, never assigned, and never rendered a script. When a rep is hired,
// grep for 'rep-c' and add the new folder to every hit.
const BRIEF_FOLDERS = ['rep-a', 'rep-b', 'rep-c', 'rep-d', 'rl', 'dc'];
const GENERATED_BUCKET = 'cold-call-scripts-generated';

// The agent David states in a script, mapped to a canonical name. Kept in sync
// with the dashboards' canonicalAgent(). This is written to leads.pitch_agent so
// the boards read one field instead of re-parsing script text every load.
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
    // The 2026-08 pivot: we sell booked qualified meetings, not agents. David's
    // new briefs name the product as "Booked Meetings" under a **Primary:**
    // heading. Without this the value canonicalized to null, pitch_agent stayed
    // null, and callable.js filtered every new-niche lead out of every queue.
    // That is what put 554 briefed, scripted, dialable leads on nobody's board.
    if (/booked meeting|qualified meeting|pipeline system/.test(v)) return 'Booked Meetings';
    return null;
}
// David names the pitched product under THREE different headings depending on
// which generation of his generator wrote the script:
//   **PRODUCT TO PITCH:** X
//   **Meeting product:** X
//   **Product (named ONCE, in the close):** X          <- newest, 2026-07 scripts
//   **Product (pitched at the 15-min meeting...):** X
//
// The third form was missing here, and the omission was silent in the worst
// way: pitch_agent had already been set from an OLDER script for those leads,
// so nothing looked broken, but the re-push refresh pass could no longer read
// the current file and the stored agent froze forever. The dashboard chip and
// the follow-up email then kept selling a product David had since changed his
// mind about. Measured drift before this fix was ~3% of scripted leads.
//
// The parenthetical is matched loosely because the wording inside it varies per
// script; only the leading word "Product" and the colon are load-bearing.
//
// 2026-08-04: a FIFTH form arrived with the sales-agency pivot. The new briefs
// drop the "Product"/"Meeting product" heading entirely and state it as:
//   ## Recommendation
//   - **Primary:** Booked Meetings
//   - **Secondary (fallback):** Lead Generator
// Only **Primary:** is read. Taking Secondary too would put a fallback product
// on the board as if David had chosen it. "Primary" is matched with a word
// boundary so it cannot collide with a future "Primary contact:" style field.
function agentFromScript(md) {
    const s = String(md || '');
    const m = s.match(
        /(?:PRODUCT TO PITCH|Meeting product|Product\s*\([^)\r\n]*\))[^\r\n]*?:\**\s*([A-Za-z][^\r\n*(|]*)/i
    );
    if (m) {
        const a = canonAgent(m[1]);
        if (a) return a;
    }
    const p = s.match(/^\s*[-*]?\s*\**Primary\**\s*:\**\s*([A-Za-z][^\r\n*(|]*)/im);
    return p ? canonAgent(p[1]) : null;
}
// "Ask for: <name>" in David's current script format; returns a plausible
// person name or null. The slot is polluted upstream (our own owner_name junk
// feeds his generator: "Personal Lines" became "Ask for: Personal"), so this
// filter is deliberately strict: short, alphabetic, not a role word, not an
// insurance line type, not a placeholder, not a fragment of the business name.
const NAME_JUNK = /^(the )?(owner|manager|office|front desk|reception(ist)?|personal( lines)?|commercial( lines)?|dwelling|high|life|auto|home|general|business|billing|claims|sales|service|info|contact|program|staff|team|unknown|none|n\/?a|tbd|john doe|jane doe)$/i;
function realNameFromScript(md, businessName) {
    const m = String(md || '').match(/Ask for:\**\s*([^\r\n·|(]+)/i);
    if (!m) return null;
    const v = m[1].replace(/[*`]/g, '').trim().replace(/[.,;:]+$/, '');
    if (v.length < 2 || v.length > 40) return null;
    if (NAME_JUNK.test(v)) return null;
    if (/owner|desk|manager|line|dept|team|doe\b|hello|verify|confirm|guess|no name/i.test(v)) return null;
    if (!/^[A-Za-zÀ-ÿ'.-]+( [A-Za-zÀ-ÿ'.-]+){0,3}$/.test(v)) return null;
    const bl = String(businessName || '').toLowerCase(), sl = v.toLowerCase();
    if (bl.startsWith(sl) || bl.includes(' ' + sl)) return null;
    return v;
}
// Fetch a lead's script (GCS listing, else our generated fallback) and return
// David's stated agent, or null. Best-effort: any failure yields null.
async function pitchAgentForLead(token, name) {
    try {
        const it = await cc.findScriptByListing(token, cc.slugify(name));
        let md = it ? await cc.readObject(token, it.name) : await cc.readGeneratedScript(cc.slugify(name));
        return agentFromScript(md);
    } catch (_) { return null; }
}

// David's manifest maps business_name/lead_id -> script filename. A lead counts
// as scripted if its name or slug is in there. Mirrors backfill_script_flag.js.
// Also returns slug -> filename so the refresh pass below can detect re-pushes.
async function loadManifestSlugs(token) {
    const raw = await cc.readObject(token, 'cold-call/manifest.json');
    const man = JSON.parse(raw);
    const scripts = Array.isArray(man) ? man : (man.scripts || []);
    const slugs = new Set();
    const fileBySlug = {};
    // David's manifest can hold DUPLICATE entries for one lead (e.g. a 07-21
    // and a 07-23 script). cold-call-script.js builds its lookup maps with
    // plain assignment, so the LAST entry wins and that is the file the
    // dashboards serve. Mirror that exactly here: last-wins, never first-wins,
    // or the refresh pass parses a different file than the one on screen.
    for (const e of scripts) {
        if (!e) continue;
        if (e.business_name) {
            const s = cc.slugify(e.business_name);
            slugs.add(s);
            if (e.filename) fileBySlug[s] = e.filename;
        }
        if (e.lead_id) {
            const s = String(e.lead_id).replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase();
            slugs.add(s);
            if (e.filename) fileBySlug[s] = e.filename;
        }
    }
    return { slugs, fileBySlug };
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
    let scripted, fileBySlug;
    try { const man = await loadManifestSlugs(token); scripted = man.slugs; fileBySlug = man.fileBySlug; }
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
            .select('id,name,owner_phone,phone,assigned_to,has_cold_call_script,pitch_agent,pitch_agent_file,owner_name').range(from, from + 999);
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

    // --- re-sync pass: David re-pushed a script for an already-enabled lead --
    // pitch_agent was historically written once, at enable time. David re-pushes
    // scripts that CHANGE the meeting product (07-14/07-23 changed 345 leads),
    // which left the dashboards' agent chip contradicting the script text under
    // it. The manifest filename is the change signal: when it differs from the
    // lead's stored pitch_agent_file, re-read that script and refresh the agent
    // (and owner_name, when the script names a real person and the lead has
    // none). Capped per run to stay inside maxDuration; hourly runs converge.
    const REFRESH_CAP = 150;
    const needsRefresh = [];
    for (const slug in bySlug) {
        const l = bySlug[slug];
        const file = fileBySlug[slug];
        if (!file) continue; // listing-only lead: the enable path handles it
        if (!l.has_cold_call_script && !targetCallable.has(l.id)) continue;
        if (l.pitch_agent_file === file) continue;
        needsRefresh.push({ lead: l, file: file });
    }

    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, prune: prune,
            briefed: briefed.size, scripted: scripted.size,
            target_callable: targetCallable.size, awaiting: awaiting.length,
            would_enable: toEnable.length,
            would_refresh: needsRefresh.length,
            would_disable: prune ? toDisable.length : 0,
            stale_not_pruned: prune ? 0 : toDisable.length,
        });
    }

    const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
    let enabled = 0, disabled = 0, agented = 0;
    for (const ids of chunk(toEnable, 200)) {
        const { error } = await pro.from('leads').update({ has_cold_call_script: true, updated_at: new Date().toISOString() }).in('id', ids);
        if (!error) enabled += ids.length;
    }
    // Store David's stated agent for each lead we just enabled, so it's set the
    // moment the lead becomes callable. The callable queue filters on pitch_agent,
    // so a newly-scripted lead only surfaces once this runs. Only the (small)
    // newly-enabled set is processed to stay within maxDuration; the historical
    // bulk was populated by a one-time backfill. A lead whose script states no
    // agent stays pitch_agent=null and correctly stays out of the queue.
    const idToLead = {};
    for (const s in bySlug) idToLead[bySlug[s].id] = bySlug[s];
    for (const id of toEnable) {
        const lead = idToLead[id];
        if (!lead) continue;
        // Manifest-listed leads are handled by the refresh pass below (which
        // also stamps pitch_agent_file); only listing-only leads need this path.
        if (fileBySlug[cc.slugify(lead.name)]) continue;
        const agent = await pitchAgentForLead(token, lead.name);
        if (agent) { const { error } = await pro.from('leads').update({ pitch_agent: agent }).eq('id', id); if (!error) agented++; }
    }
    // The re-push refresh pass (see needsRefresh above).
    let refreshed = 0, renamed = 0;
    for (const item of needsRefresh.slice(0, REFRESH_CAP)) {
        try {
            const md = await cc.readObject(token, 'cold-call/' + item.file);
            const agent = agentFromScript(md);
            const patch = { pitch_agent_file: item.file };
            if (agent) patch.pitch_agent = agent;
            const person = realNameFromScript(md, item.lead.name);
            if (person && !(item.lead.owner_name && String(item.lead.owner_name).trim())) {
                patch.owner_name = person; renamed++;
            }
            const { error } = await pro.from('leads').update(patch).eq('id', item.lead.id);
            if (!error) refreshed++;
        } catch (_) { /* transient read failure: retried next run */ }
    }
    // Only prune when explicitly asked. The default cron path never disables.
    if (prune) {
        for (const ids of chunk(toDisable, 200)) {
            const { error } = await pro.from('leads').update({ has_cold_call_script: false, updated_at: new Date().toISOString() }).in('id', ids);
            if (!error) disabled += ids.length;
        }
    }

    // --- litigator / DNC scrub gate -----------------------------------------
    // Every lead David makes dial-ready gets screened before a rep can touch
    // it. A match sets do_not_call = true inside scrubLead(), and do_not_call is
    // already honored by callable.js and both owner queues, so a blocked lead
    // vanishes from every dialing surface without a new filter anywhere.
    //
    // Deliberately runs AFTER the enable pass so it sees this push's leads, and
    // deliberately queries by verdict rather than by "enabled this run" so a
    // capped or provider-failed lead is retried until it has an answer.
    //
    // Never fails the request: a scrub outage must not stop David's pushes from
    // landing. Unscrubbed leads simply keep scrub_status null, stay ineligible
    // for SMS (which requires an explicit 'clear'), and get picked up next hour.
    const scrubStats = { checked: 0, clear: 0, blocked: 0, error: 0, pending: 0 };
    let scrubBacklog = 0;
    try {
        const { data: toScrub, count } = await pro.from('leads')
            .select('id,name,owner_phone_e164,owner_phone,phone', { count: 'exact' })
            .eq('has_cold_call_script', true)
            .or('owner_phone_e164.not.is.null,owner_phone.not.is.null,phone.not.is.null')
            // The null case must be spelled out: `scrub_status <> 'clear'` is
            // NULL for a never-scrubbed lead, which would silently exclude
            // exactly the rows this pass exists to find.
            .or('scrub_status.is.null,scrub_status.eq.pending,scrub_status.eq.error')
            .order('id', { ascending: true })
            .limit(SCRUB_CAP);

        for (const lead of (toScrub || [])) {
            const r = await scrub.scrubLead(pro, lead, 'sync-scripts');
            scrubStats.checked++;
            scrubStats[r.status] = (scrubStats[r.status] || 0) + 1;
            if (r.status === 'blocked') {
                console.warn('[scrub] BLOCKED lead=' + lead.id + ' "' + (lead.name || '') + '" reason=' + r.reason);
            }
        }
        scrubBacklog = Math.max(0, (count || 0) - scrubStats.checked);
    } catch (e) {
        console.error('[scrub] pass failed (non-fatal): ' + (e && e.message));
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
        enabled: enabled, agented: agented, disabled: disabled,
        refreshed: refreshed, renamed: renamed,
        refresh_backlog: Math.max(0, needsRefresh.length - REFRESH_CAP),
        stale_left: prune ? 0 : toDisable.length,
        awaiting: awaitingDedup.length,
        scrub: scrubStats,
        scrub_backlog: scrubBacklog,
    });
};
