/**
 * GET /api/prospects/vsl-campaign   (Vercel cron, daily)
 *
 * Cold VSL campaign to the reps' callable-lead backlog. Sends a short
 * plain-text email with the lead's attributed VSL link, capped at
 * VSL_CAMPAIGN_DAILY_CAP (default 100) per run so we walk the list over days
 * instead of blasting it.
 *
 * Deliberate choices, do not "optimise" these away:
 *
 *  - EMAIL ONLY, NO SMS. These leads never opted in. Bulk unsolicited SMS from
 *    the reps' Quo lines would get those numbers carrier-flagged, and the reps'
 *    lines ARE the cold-call business. Not worth a few meetings.
 *  - PLAIN TEXT, NO TRACKING PIXEL. Cold mail with an open-tracker lands in
 *    Promotions or spam. The VSL link carries ?lid so a click still attributes
 *    on the landing page. We trade open-rate telemetry for the Primary inbox.
 *  - NOT the "Interested Lead" copy. That template opens "Thanks for the call."
 *    ~790 of these leads have never been dialed, so that line is a lie and earns
 *    a spam complaint. This copy assumes no prior contact.
 *  - Personal addresses before generic ones. info@/sales@ inboxes convert near
 *    zero and bounce hardest, so they go last and we can stop if bounces spike.
 *  - Honors public.lcr_suppressions and sends a one-click List-Unsubscribe.
 *    Skipping either is a CAN-SPAM problem, not a style preference.
 *
 * Idempotency: a lead_messages row with variant='vsl_campaign'. No migration.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin JWT for manual runs.
 * ?dry=1 previews the batch without sending. ?cap=N overrides the cap.
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
    'remyleon@stiloaipartners.com',
];
const GENERIC_RE = /^(info|sales|contact|admin|office|hello|support|team|mail)@/i;

// One line per agent, in the prospect's language, not ours. This is the only
// thing in the email that has to earn the click.
const PITCH = {
    'receptionist': 'answers your phone at 8pm and books the job instead of taking a message',
    'lead-reply': 'replies to a new lead within 5 minutes, before they call the next guy',
    'reactivation': 'goes through your old customers and gets the ones who are overdue back in',
    'prospecting': 'builds you a list of local businesses that actually need what you sell',
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
    if (/lead gen|b2b|prospect|scout/.test(s)) return 'prospecting';
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
    // Letters only. Kills "24/7", "A-1", emails, phone fragments.
    if (!/^[A-Za-z][A-Za-z'’.-]+$/.test(first)) return null;
    if (NOT_A_NAME.test(first)) return null;
    const f = first.toLowerCase();
    // If the token also appears in the business name or the street address, it
    // is almost certainly the business or a city, not a person. This also drops
    // legitimate owner-named businesses ("Antonio Perez" of "Antonio Perez CPA"),
    // which is a fine trade: we lose a greeting, we never send a wrong one.
    if (String(business || '').toLowerCase().includes(f)) return null;
    if (String(address || '').toLowerCase().includes(f)) return null;
    return first;
}

// Scraped business names carry location/category tails:
// "Melissa Carbonell Group - Fort Lauderdale, FL Real Estate".
function cleanBusiness(name) {
    let s = String(name || '').trim();
    s = s.replace(/\s+[-–|]\s+.*$/, '');   // drop everything after " - "
    s = s.replace(/,\s*(FL|Florida)\b.*$/i, ''); // drop ", FL ..." tails
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

function buildEmail(lead, slug, link) {
    const business = cleanBusiness(lead.name);
    const first = firstName(lead.owner_name, lead.name, lead.address);
    const pitch = PITCH[slug] || PITCH['receptionist'];
    const body = [
        first ? 'Hi ' + first + ',' : 'Hi,',
        '',
        'I run a small AI agency here in Miami. We build the agent that ' + pitch + '.',
        '',
        'Not going to pitch you on a call. Here is a 2-minute look, watch it or do not:',
        link,
        '',
        'If it is useful there is a booking link on that page. If not, no hard feelings.',
        '',
        'Remy Leon',
        'STILO AI Partners',
        BASE.replace(/^https?:\/\//, ''),
    ].join('\n');
    // Only put the business name in the subject if it survived cleaning.
    const topic = business ? '2 minutes on ' + business : '2 minutes, for your shop';
    const subject = first ? first + ', ' + topic : topic;
    return { subject: subject, text: body };
}

async function sendEmail(to, subject, text) {
    const t = unsubToken(to);
    const headers = t ? {
        'List-Unsubscribe': '<' + BASE + '/api/unsubscribe?t=' + t + '>, <mailto:' + (process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com') + '?subject=unsubscribe>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: 'Remy Leon <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>',
            to: [to],
            reply_to: process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com',
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
    const cap = Math.min(
        Number((req.query && req.query.cap) || process.env.VSL_CAMPAIGN_DAILY_CAP || 100),
        250 // hard ceiling: a bug in the cap must never become a 561-email blast
    );

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // Candidates: scripted + assigned to one of the four reps + has an email.
    // Skip anyone already in a real conversation (a booked meeting or a closed
    // deal doesn't want a cold intro) and anyone we've already campaigned.
    // meeting_booked_at, not just stage: stage lags the booking (it stayed 'NEW'
    // on a lead who had booked the day before), and this copy opens by assuming
    // no prior contact. Sending "here is a 2-minute look, no pitch" to someone
    // who already has a call on the calendar with us reads as a bad mailing list.
    const { data: leads, error } = await sb.from('leads')
        .select('id,name,owner_name,owner_email,email,address,matched_product_name,stage')
        .eq('has_cold_call_script', true)
        .in('assigned_to', REPS)
        .not('stage', 'in', '("MEETING_BOOKED","CLOSED_LOST","CLIENT","DNC")')
        .is('meeting_booked_at', null)
        .limit(2000);
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });

    const { data: already } = await sb.from('lead_messages')
        .select('lead_id').eq('variant', 'vsl_campaign').limit(5000);
    const done = new Set((already || []).map(function (r) { return r.lead_id; }));

    const { data: sup } = await pub.from('lcr_suppressions').select('email').limit(5000);
    const suppressed = new Set((sup || []).map(function (r) { return String(r.email || '').toLowerCase(); }));

    const seen = new Set();
    const pool = [];
    for (const l of (leads || [])) {
        if (done.has(l.id)) continue;
        const em = (l.owner_email || l.email || '').trim();
        if (!em || em.indexOf('@') === -1) continue;
        const low = em.toLowerCase();
        if (suppressed.has(low)) continue;
        if (seen.has(low)) continue; // same inbox twice in one run looks like spam
        seen.add(low);
        pool.push({ lead: l, email: em, generic: GENERIC_RE.test(em) });
    }

    // Personal first, then generic. Stable by id inside each group.
    pool.sort(function (a, b) {
        if (a.generic !== b.generic) return a.generic ? 1 : -1;
        return a.lead.id - b.lead.id;
    });

    const batch = pool.slice(0, cap);

    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, cap: cap,
            remaining_in_pool: pool.length,
            would_send: batch.length,
            personal: batch.filter(function (b) { return !b.generic; }).length,
            generic: batch.filter(function (b) { return b.generic; }).length,
            sample: batch.slice(0, 5).map(function (b) {
                const slug = slugFor(b.lead.matched_product_name);
                const link = BASE + '/agents/' + slug + '?lid=' + b.lead.id + '&t=' + signLead(b.lead.id);
                const e = buildEmail(b.lead, slug, link);
                return { id: b.lead.id, to: b.email, slug: slug, subject: e.subject, text: e.text };
            }),
        });
    }

    const results = [];
    for (const item of batch) {
        const l = item.lead;
        const slug = slugFor(l.matched_product_name);
        const link = BASE + '/agents/' + slug + '?lid=' + l.id + '&t=' + signLead(l.id);
        const { subject, text } = buildEmail(l, slug, link);
        const r = await sendEmail(item.email, subject, text);

        if (r.ok) {
            // variant='vsl_campaign' is the idempotency marker. Written only on
            // a real send, so a failure retries tomorrow instead of vanishing.
            await sb.from('lead_messages').insert({
                lead_id: l.id, direction: 'outbound', channel: 'email',
                subject: subject, body: text, body_preview: text.slice(0, 180),
                to_address: item.email,
                from_address: process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com',
                provider: 'resend', provider_message_id: r.id || null,
                status: 'sent', variant: 'vsl_campaign', sent_at: new Date().toISOString(),
            });
            await sb.from('leads').update({ nurture_stage: 'vsl_sent', updated_at: new Date().toISOString() }).eq('id', l.id);
        }
        results.push({ id: l.id, to: item.email, slug: slug, ok: r.ok, err: r.err });
    }

    const sent = results.filter(function (r) { return r.ok; }).length;
    return res.status(200).json({
        ok: true, cap: cap, sent: sent, failed: results.length - sent,
        remaining_after_run: pool.length - sent,
        results: results,
    });
};
