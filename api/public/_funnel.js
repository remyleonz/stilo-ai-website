/**
 * Shared pieces for the client VSL landing-page funnel (first site: Blason).
 *
 *   /blason                      the page (sites/stilo-ai/blason/index.html)
 *   POST /api/public/funnel-event   every click, step and play -> public.funnel_events
 *   POST /api/public/funnel-lead    contact form -> prospecting.leads (client pool) + funnel_submissions
 *   GET  /api/public/blason-slots   Mon to Fri 9 to 4 ET, Remy's calendar free/busy
 *   POST /api/public/blason-book    10-minute call with Manuel or a showroom visit
 *   GET  /api/admin/clients/funnel  the numbers + the call list (admin only)
 *
 * Identity model. A visitor is a session_id (one tab) and a visitor_id
 * (localStorage, survives return visits). A LEAD is attached only when the URL
 * carried a valid signed ?lid=&t= (api/public/_token.js, the same token the
 * email sender puts on the link) or after the visitor submitted the form. A bare
 * lid without a valid token is never trusted: anyone can type a number in a URL.
 *
 * Phone rule. 95% of leads store owner_phone as "(305) 541-5999" while webhooks
 * normalise to E.164, so matching checks both shapes, same as
 * api/openphone/webhook.js matchLeadByPhone. New leads get BOTH columns.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { signLead, verifyLead } = require('./_token');

const SITES = {
    blason: {
        client_id: '2efae6bf-69d8-4c4d-ac25-6a693db50f8b',
        name: 'Blason Spa Equipment',
        agent: 'blason',            // vsl_events.agent for the dual-write
        lead_source: 'blason_vsl',
    },
};

// Everything the page emits. Anything else is noise or someone poking the
// endpoint and is dropped, not written.
const EVENTS = [
    'page_view', 'cta_click', 'video_play', 'video_progress', 'video_complete',
    'quiz_start', 'quiz_step', 'quiz_complete', 'contact_view', 'contact_submitted',
    'calendar_open', 'booking_confirmed', 'lang_switch',
];

const MAX_BODY_BYTES = 8192;

// Lowercased substrings that mean "not a prospect in a browser". Same list the
// VSL watch alert uses, trimmed. 'preview' catches link-preview fetchers.
const BOT_UA = [
    'headlesschrome', 'claude', 'electron', 'phantomjs', 'puppeteer', 'playwright',
    'googleimageproxy', 'yahoomailproxy', 'ggpht.com', 'mailproxy', 'proxy',
    'bot', 'crawler', 'spider', 'preview', 'scanner', 'monitor',
    'curl', 'wget', 'python-requests', 'python-urllib', 'go-http-client',
    'okhttp', 'java/', 'axios', 'node-fetch', 'apache-httpclient',
    'microsoft office', 'ms-office', 'outlook', 'barracuda', 'proofpoint',
    'mimecast', 'symantec', 'forcepoint', 'slackbot', 'facebookexternalhit',
    'whatsapp', 'telegrambot', 'twitterbot', 'discordbot', 'skypeuripreview',
];
function botReason(ua) {
    const s = String(ua || '').toLowerCase().trim();
    if (!s) return 'no user agent';
    if (s.length < 24 || !/(applewebkit|gecko|trident|khtml|edge|firefox)/.test(s)) return 'stub user agent';
    const hit = BOT_UA.find(function (b) { return s.indexOf(b) !== -1; });
    return hit ? 'bot user agent (' + hit + ')' : null;
}

function sbPublic() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
function sbProspecting() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
}
function configured() { return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY); }

async function readJsonBody(req, maxBytes) {
    const cap = maxBytes || MAX_BODY_BYTES;
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > cap) return { error: 'body_too_large' };
    // sendBeacon posts text/plain, so Vercel leaves req.body as a string. Parse both.
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; } }
    const chunks = []; let total = 0;
    for await (const c of req) {
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        total += buf.length;
        if (total > cap) return { error: 'body_too_large' };
        chunks.push(buf);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}

function str(v, n) { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, n || 200) : null; }
function intOrNull(v) { return v != null && /^\d+$/.test(String(v)) ? parseInt(String(v), 10) : null; }

function ipOf(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
}
// Never store the raw IP. A daily salt means the same IP hashes the same within
// a day (dedupe) and differently tomorrow (no long-term fingerprint).
function ipHash(req) {
    const ip = ipOf(req);
    if (!ip) return null;
    const salt = (process.env.SUPABASE_SERVICE_KEY || 'x').slice(0, 16) + new Date().toISOString().slice(0, 10);
    return crypto.createHash('sha1').update(ip + '|' + salt).digest('hex').slice(0, 24);
}

/** US number -> "+1XXXXXXXXXX" or null. */
function normalizePhone(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return null;
}
/** "+13055415999" -> "(305) 541-5999", the shape 95% of the leads table uses. */
function phoneDisplay(e164) {
    const d = String(e164 || '').replace(/\D/g, '');
    const t = d.length === 11 ? d.slice(1) : d;
    if (t.length !== 10) return e164 || null;
    return '(' + t.slice(0, 3) + ') ' + t.slice(3, 6) + '-' + t.slice(6);
}
function isEmail(s) {
    return typeof s === 'string' && s.length <= 320 && /^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

/** The lead a request is about, if the signed token checks out. */
function verifiedLeadId(body) {
    const lid = intOrNull(body.lid);
    if (lid == null) return null;
    return verifyLead(lid, body.t) ? lid : null;
}

/**
 * Find the lead this contact belongs to inside ONE client's pool, or null.
 * Order: verified token, then phone (both shapes), then email. Pool-scoped so a
 * Blason form submit can never attach to a STILO lead with the same number.
 */
async function findLead(pros, site, body) {
    const cols = 'id,name,owner_name,owner_phone,owner_phone_e164,phone,owner_email,email,stage,client_id,primary_language,rep_notes,owner_name_verify_status,address,category,call_attempts,meeting_scheduled_at,meeting_event_id';
    const vid = verifiedLeadId(body);
    if (vid != null) {
        const { data } = await pros.from('leads').select(cols).eq('id', vid).maybeSingle();
        if (data) return { lead: data, how: 'token' };
    }
    const e164 = normalizePhone(body.phone);
    if (e164) {
        const fmt = phoneDisplay(e164);
        const or = ['owner_phone_e164.eq.' + e164, 'owner_phone.eq.' + e164, 'phone.eq.' + e164,
            'owner_phone.eq.' + JSON.stringify(fmt), 'phone.eq.' + JSON.stringify(fmt)].join(',');
        const { data } = await pros.from('leads').select(cols).eq('client_id', site.client_id).or(or).order('id', { ascending: true }).limit(1);
        if (data && data[0]) return { lead: data[0], how: 'phone' };
    }
    const email = str(body.email, 320);
    if (email && isEmail(email)) {
        const byOwner = await pros.from('leads').select(cols).eq('client_id', site.client_id).ilike('owner_email', email).limit(1);
        if (byOwner.data && byOwner.data[0]) return { lead: byOwner.data[0], how: 'email' };
        const byEmail = await pros.from('leads').select(cols).eq('client_id', site.client_id).ilike('email', email).limit(1);
        if (byEmail.data && byEmail.data[0]) return { lead: byEmail.data[0], how: 'email' };
    }
    return null;
}

/** Internal alert to the inboxes Remy actually reads. Best-effort. */
async function notify(subject, html, text) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    const work = process.env.STILO_NOTIFY_EMAIL || process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';
    const to = Array.from(new Set([work, 'remyleon11@gmail.com']));
    const from = (process.env.STILO_SENDER_NAME || 'STILO AI Partners') + ' <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>';
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: from, to: to, subject: subject, html: html, text: text || undefined }),
        });
        const j = await r.json().catch(function () { return {}; });
        return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
    } catch (e) { return { error: String(e.message || e) }; }
}

