/**
 * sites/stilo-ai/api/prospects/_scrub.js
 *
 * Litigator / DNC scrub. One number in, one verdict out, plus the write-back
 * that blocks a lead the moment a provider flags it.
 *
 * The threat this defends against is narrow and specific: serial TCPA
 * plaintiffs. They maintain phone numbers for the purpose of being contacted,
 * and they earn on $500-per-violation statutory damages ($1,500 willful, and
 * Florida's FTSA stacks its own $500 on top). They are a small, known, and
 * commercially indexed population. Paying to remove them from a list is the
 * single highest-leverage compliance spend available to an outbound team.
 *
 * WHAT THIS IS NOT: scrubbing does not create consent and does not make cold
 * contact lawful. It removes the people most likely to sue. Treat it as
 * seatbelts, not as permission to drive faster.
 *
 * ---------------------------------------------------------------------------
 * THE FAIL MODE IS THE WHOLE DESIGN
 *
 * A scrub that guesses "probably clean" when it cannot read the provider's
 * answer is worse than no scrub, because it launders an unknown into a green
 * light and everyone downstream trusts it. So:
 *
 *     recognized clean signal   -> 'clear'    (only this authorizes an SMS)
 *     recognized bad signal     -> 'blocked'  (+ do_not_call, + audit row)
 *     provider/network failure  -> 'error'
 *     response we cannot parse  -> 'error'    (NEVER 'clear')
 *     no API key configured     -> 'pending'
 *
 * 'error' and 'pending' both mean "no answer yet". The SMS sender requires
 * status === 'clear' explicitly. Dialing is unaffected except for hard blocks,
 * because a 'clear'-only gate on the call queue would zero out every rep's
 * morning list the day this ships.
 *
 * ---------------------------------------------------------------------------
 * RESPONSE MAPPING IS UNVERIFIED FOR BLACKLIST ALLIANCE
 *
 * Their endpoint is public (api.blacklistalliance.net/lookup) but the response
 * schema is behind a sales conversation, so the field names below are inferred,
 * not confirmed. That is exactly why an unrecognized shape returns 'error'
 * instead of 'clear': a wrong guess costs a re-run, never a leaked send.
 *
 * To finalize it, run one live probe and paste the raw JSON back:
 *     node scripts/backfill_litigator_scrub.js --probe --phone=+13055551234
 * Then tighten mapBlacklistAlliance() to the real fields. Until that is done,
 * expect the backfill to report a large 'error' count. That is the system
 * working, not failing.
 */

const { normalizePhone } = require('../openphone/_shared');

const PROVIDER = process.env.SCRUB_PROVIDER || 'blacklist_alliance';
const TIMEOUT_MS = Number(process.env.SCRUB_TIMEOUT_MS || 8000);

// ---------------------------------------------------------------------------
// Which number do we actually check?
//
// leads carries up to three phone columns and they routinely disagree: `phone`
// is usually the scraped main business line, `owner_phone` is what David's
// research turned up, `owner_phone_e164` is the normalized version of that.
// Scrubbing the storefront line tells you nothing about the owner's cell, and
// the cell is what the SMS goes to. Prefer the most specific number available,
// and record which one we picked so the sender can verify it later.
// ---------------------------------------------------------------------------
function pickPhone(lead) {
    const raw = lead.owner_phone_e164 || lead.owner_phone || lead.phone || null;
    if (!raw) return null;
    try { return normalizePhone(raw); } catch (_) { return null; }
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('scrub_timeout')), ms)),
    ]);
}

// ---------------------------------------------------------------------------
// Provider mappers. Each returns one of:
//   { verdict: 'clear' }
//   { verdict: 'blocked', reason, flags }
//   { verdict: 'unknown', flags }   <- caller turns this into 'error'
// ---------------------------------------------------------------------------

