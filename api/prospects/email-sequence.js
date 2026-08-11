/**
 * GET /api/prospects/email-sequence?dry=1&cap=N
 *
 * Drip engine for the 3-step cold email sequence to prospecting leads with a
 * scraped-and-found owner email. Modeled on the guards in vsl-campaign.js,
 * which earned them the hard way; read that file's header before touching any
 * of these.
 *
 * AUDIENCE (every condition required):
 *   - owner_email present AND email_search_status = 'found' (the new scrape)
 *   - owner_email passes a basic shape check (local@domain.tld). A malformed
 *     scrape is a guaranteed Resend 422, and 422s cost reputation.
 *   - active: archived_batch IS NULL
 *   - email_verify_status is NOT 'dead_domain' (the MX check found no mail
 *     server; those 237-odd addresses can only bounce). NULL is KEPT: most of
 *     the list was never verified, and unverified is not the same as dead.
 *   - no prior bounce on the lead or the address (lead_messages.bounced_at)
 *   - not suppressed (public.lcr_suppressions)
 *   - not a role inbox (info@/sales@/office@/... are excluded outright; they
 *     bounced at 22.3% on the VSL run and produced nothing)
 *   - only ONE lead per shared inbox. ~59 addresses are the owner_email of 2-8
 *     different leads (franchise groups, one owner with several LLCs). Mailing
 *     each one separately is how a person gets 8 cold emails from us. The
 *     smallest lead id owns the address; the rest never become eligible.
 *   - niche resolves to one of the 5 slugs via _vsl.js nicheForLead. No slug,
 *     no email; we never guess an industry.
 *
 * PERMANENT EXITS. A reply (leads.reply_received_at, or an inbound/replied row
 * in lead_messages) or a booked meeting (leads.meeting_booked_at) removes the
 * lead from the sequence forever. A human took over; the robot stands down.
 * The reply exit is ADDRESS-level as well as lead-level: if any outbound row to
 * that address has replied_at, every lead on the address stops, same as the
 * bounce rule. One human, one conversation.
 *
 * STEP TRACKING. The existing leads.email_N_sent_at / email_N_status columns.
 * Steps 2-3 are offset from the STEP 1 send (see STEP_OFFSET_DAYS); a lead
 * with email_3_sent_at is sequence-complete and the email_4_* columns are
 * unused (left in the DB, never read or written here). Following
 * the retry-loop lesson (twice burned): the sent_at stamp is written BEFORE
 * the send is attempted, so a failed send can never loop. status then records
 * 'sent' or 'failed' for the post-mortem. The stamp is also the double-send
 * lock: it's conditional on the column still being null and returns the rows
 * it touched, so two overlapping ticks can never both send the same step. And
 * dueStep refuses any lead that got ANY step in the last 24h, so a backlog can
 * never turn into two emails in one day.
 *
 * SENDING. Plain text only, no tracking pixel, via Resend.
 *
 * SENDER. Cold rides remyleon@stiloaipartners.com by established practice: all
 * 631 historical cold sends went out on it. VSL_SENDER_EMAIL is NOT set in
 * production and that is expected, not a misconfiguration; the fallback in
 * SENDER_EMAIL below is the real, intended address. If a dedicated cold mailbox
 * is ever stood up, setting VSL_SENDER_EMAIL moves cold onto it with no code
 * change. Either way it's the SAME cold-sender identity as vsl-campaign, so
 * cold reputation stays off the transactional booking address.
 * One-click List-Unsubscribe. Every send is logged to
 * prospecting.lead_messages with variant 'seq_<slug>_s<step>_c<copyArm>_f<footerArm>'
 * (the step-1 copy arm is recorded on every step so whole-sequence outcomes
 * can be segmented by the step 1 a lead received).
 *
 * SAFETY.
 *   - EMAIL_SEQUENCE_ENABLED must be exactly 'true' or nothing sends, same
 *     default-closed contract as OUTBOUND_SEND_ENABLED in _outbound.js.
 *   - ?dry=1 returns the full plan (who, step, subject) and sends nothing.
 *   - Daily cap via ?cap= (default 40, hard ceiling 150) counted off today's
 *     seq_% rows in lead_messages, plus a per-run cap so one cron tick can
 *     never blast the whole day's budget.
 *   - Weekday 12:00-15:00 ET send window. The hourly cron is a no-op outside
 *     it (dry runs still report the full plan so the board is inspectable).
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin/SDR JWT for manual runs.
 */
