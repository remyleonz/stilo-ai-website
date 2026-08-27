/**
 * GET /api/sdr/team-analytics   (admin only)
 *
 * One call that powers the whole Team tab AND the "Export for Claude" button.
 * Company rollup + per-rep breakdown + per-niche breakdown + coaching signals +
 * the booked-meeting list. Everything is bucketed today / week / month /
 * last_week / last_month / all so the front end switches ranges without a
 * refetch.
 *
 * ── EVERY NUMBER IS PER RANGE ────────────────────────────────────────────────
 * That was not true before. avg_call_sec, talk_hours, dials_per_meeting,
 * closed_clients, mrr_cents, meetings_held and the entire niche table were
 * all-time scalars rendered underneath a range label, so the tile read
 * "AVG CALL TIME 1:06 · 34.5h talk time" while "This week" was selected and the
 * real week figures were 1:56 and 0.7h. If you add a field, give it a range.
 *
 * ── DEFINITIONS (see _metrics.js for why) ────────────────────────────────────
 *   dial          = an OUTBOUND call a rep placed. Inbound is not a dial.
 *   contact       = a human picked up. NOT just outcome='answered' — a call
 *                   that booked a meeting or got a callback request reached a
 *                   human too. The old 'answered'-only rule threw away 828
 *                   conversations and 18.7 hours of talk.
 *   conversation  = a contact longer than 120s (past the gatekeeper).
 *   talk_time     = line time on CONTACT calls.
 *   dial_time     = line time on ALL dials, voicemail and ringing included.
 *                   This is "how long were they actually on the phone".
 *   meeting booked= distinct calendar event, credited to the canonical rep
 *                   (see _identity.js), bucketed by meeting_booked_at.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');
const R = require('./_ranges');
const M = require('./_metrics');
const ID = require('./_identity');
const { emptyRange, addRange, RANGE_KEYS } = R;

function pc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function lc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

// Pages are fetched in parallel (see _pull.js). Each caller passes a FACTORY,
// because a PostgREST builder is single-use and reusing one returns page 0
// forever.
const { pullAll: pullPages } = require('./_pull');

// sdr_type / client_account: see api/migrations/sdr_type_and_rep_e.sql,
// applied 2026-08-24.
const ROSTER_COLS = 'email, display_name, sdr_key, initials, avatar_color, daily_call_quota, active, hired_at, commission_pct, sdr_type, client_account';
function pullAll(build) {
    return pullPages(function (from, to) {
        return build().range(from, to);
    });
}

/** Per-range ratio of two range objects. */
function rateR(num, den, mult) {
    mult = mult === undefined ? 100 : mult;
    const o = {};
    for (const k of RANGE_KEYS) o[k] = den[k] > 0 ? Math.round((num[k] / den[k]) * mult * 10) / 10 : 0;
    return o;
}
/** Per-range integer division (e.g. dials per meeting). null when undefined. */
function perR(num, den) {
    const o = {};
    for (const k of RANGE_KEYS) o[k] = den[k] > 0 ? Math.round(num[k] / den[k]) : null;
    return o;
}
function sumR(a, b) {
    const o = {};
    for (const k of RANGE_KEYS) o[k] = (a[k] || 0) + (b[k] || 0);
    return o;
}
function mapR(r, fn) {
    const o = {};
    for (const k of RANGE_KEYS) o[k] = fn(r[k]);
    return o;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const prospect = lc();
    const pub = pc();
    const B = R.bounds();

    // ── Everything that does not depend on another query runs at once. These
    // used to be five sequential awaits plus a 28-page full-table scan; the tab
    // spent ~13s waiting on round trips it never needed to serialise.
    const [rosterRes, calls, bookedLeads, callableLeads, occRows, emailMsgs, dealsRes, sdrIdRes] = await Promise.all([
        pub.from('sdr_users').select(ROSTER_COLS).order('display_name'),
        pullAll(function () {
            return prospect.from('lead_calls')
                .select('logged_by, direction, outcome, duration_seconds, called_at, lead_id, transcript, recording_url', { count: 'exact' })
                .in('direction', ['outbound', 'outgoing']);
        }),
        pullAll(function () {
            return prospect.from('leads')
                .select('id, name, owner_name, category, niche, assigned_to, meeting_event_id, meeting_scheduled_at, meeting_booked_at, meeting_booked_by_sdr, meeting_meet_link, pitch_agent', { count: 'exact' })
                .not('meeting_scheduled_at', 'is', null);
        }),
        pullAll(function () {
            return prospect.from('leads')
                .select('id, category, assigned_to', { count: 'exact' })
                .eq('has_cold_call_script', true);
        }),
        pullAll(function () {
            return prospect.from('meeting_occurrences')
                .select('lead_id, outcome, occurred_at, is_meeting, has_transcript, duration_seconds', { count: 'exact' })
                .eq('is_meeting', true);
        }),
        pullAll(function () {
            return prospect.from('lead_messages')
                .select('sent_by, sent_at, direction, opened_at, clicked_at, replied_at, bounced_at', { count: 'exact' })
                .eq('channel', 'email');
        }),
        pub.from('deals').select('sdr_id, stage, monthly_retainer_cents, closed_at, paid_at'),
        pub.from('sdr_users').select('id, email')
    ]);

    const roster = rosterRes.data || [];
    const idres = ID.makeResolver(roster);

    // ── roster ────────────────────────────────────────────────────────────
    const reps = {};
    roster.forEach(function (s) {
        reps[ID.lower(s.email)] = {
            email: s.email, name: s.display_name, sdr_key: s.sdr_key,
            initials: s.initials, color: s.avatar_color,
            quota: s.daily_call_quota || 50, active: s.active !== false,
            hired_at: s.hired_at,
            // Closer = 0% commission AND not assigned to a client account.
            // The commission test alone is how the owners are modelled, but it
            // misreads an owner who steps onto a client's dial list: Remy runs
            // Blason's calls at 0% because he owns the company, not because he
            // is closing STILO deals. Without the second clause he would sit in
            // the Closers section forever, and his Blason dials would never
            // appear under that account.
            is_closer: Number(s.commission_pct) === 0 && (s.sdr_type || 'new_client') !== 'client_account',
            // Which pipeline this rep's numbers belong to. A client-account rep
            // dials a PAYING CLIENT's list and books onto the client's calendar,
            // so their meetings are not our new-business pipeline. The Team tab
            // groups on this rather than summing the two into one number that
            // means nothing. See api/migrations/sdr_type_and_rep_e.sql.
            sdr_type: s.sdr_type || 'new_client', client_account: s.client_account || null,
            dials: emptyRange(), contacts: emptyRange(), conversations: emptyRange(),
            talk_sec: emptyRange(), dial_sec: emptyRange(),
            recorded: emptyRange(), transcribed: emptyRange(),
            dial_days: R.emptySets(), leads_touched: R.emptySets(),
            meetings: emptyRange(),
            mtg_occurrences: emptyRange(), mtg_showed: emptyRange(), mtg_noshow: emptyRange(), mtg_unknown: emptyRange(),
            mtg_won: emptyRange(), mtg_lost: emptyRange(),
            emails: emptyRange(), emails_opened: emptyRange(), emails_replied: emptyRange(), emails_bounced: emptyRange(),
            closed: emptyRange(), mrr_cents: emptyRange(),
            pipeline_remaining: 0
        };
    });
    function rep(rawEmail) {
        const c = idres.canonical(rawEmail);
        return c ? reps[c] : null;
    }

    const company = {
        dials: emptyRange(), contacts: emptyRange(), conversations: emptyRange(),
        talk_sec: emptyRange(), dial_sec: emptyRange(),
        recorded: emptyRange(), transcribed: emptyRange(),
        dial_days: R.emptySets(), leads_touched: R.emptySets(),
        meetings: emptyRange(),
        mtg_occurrences: emptyRange(), mtg_showed: emptyRange(), mtg_noshow: emptyRange(), mtg_unknown: emptyRange(),
        mtg_won: emptyRange(), mtg_lost: emptyRange(),
        emails: emptyRange(), emails_opened: emptyRange(), emails_replied: emptyRange(), emails_bounced: emptyRange(),
        closed: emptyRange(), mrr_cents: emptyRange()
    };
    // Anything stamped with an actor who is not a rep. Reported, never guessed
    // at and never silently dropped, because a company total that does not
    // equal the sum of its reps is how you lose trust in the whole dashboard.
    const unattributed = { dials: 0, dial_actors: {}, meetings: 0, meeting_actors: {}, emails: 0 };

    // ── niche ─────────────────────────────────────────────────────────────
    const niche = {};
    function nn(cat) {
        cat = cat || 'Uncategorized';
        if (!niche[cat]) niche[cat] = {
            niche: cat, dials: emptyRange(), contacts: emptyRange(), meetings: emptyRange(),
            callable: 0, called_leads: R.emptySets()
        };
        return niche[cat];
    }

    // ── calls ──────────────────────────────────────────────────────────────
    const callLeadIds = new Set();
    const hourStats = {}; // ET hour -> { dials, contacts } — best-time-to-call curve
    const dowStats = {};  // ET weekday -> { dials, contacts }
    for (const c of calls) {
        if (c.lead_id) callLeadIds.add(c.lead_id);
        const b = R.buckets(c.called_at, B);
        const dur = c.duration_seconds || 0;
        const contact = M.isContact(c);
        const convo = M.isConversation(c);

        addRange(company.dials, b);
        addRange(company.dial_sec, b, dur);
        if (c.recording_url) addRange(company.recorded, b);
        if (c.transcript) addRange(company.transcribed, b);
        if (contact) {
            addRange(company.contacts, b);
            addRange(company.talk_sec, b, dur);
        }
        if (convo) addRange(company.conversations, b);

        const day = c.called_at ? new Date(c.called_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null;
        if (day) R.addSet(company.dial_days, b, day);
        if (c.lead_id) R.addSet(company.leads_touched, b, c.lead_id);

        // Coaching curves are deliberately all-time: a single week of dials is
        // too thin to say anything about what hour converts.
        if (c.called_at) {
            const d = new Date(c.called_at);
            const hr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
            const dw = d.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
            if (!hourStats[hr]) hourStats[hr] = { dials: 0, contacts: 0, talk: 0 };
            hourStats[hr].dials++; if (contact) { hourStats[hr].contacts++; hourStats[hr].talk += dur; }
            if (!dowStats[dw]) dowStats[dw] = { dials: 0, contacts: 0 };
            dowStats[dw].dials++; if (contact) dowStats[dw].contacts++;
        }

        const r = rep(c.logged_by);
        if (r) {
            addRange(r.dials, b);
            addRange(r.dial_sec, b, dur);
            if (c.recording_url) addRange(r.recorded, b);
            if (c.transcript) addRange(r.transcribed, b);
            if (contact) { addRange(r.contacts, b); addRange(r.talk_sec, b, dur); }
            if (convo) addRange(r.conversations, b);
            if (day) R.addSet(r.dial_days, b, day);
            if (c.lead_id) R.addSet(r.leads_touched, b, c.lead_id);
        } else {
            unattributed.dials += 1;
            const cl = idres.classify(c.logged_by);
            unattributed.dial_actors[cl.label] = (unattributed.dial_actors[cl.label] || 0) + 1;
        }
    }

    // ── meetings booked ────────────────────────────────────────────────────
    const seenEvent = new Set();
    for (const l of bookedLeads) {
        const key = l.meeting_event_id || ('lead:' + l.id);
        if (seenEvent.has(key)) continue;
        seenEvent.add(key);
        // Bucketed by WHEN IT WAS BOOKED, never the meeting date.
        const b = R.buckets(l.meeting_booked_at, B);
        addRange(company.meetings, b);
        const r = rep(l.meeting_booked_by_sdr);
        if (r) addRange(r.meetings, b);
        else {
            unattributed.meetings += 1;
            const cl = idres.classify(l.meeting_booked_by_sdr);
            unattributed.meeting_actors[cl.label] = (unattributed.meeting_actors[cl.label] || 0) + 1;
        }
        addRange(nn(l.category || l.niche).meetings, b);
    }

    // ── callable pipeline per niche + per rep ──────────────────────────────
    for (const l of callableLeads) {
        nn(l.category).callable += 1;
        const r = rep(l.assigned_to);
        if (r) r.pipeline_remaining += 1;
    }

    // ── lead categories for the called set ─────────────────────────────────
    // callableLeads already carries (id, category) for 3,359 leads, and most
    // leads a rep has dialled are callable, so seed the map from rows we have
    // already paid for and only go back to the database for the remainder.
    // That turns ~5 chunked round trips into 1, and often into none.
    const leadCat = {};
    callableLeads.forEach(function (l) { leadCat[l.id] = l.category || 'Uncategorized'; });
    const missing = [];
    callLeadIds.forEach(function (id) { if (leadCat[id] === undefined) missing.push(id); });

    const occIds = Array.from(new Set(occRows.map(function (o) { return o.lead_id; }).filter(Boolean)));

    function chunk500(arr) {
        const out = [];
        for (let i = 0; i < arr.length; i += 500) out.push(arr.slice(i, i + 500));
        return out;
    }
    // The category backfill and the meeting-booker lookup are independent, so
    // they go out together rather than as two sequential stages.
    const [catResults, occLeadRes] = await Promise.all([
        Promise.all(chunk500(missing).map(function (c) {
            return prospect.from('leads').select('id, category').in('id', c);
        })),
        Promise.all(chunk500(occIds).map(function (c) {
            return prospect.from('leads').select('id, meeting_booked_by_sdr, category').in('id', c);
        }))
    ]);
    catResults.forEach(function (r) {
        (r.data || []).forEach(function (l) { leadCat[l.id] = l.category || 'Uncategorized'; });
    });
    const bookedByLead = {};
    occLeadRes.forEach(function (r) {
        (r.data || []).forEach(function (l) { bookedByLead[l.id] = l.meeting_booked_by_sdr; });
    });
    for (const c of calls) {
        const b = R.buckets(c.called_at, B);
        const cat = nn(leadCat[c.lead_id]);
        addRange(cat.dials, b);
        if (c.lead_id) R.addSet(cat.called_leads, b, c.lead_id);
        if (M.isContact(c)) addRange(cat.contacts, b);
    }

    // ── meeting outcomes ───────────────────────────────────────────────────
    // Bucketed by the meeting date, both sides from meeting_occurrences, so a
    // show rate can never exceed 100%. Outcomes run through classifyOutcome so
    // the three free-text paragraphs reps wrote are read rather than discarded.
    for (const o of occRows) {
        const b = R.buckets(o.occurred_at, B);
        const r = rep(bookedByLead[o.lead_id]);
        const cls = M.classifyOutcome(o.outcome);

        const noShow = cls === 'no_show';
        // A past meeting with no outcome, no transcript and no duration is
        // unknown, not attended. Assuming attendance is what pushed show rate
        // to ~100% and made the number worthless.
        const showed = !noShow && (!!cls || o.has_transcript || o.duration_seconds);

        addRange(company.mtg_occurrences, b);
        if (r) addRange(r.mtg_occurrences, b);
        if (noShow) { addRange(company.mtg_noshow, b); if (r) addRange(r.mtg_noshow, b); }
        else if (showed) { addRange(company.mtg_showed, b); if (r) addRange(r.mtg_showed, b); }
        else { addRange(company.mtg_unknown, b); if (r) addRange(r.mtg_unknown, b); }

        if (cls === 'closed_won') { addRange(company.mtg_won, b); if (r) addRange(r.mtg_won, b); }
        else if (cls === 'closed_lost') { addRange(company.mtg_lost, b); if (r) addRange(r.mtg_lost, b); }
    }

    // ── emails (with the engagement funnel that was already in the table) ───
    // direction is filtered now. Every row is outbound today, but reply capture
    // will start writing inbound rows and they must not inflate "emails sent".
    const UNDATED = { today: false, week: false, month: false, last_week: false, last_month: false, all: true };
    for (const m of emailMsgs) {
        if (m.direction && m.direction !== 'outbound') continue;
        const b = m.sent_at ? R.buckets(m.sent_at, B) : UNDATED;
        addRange(company.emails, b);
        if (m.opened_at) addRange(company.emails_opened, b);
        if (m.replied_at) addRange(company.emails_replied, b);
        if (m.bounced_at) addRange(company.emails_bounced, b);
        const r = rep(m.sent_by);
        if (r) {
            addRange(r.emails, b);
            if (m.opened_at) addRange(r.emails_opened, b);
            if (m.replied_at) addRange(r.emails_replied, b);
            if (m.bounced_at) addRange(r.emails_bounced, b);
        } else if (m.sent_by) {
            unattributed.emails += 1;
        }
    }

    // ── deals ──────────────────────────────────────────────────────────────
    // Now bucketed by closed_at instead of being an all-time scalar shown under
    // a range label.
    try {
        const idToEmail = {};
        (sdrIdRes.data || []).forEach(function (s) { idToEmail[s.id] = ID.lower(s.email); });
        (dealsRes.data || []).forEach(function (d) {
            // The lifecycle is PROPOSAL_SENT -> INVOICE_SENT -> PAID ->
            // ONBOARDING -> LIVE (-> CHURNED). Money has arrived from PAID
            // onward; MRR counts only while the retainer is actually running.
            const isPaid = d.stage === 'PAID' || d.stage === 'ONBOARDING' || d.stage === 'LIVE';
            if (!isPaid) return;
            // closed_at, else paid_at, else all-time only. Never drop a paid
            // deal entirely just because nothing stamped a date on it.
            const when = d.closed_at || d.paid_at;
            const b = when ? R.buckets(when, B)
                : { today: false, week: false, month: false, last_week: false, last_month: false, all: true };
            addRange(company.closed, b);
            if (d.stage === 'LIVE') addRange(company.mrr_cents, b, Number(d.monthly_retainer_cents) || 0);
            const r = rep(idToEmail[d.sdr_id]);
            if (r) {
                addRange(r.closed, b);
                if (d.stage === 'LIVE') addRange(r.mrr_cents, b, Number(d.monthly_retainer_cents) || 0);
            }
        });
    } catch (_) { /* deals optional */ }

    /* ── shape ─────────────────────────────────────────────────────────────── */
    function coreMetrics(x) {
        const dialDays = R.sizesOf(x.dial_days);
        const resolved = sumR(x.mtg_showed, x.mtg_noshow);
        const decided = sumR(x.mtg_won, x.mtg_lost);
        return {
            dials: x.dials,
            // THE ASK: total time on the phone for the selected period, as both
            // raw seconds and a preformatted h/m string.
            dial_time_sec: x.dial_sec,
            dial_time_label: mapR(x.dial_sec, hm),
            talk_time_sec: x.talk_sec,
            talk_time_label: mapR(x.talk_sec, hm),
            talk_hours: mapR(x.talk_sec, function (s) { return Math.round(s / 360) / 10; }),

            contacts: x.contacts,
            connect_rate_pct: rateR(x.contacts, x.dials),
            conversations: x.conversations,
            conversation_rate_pct: rateR(x.conversations, x.dials),
            avg_call_sec: perR(x.talk_sec, x.contacts),
            avg_dial_sec: perR(x.dial_sec, x.dials),

            active_days: dialDays,
            dials_per_active_day: perR(x.dials, dialDays),
            leads_touched: R.sizesOf(x.leads_touched),
            dials_per_lead: (function () {
                const lt = R.sizesOf(x.leads_touched); const o = {};
                for (const k of RANGE_KEYS) o[k] = lt[k] > 0 ? Math.round((x.dials[k] / lt[k]) * 10) / 10 : 0;
                return o;
            })(),

            meetings: x.meetings,
            booked_per_dial_pct: rateR(x.meetings, x.dials),
            booked_per_conversation_pct: rateR(x.meetings, x.conversations),
            dials_per_meeting: perR(x.dials, x.meetings),
            // How many hours of phone time it costs to produce one meeting.
            hours_per_meeting: (function () {
                const o = {};
                for (const k of RANGE_KEYS) o[k] = x.meetings[k] > 0 ? Math.round((x.dial_sec[k] / 3600 / x.meetings[k]) * 10) / 10 : null;
                return o;
            })(),

            meetings_occurred: x.mtg_occurrences,
            meetings_showed: x.mtg_showed,
            meetings_noshow: x.mtg_noshow,
            meetings_unknown: x.mtg_unknown,
            show_rate_pct: rateR(x.mtg_showed, resolved),
            no_show_rate_pct: rateR(x.mtg_noshow, x.mtg_occurrences),
            meeting_close_rate_pct: rateR(x.mtg_won, decided),
            meetings_won: x.mtg_won,
            meetings_lost: x.mtg_lost,

            emails: x.emails,
            emails_opened: x.emails_opened,
            emails_replied: x.emails_replied,
            emails_bounced: x.emails_bounced,
            email_open_rate_pct: rateR(x.emails_opened, x.emails),
            email_reply_rate_pct: rateR(x.emails_replied, x.emails),
            email_bounce_rate_pct: rateR(x.emails_bounced, x.emails),

            calls_recorded: x.recorded,
            calls_transcribed: x.transcribed,

            closed_clients: x.closed,
            mrr_cents: x.mrr_cents
        };
    }
    function hm(sec) {
        sec = Math.round(sec || 0);
        const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
        return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    }

    const perRep = Object.values(reps).map(function (r) {
        const m = coreMetrics(r);
        m.name = r.name; m.email = r.email; m.sdr_key = r.sdr_key;
        m.initials = r.initials; m.color = r.color; m.active = r.active;
        m.quota = r.quota; m.hired_at = r.hired_at; m.is_closer = r.is_closer;
        m.sdr_type = r.sdr_type; m.client_account = r.client_account;
        m.quota_attainment_pct = rateR(r.dials, { today: r.quota, week: r.quota * 5, month: r.quota * 21, last_week: r.quota * 5, last_month: r.quota * 21, all: r.quota });
        m.pipeline_remaining = r.pipeline_remaining;
        // Days of callable leads left at this rep's current pace. The earliest
        // warning you get that a rep is about to run out of people to call.
        const perDay = m.dials_per_active_day.month || m.dials_per_active_day.all || 0;
        m.pipeline_days_left = perDay > 0 ? Math.round(r.pipeline_remaining / perDay) : null;
        return m;
    }).sort(function (a, b) { return b.meetings.all - a.meetings.all || b.dials.all - a.dials.all; });

    const co = coreMetrics(company);
    co.reps_active = Object.values(reps).filter(function (r) { return r.active; }).length;
    co.pipeline_remaining = callableLeads.length;

    const byNiche = Object.values(niche).map(function (n) {
        return {
            niche: n.niche,
            dials: n.dials,
            connect_rate_pct: rateR(n.contacts, n.dials),
            leads_called: R.sizesOf(n.called_leads),
            meetings: n.meetings,
            dials_per_meeting: perR(n.dials, n.meetings),
            callable_remaining: n.callable
        };
    }).sort(function (a, b) { return b.meetings.all - a.meetings.all || b.dials.all - a.dials.all; });

    // ── coaching curves (all-time by design; a week is too thin) ────────────
    const byHour = Object.keys(hourStats).sort().map(function (h) {
        const s = hourStats[h];
        return {
            hour: Number(h), label: hourLabel(Number(h)), dials: s.dials, contacts: s.contacts,
            connect_rate_pct: s.dials ? Math.round((s.contacts / s.dials) * 1000) / 10 : 0,
            avg_talk_sec: s.contacts ? Math.round(s.talk / s.contacts) : 0
        };
    });
    const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const byDow = DOW.filter(function (d) { return dowStats[d]; }).map(function (d) {
        const s = dowStats[d];
        return { day: d, dials: s.dials, contacts: s.contacts, connect_rate_pct: s.dials ? Math.round((s.contacts / s.dials) * 1000) / 10 : 0 };
    });
    function hourLabel(h) {
        const ampm = h < 12 ? 'am' : 'pm';
        const hh = h % 12 === 0 ? 12 : h % 12;
        return hh + ampm;
    }

    // ── booked-meeting list ────────────────────────────────────────────────
    const outcomeByLead = {};
    for (const o of occRows) {
        if (!o.lead_id) continue;
        const prev = outcomeByLead[o.lead_id];
        if (!prev || new Date(o.occurred_at) > new Date(prev.at)) {
            outcomeByLead[o.lead_id] = { outcome: M.classifyOutcome(o.outcome), at: o.occurred_at };
        }
    }
    const meetings = [];
    const seen2 = new Set();
    for (const l of bookedLeads) {
        const key = l.meeting_event_id || ('lead:' + l.id);
        if (seen2.has(key)) continue; seen2.add(key);
        const canon = idres.canonical(l.meeting_booked_by_sdr);
        meetings.push({
            lead_id: l.id, business: l.name, owner: l.owner_name,
            scheduled_at: l.meeting_scheduled_at, booked_at: l.meeting_booked_at,
            booked_by: canon || l.meeting_booked_by_sdr,
            booked_by_name: canon ? reps[canon].name : idres.classify(l.meeting_booked_by_sdr).label,
            attributed: !!canon,
            meet_link: l.meeting_meet_link, niche: l.category || l.niche,
            pitch_agent: l.pitch_agent,
            outcome: (outcomeByLead[l.id] || {}).outcome || null
        });
    }
    meetings.sort(function (a, b) { return new Date(b.scheduled_at) - new Date(a.scheduled_at); });

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
        generated_at: new Date().toISOString(),
        company: co,
        per_rep: perRep,
        by_niche: byNiche,
        by_hour: byHour,
        by_dow: byDow,
        meetings: meetings,
        unattributed: unattributed,
        definitions: {
            dial: 'An outbound call a rep placed. Inbound calls are not dials.',
            contact: 'A human picked up: outcome is answered, callback_requested, booked_meeting, owner_uninterested or do_not_call. Voicemail and no-answer are not contacts.',
            conversation: 'A contact longer than 120 seconds — past the gatekeeper.',
            talk_time: 'Line time on contact calls only.',
            dial_time: 'Line time across every dial, including voicemail and ringing.',
            meeting: 'A distinct calendar event, credited to the rep who booked it, counted in the period it was BOOKED.',
            show_rate: 'Of meetings that have come round and resolved, how many the prospect attended.'
        }
    });
};