// Blacklist Alliance. Field names INFERRED — see the header note.
function mapBlacklistAlliance(json) {
    if (!json || typeof json !== 'object') return { verdict: 'unknown', flags: { raw: json } };

    // Any explicit positive signal is a block. Checked broadly on purpose:
    // over-blocking a handful of good leads is cheap, under-blocking a
    // plaintiff is not.
    const msg = String(json.message || json.Message || '');
    const looksListed =
        json.is_bad_number === true ||
        json.blacklisted === true ||
        json.litigator === true ||
        (Array.isArray(json.results) && json.results.length > 0) ||
        /found|listed|blacklist|litigat|complain/i.test(msg);

    if (looksListed) {
        return {
            verdict: 'blocked',
            reason: /litigat/i.test(msg) ? 'litigator' : 'blacklist_match',
            flags: json,
        };
    }

    // Only treat as clean on an explicit clean signal. "No error" is not one.
    const looksClean =
        json.is_bad_number === false ||
        json.blacklisted === false ||
        /no match|not found|clean|good/i.test(msg) ||
        (Array.isArray(json.results) && json.results.length === 0 &&
            String(json.status || '').toLowerCase() === 'success');

    if (looksClean) return { verdict: 'clear', flags: json };

    return { verdict: 'unknown', flags: json };
}

/**
 * IPQualityScore, calibrated for B2B on 2026-07-29.
 *
 * READ THIS BEFORE CHANGING THE THRESHOLDS. The obvious mapping (block on
 * do_not_call, block on fraud_score >= 85) was measured against 12 real leads we
 * had already spoken to and would have blocked 6 of the 8 valid numbers,
 * including Randy Lindgren, who is a paying client. Two reasons:
 *
 *   1. IPQS `do_not_call` reflects the FEDERAL DNC REGISTRY. That registry
 *      protects residential subscribers, and business-to-business calls are
 *      largely exempt from it. A B2B lead sitting on the DNC list is normal and
 *      is not a reason to refuse to contact a business. We record it, we do not
 *      block on it.
 *   2. `fraud_score` is driven hard by line type. Ordinary small-business VOIP
 *      lines score 85 by default. Blocking at 85 blocks the VOIP half of the
 *      small-business world, which is most of our ICP.
 *
 * ALSO IMPORTANT: IPQS IS NOT A LITIGATOR DATABASE. It answers "is this number
 * real, active, and abusive", not "does this person sue people for a living".
 * Serial-plaintiff lists are a separate paid product (Blacklist Alliance,
 * DNC.com). Do not let the presence of this integration create the impression
 * that litigator screening is solved. It is not.
 *
 * What we actually block on is narrow and defensible:
 *   - recent_abuse: a real abuse-report signal against that number
 *   - valid === false: the number does not exist, so it cannot be texted
 *   - active === false: disconnected line
 * Everything else is 'clear' with the raw signals kept in scrub_flags for later
 * analysis if the calibration ever needs revisiting.
 */
function mapIpqs(json) {
    if (!json || typeof json !== 'object') return { verdict: 'unknown', flags: { raw: json } };

    // "Invalid/nonexistent phone number" comes back as success:false with a
    // message. That is a real, useful answer about the number, not an API
    // failure, so it must not be reported as 'unknown' (which would retry
    // forever and burn the free-tier quota on numbers that will never resolve).
    if (json.success !== true) {
        if (/invalid|nonexistent|not a valid/i.test(String(json.message || ''))) {
            return { verdict: 'blocked', reason: 'invalid_number', flags: { message: json.message } };
        }
        return { verdict: 'unknown', flags: json };
    }

    const flags = {
        fraud_score: json.fraud_score,
        recent_abuse: json.recent_abuse,
        risky: json.risky,
        do_not_call: json.do_not_call,   // recorded, deliberately NOT blocked on
        line_type: json.line_type,
        active: json.active,
        valid: json.valid,
        carrier: json.carrier,
    };

    if (json.valid === false) return { verdict: 'blocked', reason: 'invalid_number', flags };
    if (json.active === false) return { verdict: 'blocked', reason: 'inactive_number', flags };
    if (json.recent_abuse === true) return { verdict: 'blocked', reason: 'recent_abuse', flags };

    return { verdict: 'clear', flags };
}