const crypto = require('crypto');
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { nicheForLead } = require('./_vsl');
const { COPY, NICHE_SLOTS } = require('./_email_sequence_copy');
const { signLead } = require('../public/_token');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Days after the STEP 1 send at which each later step becomes due.
const STEP_OFFSET_DAYS = { 2: 4, 3: 11 };
const DEFAULT_DAILY_CAP = 40;
const HARD_DAILY_CEILING = 150;  // a bug in ?cap= must never become a blast
const MAX_PER_RUN = 20;          // one cron tick can't spend the whole day
const WINDOW = { tz: 'America/New_York', startMin: 12 * 60, endMin: 15 * 60 };

const SEQUENCE_ENABLED = String(process.env.EMAIL_SEQUENCE_ENABLED || '').toLowerCase() === 'true';

const BASE = (process.env.PUBLIC_BASE_URL || 'https://stiloaipartners.com').replace(/\/$/, '');

// Same cold-sender identity as vsl-campaign: outreach rides its own address so
// a bad campaign cannot take the booking confirmations down with it.
const SENDER_EMAIL = process.env.VSL_SENDER_EMAIL || process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
const SENDER_NAME = process.env.VSL_SENDER_NAME || 'Remy Leon';
const REPLY_TO = process.env.VSL_REPLY_TO || process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';

// Superset of the required info@/sales@/office@/contact@/admin@/support@/hello@
// exclusions, borrowed verbatim from vsl-campaign.js.
// Broader than vsl-campaign's: dot/word suffixes (info.miami@), customer-service
// spellings, and legal/HR inboxes all surfaced in the first dry run.
const ROLE_RE = /^(info|sales|contact|admin|office|hello|support|team|mail|billing|help|service|services|reception|frontdesk|no-?reply|cs|customerservice|customer\.?care|privacy|legal|careers|jobs|hr|accounts?|ops|dispatch|estimating|estimates|quotes?)([.@_-]|@)/i;