function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function etStamp(iso) {
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    } catch (_) { return String(iso); }
}

// Human-readable labels for the quiz answer keys. The page and the admin tab
// both read these so a key change is one edit.
const LABELS = {
    interest: {
        laser_hair: 'Laser hair removal', resurfacing: 'Skin: resurfacing, scars, tightening',
        body: 'Body: contouring, fat, cellulite', facials: 'Facials: hydro, LED, multifunction',
        tattoo: 'Tattoo or pigment removal', notsure: 'Not sure yet',
    },
    quoted: { brand: 'Quoted by a brand name', importer: 'Quoted by another importer', replacing: 'Replacing a machine they own', none: 'Not quoted yet' },
    medical: { yes: 'Has MD / NP / PA', no: 'No medical director', planning: 'Planning to add one' },
    motive: { expansion: 'New room or location', demand: 'Clients keep asking', aging: 'Machine old or down', shopping: 'Shopping a quote they dislike' },
    path_pref: { showroom: 'Miami showroom visit', call: '10-minute call with Manuel' },
    // kept for rows written before the 2026-10-02 reorder
    segment: { medspa: 'Med spa', clinic: 'Laser / derm / plastic surgery clinic', spa: 'Spa or esthetics studio', salon: 'Salon or beauty school', wellness: 'Wellness or weight loss' },
    timeline: { now: 'Ready now', d30: 'Next 30 days', d90: '1 to 3 months', looking: 'Just looking' },
};
const QUIZ_KEYS = ['interest', 'medical', 'motive', 'path_pref', 'quoted'];  // quoted: asked 10/02 only, dropped the same day
function label(group, key) { return (LABELS[group] && LABELS[group][key]) || key || ''; }

module.exports = {
    SITES, EVENTS, MAX_BODY_BYTES, LABELS, QUIZ_KEYS, label,
    botReason, sbPublic, sbProspecting, configured, readJsonBody, str, intOrNull,
    ipOf, ipHash, normalizePhone, phoneDisplay, isEmail, verifiedLeadId, findLead,
    notify, esc, etStamp, signLead,
};
