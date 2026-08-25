/**
 * Canonical rep identity.
 *
 * Rows in prospecting are stamped with whatever email the actor was signed in
 * as at the time, and that is not always the email on their sdr_users row. On
 * 2026-08-24 this silently hid the two live deals: Ortega Prime and Blason Spa
 * Equipment were both stamped meeting_booked_by_sdr = 'remyleon11@gmail.com'
 * (Remy's personal Gmail, which is an ADMIN_EMAILS entry across the API but is
 * not his roster row, remyleon@stiloaipartners.com). Every per-rep number
 * looked up the raw string, missed, and dropped the meeting on the floor —
 * while the company total still counted it. Reps' numbers did not add up to the
 * company's, and nobody could see why.
 *
 * Resolution order:
 *   1. exact match on an sdr_users.email
 *   2. a known alias below
 *   3. null  ->  the caller reports it as unattributed rather than guessing
 *
 * Add an alias here rather than editing the roster: sdr_users.email has to keep
 * matching the auth identity the rep signs in with.
 */

// Alternate identities that belong to a rep on the roster. Only add an entry
// when you are certain the same human owns both addresses.
const ALIASES = {
    // Remy's personal Gmail. Used as an admin login across the API long before
    // sdr_users existed, and still stamped on rows he creates from some paths.
    'remyleon11@gmail.com': 'remyleon@stiloaipartners.com',
    'stiloaiconsulting@gmail.com': 'remyleon@stiloaipartners.com'
};

// Non-human actors. Named so they are reported as automation rather than
// counted against a rep or lumped in with genuinely unknown stamps.
const SYSTEM_ACTORS = {
    'vsl_landing': 'Self-booked (VSL landing page)',
    'vsl': 'Self-booked (VSL)',
    'system': 'System',
    'cron': 'Automation'
};

function lower(v) { return String(v === null || v === undefined ? '' : v).toLowerCase().trim(); }

/**
 * Build a resolver bound to one roster pull.
 * @param {Array} roster rows from public.sdr_users (needs .email)
 */
function makeResolver(roster) {
    const known = new Set((roster || []).map(function (r) { return lower(r.email); }));

    /** Canonical roster email, or null if this stamp belongs to no rep. */
    function canonical(raw) {
        const e = lower(raw);
        if (!e) return null;
        if (known.has(e)) return e;
        const alias = ALIASES[e];
        if (alias && known.has(alias)) return alias;
        return null;
    }

    /** Why did canonical() return null? Drives the unattributed report. */
    function classify(raw) {
        const e = lower(raw);
        if (!e) return { kind: 'missing', label: 'No actor recorded' };
        if (canonical(e)) return { kind: 'rep', label: canonical(e) };
        if (SYSTEM_ACTORS[e]) return { kind: 'system', label: SYSTEM_ACTORS[e] };
        return { kind: 'unknown', label: raw };
    }

    return { canonical: canonical, classify: classify, known: known };
}

module.exports = { makeResolver, ALIASES, SYSTEM_ACTORS, lower };