// ---------------------------------------------------------------------------
// scrubPhone(phone) -> { status, reason, flags, provider, phone }
// status: 'clear' | 'blocked' | 'error' | 'pending'
// ---------------------------------------------------------------------------
async function scrubPhone(phone) {
    const base = { provider: PROVIDER, phone: phone, flags: null, reason: null };
    if (!phone) return Object.assign({}, base, { status: 'error', reason: 'no_phone' });

    let url;
    let mapper;

    if (PROVIDER === 'blacklist_alliance') {
        const key = process.env.BLACKLIST_ALLIANCE_KEY;
        if (!key) return Object.assign({}, base, { status: 'pending', reason: 'no_api_key' });
        const digits = String(phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
        url = 'https://api.blacklistalliance.net/lookup'
            + '?key=' + encodeURIComponent(key)
            + '&phone=' + encodeURIComponent(digits)
            + '&ver=v1&resp=json';
        mapper = mapBlacklistAlliance;
    } else if (PROVIDER === 'ipqualityscore') {
        const key = process.env.IPQS_API_KEY;
        if (!key) return Object.assign({}, base, { status: 'pending', reason: 'no_api_key' });
        url = 'https://www.ipqualityscore.com/api/json/phone/'
            + encodeURIComponent(key) + '/' + encodeURIComponent(phone);
        mapper = mapIpqs;
    } else {
        return Object.assign({}, base, { status: 'pending', reason: 'no_provider_configured' });
    }

    let json;
    try {
        const r = await withTimeout(fetch(url, { headers: { accept: 'application/json' } }), TIMEOUT_MS);
        // 403 on a bad key and 422 on a bad number are permanent for THIS call
        // but not a reason to mark a lead clean. Both land in 'error'.
        if (!r.ok) {
            return Object.assign({}, base, {
                status: 'error',
                reason: 'http_' + r.status,
                flags: { http_status: r.status },
            });
        }
        json = await r.json();
    } catch (e) {
        return Object.assign({}, base, { status: 'error', reason: String(e.message || e).slice(0, 80) });
    }

    const m = mapper(json);
    if (m.verdict === 'blocked') {
        return Object.assign({}, base, { status: 'blocked', reason: m.reason, flags: m.flags });
    }
    if (m.verdict === 'clear') {
        return Object.assign({}, base, { status: 'clear', flags: m.flags });
    }
    return Object.assign({}, base, { status: 'error', reason: 'unrecognized_response', flags: m.flags });
}

// ---------------------------------------------------------------------------
// scrubLead(pro, lead, source) -> result
//
// `pro` is a supabase client already scoped to the `prospecting` schema.
// Writes the verdict onto the lead, and on a block also flips do_not_call and
// appends an audit row. do_not_call is what the existing queues already honor,
// so a block removes the lead from every dialing surface with no new filter.
// ---------------------------------------------------------------------------
async function scrubLead(pro, lead, source) {
    const phone = pickPhone(lead);
    const res = await scrubPhone(phone);

    const patch = {
        scrub_status: res.status,
        scrub_checked_at: new Date().toISOString(),
        scrub_provider: res.provider,
        scrub_reason: res.reason,
        scrub_phone: phone,
        scrub_flags: res.flags || null,
    };

    if (res.status === 'blocked') {
        patch.do_not_call = true;
        await pro.from('scrub_blocks').insert({
            lead_id: lead.id,
            phone: phone,
            provider: res.provider,
            reason: res.reason,
            flags: res.flags || null,
            source: source || 'unknown',
        });
    }

    const { error } = await pro.from('leads').update(patch).eq('id', lead.id);
    if (error) return Object.assign({}, res, { write_error: error.message });
    return res;
}

/**
 * Gate for any outbound SMS. Returns { ok } or { ok: false, reason }.
 *
 * Requires an affirmative 'clear' AND that the number about to be texted is the
 * same one that was scrubbed. The second check is the one that catches the real
 * bug: a lead scrubbed on its storefront line, then texted on the owner's cell,
 * is an unscrubbed send wearing a green badge.
 */
function assertScrubbedForSms(lead, targetPhone) {
    if (!lead) return { ok: false, reason: 'no_lead' };
    if (lead.scrub_status !== 'clear') {
        return { ok: false, reason: 'scrub_' + (lead.scrub_status || 'never_run') };
    }
    let target = null;
    try { target = normalizePhone(targetPhone); } catch (_) { /* falls through */ }
    if (!target) return { ok: false, reason: 'bad_target_phone' };
    if (lead.scrub_phone && lead.scrub_phone !== target) {
        return { ok: false, reason: 'scrub_phone_mismatch' };
    }
    return { ok: true };
}

module.exports = { scrubPhone, scrubLead, pickPhone, assertScrubbedForSms, PROVIDER };
