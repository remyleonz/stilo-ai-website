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

// Interested Lead Flow: the follow-up email links to the prospect's NICHE VSL
// landing page (attributed) instead of a generic calendar link.
//
// 2026-08 pivot: which video they get is decided by their INDUSTRY, not by which
// agent we picked for them, because we only sell one thing now. agentKey() in
// _vsl.js resolves leads.niche / category to one of the five /vsl/<slug> pages
// and returns null when it cannot, in which case we fall back to the calendar
// link rather than mail a roofer the cleaning video.
const VSL_BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const { agentKey: nicheKey, AGENTS: VSL_NICHES } = require('./_vsl');

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
        "You are an SDR at STILO AI Partners, a Miami sales agency. We book qualified meetings with buyers onto our clients' calendars. We do NOT sell software or AI agents.",
        "Write a SHORT cold-call follow-up email to a prospect we just called. They were busy or asked us to email them.",
        "",
        "PROSPECT:",
        "- Business: " + ctx.business,
        "- Contact first name: " + (ctx.firstName || '(unknown, use \"Hi there,\")'),
        "- Industry: " + (ctx.niche || 'local business'),
        ctx.hook ? "- What we noticed: " + ctx.hook : "",
        "",
        "WHAT WE SELL: qualified meetings with their ideal customer, booked onto their calendar. Setup fee and a flat fee per qualified meeting. No retainer.",
        "THE PAIN TO NAME: " + ctx.pain,
        "",
        "RULES:",
        "- 120 to 190 words. Plain text only, no markdown, no subject line in the body.",
        "- Open by referencing that we called " + ctx.business + " today.",
        "- Name the pain in plain language, then say what we do in one line. Do NOT mention AI, agents, software, or prices.",
        "- One short line on who we are: a small Miami sales team that finds their buyers and books the meetings, paid on meetings that actually show up, no retainer.",
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
        .select('id,name,owner_name,owner_email,email,niche,category,address,deep_research_json,prospect_reasoning,matched_product_name,pitch_agent,client_id,primary_language')
        .eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ error: 'lead_read_failed', detail: error.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // ── CLIENT CAMPAIGN (content firewall) ──────────────────────────────
    // A lead in a client's pool must never receive STILO copy: no VSL, no
    // STILO calendar link, no meetings pitch. The email's one job is to CLOSE
    // the next step from the cold-call script: the showroom visit (local) or
    // the 15-minute video call with the client's owner. Deterministic
    // templates, es/en per primary_language. Blason is the only client
    // campaign today; branch on the pool, write the copy for Blason.
    if (lead.client_id) {
        const cfName = kit.firstName(lead.owner_name, lead.name, lead.address);
        const es = lead.primary_language === 'es';
        // Showroom range = Miami-Dade + Broward (zip3 330-333), same rule the
        // scripts use. Match the 5-digit zip and test its prefix; an inline
        // \b after four digits never matches a 5-digit zip (it did not, so
        // every local lead was getting the weaker video-call ask).
        const zipM = String(lead.address || '').match(/\b(\d{5})(?:-\d{4})?\b/);
        const local = !!zipM && ['330', '331', '332', '333'].indexOf(zipM[1].slice(0, 3)) !== -1;
        let cSubject, cBody;
        if (es && local) {
            cSubject = (cfName ? cfName + ', ' : '') + 'venga a ver las máquinas funcionando';
            cBody = 'Hola ' + (cfName || '') + ',\n\n'
                + 'Gracias por atender la llamada. Le escribo de parte de Blason Spa Equipment, aquí en Miami.\n\n'
                + 'Como le comenté, una máquina no se compra por una hoja de especificaciones. En el showroom de Hialeah están puestas y funcionando. Manuel, el dueño, le enseña las que le sirven para lo que usted quiere ofrecer, usted las prueba con sus propias manos, y él le explica cómo otros spas las financian.\n\n'
                + '3110 W 84th St Unit 4, Hialeah. De lunes a sábado, de 9 a 4.\n\n'
                + 'Respóndame con el día y la hora que le sirven y se lo aparto. Si esta semana le queda difícil llegar, Manuel la llama y lo hablan por teléfono.\n\n'
                + 'Cualquier pregunta, me escribe aquí.\n';
        } else if (es) {
            cSubject = (cfName ? cfName + ', ' : '') + 'una llamada con Manuel, el dueño de Blason';
            cBody = 'Hola ' + (cfName || '') + ',\n\n'
                + 'Gracias por atender la llamada. Le escribo de parte de Blason Spa Equipment, en Miami.\n\n'
                + 'El siguiente paso es hablar directo con Manuel, el dueño. Él importa el equipo, así que le dice de frente cuál máquina le sirve para lo que usted quiere ofrecer y cuál no le conviene. Sin presión y sin vueltas.\n\n'
                + 'Blason es representante directo: las piezas y el servicio salen de Miami, en español, no de un call center en otro país.\n\n'
                + 'Respóndame con dos horarios que le sirvan esta semana y se la coordino. Y si prefiere verlas en persona, el showroom está en Hialeah y vale el viaje.\n\n'
                + 'Cualquier pregunta, me escribe aquí.\n';
        } else if (local) {
            cSubject = (cfName ? cfName + ', ' : '') + 'come see the machines running';
            cBody = 'Hi ' + (cfName || 'there') + ',\n\n'
                + 'Thanks for taking the call. I\'m writing on behalf of Blason Spa Equipment here in Miami.\n\n'
                + 'Like I said on the phone, you don\'t buy one of these off a spec sheet. The showroom in Hialeah has them set up and running. Manuel, the owner, walks you through the ones that fit what you want to offer, you get your hands on them, and he explains how other spas finance them.\n\n'
                + '3110 W 84th St Unit 4, Hialeah. Monday through Saturday, 9 to 4.\n\n'
                + 'Reply with a day and time that work and I\'ll hold it for you. If getting over there is tough this week, Manuel can just call you instead.\n\n'
                + 'Any questions, reply here.\n';
        } else {
            cSubject = (cfName ? cfName + ', ' : '') + 'a call with Manuel, the owner of Blason';
            cBody = 'Hi ' + (cfName || 'there') + ',\n\n'
                + 'Thanks for taking the call. I\'m writing on behalf of Blason Spa Equipment in Miami.\n\n'
                + 'The next step is a straight conversation with Manuel, the owner. He imports the equipment himself, so he\'ll tell you which machine actually fits what you want to offer and which one isn\'t worth it for you. No pitch, no pressure.\n\n'
                + 'Blason is a direct distributor, so parts and service come out of Miami, in English or Spanish, not a call center overseas.\n\n'
                + 'Reply with two times that work this week and I\'ll set it up. And if you\'d rather put your hands on the machines, the showroom is in Hialeah and it\'s worth the trip.\n\n'
                + 'Any questions, reply here.\n';
        }
        const cSender = await kit.getSenderIdentity(gate.email);
        return res.status(200).json({
            to_email: lead.owner_email || lead.email || researchEmail(lead) || '',
            subject: cSubject,
            body: kit.sanitizeCopy(cBody),
            client_id: lead.client_id,
            client_campaign: 'Blason Spa Equipment',
            agents: [],
            sender: { name: cSender.name, phone: cSender.phone, footer: kit.clientFooterText(cSender, 'Blason Spa Equipment', es, 'blasononline.com') },
            source: 'client_campaign'
        });
    }

    const business = lead.name || 'your business';
    const niche = lead.category || '';
    const fName = kit.firstName(lead.owner_name, lead.name, lead.address);
    // Pitch the agent we're ACTUALLY selling this lead. Priority:
    //   1. body.agent      — composer dropdown override (rep picked it)
    //   2. leads.pitch_agent — THE source of truth, and the exact field the lead
    //      panel's agent chip renders (admin/index.html psResolveAgentName).
    //   3. live re-parse of David's brief from GCS
    //   4. prospect_reasoning ("product=...") then niche
    //
    // WHY pitch_agent MOVED TO THE TOP (2026-07-28): this endpoint used to skip
    // it entirely — it wasn't even in the select above — and led with a live GCS
    // re-parse whose every failure was swallowed by a bare `catch(_)`. So any
    // transient GCS hiccup, expired token, or brief whose wording the parser
    // didn't match silently dropped the email through to prospect_reasoning,
    // which is the SCORING ENGINE's guess, not David's decision. The visible
    // symptom was a lead panel showing "Website Builder" while the email
    // composer defaulted to "LCR" for the same lead: two different sources, one
    // of them failing quietly. pitch_agent is written by sync-scripts.js from
    // the same brief and refreshed when David re-pushes, so leading with it
    // makes the email agree with the screen by construction.
    //
    // The live parse is KEPT as a fallback because it reads patterns
    // agentFromScript() doesn't ("Top solutions", "likely fit", "Recommended
    // STILO agent"), so it still rescues leads whose brief never populated
    // pitch_agent. It just no longer overrides a known-good answer.
    let scriptAgentName = null;
    let agentSource = null;
    if (body.agent) {
        agentSource = 'composer_override';
    } else if (lead.pitch_agent) {
        scriptAgentName = lead.pitch_agent;
        agentSource = 'pitch_agent';
    } else {
        try {
            scriptAgentName = await scriptAgent.getScriptAgentName(lead.name);
            if (scriptAgentName) agentSource = 'script_reparse';
        } catch (e) {
            // Deliberately NOT silent. A swallowed failure here is exactly how
            // the wrong agent shipped in an email with nobody noticing.
            console.error('[draft-email] script re-parse failed for lead ' + id + ': ' + (e && e.message));
        }
        if (!scriptAgentName) agentSource = 'reasoning_or_niche_fallback';
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
    // The rep can override the niche from the modal dropdown (body.agent keeps
    // its name for wire compatibility with both dashboards); otherwise it comes
    // off the lead.
    const slug = nicheKey(body.agent) || nicheKey(lead.niche) || nicheKey(lead.category);
    const vslLink = slug
        ? VSL_BASE + '/vsl/' + slug + '?lid=' + id + '&t=' + signLead(id)
        : kit.CALENDAR_LINK;
    const source = slug ? 'vsl_template' : 'calendar_fallback';
    // Two different emails. Promising "here is a short video" and then linking a
    // calendar is worse than not mentioning video at all, so the no-niche branch
    // is written separately rather than swapping the URL inside one template.
    let draft = slug
        ? 'Hi ' + (fName || 'there') + ',\n\n'
            + 'Thanks for taking the call. Here is a short video that walks through exactly how we get '
            + business + ' more meetings with the kind of customer you actually want:\n'
            + vslLink + '\n\n'
            + 'Short version: we find every company in your area that fits, we research them, and our team '
            + 'works them across email, phone and text until the ones who are actually in the market end up '
            + 'on your calendar. You only pay for the meetings that show up.\n\n'
            + 'If it looks worth 15 minutes, you can grab a time right from that page. Any questions, just reply.\n'
        : 'Hi ' + (fName || 'there') + ',\n\n'
            + 'Thanks for taking the call. Quick version of what we do for ' + business + ': we find every '
            + 'company in your area that fits the customer you actually want, we research them, and our team '
            + 'works them across email, phone and text until the ones who are in the market end up on your '
            + 'calendar. You only pay for the meetings that show up.\n\n'
            + 'If that is worth 15 minutes, you can grab a time here:\n'
            + vslLink + '\n\n'
            + 'Any questions, just reply.\n';
    draft = kit.sanitizeCopy(draft);

    // This lands minutes after a call the prospect agreed to take, so the
    // subject's job is to be instantly recognisable, not to sell. "Quick look
    // for <business>" read like every agency blast they already ignore and
    // named the company rather than the conversation.
    //
    // It has to track the same branch the body took. Saying "the video" when
    // the no-niche branch sends a calendar link is the exact mismatch the
    // comment above the templates warns about.
    const subject = slug
        ? (fName ? fName + ', the video I mentioned' : 'The video I mentioned on our call')
        : (fName ? fName + ', following up on our call' : 'Following up on our call');

    const toEmail = lead.owner_email || lead.email || researchEmail(lead) || '';

    return res.status(200).json({
        to_email: toEmail,
        subject: subject,
        body: draft,
        variant: variant,
        variant_label: kit.variantLabel(variant),
        agent: playbook.agent,
        agent_key: kit.playbookKey(playbook),
        // Which rung of the priority ladder actually decided the agent. Surfaced
        // so a "why is this pitching LCR?" question is answerable from the
        // response instead of by reading code. 'reasoning_or_niche_fallback'
        // means we had no brief-backed answer at all for this lead.
        agent_source: agentSource,
        // The five niches, for the dropdown in the email modal. This used to list
        // the 8 sellable agents; since the pivot there is one offer, so the only
        // thing left to choose is which industry video they get.
        agents: VSL_NICHES ? Object.keys(VSL_NICHES).map(function (k) {
            return { key: k, label: VSL_NICHES[k].name };
        }) : [],
        niche_slug: slug,
        sender: { name: sender.name, phone: sender.phone, footer: kit.footerText(sender) },
        source: source
    });
};
