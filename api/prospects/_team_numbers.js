/**
 * The ONE list of phone numbers that belong to our own people.
 *
 * Why this exists (Remy, 2026-08-25): the outbound machinery is built to
 * protect PROSPECTS — connected-call gates, per-lead rate caps, opt-out
 * suppression, unknown-caller lead stubbing. Every one of those guards is
 * wrong when the number on the other end is an SDR's own cell or another rep's
 * Quo line: an SDR has obviously never "had a connected call with" their own
 * phone, so prospect logic starves internal alerts; and a rep replying "ok" to
 * the 6pm stats text from their personal cell must not be stubbed into
 * prospecting.leads as "Unknown caller".
 *
 * Consumers:
 *   - _sms.js sendSms          -> skips the prospect guardrail for team numbers
 *   - _outbound.js preSendCheck -> waives the prospect gates ('team_number')
 *   - openphone/webhook.js      -> never stubs a lead for a team number
 *   - team-rituals.js           -> imports PERSONAL instead of its own copy
 *
 * TWO SOURCES, both covered:
 *   PERSONAL — the reps' own cells, from Remy. Static on purpose: a wrong
 *              entry texts a stranger, so it changes by code review, not data.
 *   roster   — every openphone_number on public.sdr_users, pulled live and
 *              cached for 5 minutes, so a line reassignment is picked up
 *              without a deploy.
 */
const { createClient } = require('@supabase/supabase-js');
const { normalizePhone } = require('../openphone/_shared');

// email (sdr_users) -> personal cell. From Remy 2026-08-24/25.
const PERSONAL = {
    'aleb1027@gmail.com': '+13057759522',
    'ayesjorge911@gmail.com': '+13053377495',   // was +1303… (typo) — carrier-rejected 8/25
    'georgegutierrez446@gmail.com': '+17867975869',
    'melanyealtuve12@gmail.com': '+17865806735'
};

let cache = { at: 0, set: null };
const TTL_MS = 5 * 60 * 1000;

async function teamNumberSet() {
    const now = Date.now();
    if (cache.set && now - cache.at < TTL_MS) return cache.set;
    const set = new Set(Object.values(PERSONAL).map(normalizePhone).filter(Boolean));
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        // Not filtered on active: a departed rep's line is still OURS until the
        // number is released, and prospect logic must never fire at it.
        const { data } = await sb.from('sdr_users').select('openphone_number');
        (data || []).forEach(function (r) {
            const n = normalizePhone(r.openphone_number);
            if (n) set.add(n);
        });
    } catch (_) { /* personals alone still protect the common case */ }
    cache = { at: now, set: set };
    return set;
}

/** Is this phone one of ours (a rep's personal cell or a Quo line)? */
async function isTeamNumber(phone) {
    const n = normalizePhone(phone);
    if (!n) return false;
    return (await teamNumberSet()).has(n);
}

module.exports = { PERSONAL, isTeamNumber, teamNumberSet };