// Deliberately loose: local@domain.tld with no whitespace and a real TLD. This
// is a garbage filter for the scraper's output ("owner@", "n/a", a phone number
// that landed in the column), not RFC 5322. Anything malformed is a certain
// Resend 422, and 422s are logged against our sending reputation.
// The local part keeps the apostrophe (o'brien@ is a real address); the domain
// does not.
const EMAIL_SHAPE_RE = /^[^\s@,;<>"]+@[^\s@,;<>"']+\.[A-Za-z]{2,}$/;

// The MX probe's verdict for "this domain has no mail server". Excluded outright.
// NULL means never probed, which is most of the list, and must stay eligible.
const DEAD_VERIFY_STATUS = 'dead_domain';

// A lead that got any step inside this window is not due for another one, no
// matter what the offsets say. Guards against a backlogged lead catching up two
// steps in a single day.
const MIN_GAP_MS = 24 * 60 * 60 * 1000;

// Audience read. PostgREST hard-caps a response at 1000 rows, so the audience
// is paged rather than asked for in one 5000-row .limit() that never happens.
const AUDIENCE_PAGE = 1000;
const AUDIENCE_MAX = 5000;

// Off-ICP categories the loose niche matcher would otherwise sweep into
// commercial-cleaning: residential maids and pool companies are not janitorial
// buyers, and mailing them the bid-list pitch reads like a mistake.
const OFF_ICP_RE = /pool|maid|house ?cleaning|carpet|pressure ?wash|car ?wash|laundry|dry ?clean/i;

// Same "is this actually a person's name" bar as vsl-campaign.js. owner_name is
// scraped and ~30% junk; a wrong name is worse than no name.
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

function cleanBusiness(name) {
    let s = String(name || '').trim();
    s = s.replace(/\s+[-–|]\s+.*$/, '');
    s = s.replace(/,\s*(FL|Florida)\b.*$/i, '');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s || null;
}

// "15979 Biscayne Blvd #4605, North Miami Beach, FL 33160" -> "North Miami Beach"
function cityFromAddress(address) {
    const parts = String(address || '').split(',').map(function (p) { return p.trim(); });
    if (parts.length < 2) return null;
    const c = parts[parts.length - 2];
    if (!c || /\d/.test(c) || c.length < 3 || c.length > 30) return null;
    return c;
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
// Merge
// ---------------------------------------------------------------------------
/**
 * Fill {{slots}} into a template. Refuses (ok:false) when any slot is left
 * unresolved, because "Hi {{first_name}}," in a real inbox is how a prospect
 * learns they are a row in a spreadsheet.
 *
 * The greeting works with no name: when values.first_name is empty, the
 * renderer collapses "Hi {{first_name}}," to "Hi," and strips the name (plus
 * its trailing comma-space) from subjects before the unresolved-slot check.
 */
function mergeAndValidate(template, values) {
    let out = String(template || '');
    if (!values.first_name) {
        out = out.replace(/Hi \{\{first_name\}\}/g, 'Hi')
                 .replace(/\{\{first_name\}\},\s*/g, '')
                 .replace(/,\s*\{\{first_name\}\}/g, '')
                 .replace(/\{\{first_name\}\}/g, '');
        out = out.trim();
        // A subject that STARTED with the name can be left capitalized oddly
        // ("quick question...") — acceptable for a subject, broken for nothing.
        if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
    }
    for (const k of Object.keys(values)) {
        if (values[k] == null || values[k] === '') continue;
        out = out.split('{{' + k + '}}').join(String(values[k]));
    }
    const leftover = out.match(/\{\{\s*[\w.-]+\s*\}\}/);
    if (leftover) return { ok: false, why: 'unresolved_slot:' + leftover[0] };
    return { ok: true, text: out };
}

function buildEmail(lead, slug, step) {
    // Step-1 copy A/B (2026-08-10), orthogonal to the footer arm below (which
    // is lead.id % 2, so id/2 keeps the two assignments independent):
    //   Q: the original step 1. Question CTA, no links.
    //   V: step1_v, same opener and hook, then the direct pay-per-meeting
    //      promise and the niche VSL link. Falls back to step1 if a niche has
    //      no step1_v yet. Steps 2-3 are identical for both arms; the arm is
    //      still logged on every step (variant _cQ/_cV) so whole-sequence
    //      outcomes can be segmented by the step 1 a lead received.
    const copyArm = Math.floor(lead.id / 2) % 2 === 0 ? 'Q' : 'V';
    let copy = COPY[slug] && COPY[slug]['step' + step];
    if (step === 1 && copyArm === 'V' && COPY[slug] && COPY[slug].step1_v) {
        copy = COPY[slug].step1_v;
    }
    if (!copy) return { ok: false, why: 'no_copy' };
    const values = Object.assign({
        first_name: firstName(lead.owner_name, lead.name, lead.address) || '',
        company: cleanBusiness(lead.name) || 'your company',
        city: cityFromAddress(lead.address) || 'your area',
    }, NICHE_SLOTS[slug] || {});
    // History-aware hook: when a rep already had this lead on the phone, the
    // step-1 hook says so instead of the generic niche line. Honest context
    // ("how I got your name") reads warmer and explains the email.
    if (['answered', 'callback', 'booked_meeting'].includes(String(lead.last_called_outcome || ''))) {
        values.hook_line = 'One of my reps called ' + values.company
            + ' a while back, which is how I got your name.';
    }
    const subject = mergeAndValidate(copy.subject, values);
    if (!subject.ok) return subject;
    const body = mergeAndValidate(copy.body, values);
    if (!body.ok) return body;
    // Per-lead VSL attribution: the copy layer only knows static /vsl/<slug>
    // URLs, so sign the lead id onto any of ours after the merge. Same token
    // scheme as vsl-campaign, so vsl_events attribute the view to this lead.
    let attributed = body.text.replace(
        /https:\/\/stiloaipartners\.com\/vsl\/([a-z-]+)/g,
        (m, s) => m + '?lid=' + lead.id + '&t=' + signLead(lead.id)
    );
    // Footer A/B (2026-08-10): arm by lead id, stable across all steps.
    //   A: "Remy Leon / Miami" everywhere (as authored, max deliverability).
    //   B: same on step 1 (link-free rule), full co-founder footer steps 2-3.
    // Scored on replies per arm via the _fA/_fB variant suffix.
    const footerArm = lead.id % 2 === 0 ? 'A' : 'B';
    if (footerArm === 'B' && step >= 2) {
        attributed = attributed.replace(/Remy Leon\nMiami\s*$/, [
            'Remy Leon',
            'Co-founder, STILO AI Partners',
            '(786) 837-6639',
            'stiloaipartners.com',
        ].join('\n'));
    }
    return { ok: true, subject: subject.text, body: attributed, footerArm: footerArm, copyArm: copyArm };
}

// ---------------------------------------------------------------------------
// Send window: weekdays 12:00-15:00 ET. Computed in ET, never server-local,
// because Vercel runs UTC (see _outbound.js windowState for the precedent).
// ---------------------------------------------------------------------------
function windowState(now) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: WINDOW.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const part of fmt.formatToParts(now || new Date())) p[part.type] = part.value;
    const minutes = Number(p.hour) * 60 + Number(p.minute);
    const weekday = ['Sat', 'Sun'].indexOf(p.weekday) === -1;
    return {
        open: weekday && minutes >= WINDOW.startMin && minutes < WINDOW.endMin,
        weekday: p.weekday, local: p.hour + ':' + p.minute + ' ET',
    };
}

