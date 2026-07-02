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

async function countCalls(sb, email, sinceISO, untilISO) {
    let q = sb.from('lead_calls').select('id', { count: 'exact', head: true });
    if (email) q = q.eq('logged_by', email);
    if (sinceISO) q = q.gte('called_at', sinceISO);
    if (untilISO) q = q.lt('called_at', untilISO);
    const { count } = await q;
    return count || 0;
}

// Count DISTINCT booked meetings, not call-log rows. The old version counted
// prospecting.lead_calls rows with outcome='booked_meeting', so every re-dial or
// re-book that got logged as "booked_meeting" inflated the number (one lead
// showed up 6 times), and it credited whoever LOGGED the call rather than the
// meeting owner. Source of truth is one row per lead in prospecting.leads:
// meeting_scheduled_at (the meeting exists) + meeting_booked_by_sdr (who owns it).
// Bucketed by the meeting DATE, with an upper bound, so a meeting scheduled for
// next week doesn't leak into "this week".
async function countMeetingsBooked(sb, email, sinceISO, untilISO) {
    let q = sb.from('leads')
        .select('id, meeting_event_id')
        .not('meeting_scheduled_at', 'is', null);
    if (email) q = q.eq('meeting_booked_by_sdr', email);
    // Bucket by WHEN THE REP BOOKED IT (meeting_booked_at), not by the meeting
    // date. The old version filtered on meeting_scheduled_at, so a rep's card
    // counted meetings HAPPENING in the period, not meetings they BOOKED in it —
    // e.g. Luke showed 2 (two meetings scheduled for today) while Ale showed 0
    // despite booking 2 meetings today (both future-dated). meeting_booked_at is
    // stamped at booking time by book-meeting / sync-bookings / mark-booked.
    if (sinceISO) q = q.gte('meeting_booked_at', sinceISO);
    if (untilISO) q = q.lt('meeting_booked_at', untilISO);
    const { data } = await q.limit(5000);
    // Dedup by the CALENDAR EVENT. One Google event can end up stamped on two
    // leads (e.g. the sync's title-vs-business-name fallback matching a second
    // lead), which double-counted a single meeting on the rep's card. Count one
    // per distinct event; leads with no event id dedup by their own id.
    const seen = new Set();
    (data || []).forEach(function (r) { seen.add(r.meeting_event_id || ('lead:' + r.id)); });
    return seen.size;
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
    // Upper bounds for the meeting-date buckets (meetings are future-dated, so a
    // gte-only filter would count next week's meeting as "this week").
    const todayEndISO = new Date(new Date(todayISO).getTime() + 86400000).toISOString();
    const weekEndISO = new Date(new Date(weekISO).getTime() + 7 * 86400000).toISOString();
    const md = new Date(monthISO);
    const monthEndISO = new Date(Date.UTC(md.getUTCFullYear(), md.getUTCMonth() + 1, 1, 4, 0, 0)).toISOString();
    // Last week = the prior Mon-Sun calendar week. Last month = the prior calendar month.
    const lastWeekISO = new Date(new Date(weekISO).getTime() - 7 * 86400000).toISOString();
    const lastWeekEndISO = weekISO; // start of this week is the end of last week
    const lastMonthISO = new Date(Date.UTC(md.getUTCFullYear(), md.getUTCMonth() - 1, 1, 4, 0, 0)).toISOString();
    const lastMonthEndISO = monthISO; // start of this month is the end of last month

    const psb = prospectingClient(); // lead_calls + leads live in the prospecting schema
    const [
        dialsToday, dialsWeek, dialsMonth, dialsAll, dialsLastWeek, dialsLastMonth,
        meetingsToday, meetingsWeek, meetingsMonth, meetingsAll, meetingsLastWeek, meetingsLastMonth,
        uniqueToday, uniqueAll
    ] = await Promise.all([
        countCalls(psb, filterEmail, todayISO),
        countCalls(psb, filterEmail, weekISO),
        countCalls(psb, filterEmail, monthISO),
        countCalls(psb, filterEmail, null),
        countCalls(psb, filterEmail, lastWeekISO, lastWeekEndISO),
        countCalls(psb, filterEmail, lastMonthISO, lastMonthEndISO),
        countMeetingsBooked(psb, filterEmail, todayISO, todayEndISO),
        countMeetingsBooked(psb, filterEmail, weekISO, weekEndISO),
        countMeetingsBooked(psb, filterEmail, monthISO, monthEndISO),
        countMeetingsBooked(psb, filterEmail, null, null),
        countMeetingsBooked(psb, filterEmail, lastWeekISO, lastWeekEndISO),
        countMeetingsBooked(psb, filterEmail, lastMonthISO, lastMonthEndISO),
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
            all: dialsAll,
            last_week: dialsLastWeek,
            last_month: dialsLastMonth
        },
        meetings_booked: {
            today: meetingsToday,
            week: meetingsWeek,
            month: meetingsMonth,
            all: meetingsAll,
            last_week: meetingsLastWeek,
            last_month: meetingsLastMonth
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
