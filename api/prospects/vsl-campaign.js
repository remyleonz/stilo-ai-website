/**
 * GET /api/prospects/vsl-campaign?audience=warm|cold&dry=1&cap=N
 *
 * Sends the VSL link. Two audiences, and the default changed on 2026-07-15.
 *
 * WHY WARM IS NOW THE DEFAULT
 * ---------------------------
 * The cold blast ran once (100 sends, 91 delivered, 2026-07-15) and the result
 * was unambiguous:
 *   - 16 leads "loaded" the page, but 4 of them fired 9-11 DIFFERENT user agents
 *     and 12 loaded 2-4 times inside 30 seconds. That is mail-security scanners
 *     following the link on delivery, not buyers.
 *   - ZERO of those 16 pressed play. Not one.
 * A 17% click rate on cold email would be 5x world-class; the giveaway that it
 * wasn't real is that nobody watched. Cold delivered nothing.
 *
 * Meanwhile the only booking this page has ever produced came from a lead who had
 * a 308-second phone call with a rep two weeks earlier. He opened the page and
 * booked 52 seconds later. The video closes people who already spoke to a human
 * and does nothing for strangers, so we mail the people who spoke to a human.
 *
 * Deliberate choices, do not "optimise" these away:
 *
 *  - EMAIL ONLY, NO SMS. Bulk unsolicited SMS from the reps' Quo lines would get
 *    those numbers carrier-flagged, and the reps' lines ARE the cold-call business.
 *  - PLAIN TEXT, NO TRACKING PIXEL. An open pixel lands cold mail in Promotions,
 *    and post Apple Mail Privacy Protection the "opens" it buys are mostly fake
 *    anyway (Apple pre-fetches every image). The VSL link carries ?lid, so a click
 *    still attributes. We trade junk telemetry for the Primary inbox.
 *  - NO ROLE INBOXES, EVER. info@/sales@/office@ bounced at 22.3% across 103 sends
 *    and produced 1 open and 0 replies. They are pure deliverability damage with
 *    no upside, so they are excluded rather than merely deprioritised.
 *  - NEVER RE-MAIL A BOUNCE. Any address with a prior bounce on this lead is
 *    skipped permanently.
 *  - Honors public.lcr_suppressions and sends a one-click List-Unsubscribe.
 *    Skipping either is a CAN-SPAM problem, not a style preference.
 *
 * Idempotency: a lead_messages row with variant vsl_warm_a / vsl_warm_b (or
 * vsl_campaign for the legacy cold run). No migration.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin JWT for manual runs.
 */
const crypto = require('crypto');
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { signLead } = require('../public/_token');

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');
const REPS = [
    'aleb1027@gmail.com',
    'huronfire5@gmail.com',
    'ayesjorge911@gmail.com',
    'georgegutierrez446@gmail.com',
    'remyleon@stiloaipartners.com',
];
// Excluded outright, not sorted last. See the header note.
const ROLE_RE = /^(info|sales|contact|admin|office|hello|support|team|mail|billing|help|service|reception|frontdesk|no-?reply)@/i;

// Outreach rides its own sender identity so a bad campaign cannot take the
// booking confirmations down with it. Set VSL_SENDER_EMAIL to an address on a
// SEPARATE domain (not a subdomain of the transactional one) once DNS is up.
// Until then it falls back to the current sender and nothing changes.
const SENDER_EMAIL = process.env.VSL_SENDER_EMAIL || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
const SENDER_NAME = process.env.VSL_SENDER_NAME || 'Remy Leon';
const REPLY_TO = process.env.VSL_REPLY_TO || process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

// One line per agent, in the prospect's language, not ours.
const PITCH = {
    'receptionist': 'answers your phone at 8pm and books the job instead of taking a message',
    'lead-reply': 'replies to a new lead within 5 minutes, before they call the next guy',
    'reactivation': 'goes through your old customers and gets the ones who are overdue back in',
    'b2bleadgen': 'builds you a list of local businesses that actually need what you sell',
    'website': 'rebuilds your site so it books work instead of just sitting there',
    'sales-agent': 'coaches your reps off their own call recordings',
};

// ai-seo and ontology were retired 2026-07-15 (never filmed, now redirected in
// vercel.json). Anything that used to route there falls through to receptionist
// rather than mailing a prospect a link that bounces them to the homepage.
function slugFor(name) {
    const s = String(name || '').toLowerCase();
    if (/recept/.test(s)) return 'receptionist';
    if (/reactiv|lcr|lost customer/.test(s)) return 'reactivation';
    if (/lead reply|lead response|outbound|instant lead/.test(s)) return 'lead-reply';
    if (/lead gen|b2b|prospect|scout/.test(s)) return 'b2bleadgen';
    if (/website|web build/.test(s)) return 'website';
    if (/sales coach|coach|sales agent|pitch/.test(s)) return 'sales-agent';
    return 'receptionist';
}