// email_N_sent_at is timestamp WITHOUT time zone holding naive-UTC ISO strings
// (same convention as last_called_at). Parse as UTC explicitly.
function parseNaiveUtc(v) {
    if (!v) return null;
    const s = String(v);
    return new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
}

/**
 * Which step (if any) this lead is due for right now. Offsets anchor on the
 * step 1 send so the cadence a strategist wrote is the cadence that happens,
 * even if a middle send slipped a day.
 */
function dueStep(lead, now) {
    // Pile-up guard, checked before anything else. If ANY step went out in the
    // last 24h this lead is done for today. Without it, a lead whose step 2 was
    // sent late (say on day 10) is instantly "due" for step 3 on day 11 and
    // gets two of our emails inside 24 hours.
    for (const s of [1, 2, 3]) {
        const t = parseNaiveUtc(lead['email_' + s + '_sent_at']);
        if (t && (now - t) < MIN_GAP_MS) return null;
    }
    if (!lead.email_1_sent_at) return 1;
    if (lead.email_3_sent_at) return null; // sequence complete
    const anchor = parseNaiveUtc(lead.email_1_sent_at);
    if (!anchor) return null;
    const days = (now - anchor) / 86400000;
    for (const step of [2, 3]) {
        if (lead['email_' + step + '_sent_at']) continue;
        return days >= STEP_OFFSET_DAYS[step] ? step : null;
    }
    return null;
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
    const cap = Math.min(
        Number((req.query && req.query.cap) || process.env.EMAIL_SEQUENCE_DAILY_CAP || DEFAULT_DAILY_CAP),
        HARD_DAILY_CEILING
    );

    const now = new Date();
    const win = windowState(now);
    // Outside the window the cron tick is a no-op. Dry runs still compute the
    // plan so the board can be inspected at any hour.
    if (!win.open && !dry) {
        return res.status(200).json({ ok: true, sent: 0, note: 'send_window_closed', window: win });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // ---- audience ----------------------------------------------------------
    // Paged, and ordered by id, on purpose. PostgREST caps any single response
    // at 1000 rows no matter what .limit() asks for, so the old single-shot
    // read silently saw the first 1000 of ~2,500 eligible leads. That is
    // load-bearing for the shared-inbox rule below: "smallest lead id owns the
    // address" is only true if every lead on the address is actually in hand.
    const leads = [];
    for (let from = 0; from < AUDIENCE_MAX; from += AUDIENCE_PAGE) {
        const { data, error } = await sb.from('leads')
            .select('id,name,owner_name,owner_email,address,niche,category,assigned_to,'
                + 'last_called_outcome,'
                + 'email_1_sent_at,email_2_sent_at,email_3_sent_at')
            .eq('email_search_status', 'found')
            .not('owner_email', 'is', null)
            .is('archived_batch', null)
            .is('meeting_booked_at', null)   // permanent exit: booked
            .is('reply_received_at', null)   // permanent exit: replied
            .is('email_3_sent_at', null)     // sequence already finished
            // Dead domains (no MX) can only bounce. NULL semantics matter here:
            // PostgREST's .neq() compiles to SQL `<>`, and `NULL <> 'dead_domain'`
            // is NULL, not true, so a plain .neq would silently drop the ~1,568
            // never-probed leads along with the 239 dead ones. The explicit
            // is.null OR neq keeps unverified in and takes only the dead out.
            .or('email_verify_status.is.null,email_verify_status.neq.' + DEAD_VERIFY_STATUS)
            .order('id', { ascending: true })
            .range(from, from + AUDIENCE_PAGE - 1);
        if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
        for (const row of (data || [])) leads.push(row);
        if (!data || data.length < AUDIENCE_PAGE) break;
    }

    // Permanent exit: any inbound or replied message on the lead. A human is
    // talking to them now; the drip must never interrupt that conversation.
    const { data: replies } = await sb.from('lead_messages')
        .select('lead_id')
        .or('direction.eq.inbound,replied_at.not.is.null')
        .limit(10000);
    const repliedLeads = new Set((replies || []).map(function (r) { return r.lead_id; }));

    // ...and the same exit at the ADDRESS level, mirroring bouncedAddrs below.
    // One person can sit on several lead rows; when they reply from one, the
    // other rows must stop too, or we keep dripping at someone mid-conversation.
    const { data: repliedRows } = await sb.from('lead_messages')
        .select('to_address').not('replied_at', 'is', null).limit(10000);
    const repliedAddrs = new Set((repliedRows || [])
        .map(function (r) { return String(r.to_address || '').toLowerCase(); })
        .filter(Boolean));

    // Never re-mail a bounce, on this lead or this address.
    const { data: bounces } = await sb.from('lead_messages')
        .select('lead_id,to_address').not('bounced_at', 'is', null).limit(10000);
    const bouncedLeads = new Set((bounces || []).map(function (r) { return r.lead_id; }));
    const bouncedAddrs = new Set((bounces || []).map(function (r) { return String(r.to_address || '').toLowerCase(); }));

    const { data: sup } = await pub.from('lcr_suppressions').select('email').limit(10000);
    const suppressed = new Set((sup || []).map(function (r) { return String(r.email || '').toLowerCase(); }));

    // Daily cap: counted off today's seq_% sends in lead_messages, not a
    // counter column, so it survives re-runs and manual edits.
    const midnightEtIso = (function () {
        const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: WINDOW.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        // ET is -04:00 (EDT) or -05:00 (EST); pick whichever round-trips to 00:00.
        const hm = new Intl.DateTimeFormat('en-US', { timeZone: WINDOW.tz, hour: '2-digit', minute: '2-digit', hour12: false });
        for (const off of ['-04:00', '-05:00']) {
            const d = new Date(ymd + 'T00:00:00' + off);
            const h = hm.format(d);
            if (h === '00:00' || h === '24:00') return d.toISOString();
        }
        return new Date(ymd + 'T00:00:00-05:00').toISOString();
    })();
    const { count: sentToday } = await sb.from('lead_messages')
        .select('id', { count: 'exact', head: true })
        .like('variant', 'seq_%')
        .gte('sent_at', midnightEtIso);
    const dailyRemaining = Math.max(0, cap - (sentToday || 0));
    const budget = Math.min(dailyRemaining, MAX_PER_RUN);

    // Shared-inbox ownership, decided across the WHOLE audience before any
    // per-lead filtering: the smallest lead id on an address is the only row
    // ever allowed to mail it. ~59 addresses are shared by 2-8 leads (one owner,
    // several LLCs), and eight cold emails to one person is how a domain gets
    // reported. Computed over every fetched lead, not just the eligible ones,
    // so the owner is stable from run to run even as leads drop out.
    const inboxOwner = new Map();
    for (const l of (leads || [])) {
        const low = String(l.owner_email || '').trim().toLowerCase();
        if (!low) continue;
        const cur = inboxOwner.get(low);
        if (cur === undefined || l.id < cur) inboxOwner.set(low, l.id);
    }

    const skipped = {
        role_inbox: 0, replied: 0, bounced: 0, suppressed: 0, no_niche: 0,
        off_icp: 0, not_due: 0, dupe_inbox: 0, shared_inbox: 0, bad_email: 0, bad_merge: 0,
    };
    const seen = new Set();
    const plan = [];
    for (const l of (leads || [])) {
        if (repliedLeads.has(l.id)) { skipped.replied++; continue; }
        if (bouncedLeads.has(l.id)) { skipped.bounced++; continue; }
        const em = String(l.owner_email || '').trim();
        if (!em || !EMAIL_SHAPE_RE.test(em)) { skipped.bad_email++; continue; }
        const low = em.toLowerCase();
        // Another lead owns this inbox. Not a per-run dedupe (that's `seen`
        // below); this one is permanent, so the same lead speaks for the
        // address on every step of every run.
        if (inboxOwner.get(low) !== l.id) { skipped.shared_inbox++; continue; }
        if (ROLE_RE.test(em)) { skipped.role_inbox++; continue; }
        if (repliedAddrs.has(low)) { skipped.replied++; continue; }
        if (bouncedAddrs.has(low)) { skipped.bounced++; continue; }
        if (suppressed.has(low)) { skipped.suppressed++; continue; }
        if (OFF_ICP_RE.test(String(l.niche || '') + ' ' + String(l.category || ''))) { skipped.off_icp++; continue; }
        const slug = nicheForLead(l);
        if (!slug) { skipped.no_niche++; continue; }
        const step = dueStep(l, now);
        if (!step) { skipped.not_due++; continue; }
        if (seen.has(low)) { skipped.dupe_inbox++; continue; } // same inbox twice in one run looks like spam
        seen.add(low);
        plan.push({ lead: l, email: em, slug: slug, step: step });
    }
    // Later steps first: finishing a sequence someone is mid-way through beats
    // opening a new one. Then oldest lead id for a stable, resumable order.
    plan.sort(function (a, b) { return (b.step - a.step) || (a.lead.id - b.lead.id); });
    const batch = plan.slice(0, budget);

    const perNiche = {};
    const perStep = {};
    for (const p of plan) {
        perNiche[p.slug] = (perNiche[p.slug] || 0) + 1;
        perStep['step' + p.step] = (perStep['step' + p.step] || 0) + 1;
    }

    if (dry || !SEQUENCE_ENABLED) {
        return res.status(200).json({
            ok: true,
            dry: dry,
            send_enabled_env: SEQUENCE_ENABLED,
            note: !SEQUENCE_ENABLED ? 'EMAIL_SEQUENCE_ENABLED lock is closed; nothing sends' : undefined,
            window: win,
            cap: cap, sent_today: sentToday || 0, per_run_cap: MAX_PER_RUN, budget_this_run: budget,
            due_now: plan.length,
            due_by_niche: perNiche,
            due_by_step: perStep,
            skipped: skipped,
            would_send: batch.map(function (p) {
                const e = buildEmail(p.lead, p.slug, p.step);
                return {
                    id: p.lead.id, to: p.email, niche: p.slug, step: p.step,
                    subject: e.ok ? e.subject : null,
                    merge_error: e.ok ? undefined : e.why,
                };
            }),
        });
    }

    const results = [];
    // A send we could not log is a send we cannot count. The daily cap is read
    // back off lead_messages, so a silently failing insert makes the cap read
    // low forever and the engine keeps spending budget it already spent. One
    // failure stops the run.
    let logFailures = 0;
    let halted = null;
    for (const p of batch) {
        const l = p.lead;
        const e = buildEmail(l, p.slug, p.step);
        if (!e.ok) { skipped.bad_merge++; results.push({ id: l.id, step: p.step, ok: false, err: e.why }); continue; }

        // Stamp the attempt BEFORE evaluating the result (the retry-loop rule,
        // learned twice). A lead whose send explodes mid-flight is marked and
        // never re-attempted by the next tick; status records what happened.
        const stampCol = 'email_' + p.step + '_sent_at';
        const statusCol = 'email_' + p.step + '_status';
        const attempt = {};
        attempt[stampCol] = now.toISOString();
        attempt[statusCol] = 'sending';
        // The .is(stampCol, null) is the double-send lock, but a conditional
        // update that matches nothing is not an error, so the row count is the
        // only way to know we won it. Zero rows means a concurrent tick (or a
        // retry of this one) already claimed this step: do not send.
        const { data: stamped, error: stampErr } = await sb.from('leads')
            .update(attempt).eq('id', l.id).is(stampCol, null).select('id');
        if (stampErr) { results.push({ id: l.id, step: p.step, ok: false, err: 'stamp_failed:' + stampErr.message }); continue; }
        if (!stamped || !stamped.length) {
            results.push({ id: l.id, step: p.step, ok: false, err: 'already_stamped' });
            continue;
        }

        const r = await sendEmail(p.email, e.subject, e.body);

        const outcome = {};
        outcome[statusCol] = r.ok ? 'sent' : 'failed';
        await sb.from('leads').update(outcome).eq('id', l.id);

        let logErrMsg = null;
        if (r.ok) {
            const { error: logErr } = await sb.from('lead_messages').insert({
                lead_id: l.id, direction: 'outbound', channel: 'email',
                subject: e.subject, body: e.body, body_preview: e.body.slice(0, 180),
                to_address: p.email, from_address: SENDER_EMAIL,
                provider: 'resend', provider_message_id: r.id || null,
                status: 'sent',
                sent_by: l.assigned_to || null,
                variant: 'seq_' + p.slug + '_s' + p.step + '_c' + (e.copyArm || 'Q') + '_f' + (e.footerArm || 'A'),
                sent_at: new Date().toISOString(),
            });
            if (logErr) {
                logFailures++;
                logErrMsg = logErr.message;
                console.error('[email-sequence] lead_messages insert FAILED, halting run:', l.id, logErr.message);
            }
        }
        results.push({ id: l.id, to: p.email, niche: p.slug, step: p.step, ok: r.ok, err: r.err, log_error: logErrMsg || undefined });

        // The email went out but the ledger did not record it. Stop here: every
        // further send would be spending a budget we can no longer measure.
        if (logErrMsg) { halted = 'lead_message_insert_failed'; break; }
    }

    const sent = results.filter(function (r) { return r.ok; }).length;
    return res.status(200).json({
        ok: true, window: win, cap: cap, budget_this_run: budget,
        sent: sent, failed: results.length - sent,
        log_failures: logFailures,
        halted: halted || undefined,
        due_by_niche: perNiche, due_by_step: perStep, skipped: skipped,
        remaining_due: plan.length - batch.length,
        results: results,
    });
};

// Up to 20 sequential Resend round-trips plus their DB writes per tick. The
// 10s default kills the run mid-batch, which is survivable (stamps are written
// first) but wastes the day's budget.
module.exports.maxDuration = 60;
