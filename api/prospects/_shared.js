/**
 * sites/stilo-ai/api/prospects/_shared.js
 *
 * Shared helpers for the prospecting proxy endpoints. The leading
 * underscore is conventional only — the local serve.js router maps
 * /api/<dir>/<name> straight to the file, so anyone calling
 * /api/prospects/_shared would get 405. The handler at the bottom
 * makes that explicit.
 *
 * Two responsibilities:
 *
 *   1. assertAdmin(req, res) — verify the request comes from an
 *      authenticated admin (mirrors the pattern in api/admin/impersonate.js).
 *   2. forwardToProspecting({...}) — proxy the request to David's
 *      Python backend at PROSPECTING_API_URL with a server-side bearer
 *      token. Browsers never see the URL or the token.
 *
 * Required env vars (validated at call time, not module load):
 *   - SUPABASE_URL, SUPABASE_SERVICE_KEY (admin gate)
 *   - PROSPECTING_API_URL                (upstream base URL)
 *   - PROSPECTING_API_TOKEN              (upstream bearer)
 */

const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAILS = [
    'remyleon11@gmail.com',
    'stiloaiconsulting@gmail.com',
    'remyleon@stiloaipartners.com',
    'davidcoira@stiloaipartners.com'
];

// David's cold-call brief Tier (1=top priority) → the dashboard's named tier.
const BRIEF_TIER_MAP = { 1: 'hot', 2: 'warm', 3: 'cool' };

function adminClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    try { return JSON.parse(raw); } catch { return {}; }
}

async function assertAdmin(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
        res.status(401).json({ error: 'missing_token' });
        return { ok: false };
    }
    const sb = adminClient();
    const { data: userData, error } = await sb.auth.getUser(token);
    const email = userData && userData.user && userData.user.email;
    if (error || !email) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    const role = (userData.user.app_metadata && userData.user.app_metadata.role) || null;
    const isAdmin = role === 'admin' || ADMIN_EMAILS.includes(email);
    if (!isAdmin) {
        res.status(403).json({ error: 'not_admin' });
        return { ok: false };
    }
    return { ok: true, email: email };
}

/**
 * Like assertAdmin but accepts admin OR sdr roles. Returns caller details so
 * the handler can scope queries (e.g. force ?assigned_to=email for SDRs).
 */
async function assertAdminOrSdr(req, res) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        res.status(500).json({ error: 'supabase_not_configured' });
        return { ok: false };
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) { res.status(401).json({ error: 'missing_token' }); return { ok: false }; }

    const sb = adminClient();
    const { data: userData, error } = await sb.auth.getUser(token);
    const user = userData && userData.user;
    if (error || !user || !user.email) {
        res.status(401).json({ error: 'invalid_token' });
        return { ok: false };
    }
    const email = user.email;
    const role = (user.app_metadata && user.app_metadata.role) || null;
    const isAdmin = role === 'admin' || ADMIN_EMAILS.includes(email);
    const isSdr = role === 'sdr';
    if (!isAdmin && !isSdr) {
        res.status(403).json({ error: 'not_admin_or_sdr' });
        return { ok: false };
    }
    return { ok: true, email: email, role: role, isAdmin: isAdmin, isSdr: isSdr };
}

/**
 * Force-scope a query object to the SDR's email when the caller is an SDR.
 * Admins can pass ?assigned_to=... explicitly. SDRs always have their own
 * email injected and cannot view another SDR's data even if they try.
 */
function scopedQuery(caller, q) {
    const out = Object.assign({}, q || {});
    if (caller && caller.isSdr && !caller.isAdmin) {
        out.assigned_to = caller.email;
    }
    return out;
}

/**
 * Forward a request to PROSPECTING_API_URL (David's FastAPI Cloud Run service
 * at stilo-api-...run.app). The shim_dispatcher fallback was removed when
 * David's service went live — there's no in-process stand-in anymore.
 *
 * @param {object} opts
 * @param {string} opts.method   'GET' | 'POST' (others rejected upstream)
 * @param {string} opts.path     starts with '/', e.g. '/api/prospects/stats'
 * @param {object} [opts.query]  key/value query params (string or array)
 * @param {object} [opts.body]   JSON body for POST
 * @returns {Promise<{status:number, json:any}>}
 */
