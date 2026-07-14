/**
 * POST /api/prospects/draft-email
 * Body: { id }
 *
 * Drafts the personalized cold-call follow-up email for a lead. This is the
 * "AI sales agent" behind the Email button in the SDR lead drawer. It pulls
 * the lead (business, owner, niche, deep research), picks the agent to lead
 * with, and asks Gemini to write a short, inviting message grounded in our
 * service catalog. Gemini is the primary drafter; a deterministic template is
 * the guaranteed fallback if the key is missing, the call errors, or it times
 * out. The booking link + sender footer are appended at SEND time.
 *
 * Returns: { to_email, subject, body, sender, agent, source }
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const kit = require('./_email_kit');
const scriptAgent = require('./_script_agent');
const { signLead } = require('../public/_token');

// Interested Lead Flow: the follow-up email links to the agent's VSL landing
// page (attributed) instead of a generic calendar link. Map the playbook key
// (from _email_kit) to the /agents/<slug> VSL page.
const VSL_BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const VSL_SLUG = { receptionist: 'receptionist', lead_response: 'lead-reply', reactivation: 'reactivation', lead_gen: 'prospecting', website: 'website', seo: 'ai-seo', growth: 'ontology', custom: 'sales-agent' };

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

// Pull a short pain/observation out of the lead's research, if David captured
// one. Used to make the Gemini prompt concrete; never shown raw.
function researchHook(r) {
    let dr = r.deep_research_json;
    if (!dr) return '';
    try { dr = typeof dr === 'string' ? JSON.parse(dr) : dr; } catch (_) { return ''; }
    const h = (dr.hook_observable || dr.pain_observable || '').trim();
    return h ? h.slice(0, 280) : '';
}

// Last-resort email: the email-finder step often lands an address in
// deep_research_json (email / owner_email) even when the structured columns are
// blank. We surface it into the composer's TO field for the rep to CONFIRM (the
// modal never auto-sends), so they aren't retyping an address research already
// found. Returns '' when nothing usable is present.
function researchEmail(r) {
    let dr = r.deep_research_json;
    if (!dr) return '';
    try { dr = typeof dr === 'string' ? JSON.parse(dr) : dr; } catch (_) { return ''; }
    const e = String(dr.owner_email || dr.email || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

async function geminiDraft(ctx) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const prompt = [
        "You are an SDR at STILO AI Partners, a Miami agency that builds and runs AI agents for local businesses.",
        "Write a SHORT cold-call follow-up email to a prospect we just called. They were busy or asked us to email them.",
        "",
        "PROSPECT:",
        "- Business: " + ctx.business,
        "- Contact first name: " + (ctx.firstName || '(unknown, use \"Hi there,\")'),
        "- Industry: " + (ctx.niche || 'local business'),
        ctx.hook ? "- What we noticed: " + ctx.hook : "",
        "",
        "LEAD WITH THIS AGENT: " + ctx.agent,
        "WHAT IT DOES: " + ctx.oneLiner,
        "THE PAIN TO NAME: " + ctx.pain,
        "",
        "RULES:",
        "- 120 to 190 words. Plain text only, no markdown, no subject line in the body.",
        "- Open by referencing that we called " + ctx.business + " today.",
        "- Name the pain in plain language, then introduce the agent at a high level. Do NOT list features or prices.",
        "- One short line on who we are: a small Miami team that designs, builds, and runs the agent for them, ROI usually inside 30 days, no long contract.",
        "- End the message with this exact line on its own, then the URL on its own line:",
        "  If it's worth a closer look, grab a 15-minute call with us here:",
        "  " + kit.CALENDAR_LINK,
        "- Sign off warm but brief. Do NOT add a signature, name, title, phone, or company footer (we append that).",
        "- Hard bans: no em dashes (use commas or periods), no exclamation points, and never use the words leverage, utilize, streamline, seamless, robust, cutting-edge, innovative, holistic.",
        "- Use contractions. Vary sentence length. Sound like a sharp human, not a brochure.",
        "",
        "Write only the email body now."
    ].filter(Boolean).join('\n');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 9000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } }
            })
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const j = await r.json();
        const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
            && j.candidates[0].content.parts && j.candidates[0].content.parts[0]
            && j.candidates[0].content.parts[0].text;
        if (!text || text.trim().length < 60) return null;
        return text.trim();
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    const sb = leadsClient();
    // NOTE: prospecting.leads has no `niche` column (only `category`). Selecting
    // a non-existent column makes PostgREST 400 and surfaced to the SDR/admin as
    // "Could not draft: lead_read_failed". Use category as the niche signal.
    const { data: lead, error } = await sb.from('leads')
        .select('id,name,owner_name,owner_email,email,category,address,deep_research_json,prospect_reasoning,matched_product_name')
        .eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ error: 'lead_read_failed', detail: error.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    const business = lead.name || 'your business';
    const niche = lead.category || '';
    const fName = kit.firstName(lead.owner_name);
    // Pitch the agent we're ACTUALLY selling this lead. Priority:
    //   1. body.agent  — composer dropdown override (rep picked it)
    //   2. the agent the cold-call SCRIPT names (David's brief "Pitch: <agent>") —
    //      the human pick the rep reads off the screen. This can DIFFER from the
    //      scoring engine (e.g. brief says Website Builder, engine says LCR), and
    //      the script wins because that's what the rep pitched.
    //   3. prospect_reasoning ("product=...") then niche.
    // Only hit GCS for the script when there's no explicit dropdown override.
    let scriptAgentName = null;
    if (!body.agent) {
        try { scriptAgentName = await scriptAgent.getScriptAgentName(lead.name); }
        catch (_) { scriptAgentName = null; }
    }
    const playbook = kit.pickPlaybookForLead({
        agentKey: body.agent,
        agentName: scriptAgentName,
        prospectReasoning: lead.prospect_reasoning || lead.matched_product_name,
        niche: niche
    });
    const sender = await kit.getSenderIdentity(gate.email);

    // A/B arm for this lead. Deterministic by lead id (even→A, odd→B) so the
    // arm is stable across re-draws and re-sends. The composer can force an arm
    // (body.variant) for previewing, but normal use leaves it auto.
    const variant = (body.variant === 'A' || body.variant === 'B') ? body.variant : kit.pickVariant(id);

    // Short VSL email (Interested Lead Flow): thank them for the call, then link
    // to the agent's VSL page. The link is attributed (?lid&t) so a booking off
    // the page ties straight to this lead. The agent switcher (body.agent) still
    // decides which VSL. Reps can switch and re-draft as before.
    const slug = VSL_SLUG[kit.playbookKey(playbook)] || 'receptionist';
    const vslLink = VSL_BASE + '/agents/' + slug + '?lid=' + id + '&t=' + signLead(id);
    const source = 'vsl_template';
    let draft = 'Hi ' + (fName || 'there') + ',\n\n'
        + 'Thanks for the call. Here is a quick 2-minute look at how the ' + playbook.agent + ' would work for ' + business + ':\n'
        + vslLink + '\n\n'
        + 'If it looks like a fit, you can grab a 15-minute call with us right from that page. Any questions, just reply.\n';
    draft = kit.sanitizeCopy(draft);

    const subject = 'Quick look for ' + business;

    const toEmail = lead.owner_email || lead.email || researchEmail(lead) || '';

    return res.status(200).json({
        to_email: toEmail,
        subject: subject,
        body: draft,
        variant: variant,
        variant_label: kit.variantLabel(variant),
        agent: playbook.agent,
        agent_key: kit.playbookKey(playbook),
        // All 8 sellable STILO agents (matches service_offerings.md). A rep can
        // pick any of these to re-draft if the call turned toward a different one.
        agents: [
            { key: 'receptionist', label: 'Receptionist' },
            { key: 'lead_response', label: 'Outbound Lead Response' },
            { key: 'reactivation', label: 'Lost Customer Reactivation' },
            { key: 'lead_gen', label: 'B2B Lead Generator' },
            { key: 'website', label: 'Website' },
            { key: 'seo', label: 'AI SEO' },
            { key: 'growth', label: 'Ontology' },
            { key: 'custom', label: 'Custom Automations' }
        ],
        sender: { name: sender.name, phone: sender.phone, footer: kit.footerText(sender) },
        source: source
    });
};
