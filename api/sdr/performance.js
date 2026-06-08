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
const { createClient } = require('@supabase/supabase-js');

// lead_calls lives in the `prospecting` schema. caller.sb (from authSdr)
// defaults to `public`, so querying lead_calls through it silently returns 0
// (no public.lead_calls). Use a prospecting-scoped client for dial/meeting
// counts. This was the cause of every SDR showing 0 dials on the admin Team
// profile + the SDR overview, despite real calls.
function prospectingClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

function startOfTodayET() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return new Date(etDateStr + 'T00:00:00-04:00').toISOString();
}

// Monday 00:00 America/New_York of the CURRENT calendar week — not a rolling
// 7-day window. The old version subtracted 7 days, so on a Monday it summed all
// of last week (Mon-Sun) plus today, inflating "this week". Week resets Monday.
function startOfWeekISO() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD in ET
    const weekday = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const daysSinceMon = ((({ Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 })[weekday]) + 6) % 7;
    const monday = new Date(etDateStr + 'T00:00:00-04:00'); // ET midnight today (EDT season)
    monday.setUTCDate(monday.getUTCDate() - daysSinceMon);
    return monday.toISOString();
}

// First of the CURRENT calendar month at 00:00 ET (was a rolling 30 days).
function startOfMonthISO() {
    const now = new Date();
    const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    const firstOfMonth = etDateStr.slice(0, 8) + '01';
    return new Date(firstOfMonth + 'T00:00:00-04:00').toISOString();
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

    const psb = prospectingClient(); // lead_calls is in the prospecting schema
    const [
        dialsToday, dialsWeek, dialsMonth, dialsAll,
        meetingsToday, meetingsWeek, meetingsMonth, meetingsAll,
        uniqueToday, uniqueAll
    ] = await Promise.all([
        countCalls(psb, filterEmail, todayISO),
        countCalls(psb, filterEmail, weekISO),
        countCalls(psb, filterEmail, monthISO),
        countCalls(psb, filterEmail, null),
        countMeetingsBooked(psb, filterEmail, todayISO),
        countMeetingsBooked(psb, filterEmail, weekISO),
        countMeetingsBooked(psb, filterEmail, monthISO),
        countMeetingsBooked(psb, filterEmail, null),
        uniqueLeadsContacted(psb, filterEmail, todayISO),
        uniqueLeadsContacted(psb, filterEmail, null)
    ]);

    // Closed clients via client_attribution (admins see all, SDR sees own)
    let closedQ = caller.sb.from('client_attribution')
        .select('id', { count: 'exact', head: true });
    if (scope.sdrId) closedQ = closedQ.eq('sdr_id', scope.sdrId);
    const { count: closedClients } = await closedQ;

    const closeRate = dialsAll > 0 ? (meetingsAll / dialsAll) * 100 : 0;
    const conversionRate = meetingsAll > 0 ? ((closedClients || 0) / meetingsAll) * 100 : 0;

    const dailyQuota = scope.sdr && scope.sdr.daily_call_quota ? scope.sdr.daily_call_quota : 50;

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