async function forwardToProspecting(opts) {
    const base = process.env.PROSPECTING_API_URL;
    const token = process.env.PROSPECTING_API_TOKEN;
    if (!base) {
        return { status: 503, json: { error: 'prospecting_url_not_configured' } };
    }
    let url = base.replace(/\/+$/, '') + opts.path;
    if (opts.query) {
        const parts = [];
        for (const k in opts.query) {
            const v = opts.query[k];
            if (v == null || v === '') continue;
            const arr = Array.isArray(v) ? v : [v];
            for (const item of arr) {
                parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(item)));
            }
        }
        if (parts.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
    }
    const headers = { 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const init = { method: opts.method, headers: headers };
    if (opts.body !== undefined && opts.method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        return { status: 502, json: { error: 'prospecting_unavailable', detail: String(e && e.message || e) } };
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { json = { raw: text }; }
    return { status: res.status, json: json };
}

function methodNotAllowed(res, allow) {
    res.setHeader('Allow', allow);
    return res.status(405).json({ error: 'method_not_allowed' });
}

function safeNumberId(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n;
}

// Start of "today" in America/New_York, returned as a Date (UTC instant).
// We're on ET (Miami) and the calling day should end at midnight ET, not UTC,
// so an evening call doesn't roll out of "Calls Today" at 7pm. DST-aware via
// Intl.DateTimeFormat — no extra dependency.
function startOfDayET() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const utcWall = now.toLocaleString('sv-SE', { timeZone: 'UTC' });                    // YYYY-MM-DD HH:mm:ss
    const etWall  = now.toLocaleString('sv-SE', { timeZone: 'America/New_York' });
    const utcMs = new Date(utcWall.replace(' ', 'T') + 'Z').getTime();
    const etMs  = new Date(etWall.replace(' ', 'T') + 'Z').getTime();
    const offsetMs = utcMs - etMs; // positive in ET (UTC-5 / UTC-4)
    const etMidnightUtc = new Date(etDateStr + 'T00:00:00Z').getTime();
    return new Date(etMidnightUtc + offsetMs);
}

