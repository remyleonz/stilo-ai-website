/**
 * _email_guard.js: the single pre-send gate for every outbound email.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same logic lived as PRIVATE functions inside send-email.js (the path a rep
 * triggers by clicking "Email this lead") and, separately, as a different
 * precomputed mechanism inside vsl-campaign.js. Two implementations, and the
 * remaining senders (send-nurture-value, send-vsl-followup) had neither. One
 * definition means a fix applies everywhere instead of to whichever copy someone
 * remembered.
 *
 * STATE OF THE BOUNCE PROBLEM, measured 2026-08-05
 * -----------------------------------------------
 *   before 2026-07-29 (no dead-domain gate):  504 sends, 14.9% bounce
 *   after  2026-07-29 (gate live):            117 sends,  5.1% bounce
 *
 * The dead-domain gate in vsl-campaign.js already did the heavy lifting. Do NOT
 * read the all-time 13.2% figure as current; it is dominated by pre-gate sends.
 * The remaining target is 5.1% -> under 2%, since providers throttle around 2% and
 * blocklist around 5%.
 *
 * All 6 post-gate bounces, and what they teach:
 *   %20support@lansight.com      malformed at source, see isMalformed() below
 *   community@tsroofingsystems.com, mailbox@jsandgcpa.com   guessed local parts
 *   cbernal@bmaccountax.com      real-looking, person likely gone
 *   info@floridaindependent...,  info@walkermiller.com      role accounts
 *
 * Separately: every cold send goes from remyleon@stiloaipartners.com, the SAME
 * address that sends meeting confirmations to booked prospects. Cold volume and
 * transactional mail should not share a reputation. That fix is a separate sending
 * domain and is not something this module can do.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * No paid verification service, no SMTP probe. Per Remy, low-confidence guesses
 * still send and the rep confirms the real address on the call. Only guaranteed-dead
 * recipients are blocked. Role accounts are REPORTED, never blocked: they bounce at
 * about twice their share of deliveries but still deliver most of the time, and for
 * a small business info@ is often the only published address. Every non-definitive
 * DNS result FAILS OPEN, because a timeout must never silently halt a campaign.
 */const dns = require('dns').promises;
const { createClient } = require('@supabase/supabase-js');

const DISPOSABLE_DOMAINS = new Set([
    'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
    'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
    'getnada.com', 'temp-mail.org', 'dispostable.com', 'maildrop.cc',
]);

// Role accounts are not blocked. They deliver most of the time and for small
// businesses info@ is often the ONLY published address. Tracked so we can see the
// split in reporting rather than guess at it.
const ROLE_PREFIX = /^(info|contact|admin|sales|office|hello|support|team|help|billing|accounts?)@/i;

const MX_TTL_MS = 24 * 60 * 60 * 1000;
const _mxCache = new Map();   // domain -> { at, block, reason }

function domainOf(email) {
    const at = String(email || '').lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }

// Scraped addresses arrive with junk fused to them. A real one that shipped and
// bounced: "%20support@lansight.com", a leading space that got percent-encoded
// somewhere upstream. It passes the standard email regex (no literal whitespace),
// so it sends every time and hard-bounces every time. Anything percent-encoded,
// or carrying stray punctuation/whitespace at the edges, is malformed at source.
const ENCODED_JUNK = /%[0-9a-f]{2}|[\s<>(),;:"'\[\]\\]/i;
function isMalformed(email) {
    const e = String(email || '').trim();
    if (ENCODED_JUNK.test(e)) return true;
    if (e.startsWith('.') || e.includes('..')) return true;
    const local = e.split('@')[0] || '';
    return local.length === 0;
}

function isRoleAccount(email) { return ROLE_PREFIX.test(String(email || '').trim()); }

/**
 * MX check on the recipient domain. Blocks disposable domains and domains that
 * publish NO MX records. FAILS OPEN on timeout / transient DNS failure.
 * Cached for 24h per domain so a 500-lead campaign does not issue 500 lookups.
 */
async function mxGate(email, timeoutMs) {
    const domain = domainOf(email);
    if (!domain) return { block: false, reason: 'no_domain' };
    if (DISPOSABLE_DOMAINS.has(domain)) return { block: true, reason: 'disposable_domain' };

    const hit = _mxCache.get(domain);
    if (hit && (Date.now() - hit.at) < MX_TTL_MS) return { block: hit.block, reason: hit.reason };

    let timer;
    try {
        const lookup = dns.resolveMx(domain);
        const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('mx_timeout')), timeoutMs || 4000); });
        const records = await Promise.race([lookup, guard]);
        clearTimeout(timer);
        const out = (!Array.isArray(records) || records.length === 0)
            ? { block: true, reason: 'no_mx' }
            : { block: false, reason: 'has_mx' };
        _mxCache.set(domain, { at: Date.now(), ...out });
        return out;
    } catch (e) {
        clearTimeout(timer);
        const code = e && e.code;
        // ENOTFOUND / ENODATA definitively mean "publishes no MX" -> block and cache.
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
            const out = { block: true, reason: 'no_mx' };
            _mxCache.set(domain, { at: Date.now(), ...out });
            return out;
        }
        // Anything else is non-definitive. Fail open and do NOT cache, so a blip
        // does not lock a domain out for 24 hours.
        return { block: false, reason: 'mx_lookup_error:' + (code || (e && e.message) || 'unknown') };
    }
}

/**
 * The full pre-send gate. Call this before every outbound email, no exceptions.
 *
 *   const gate = await canSend({ email, leadId, leadBouncedAt });
 *   if (!gate.ok) { skip(gate.reason); return; }
 *
 * Pass leadBouncedAt when you already have the lead row, to skip a query.
 * Returns { ok, reason, role }. `role` is informational only.
 */
async function canSend(opts) {
    const email = String((opts && opts.email) || '').trim();
    const role = isRoleAccount(email);

    if (!validEmail(email)) return { ok: false, reason: 'invalid_email', role };
    if (isMalformed(email)) return { ok: false, reason: 'malformed_address', role };

    // 1. Never re-send to an address that already bounced.
    if (opts && opts.leadBouncedAt) return { ok: false, reason: 'previously_bounced', role };

    if (opts && opts.leadId && !opts.skipDbChecks) {
        try {
            const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
                { auth: { persistSession: false }, db: { schema: 'prospecting' } });
            const { data: lead } = await pro.from('leads').select('bounced_at').eq('id', opts.leadId).maybeSingle();
            if (lead && lead.bounced_at) return { ok: false, reason: 'previously_bounced', role };
        } catch (e) { /* fail open: a DB hiccup must not halt a campaign */ }
    }

    // 2. Honor unsubscribes. One-click List-Unsubscribe writes to lcr_suppressions.
    if (!(opts && opts.skipDbChecks)) {
        try {
            const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
                { auth: { persistSession: false } });
            const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', email).limit(1);
            if (sup && sup.length) return { ok: false, reason: 'unsubscribed', role };
        } catch (e) { /* fail open */ }
    }

    // 3. Free DNS check. Guaranteed-dead domains only.
    const mx = await mxGate(email, opts && opts.timeoutMs);
    if (mx.block) return { ok: false, reason: mx.reason, role };

    return { ok: true, reason: mx.reason, role };
}

module.exports = {
    canSend, mxGate, validEmail, isMalformed, isRoleAccount, domainOf,
    DISPOSABLE_DOMAINS,
};
