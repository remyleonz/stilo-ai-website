/**
 * api/prospects/_script_agent.js
 *
 * Resolve which agent a lead's cold-call SCRIPT actually pitches. David's brief
 * (in the stilo-cold-call-scripts GCS bucket) is the human decision the rep
 * reads off the screen as "Pitch: <agent>", and it can differ from the scoring
 * engine's prospect_reasoning ("product=LCR"). The follow-up email must match
 * what the rep pitched, so draft-email asks this module first.
 *
 * Mirrors the client-side psResolveAgentName() in admin/index.html, but only
 * returns an EXPLICIT pick from the brief (PRODUCT TO PITCH / Recommended agent
 * / Top solution / likely fit / Recommendation). If the brief doesn't name one,
 * we return null so the caller can fall back to prospect_reasoning / niche.
 */
const cc = require('./cold-call-script');

function cleanAgent(s) {
    return String(s || '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
}
function isJunk(v) { return !v || /^(unknown|none|n\/?a|tbd)$/i.test(v); }

// Pull the explicitly-named pitched agent out of the brief markdown. Returns a
// display name string (e.g. "Website Builder") or null.
function resolveScriptAgentName(md) {
    const src = String(md || '');

    // Kept in lockstep with agentFromScript() in sync-scripts.js. The
    // "Product (...)" form is David's newest heading; leaving it out here made
    // this module silently fall through to prospect_reasoning on 2026-07
    // scripts, which is the scoring engine's guess rather than his decision.
    let m = src.match(/(?:PRODUCT TO PITCH|Meeting product|Product\s*\([^)\r\n]*\))[^\r\n]*?:\**\s*([A-Za-z][^\r\n*|]*)/i);
    if (m) { const v = cleanAgent(m[1]); if (!isJunk(v)) return v; }

    const sec = src.match(/#{1,6}\s*Recommended STILO agent\s*\r?\n([\s\S]*?)(?=\r?\n#{1,6}\s|$)/i);
    if (sec) {
        const lines = sec[1].split(/\r?\n/);
        for (const line of lines) {
            const raw = line.replace(/^[-*]\s*/, '').replace(/[*`]/g, '').trim();
            if (!raw || /^secondary/i.test(raw)) continue;
            const pm = raw.match(/^(?:primary|lead with)\s*:\s*(.+)$/i);
            const v = cleanAgent(pm ? pm[1] : raw);
            if (!isJunk(v)) return v;
        }
    }

    let t = src.match(/\*\*Top solution[s]?:\*\*\s*([^\r\n⭐]+)/i);
    if (t) { const v = cleanAgent(t[1]); if (!isJunk(v)) return v; }

    let f = src.match(/likely fit:\s*([^\r\n]+)/i);
    if (f) { const v = cleanAgent(f[1].replace(/[·*].*$/, '')); if (!isJunk(v)) return v; }

    const rec = src.match(/#{1,6}\s*Recommendation\s*\r?\n([\s\S]*?)(?=\r?\n#{1,6}\s|$)/i);
    if (rec) {
        const pm = rec[1].replace(/[*`]/g, '').match(/primary\s*:\s*([^\r\n]+)/i);
        if (pm) { const v = cleanAgent(pm[1]); if (!isJunk(v)) return v; }
    }
    return null;
}

// Fetch the brief markdown for a lead from GCS (manifest first, then listing),
// the same source the dashboards render. Returns the markdown string or null.
async function fetchScriptMd(businessName) {
    if (!businessName) return null;
    let token;
    try { token = await cc.getAccessToken(); }
    catch (_) { return null; } // SA not configured / token failed → no script
    const slug = cc.slugify(businessName);
    if (!slug) return null;

    // 1) manifest maps business_name → exact filename.
    try {
        const raw = await cc.readObject(token, 'cold-call/manifest.json');
        const j = JSON.parse(raw);
        const scripts = Array.isArray(j) ? j : (j.scripts || []);
        const byName = {}, bySlug = {};
        for (const e of scripts) {
            if (!e || !e.filename) continue;
            if (e.business_name) byName[String(e.business_name).trim().toLowerCase()] = e;
            const base = String(e.lead_id || e.filename.replace(/-script-\d{4}-\d{2}-\d{2}\.md$/i, ''))
                .replace(/-\d{4}-\d{2}-\d{2}$/, '').toLowerCase();
            if (base) bySlug[base] = e;
        }
        const entry = byName[String(businessName).trim().toLowerCase()] || bySlug[slug];
        if (entry && entry.filename) return await cc.readObject(token, 'cold-call/' + entry.filename);
    } catch (_) { /* fall through to listing */ }

    // 2) prefix listing for <slug>...-script-<date>.md
    try {
        const item = await cc.findScriptByListing(token, slug);
        if (item) return await cc.readObject(token, item.name);
    } catch (_) { /* no script */ }

    return null;
}

// One call: resolve the pitched agent name for a lead from its brief, or null.
async function getScriptAgentName(businessName) {
    const md = await fetchScriptMd(businessName);
    if (!md) return null;
    return resolveScriptAgentName(md);
}

module.exports = { resolveScriptAgentName, fetchScriptMd, getScriptAgentName };
