/**
 * GET /api/sdr/performance?sdr_id=<uuid>&range=today|week|month|all
 *
 * High-level performance stats for one SDR (or aggregate for admins
 * without sdr_id). Returns:
 *   {
 *     dials_today, dials_week, dials_month, dials_all,
 *     unique_leads_contacted_today, ...
 *     meetings_booked_today, ...
 *     close_rate_pct,           // meetings_booked / dials_all
 *     conversion_rate_pct,      // closed_clients / meetings_booked
 *     active_callbacks,
 *     dead_pool_count,
 *     quota: { daily, today_progress, today_remaining }
 *   }
 *
 * Sourced from prospecting.lead_calls (dial-level truth) and
 * prospecting.leads (lifecycle stage) joined by lead_id.
 */
const { authSdr, resolveScope, methodNotAllowed } = require('./_shared');

function startOfTodayET() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return new Date(etDateStr + 'T00:00:00-04:00').toISOString();
}

function startOfWeekISO() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
}

function startOfMonthISO() {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString();
}

async function countCalls(sb, email, sinceISO) {
    let q = sb.from('lead_calls').select('id', { count: 'exact', head: true });
    if (email) q = q.eq('logged_by', email);
    if (sinceISO) q = q.gte('called_at', sinceISO);
    const { count } = await q;
    return count || 0;
}

async function countMeetingsBooked(sb, email, sinceISO) {
    let q = sb.from('lead_calls')
        .select('id', { count: 'exact', head: true })
        .eq('outcome', 'booked_meeting');
    if (email) q = q.eq('logged_by', email);
    if (sinceISO) q = q.gte('called_at', sinceISO);
    const { count } = await q;
    return count || 0;
}

async function uniqueLeadsContacted(sb, email, sinceISO) {
    let q = sb.from('lead_calls').select('lead_id').not('lead_id', 'is', null);
    if (email) q = q.eq('logged_by', email);
    if (sinceISO) q = q.gte('called_at', sinceISO);
    const { data } = await q.limit(10000);
    const s = new Set();
    (data || []).forEach(r => s.add(r.lead_id));
    return s.size;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const caller = await authSdr(req, res);
    if (!caller.ok) return;

    const scope = await resolveScope(req, caller);
    const email = scope.sdr && scope.sdr.email ? scope.sdr.email : null;
    // Admin "all" view doesn't filter by email (returns agency totals)
    const filterEmail = scope.isAllScope ? null : email;

    const todayISO = startOfTodayET();
    const weekISO = startOfWeekISO();
    const monthISO = startOfMonthISO();

    const [
        dialsToday, dialsWeek, dialsMonth, dialsAll,
        meetingsToday, meetingsWeek, meetingsMonth, meetingsAll,
        uniqueToday, uniqueAll
    ] = await Promise.all([
        countCalls(caller.sb, filterEmail, todayISO),
        countCalls(caller.sb, filterEmail, weekISO),
        countCalls(caller.sb, filterEmail, monthISO),
        countCalls(caller.sb, filterEmail, null),
        countMeetingsBooked(caller.sb, filterEmail, todayISO),
        countMeetingsBooked(caller.sb, filterEmail, weekISO),
        countMeetingsBooked(caller.sb, filterEmail, monthISO),
        countMeetingsBooked(caller.sb, filterEmail, null),
        uniqueLeadsContacted(caller.sb, filterEmail, todayISO),
        uniqueLeadsContacted(caller.sb, filterEmail, null)
    ]);

    // Closed clients via client_attribution (admins see all, SDR sees own)
    let closedQ = caller.sb.from('client_attribution')
        .select('id', { count: 'exact', head: true });
    if (scope.sdrId) closedQ = closedQ.eq('sdr_id', scope.sdrId);
    const { count: closedClients } = await closedQ;

    const closeRate = dialsAll > 0 ? (meetingsAll / dialsAll) * 100 : 0;
    const conversionRate = meetingsAll > 0 ? ((closedClients || 0) / meetingsAll) * 100 : 0;

    const dailyQuota = scope.sdr && scope.sdr.daily_call_quota ? scope.sdr.daily_call_quota : 80;

    return res.status(200).json({
        scope: {
            sdr_id: scope.sdrId,
            sdr_name: scope.sdr ? scope.sdr.display_name : 'All SDRs',
            is_all: scope.isAllScope
        },
        dials: {
            today: dialsToday,
            week: dialsWeek,
            month: dialsMonth,
            all: dialsAll
        },
        meetings_booked: {
            today: meetingsToday,
            week: meetingsWeek,
            month: meetingsMonth,
            all: meetingsAll
        },
        unique_leads: {
            today: uniqueToday,
            all: uniqueAll
        },
        closed_clients: closedClients || 0,
        rates: {
            close_rate_pct: Math.round(closeRate * 10) / 10,
            conversion_rate_pct: Math.round(conversionRate * 10) / 10
        },
        quota: {
            daily: dailyQuota,
            today_progress: dialsToday,
            today_remaining: Math.max(0, dailyQuota - dialsToday),
            today_pct: dailyQuota > 0 ? Math.min(100, Math.round((dialsToday / dailyQuota) * 100)) : 0
        }
    });
};
