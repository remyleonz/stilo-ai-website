/**
 * GET /api/sdr/team-analytics   (admin only)
 *
 * One call that powers the whole Team tab AND the "Export for Claude" button.
 * Company rollup + per-rep breakdown + per-niche breakdown + the booked-meeting
 * list with outcomes. Everything is bucketed today / week / month / all so the
 * front end can switch ranges without re-fetching.
 *
 * Definitions (matter — these are the KPIs the sales manager reviews daily):
 *   dial            = OUTBOUND call the rep placed (direction outbound|outgoing).
 *                     'incoming' (a prospect calling us) is NOT a dial.
 *   connect         = an outbound dial with outcome 'answered'.
 *   connect_rate    = connects / dials.
 *   talk_time       = sum of duration on connected outbound calls.
 *   avg_call_sec    = talk_time / connects.
 *   meeting booked  = distinct calendar event on a lead, credited to
 *                     meeting_booked_by_sdr, bucketed by meeting_booked_at.
 *   dials_per_mtg   = dials / meetings_booked (lower is more efficient).
 *   meeting close % = closed_won / meetings that reached a terminal-ish outcome.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function pc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function lc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

// ── ET calendar boundaries ────────────────────────────────────────────────
function etParts() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const wd = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    return { dateStr, wd };
}
function startOfTodayET() { return new Date(etParts().dateStr + 'T00:00:00-04:00'); }
function startOfWeekET() {
    const { dateStr, wd } = etParts();
    const daysSinceMon = (({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[wd] + 6) % 7;
    const d = new Date(dateStr + 'T00:00:00-04:00');
    d.setUTCDate(d.getUTCDate() - daysSinceMon);
    return d;
}
function startOfMonthET() { return new Date(etParts().dateStr.slice(0, 8) + '01' + 'T00:00:00-04:00'); }

// Which range buckets does this timestamp fall in?
function buckets(iso, tday, twk, tmon) {
    const t = new Date(iso).getTime();
    return {
        today: t >= tday,
        week: t >= twk,
        month: t >= tmon,
        all: true
    };
}
function emptyRange() { return { today: 0, week: 0, month: 0, all: 0 }; }
function addRange(r, b, n) { n = n || 1; if (b.today) r.today += n; if (b.week) r.week += n; if (b.month) r.month += n; r.all += n; }

async function pullAll(query) {
    // Paginate a select past PostgREST's 1000-row cap.
    let out = [], from = 0;
    for (;;) {
        const { data, error } = await query.range(from, from + 999);
        if (error) throw error;
        if (!data || !data.length) break;
        out = out.concat(data);
        if (data.length < 1000) break;
        from += 1000;
    }
    return out;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const prospect = lc();
    const pub = pc();

    const tday = startOfTodayET().getTime();
    const twk = startOfWeekET().getTime();
    const tmon = startOfMonthET().getTime();

    // ── roster ────────────────────────────────────────────────────────────
    const { data: roster } = await pub.from('sdr_users')
        .select('email, display_name, sdr_key, initials, avatar_color, daily_call_quota, active')
        .order('display_name');
    const reps = {};
    (roster || []).forEach(function (s) {
        reps[String(s.email).toLowerCase()] = {
            email: s.email, name: s.display_name, sdr_key: s.sdr_key,
            initials: s.initials, color: s.avatar_color,
            quota: s.daily_call_quota || 50, active: s.active !== false,
            dials: emptyRange(), connects: emptyRange(), talk_sec: emptyRange(), connected: emptyRange(),
            dial_days: new Set(),
            meetings: emptyRange(),
            mtg_outcomes: { interested: 0, needs_time: 0, rescheduled: 0, no_show: 0, closed_won: 0, closed_lost: 0 },
            closed: 0, mrr_cents: 0
        };
    });
    function rep(email) { return email ? reps[String(email).toLowerCase()] : null; }

    // ── calls (dials/connects/talk) ─────────────────────────────────────────
    const calls = await pullAll(prospect.from('lead_calls')
        .select('logged_by, direction, outcome, duration_seconds, called_at, lead_id')
        .in('direction', ['outbound', 'outgoing'])
        .order('called_at', { ascending: false }));

    const company = {
        dials: emptyRange(), connects: emptyRange(), talk_sec: emptyRange(), connected: emptyRange(),
        meetings: emptyRange(), emails: emptyRange(),
        mtg_outcomes: { interested: 0, needs_time: 0, rescheduled: 0, no_show: 0, closed_won: 0, closed_lost: 0 },
        closed: 0, mrr_cents: 0
    };
    // niche (category) performance from called leads
    const callLeadIds = new Set();
    const niche = {}; // category -> { dials, connects, meetings, callable, called_leads:Set }
    function nn(cat) { cat = cat || 'Uncategorized'; if (!niche[cat]) niche[cat] = { niche: cat, dials: 0, connects: 0, meetings: 0, callable: 0, called_leads: new Set() }; return niche[cat]; }

    const leadCat = {}; // lead_id -> category (filled below)
    for (const c of calls) {
        if (c.lead_id) callLeadIds.add(c.lead_id);
        const b = buckets(c.called_at, tday, twk, tmon);
        const answered = c.outcome === 'answered';
        addRange(company.dials, b);
        const r = rep(c.logged_by);
        if (r) {
            addRange(r.dials, b);
            const day = new Date(c.called_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            r.dial_days.add(day);
        }
        if (answered) {
            addRange(company.connects, b);
            addRange(company.connected, b);
            if (c.duration_seconds) addRange(company.talk_sec, b, c.duration_seconds);
            if (r) {
                addRange(r.connects, b); addRange(r.connected, b);
                if (c.duration_seconds) addRange(r.talk_sec, b, c.duration_seconds);
            }
        }
    }

    // ── leads: meetings + niche category lookup ─────────────────────────────
    // Category for the called leads (bounded set) + all callable leads for the
    // niche pipeline. One pull of callable + called leads.
    const bookedLeads = await pullAll(prospect.from('leads')
        .select('id, name, owner_name, category, assigned_to, has_cold_call_script, meeting_event_id, meeting_scheduled_at, meeting_booked_at, meeting_booked_by_sdr, meeting_meet_link')
        .not('meeting_scheduled_at', 'is', null));
    // meetings per rep + company, deduped by event
    const seenEvent = new Set();
    for (const l of bookedLeads) {
        const key = l.meeting_event_id || ('lead:' + l.id);
        if (seenEvent.has(key)) continue;
        seenEvent.add(key);
        const bAt = l.meeting_booked_at || l.meeting_scheduled_at;
        const b = buckets(bAt, tday, twk, tmon);
        addRange(company.meetings, b);
        const r = rep(l.meeting_booked_by_sdr);
        if (r) addRange(r.meetings, b);
        const cat = nn(l.category); cat.meetings += 1;
    }

    // callable-by-niche pipeline (leads with a script + a phone)
    const callable = await pullAll(prospect.from('leads')
        .select('id, category')
        .eq('has_cold_call_script', true));
    for (const l of callable) { nn(l.category).callable += 1; }

    // category for called leads (for niche dial/connect attribution)
    if (callLeadIds.size) {
        const ids = Array.from(callLeadIds);
        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            const { data } = await prospect.from('leads').select('id, category').in('id', chunk);
            (data || []).forEach(function (l) { leadCat[l.id] = l.category || 'Uncategorized'; });
        }
    }
    // now attribute dials/connects to niche (second pass over calls)
    for (const c of calls) {
        const cat = nn(leadCat[c.lead_id]);
        cat.dials += 1;
        if (c.lead_id) cat.called_leads.add(c.lead_id);
        if (c.outcome === 'answered') cat.connects += 1;
    }

    // ── meeting outcomes (per rep + company + niche) ────────────────────────
    const outcomes = await pullAll(prospect.from('lead_meetings')
        .select('lead_id, outcome, occurred_at')
        .not('outcome', 'is', null));
    // map lead_id -> booked_by + category for attribution
    const outIds = Array.from(new Set(outcomes.map(function (o) { return o.lead_id; }).filter(Boolean)));
    const bookedByLead = {}, catByLead = {};
    for (let i = 0; i < outIds.length; i += 500) {
        const chunk = outIds.slice(i, i + 500);
        const { data } = await prospect.from('leads').select('id, meeting_booked_by_sdr, category').in('id', chunk);
        (data || []).forEach(function (l) { bookedByLead[l.id] = l.meeting_booked_by_sdr; catByLead[l.id] = l.category; });
    }
    for (const o of outcomes) {
        if (!o.outcome || !company.mtg_outcomes.hasOwnProperty(o.outcome)) continue;
        company.mtg_outcomes[o.outcome] += 1;
        const r = rep(bookedByLead[o.lead_id]);
        if (r) r.mtg_outcomes[o.outcome] += 1;
    }

    // ── deals (closed clients + MRR) ────────────────────────────────────────
    try {
        const { data: deals } = await pub.from('deals').select('sdr_id, stage, monthly_retainer_cents');
        const { data: sdrRows } = await pub.from('sdr_users').select('id, email');
        const idToEmail = {}; (sdrRows || []).forEach(function (s) { idToEmail[s.id] = String(s.email).toLowerCase(); });
        (deals || []).forEach(function (d) {
            const isPaid = d.stage === 'LIVE' || d.stage === 'ONBOARDING';
            if (!isPaid) return;
            company.closed += 1;
            if (d.stage === 'LIVE') company.mrr_cents += Number(d.monthly_retainer_cents) || 0;
            const r = rep(idToEmail[d.sdr_id]);
            if (r) { r.closed += 1; if (d.stage === 'LIVE') r.mrr_cents += Number(d.monthly_retainer_cents) || 0; }
        });
    } catch (_) { /* deals optional */ }

    // ── emails sent ─────────────────────────────────────────────────────────
    try {
        const msgs = await pullAll(prospect.from('lead_messages').select('sent_by, sent_at').eq('channel', 'email'));
        for (const m of msgs) { addRange(company.emails, buckets(m.sent_at || new Date().toISOString(), tday, twk, tmon)); }
    } catch (_) {}

    // ── shape the response ──────────────────────────────────────────────────
    const rate = function (num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; };
    const terminalMtgs = function (o) { return o.closed_won + o.closed_lost + o.no_show; };
    function shapeRep(r) {
        const activeDays = r.dial_days.size || 1;
        const o = r.mtg_outcomes;
        return {
            name: r.name, email: r.email, sdr_key: r.sdr_key, initials: r.initials, color: r.color,
            active: r.active, quota: r.quota,
            dials: r.dials,
            avg_dials_per_day: Math.round(r.dials.all / activeDays),
            active_days: r.dial_days.size,
            connects: r.connects,
            connect_rate_pct: rate(r.connects.all, r.dials.all),
            talk_min: Math.round(r.talk_sec.all / 60),
            avg_call_sec: r.connected.all > 0 ? Math.round(r.talk_sec.all / r.connected.all) : 0,
            meetings: r.meetings,
            dials_per_meeting: r.meetings.all > 0 ? Math.round(r.dials.all / r.meetings.all) : null,
            quota_attainment_pct: rate(r.dials.today, r.quota),
            meeting_outcomes: o,
            meetings_held: terminalMtgs(o),
            no_show_rate_pct: rate(o.no_show, r.meetings.all),
            meeting_close_rate_pct: rate(o.closed_won, terminalMtgs(o)),
            closed_clients: r.closed,
            mrr_cents: r.mrr_cents
        };
    }
    const perRep = Object.values(reps).map(shapeRep)
        .sort(function (a, b) { return b.meetings.all - a.meetings.all || b.dials.all - a.dials.all; });

    const co = {
        dials: company.dials, connects: company.connects,
        connect_rate_pct: rate(company.connects.all, company.dials.all),
        talk_hours: Math.round(company.talk_sec.all / 360) / 10,
        avg_call_sec: company.connected.all > 0 ? Math.round(company.talk_sec.all / company.connected.all) : 0,
        meetings: company.meetings,
        dials_per_meeting: company.meetings.all > 0 ? Math.round(company.dials.all / company.meetings.all) : null,
        emails: company.emails,
        meeting_outcomes: company.mtg_outcomes,
        meetings_held: terminalMtgs(company.mtg_outcomes),
        meeting_close_rate_pct: rate(company.mtg_outcomes.closed_won, terminalMtgs(company.mtg_outcomes)),
        no_show_rate_pct: rate(company.mtg_outcomes.no_show, company.meetings.all),
        closed_clients: company.closed,
        mrr_cents: company.mrr_cents,
        reps_active: Object.values(reps).filter(function (r) { return r.active; }).length
    };

    const byNiche = Object.values(niche).map(function (n) {
        return {
            niche: n.niche, dials: n.dials, connect_rate_pct: rate(n.connects, n.dials),
            leads_called: n.called_leads.size, meetings: n.meetings, callable_remaining: n.callable
        };
    }).sort(function (a, b) { return b.meetings - a.meetings || b.dials - a.dials; });

    // booked-meeting list (upcoming + recent), with an outcome flag
    const outcomeByLead = {};
    for (const o of outcomes) { outcomeByLead[o.lead_id] = o.outcome; }
    const meetings = [];
    const seen2 = new Set();
    for (const l of bookedLeads) {
        const key = l.meeting_event_id || ('lead:' + l.id);
        if (seen2.has(key)) continue; seen2.add(key);
        meetings.push({
            lead_id: l.id, business: l.name, owner: l.owner_name,
            scheduled_at: l.meeting_scheduled_at, booked_by: l.meeting_booked_by_sdr,
            booked_by_name: (rep(l.meeting_booked_by_sdr) || {}).name || l.meeting_booked_by_sdr,
            meet_link: l.meeting_meet_link, niche: l.category,
            outcome: outcomeByLead[l.id] || null
        });
    }
    meetings.sort(function (a, b) { return new Date(b.scheduled_at) - new Date(a.scheduled_at); });

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json({
        generated_at: new Date().toISOString(),
        company: co,
        per_rep: perRep,
        by_niche: byNiche,
        meetings: meetings
    });
};
