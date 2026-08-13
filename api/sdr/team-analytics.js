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
// assertAdminOrSdr lives in the prospects shared module (api/sdr/_shared only
// exports authSdr) — importing it from ./_shared made this endpoint 500.
const { assertAdminOrSdr, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

function pc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function lc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

// ── ET calendar boundaries ────────────────────────────────────────────────
// Shared with closer-analytics via ./_ranges so every card on the Team tab
// agrees on what "last week" means. The local copies here only had
// today/week/month, which is why the admin UI folded last_week onto week and
// showed the current week's numbers under a "Last week" label.
const R = require('./_ranges');
const { emptyRange, addRange } = R;

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

    const B = R.bounds();

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
            dials: emptyRange(), connects: emptyRange(), conversations: emptyRange(), talk_sec: emptyRange(), connected: emptyRange(),
            dial_days: new Set(),
            meetings: emptyRange(),
            mtg_outcomes: { interested: 0, needs_time: 0, rescheduled: 0, no_show: 0, closed_won: 0, closed_lost: 0 },
            mtg_occurrences: emptyRange(), mtg_showed: emptyRange(), mtg_noshow: emptyRange(), mtg_unknown: emptyRange(),
            mtg_won: emptyRange(), mtg_lost: emptyRange(),
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
        dials: emptyRange(), connects: emptyRange(), conversations: emptyRange(), talk_sec: emptyRange(), connected: emptyRange(),
        meetings: emptyRange(), emails: emptyRange(),
        mtg_outcomes: { interested: 0, needs_time: 0, rescheduled: 0, no_show: 0, closed_won: 0, closed_lost: 0 },
        mtg_occurrences: emptyRange(), mtg_showed: emptyRange(), mtg_noshow: emptyRange(), mtg_unknown: emptyRange(),
        mtg_won: emptyRange(), mtg_lost: emptyRange(),
        closed: 0, mrr_cents: 0
    };
    // niche (category) performance from called leads
    const callLeadIds = new Set();
    const niche = {}; // category -> { dials, connects, meetings, callable, called_leads:Set }
    function nn(cat) { cat = cat || 'Uncategorized'; if (!niche[cat]) niche[cat] = { niche: cat, dials: 0, connects: 0, meetings: 0, callable: 0, called_leads: new Set() }; return niche[cat]; }

    const leadCat = {}; // lead_id -> category (filled below)
    for (const c of calls) {
        if (c.lead_id) callLeadIds.add(c.lead_id);
        const b = R.buckets(c.called_at, B);
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
            // A "conversation" = a real talk past the gatekeeper: answered AND
            // longer than 2 minutes. Proxy for reaching the decision-maker.
            if ((c.duration_seconds || 0) > 120) {
                addRange(company.conversations, b);
                if (r) addRange(r.conversations, b);
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
        // Bucket by WHEN THE REP BOOKED IT, never by the meeting date. No
        // fallback to meeting_scheduled_at — that would count a meeting in the
        // period it's HELD, not booked (the "why does Luke show meetings
        // scheduled-this-week" bug). A meeting missing booked_at counts only in
        // all-time (buckets(null) → all:true, periods:false), never a wrong week.
        const b = R.buckets(l.meeting_booked_at, B);
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
    // Reads meeting_occurrences, NOT lead_meetings. lead_meetings holds one row
    // per artifact (booking, call, transcript, note, manual outcome), so a lead
    // with four outcome logs counted four times here while the denominator
    // counted one booking. That mismatch is why Luke showed a 150% held rate.
    //
    // An SDR does not hold meetings, they book them. So what this measures for
    // a rep is booking QUALITY: of the meetings they set, how many did the
    // prospect actually turn up to. Numerator and denominator both come from
    // occurrences and are bucketed by the meeting date, so it cannot exceed 100%.
    const occRows = await pullAll(prospect.from('meeting_occurrences')
        .select('lead_id, outcome, occurred_at, is_meeting, has_transcript, duration_seconds')
        .eq('is_meeting', true));
    const occIds = Array.from(new Set(occRows.map(function (o) { return o.lead_id; }).filter(Boolean)));
    const bookedByLead = {}, catByLead = {};
    for (let i = 0; i < occIds.length; i += 500) {
        const chunk = occIds.slice(i, i + 500);
        const { data } = await prospect.from('leads').select('id, meeting_booked_by_sdr, category').in('id', chunk);
        (data || []).forEach(function (l) { bookedByLead[l.id] = l.meeting_booked_by_sdr; catByLead[l.id] = l.category; });
    }
    const NOSHOW_OC = ['no_show', 'noshow'];
    for (const o of occRows) {
        const b = R.buckets(o.occurred_at, B);
        const r = rep(bookedByLead[o.lead_id]);
        const oc = String(o.outcome || '').toLowerCase().trim();

        // Same evidence rule the closer cards use: a past meeting with no
        // outcome, no transcript and no duration is unknown, not attended.
        const noShow = NOSHOW_OC.indexOf(oc) !== -1;
        const showed = !noShow && (!!oc || o.has_transcript || o.duration_seconds);

        addRange(company.mtg_occurrences, b);
        if (r) addRange(r.mtg_occurrences, b);
        if (noShow) { addRange(company.mtg_noshow, b); if (r) addRange(r.mtg_noshow, b); }
        else if (showed) { addRange(company.mtg_showed, b); if (r) addRange(r.mtg_showed, b); }
        else { addRange(company.mtg_unknown, b); if (r) addRange(r.mtg_unknown, b); }

        if (o.outcome && company.mtg_outcomes.hasOwnProperty(o.outcome)) {
            company.mtg_outcomes[o.outcome] += 1;
            if (r) r.mtg_outcomes[o.outcome] += 1;
        }
        if (oc === 'closed_won') { addRange(company.mtg_won, b); if (r) addRange(r.mtg_won, b); }
        else if (oc === 'closed_lost') { addRange(company.mtg_lost, b); if (r) addRange(r.mtg_lost, b); }
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
        // sent_at is null on older rows. They belong in the all-time total but
        // in no dated bucket; the previous code substituted new Date(), which
        // stamped every undated email onto "today".
        const UNDATED = { today: false, week: false, month: false, last_week: false, last_month: false, all: true };
        for (const m of msgs) { addRange(company.emails, m.sent_at ? R.buckets(m.sent_at, B) : UNDATED); }
    } catch (_) {}

    // ── shape the response ──────────────────────────────────────────────────
    const rate = function (num, den) { return den > 0 ? Math.round((num / den) * 1000) / 10 : 0; };
    // Per-range version. Held% and Close% used to be all-time scalars, so they
    // ignored the range slider entirely while every column beside them moved.
    const rateR = function (num, den) {
        const o = {};
        for (const k of R.RANGE_KEYS) o[k] = (den[k] > 0) ? Math.round((num[k] / den[k]) * 1000) / 10 : 0;
        return o;
    };
    // "Held" = the prospect showed up and engaged (won/lost/interested/needs_time).
    // no_show and rescheduled did NOT hold; upcoming hasn't happened yet. Held rate
    // depends on reps logging meeting outcomes (Data Health flags the gaps).
    const heldCount = function (o) { return o.closed_won + o.closed_lost + o.interested + o.needs_time; };
    function shapeRep(r) {
        const activeDays = r.dial_days.size || 1;
        const o = r.mtg_outcomes;
        const held = heldCount(o);
        return {
            name: r.name, email: r.email, sdr_key: r.sdr_key, initials: r.initials, color: r.color,
            active: r.active, quota: r.quota,
            dials: r.dials,
            avg_dials_per_day: Math.round(r.dials.all / activeDays),
            active_days: r.dial_days.size,
            connects: r.connects,
            connect_rate_pct: rate(r.connects.all, r.dials.all),
            conversations: r.conversations,
            conversation_rate_pct: rate(r.conversations.all, r.dials.all),
            talk_min: Math.round(r.talk_sec.all / 60),
            avg_call_sec: r.connected.all > 0 ? Math.round(r.talk_sec.all / r.connected.all) : 0,
            meetings: r.meetings,
            booked_per_dial_pct: rate(r.meetings.all, r.dials.all),
            booked_per_conversation_pct: rate(r.meetings.all, r.conversations.all),
            dials_per_meeting: r.meetings.all > 0 ? Math.round(r.dials.all / r.meetings.all) : null,
            quota_attainment_pct: rate(r.dials.today, r.quota),
            meeting_outcomes: o,
            // An SDR books meetings, they do not hold them. What this measures
            // is booking QUALITY: of the meetings they set that have since come
            // round, how many the prospect actually turned up to. Both sides are
            // occurrences bucketed by meeting date, so it cannot exceed 100%.
            meetings_occurred: r.mtg_occurrences,
            meetings_showed: r.mtg_showed,
            meetings_noshow: r.mtg_noshow,
            meetings_unknown: r.mtg_unknown,
            meetings_held: held,
            show_rate_pct: rateR(r.mtg_showed, { today: r.mtg_showed.today + r.mtg_noshow.today, week: r.mtg_showed.week + r.mtg_noshow.week, month: r.mtg_showed.month + r.mtg_noshow.month, last_week: r.mtg_showed.last_week + r.mtg_noshow.last_week, last_month: r.mtg_showed.last_month + r.mtg_noshow.last_month, all: r.mtg_showed.all + r.mtg_noshow.all }),
            no_show_rate_pct: rateR(r.mtg_noshow, r.mtg_occurrences),
            meeting_close_rate_pct: rateR(r.mtg_won, { today: r.mtg_won.today + r.mtg_lost.today, week: r.mtg_won.week + r.mtg_lost.week, month: r.mtg_won.month + r.mtg_lost.month, last_week: r.mtg_won.last_week + r.mtg_lost.last_week, last_month: r.mtg_won.last_month + r.mtg_lost.last_month, all: r.mtg_won.all + r.mtg_lost.all }),
            closed_clients: r.closed,
            mrr_cents: r.mrr_cents
        };
    }
    const perRep = Object.values(reps).map(shapeRep)
        .sort(function (a, b) { return b.meetings.all - a.meetings.all || b.dials.all - a.dials.all; });

    const coHeld = heldCount(company.mtg_outcomes);
    const co = {
        dials: company.dials, connects: company.connects,
        connect_rate_pct: rateR(company.connects, company.dials),
        conversations: company.conversations,
        conversation_rate_pct: rateR(company.conversations, company.dials),
        talk_hours: Math.round(company.talk_sec.all / 360) / 10,
        avg_call_sec: company.connected.all > 0 ? Math.round(company.talk_sec.all / company.connected.all) : 0,
        meetings: company.meetings,
        booked_per_dial_pct: rateR(company.meetings, company.dials),
        booked_per_conversation_pct: rateR(company.meetings, company.conversations),
        dials_per_meeting: company.meetings.all > 0 ? Math.round(company.dials.all / company.meetings.all) : null,
        emails: company.emails,
        meeting_outcomes: company.mtg_outcomes,
        // Company-wide averages across every closer, per range. The no-show
        // rate is deliberately a company number: there is more than one closer,
        // so the average is the useful figure.
        meetings_occurred: company.mtg_occurrences,
        meetings_showed: company.mtg_showed,
        meetings_noshow: company.mtg_noshow,
        meetings_unknown: company.mtg_unknown,
        meetings_held: coHeld,
        show_rate_pct: rateR(company.mtg_showed, { today: company.mtg_showed.today + company.mtg_noshow.today, week: company.mtg_showed.week + company.mtg_noshow.week, month: company.mtg_showed.month + company.mtg_noshow.month, last_week: company.mtg_showed.last_week + company.mtg_noshow.last_week, last_month: company.mtg_showed.last_month + company.mtg_noshow.last_month, all: company.mtg_showed.all + company.mtg_noshow.all }),
        no_show_rate_pct: rateR(company.mtg_noshow, company.mtg_occurrences),
        meeting_close_rate_pct: rateR(company.mtg_won, { today: company.mtg_won.today + company.mtg_lost.today, week: company.mtg_won.week + company.mtg_lost.week, month: company.mtg_won.month + company.mtg_lost.month, last_week: company.mtg_won.last_week + company.mtg_lost.last_week, last_month: company.mtg_won.last_month + company.mtg_lost.last_month, all: company.mtg_won.all + company.mtg_lost.all }),
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
    // occRows replaced the old `outcomes` pull (which read lead_meetings, one
    // row per artifact). Take the most recent occurrence's outcome per lead.
    const outcomeByLead = {};
    for (const o of occRows) {
        if (!o.lead_id) continue;
        const prev = outcomeByLead[o.lead_id];
        if (!prev || new Date(o.occurred_at) > new Date(prev.at)) {
            outcomeByLead[o.lead_id] = { outcome: o.outcome, at: o.occurred_at };
        }
    }
    Object.keys(outcomeByLead).forEach(function (k) { outcomeByLead[k] = outcomeByLead[k].outcome; });
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