// Best-effort "City" from a full street address like
// "2519 NW 38th St, Miami, FL 33142" -> "Miami".
function cityFromAddress(addr) {
    if (!addr || typeof addr !== 'string') return null;
    const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/**
 * Normalize a prospecting.leads row to the shape the dashboards expect.
 * The Supabase table uses `name`/`category`; David's Cloud Run API aliased
 * those to `business_name`/`niche`. Every endpoint that returns Supabase rows
 * runs them through here so the frontend renders identically regardless of
 * source. Originals are preserved; aliases are added only when missing.
 */
function normalizeLead(r) {
    if (!r || typeof r !== 'object') return r;
    return Object.assign({}, r, {
        business_name: r.business_name || r.name || null,
        niche: r.niche || r.category || null,
        city: r.city || cityFromAddress(r.address),
        // Surface a dialable number: many leads carry the business line in
        // `phone` with owner_phone null. The dashboards render owner_phone.
        owner_phone: r.owner_phone || r.phone || null,
        // Tier source of truth (in priority order):
        //   1. brief_tier — David's CURRENT ranking, parsed from the cold-call
        //      brief header ("**Tier:** N", 1=hot/2=warm/3=cool). Present on
        //      every scripted lead the reps actually call.
        //   2. prospect_tier — his older scoring column (hot/warm/cool/dead),
        //      used only when there's no brief tier.
        //   3. has_cold_call_script but no tier anywhere — David shipped no
        //      brief/score for it, yet it's in the active call queue → default
        //      to 'cool' (lowest priority, sorts last) so the queue has no blank
        //      tiers. Not written to the DB; purely a display default.
        //   4. null → "—" (non-callable leads only).
        // The legacy `tier` column (stale 'cold' on ~2k old-import leads) is
        // never read. Future brief pushes flow through automatically once
        // backfill_brief_tier.js stamps brief_tier.
        tier: (BRIEF_TIER_MAP[r.brief_tier] || r.prospect_tier || (r.has_cold_call_script ? 'cool' : null)),
        prospect_tier: (BRIEF_TIER_MAP[r.brief_tier] || r.prospect_tier || (r.has_cold_call_script ? 'cool' : null)),
    });
}

module.exports = async function (req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};

/**
 * Resolve a `?assigned_to=` parameter into an email. Accepts:
 *   - A full email (returned as-is, lowercased)
 *   - An sdr_key (looked up against sdr_users via a 60s memoized cache)
 *   - null/empty (returns null)
 *
 * The lookup-cache means high-throughput endpoints (lifecycle-stats,
 * callable) don't hit the DB per request. Cache invalidates after 60s
 * so newly-hired SDRs become resolvable within a minute.
 */
let _sdrKeyCache = null;
let _sdrKeyCacheAt = 0;
async function loadSdrKeyMap() {
    const now = Date.now();
    if (_sdrKeyCache && (now - _sdrKeyCacheAt) < 60_000) return _sdrKeyCache;
    try {
        const sb = adminClient();
        const { data } = await sb.from('sdr_users').select('sdr_key, email').eq('active', true);
        const m = {};
        (data || []).forEach(r => { if (r.sdr_key && r.email) m[r.sdr_key.toLowerCase()] = r.email.toLowerCase(); });
        // Legacy aliases (Remy + David sometimes referenced as sdr_keys in callers)
        if (!m.remy)  m.remy  = 'remyleon@stiloaipartners.com';
        if (!m.david) m.david = 'davidcoira@stiloaipartners.com';
        _sdrKeyCache = m;
        _sdrKeyCacheAt = now;
        return m;
    } catch (e) {
        // On DB error fall back to legacy map so prod doesn't 500
        return { remy: 'remyleon@stiloaipartners.com', david: 'davidcoira@stiloaipartners.com' };
    }
}

async function resolveAssignedTo(input) {
    const v = String(input || '').trim().toLowerCase();
    if (!v) return null;
    if (v.indexOf('@') > 0) return v;
    const map = await loadSdrKeyMap();
    return map[v] || null;
}

module.exports.assertAdmin = assertAdmin;
module.exports.assertAdminOrSdr = assertAdminOrSdr;
module.exports.scopedQuery = scopedQuery;
module.exports.resolveAssignedTo = resolveAssignedTo;
module.exports.loadSdrKeyMap = loadSdrKeyMap;
module.exports.forwardToProspecting = forwardToProspecting;
module.exports.readJsonBody = readJsonBody;
module.exports.methodNotAllowed = methodNotAllowed;
module.exports.safeNumberId = safeNumberId;
module.exports.startOfDayET = startOfDayET;

// The offer we currently sell. Boards and callback queues both gate on it so a
// rep can never open a script for a retired product. Env-overridable;
// CALLABLE_OFFER=* disables the gate everywhere at once.
// Set 2026-08-04 with the sales-agency pivot. See api/prospects/callable.js.
const CURRENT_OFFER = process.env.CALLABLE_OFFER || 'Booked Meetings';
function gateToCurrentOffer(q, clientId) {
    // Client-account mode: the board IS the client's lead pool. Client leads
    // never carry a STILO pitch_agent (they're not being sold a STILO offer),
    // so the pitch gate is replaced, not stacked, with the client_id filter.
    if (clientId) return q.eq('client_id', clientId);
    return CURRENT_OFFER === '*' ? q : q.eq('pitch_agent', CURRENT_OFFER);
}

/**
 * Which client does this rep dial for? Returns the clients.id uuid for a
 * sdr_users row with sdr_type='client_account', else null (a STILO rep).
 *
 * Every board/queue endpoint calls this with the EFFECTIVE assigned_to email
 * (the SDR themselves, or the rep an admin is impersonating), so a client rep
 * sees their client's pool and everyone else sees STILO's, from one gate.
 */
async function resolveClientScope(email) {
    if (!email) return null;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }
        });
        const { data } = await sb.from('sdr_users')
            .select('sdr_type, client_id')
            .eq('email', String(email).toLowerCase()).maybeSingle();
        if (data && data.sdr_type === 'client_account' && data.client_id) return data.client_id;
    } catch (_) { /* on error, behave like a STILO rep — never 500 a board */ }
    return null;
}

module.exports.normalizeLead = normalizeLead;
module.exports.CURRENT_OFFER = CURRENT_OFFER;
module.exports.gateToCurrentOffer = gateToCurrentOffer;
module.exports.resolveClientScope = resolveClientScope;

