/**
 * Shared ET range buckets for the Team tab.
 *
 * Every analytics endpoint behind that tab returns all ranges in one response
 * so the range buttons switch instantly without a refetch. That only works if
 * every endpoint agrees on what "last week" means, which is why this lives in
 * one file instead of being copied per endpoint.
 *
 * last_week and last_month are CLOSED ranges (they have an end), unlike
 * today/week/month which are open-ended from a start. They were missing, and
 * the admin UI papered over it by mapping last_week -> week, so picking
 * "Last week" silently showed THIS week's numbers on every card.
 *
 * Weeks are Monday-start ET, matching the rest of the dashboard.
 */

function etParts(d) {
    const now = d || new Date();
    return {
        dateStr: now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        wd: now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    };
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function startOfTodayET() { return new Date(etParts().dateStr + 'T00:00:00-04:00'); }

function startOfWeekET() {
    const { dateStr, wd } = etParts();
    const daysSinceMon = (WD[wd] + 6) % 7;
    const d = new Date(dateStr + 'T00:00:00-04:00');
    d.setUTCDate(d.getUTCDate() - daysSinceMon);
    return d;
}

function startOfMonthET() {
    return new Date(etParts().dateStr.slice(0, 8) + '01T00:00:00-04:00');
}

function startOfLastWeekET() {
    const d = new Date(startOfWeekET());
    d.setUTCDate(d.getUTCDate() - 7);
    return d;
}

function startOfLastMonthET() {
    const d = new Date(startOfMonthET());
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d;
}

/** All range boundaries, computed once per request. */
function bounds() {
    return {
        tday: startOfTodayET().getTime(),
        twk: startOfWeekET().getTime(),
        tmon: startOfMonthET().getTime(),
        tlwk: startOfLastWeekET().getTime(),
        tlmon: startOfLastMonthET().getTime()
    };
}

/** Which buckets does this timestamp belong to? Null/invalid dates match none. */
function buckets(iso, B) {
    const t = new Date(iso).getTime();
    if (!iso || isNaN(t)) {
        return { today: false, week: false, month: false, last_week: false, last_month: false, all: false };
    }
    return {
        today: t >= B.tday,
        week: t >= B.twk,
        month: t >= B.tmon,
        // Closed on both sides, so these never include the current period.
        last_week: t >= B.tlwk && t < B.twk,
        last_month: t >= B.tlmon && t < B.tmon,
        all: true
    };
}

const RANGE_KEYS = ['today', 'week', 'month', 'last_week', 'last_month', 'all'];

function emptyRange() {
    return { today: 0, week: 0, month: 0, last_week: 0, last_month: 0, all: 0 };
}

function addRange(r, b, n) {
    n = (n === undefined || n === null) ? 1 : n;
    for (const k of RANGE_KEYS) if (b[k]) r[k] += n;
}

/** Per-range Set counts, for things like distinct active days or distinct leads. */
function emptySets() {
    const o = {};
    for (const k of RANGE_KEYS) o[k] = new Set();
    return o;
}
function addSet(s, b, v) {
    for (const k of RANGE_KEYS) if (b[k]) s[k].add(v);
}
function sizesOf(s) {
    const o = {};
    for (const k of RANGE_KEYS) o[k] = s[k].size;
    return o;
}

/** Divide two range objects into a rounded per-range rate, guarding /0. */
function rateRange(num, den, mult, round) {
    const o = {};
    for (const k of RANGE_KEYS) {
        const d = den[k] || 0;
        const v = d ? (num[k] / d) * (mult === undefined ? 1 : mult) : 0;
        o[k] = round === 0 ? Math.round(v) : Math.round(v * 10) / 10;
    }
    return o;
}

module.exports = {
    RANGE_KEYS, bounds, buckets, emptyRange, addRange,
    emptySets, addSet, sizesOf, rateRange,
    startOfTodayET, startOfWeekET, startOfMonthET, startOfLastWeekET, startOfLastMonthET
};