// owner_name is scraped and only ~70% real names. The rest is cities
// ("Hallandale Beach"), business names ("Brakes Complete", "Affinity
// Construction") and junk ("Program", "Executives"). A dry run of this campaign
// produced "Hi Program," and "Hi Executives,". A wrong name is worse than no
// name: it is an instant spam-complaint and it tells the reader we scraped them.
// So the bar is high and the fallback ("Hi,") is always safe.
const NOT_A_NAME = new RegExp('^(' + [
    'program', 'programs', 'executive', 'executives', 'team', 'teams', 'alert', 'alerts',
    'system', 'systems', 'group', 'inc', 'llc', 'corp', 'company', 'co',
    'complete', 'construction', 'service', 'services', 'auto', 'realty', 'realtors',
    'office', 'sales', 'info', 'contact', 'admin', 'support', 'billing',
    'manager', 'owner', 'president', 'ceo', 'director', 'department', 'dept',
    'main', 'front', 'desk', 'customer', 'client', 'new', 'the', 'best', 'top',
    'north', 'south', 'east', 'west', 'beach', 'harbour', 'harbor', 'park',
    'miami', 'florida', 'doral', 'hialeah', 'brickell', 'kendall', 'aventura',
].join('|') + ')$', 'i');

function firstName(ownerName, business, address) {
    const raw = String(ownerName || '').trim();
    if (!raw) return null;
    const first = raw.split(/\s+/)[0];
    if (!first || first.length < 2 || first.length > 20) return null;
    if (!/^[A-Za-z][A-Za-z'’.-]+$/.test(first)) return null;
    if (NOT_A_NAME.test(first)) return null;
    const f = first.toLowerCase();
    if (String(business || '').toLowerCase().includes(f)) return null;
    if (String(address || '').toLowerCase().includes(f)) return null;
    return first;
}

// Scraped business names carry location/category tails:
// "Melissa Carbonell Group - Fort Lauderdale, FL Real Estate".
function cleanBusiness(name) {
    let s = String(name || '').trim();
    s = s.replace(/\s+[-–|]\s+.*$/, '');
    s = s.replace(/,\s*(FL|Florida)\b.*$/i, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || null;
}
function b64url(s) {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = b64url(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }));
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}

// ---------------------------------------------------------------------------
// COPY
//
// The A/B axis is the ASK, not the wording. 371 emails have produced 0 replies,
// so the thing to test is whether we are asking for the wrong action, not whether
// a synonym lands better.
//
//   A (watch): the current ask. Here is the video, watch it or don't.
//   B (reply): no video ask at all. One concrete question they can answer in
//              four words. The link is a P.S., not the CTA.
//
// Both are true to the warm audience: we HAVE spoken to these people, so the
// call reference is honest (it was a lie for the cold list, which is why the
// cold copy never mentioned it).
// ---------------------------------------------------------------------------
// The sender IS Remy, so "You spoke with Remy Leon" signed "Remy Leon" reads like
// a mail merge that forgot who it was. Say "We spoke" when the rep was Remy.
function callRef(repName) {
    const rep = String(repName || '').trim();
    if (!rep) return 'We spoke a little while back';
    if (/^remy\b/i.test(rep) || rep === SENDER_NAME) return 'We spoke a little while back';
    return 'You spoke with ' + rep.split(/\s+/)[0] + ' on my team a little while back';
}

function warmEmailA(lead, slug, link, repName) {
    const first = firstName(lead.owner_name, lead.name, lead.address);
    const pitch = PITCH[slug] || PITCH['receptionist'];
    const body = [
        first ? 'Hi ' + first + ',' : 'Hi,',
        '',
        callRef(repName) + ' about the agent that ' + pitch + '.',
        '',
        'Never sent you the 2-minute version. Here it is:',
        link,
        '',
        'Booking link is on that page if you want it. If the timing is wrong, ignore this.',
        '',
        'Remy Leon',
        'STILO AI Partners',
    ].join('\n');
    const business = cleanBusiness(lead.name);
    return {
        subject: first ? (first + ', the 2-minute version') : 'The 2-minute version' + (business ? ' for ' + business : ''),
        text: body,
    };
}
function warmEmailB(lead, slug, link, repName) {
    const first = firstName(lead.owner_name, lead.name, lead.address);
    const ASK = {
        'receptionist': 'Roughly how many calls a week ring out when the team is busy?',
        'lead-reply': 'When a new lead comes in, how long before someone actually calls them back?',
        'reactivation': 'Roughly how many past customers are overdue to come back in?',
        'b2bleadgen': 'How are you finding new accounts right now, referrals or outbound?',
        'website': 'Is your site actually booking work, or just sitting there?',
        'sales-agent': 'Are you recording your reps\' calls right now?',
    };
    const ask = ASK[slug] || ASK['receptionist'];
    const body = [
        first ? 'Hi ' + first + ',' : 'Hi,',
        '',
        callRef(repName) + '. One question I never got an answer to:',
        '',
        ask,
        '',
        'Genuinely just curious what the number is. A one-line reply is plenty.',
        '',
        'Remy Leon',
        'STILO AI Partners',
        '',
        'P.S. If you would rather just watch it than type: ' + link,
    ].join('\n');
    return { subject: first ? (first + ', one question') : 'One question', text: body };
}

async function sendEmail(to, subject, text) {
    const t = unsubToken(to);
    const headers = t ? {
        'List-Unsubscribe': '<' + BASE + '/api/unsubscribe?t=' + t + '>, <mailto:' + REPLY_TO + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: SENDER_NAME + ' <' + SENDER_EMAIL + '>',
            to: [to],
            reply_to: REPLY_TO,
            subject: subject,
            text: text, // plain text only: no html part, no pixel
            headers: headers,
        }),
    });
    const j = await r.json().catch(function () { return {}; });
    return { ok: r.ok, status: r.status, id: j.id, err: r.ok ? null : (j.message || 'send_failed') };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'resend_not_configured' });

    const dry = String((req.query && req.query.dry) || '') === '1';
    const audience = String((req.query && req.query.audience) || 'warm').toLowerCase() === 'cold' ? 'cold' : 'warm';
    const cap = Math.min(
        Number((req.query && req.query.cap) || process.env.VSL_CAMPAIGN_DAILY_CAP || 100),
        250 // hard ceiling: a bug in the cap must never become a 561-email blast
    );

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // ---- audience -----------------------------------------------------------
    // warm: anyone a rep actually held a 60s+ conversation with. That is the only
    // audience the video has ever worked on.
    let warmIds = null, repByLead = {};
    if (audience === 'warm') {
        const { data: calls, error: cErr } = await sb.from('lead_calls')
            .select('lead_id,logged_by,duration_seconds,direction')
            .gte('duration_seconds', 60).limit(20000);
        if (cErr) return res.status(500).json({ error: 'calls_read_failed', detail: cErr.message });
        const ids = new Set();
        for (const c of (calls || [])) {
            if (!c.lead_id) continue;
            if (['outbound', 'outgoing'].indexOf(String(c.direction || '')) === -1) continue;
            ids.add(c.lead_id);
            if (c.logged_by && !repByLead[c.lead_id]) repByLead[c.lead_id] = c.logged_by;
        }
        warmIds = Array.from(ids);
        if (!warmIds.length) return res.status(200).json({ ok: true, audience: audience, sent: 0, note: 'no 60s+ conversations found' });
    }

    let q = sb.from('leads')
        .select('id,name,owner_name,owner_email,email,address,matched_product_name,stage,assigned_to')
        .not('stage', 'in', '("MEETING_BOOKED","CLOSED_LOST","CLIENT","DNC")')
        .is('meeting_booked_at', null);
    if (audience === 'warm') q = q.in('id', warmIds);
    else q = q.eq('has_cold_call_script', true).in('assigned_to', REPS);

    const { data: leads, error } = await q.limit(5000);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    // Already sent any VSL (either audience) -> never send a second one.
    const { data: already } = await sb.from('lead_messages')
        .select('lead_id').in('variant', ['vsl_campaign', 'vsl_warm_a', 'vsl_warm_b']).limit(10000);
    const done = new Set((already || []).map(function (r) { return r.lead_id; }));

    // Any prior bounce on this lead -> the address is bad, never retry it.
    const { data: bounces } = await sb.from('lead_messages')
        .select('lead_id,to_address').not('bounced_at', 'is', null).limit(10000);
    const bouncedLeads = new Set((bounces || []).map(function (r) { return r.lead_id; }));
    const bouncedAddrs = new Set((bounces || []).map(function (r) { return String(r.to_address || '').toLowerCase(); }));

    const { data: sup } = await pub.from('lcr_suppressions').select('email').limit(10000);
    const suppressed = new Set((sup || []).map(function (r) { return String(r.email || '').toLowerCase(); }));

    // Rep display names, so the warm copy can say who they actually talked to.
    const roster = {};
    try {
        const { data: sdrs } = await pub.from('sdr_users').select('email,display_name');
        (sdrs || []).forEach(function (s) { if (s.email) roster[s.email.toLowerCase()] = s.display_name; });
    } catch (_) { /* copy falls back to "someone on my team" */ }

    const skipped = { role_inbox: 0, no_email: 0, already_sent: 0, bounced: 0, suppressed: 0, dupe_inbox: 0 };
    const seen = new Set();
    const pool = [];
    for (const l of (leads || [])) {
        if (done.has(l.id)) { skipped.already_sent++; continue; }
        if (bouncedLeads.has(l.id)) { skipped.bounced++; continue; }
        const em = (l.owner_email || l.email || '').trim();
        if (!em || em.indexOf('@') === -1) { skipped.no_email++; continue; }
        const low = em.toLowerCase();
        if (ROLE_RE.test(em)) { skipped.role_inbox++; continue; }
        if (bouncedAddrs.has(low)) { skipped.bounced++; continue; }
        if (suppressed.has(low)) { skipped.suppressed++; continue; }
        if (seen.has(low)) { skipped.dupe_inbox++; continue; } // same inbox twice in one run looks like spam
        seen.add(low);
        pool.push({ lead: l, email: em, rep: roster[String(repByLead[l.id] || '').toLowerCase()] || null });
    }
    pool.sort(function (a, b) { return a.lead.id - b.lead.id; });
    const batch = pool.slice(0, cap);

    // Deterministic 50/50 split on lead id: a re-run can't reshuffle an arm.
    const buildFor = function (item) {
        const l = item.lead;
        const slug = slugFor(l.matched_product_name);
        const link = BASE + '/agents/' + slug + '?lid=' + l.id + '&t=' + signLead(l.id);
        const arm = (l.id % 2 === 0) ? 'A' : 'B';
        const built = audience === 'warm'
            ? (arm === 'A' ? warmEmailA(l, slug, link, item.rep) : warmEmailB(l, slug, link, item.rep))
            : warmEmailA(l, slug, link, item.rep);
        return { slug: slug, link: link, arm: arm, subject: built.subject, text: built.text };
    };

    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, audience: audience, cap: cap,
            remaining_in_pool: pool.length,
            would_send: batch.length,
            skipped: skipped,
            arm_split: { A: batch.filter(b => b.lead.id % 2 === 0).length, B: batch.filter(b => b.lead.id % 2 !== 0).length },
            sample: batch.slice(0, 4).map(function (b) {
                const e = buildFor(b);
                return { id: b.lead.id, to: b.email, slug: e.slug, arm: e.arm, subject: e.subject, text: e.text };
            }),
        });
    }

    const results = [];
    for (const item of batch) {
        const l = item.lead;
        const e = buildFor(item);
        const r = await sendEmail(item.email, e.subject, e.text);

        if (r.ok) {
            // variant is the idempotency marker AND the A/B arm. Written only on a
            // real send, so a failure retries tomorrow instead of vanishing.
            await sb.from('lead_messages').insert({
                lead_id: l.id, direction: 'outbound', channel: 'email',
                subject: e.subject, body: e.text, body_preview: e.text.slice(0, 180),
                to_address: item.email, from_address: SENDER_EMAIL,
                provider: 'resend', provider_message_id: r.id || null,
                status: 'sent',
                // Attribute the auto send to the lead's owning rep so it shows on
                // their Emailed tab (the rep "sends" it, even though a cron fires it).
                sent_by: l.assigned_to || null,
                variant: audience === 'warm' ? ('vsl_warm_' + e.arm.toLowerCase()) : 'vsl_campaign',
                sent_at: new Date().toISOString(),
            });
            await sb.from('leads').update({ nurture_stage: 'vsl_sent', updated_at: new Date().toISOString() }).eq('id', l.id);
        }
        results.push({ id: l.id, to: item.email, slug: e.slug, arm: e.arm, ok: r.ok, err: r.err });
    }

    const sent = results.filter(function (r) { return r.ok; }).length;
    return res.status(200).json({
        ok: true, audience: audience, cap: cap, sent: sent, failed: results.length - sent,
        skipped: skipped,
        remaining_after_run: pool.length - sent,
        results: results,
    });
};