/**
 * The columns a LEAD LIST needs. Nothing else.
 *
 * prospecting.leads has ~150 columns and averages 1,358 bytes a row, but 44% of
 * that is deep_research_json alone (2,346 bytes average across the 7k rows that
 * have it). A select('*') page of 200 rows weighed 377 kB, and the dial board
 * reloads all day, which is what put the org over the 5.5 GB Supabase egress
 * quota. None of the list tables render the research blob, the business profile,
 * the outreach draft or the scoring prose: those belong to the lead drawer,
 * which fetches ONE row through detail.js.
 *
 * Every column below is read by admin/index.html renderProspectTable() or
 * sdr/index.html standardLeadTableHtml() / the callback calendar, or by
 * normalizeLead() above to build the business_name / niche / tier / owner_phone
 * aliases those renderers depend on. If you add a column to a list table, add it
 * here too or it renders as a dash.
 *
 * Deliberately NOT here (detail-view or backend-only): deep_research_json,
 * business_profile, outreach_draft, outreach_angle, scoring_reasoning,
 * prospect_reasoning, pain_signals, all_emails_json, call_notes, rep_notes,
 * confirmation_email_body, address, website and the whole email-verify plus
 * phone-scrub enrichment surface.
 */
const LEAD_LIST_COLUMNS = [
    'id',
    // Name + niche: normalizeLead aliases these to business_name / niche.
    'name', 'category', 'niche',
    // Contact columns. leadPhone() in /sdr/ reads owner_phone_e164 first, then
    // owner_phone, then the business `phone`, so all three have to come back.
    'owner_name', 'owner_phone', 'owner_phone_e164', 'phone', 'owner_email', 'email',
    // Score + tier. brief_tier and has_cold_call_script feed normalizeLead's
    // tier derivation, so the Hot/Warm/Cool badge needs them even though the
    // renderer only ever reads prospect_tier.
    'prospect_score', 'score', 'prospect_tier', 'brief_tier', 'has_cold_call_script',
    // Lifecycle: stage badge, SDR scoping, dialed-today dimming, last-touch sort.
    'stage', 'assigned_to', 'last_called_at', 'last_called_outcome', 'call_attempts',
    // Callback + meeting stamps the calendars and the Booked column read.
    'next_action_due_at', 'meeting_scheduled_at', 'meeting_confirmed_at',
    // Client-account scoping: which client's pool this lead belongs to
    // (null = STILO's own prospect). Read by the client CRM and board gates.
    'client_id'
].join(', ');

module.exports.LEAD_LIST_COLUMNS = LEAD_LIST_COLUMNS;

/**
 * Role inboxes: info@, sales@, office@ and friends.
 *
 * These are shared mailboxes, not a person. They bounced at 22.3% historically
 * and produced no replies, so nothing we build a cold-email audience from
 * should include them. 3,531 of the 4,258 addresses on file are one of these,
 * and 3,296 of those are plain info@.
 *
 * Two shapes of the same list, because they get used in two different places:
 *
 *   ROLE_INBOX_PREFIXES: for a PostgREST `not.ilike.<prefix>@*` filter, so the
 *     exclusion happens in Postgres and the endpoint never pays egress for rows
 *     it is going to throw away.
 *   ROLE_INBOX_RE: the same list as a regex, which also catches the separator
 *     variants ILIKE cannot express cheaply (info.miami@, contact_us@). Measured
 *     2026-08-14: only 3 addresses in the whole pool need it, so it runs as a
 *     JS pass over the rows the SQL filter already narrowed.
 *
 * api/prospects/email-sequence.js still carries its own ROLE_RE copy. Point it
 * here when its in-flight work lands; two role tables drift the same way two
 * niche tables did.
 */
const ROLE_INBOX_PREFIXES = [
    'info', 'sales', 'contact', 'admin', 'office', 'hello', 'support', 'team',
    'mail', 'billing', 'help', 'service', 'services', 'reception', 'frontdesk',
    'noreply', 'no-reply', 'cs', 'customerservice', 'customercare',
    'privacy', 'legal', 'careers', 'jobs', 'hr', 'account', 'accounts', 'ops',
    'dispatch', 'estimating', 'estimates', 'quote', 'quotes'
];

const ROLE_INBOX_RE = /^(info|sales|contact|admin|office|hello|support|team|mail|billing|help|service|services|reception|frontdesk|no-?reply|cs|customerservice|customer\.?care|privacy|legal|careers|jobs|hr|accounts?|ops|dispatch|estimating|estimates|quotes?)([.@_-]|@)/i;

function isRoleInbox(addr) {
    return ROLE_INBOX_RE.test(String(addr || '').trim());
}

module.exports.ROLE_INBOX_PREFIXES = ROLE_INBOX_PREFIXES;
module.exports.ROLE_INBOX_RE = ROLE_INBOX_RE;
module.exports.isRoleInbox = isRoleInbox;
