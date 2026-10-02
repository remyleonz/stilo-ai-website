/**
 * GET /api/admin/clients/funnel?client_id=<uuid>&days=30
 *
 * The VSL landing-page funnel for one client, read from public.funnel_events
 * and public.funnel_submissions (api/public/_funnel.js). Two halves:
 *
 *   numbers   sessions (all / human), video plays, 50% and 75% marks, quiz
 *             starts, how many sessions reached each of the 5 questions,
 *             contact submits, bookings, plus the answer distribution per
 *             question. Humans only unless ?bots=1: a session whose user agent
 *             is a known scanner or stub is excluded the same way the VSL
 *             watch alert excludes them.
 *   worklist  one row per session Remy can act on: every session tied to a
 *             lead (signed link or form submit), furthest step reached, when,
 *             the lead's name and phones, the quiz answers. Sorted hottest
 *             first (booked > contact > quiz complete > deep quiz > play >
 *             view). Anonymous human sessions are counted, not listed: there
 *             is nobody to call.
 *
 * Auth: admin JWT (assertAdmin). Client scoped: the site is derived from the
 * client id, so a Blason admin call can never read another site's funnel.
 */
const { assertAdmin, methodNotAllowed } = require('../../prospects/_shared');
const F = require('../../public/_funnel');

const SITE_BY_CLIENT = Object.keys(F.SITES).reduce(function (o, k) { o[F.SITES[k].client_id] = k; return o; }, {});
const RANK = { booking_confirmed: 7, contact_submitted: 6, quiz_complete: 5, quiz_step: 4, contact_view: 5, calendar_open: 6, video_complete: 3, video_progress: 3, video_play: 2, quiz_start: 2, cta_click: 1, page_view: 0, lang_switch: 0 };

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const clientId = req.query && req.query.client_id;
    const site = SITE_BY_CLIENT[clientId];
    if (!site) return res.status(200).json({ ok: true, site: null, numbers: null, worklist: [], note: 'no_funnel_for_client' });
    const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '30', 10) || 30, 1), 180);
    const includeBots = String(req.query && req.query.bots || '') === '1';
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const pub = F.sbPublic();
    const pros = F.sbProspecting();

    // Events (bounded; the page emits a dozen rows per real visit)
    const events = [];
    for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await pub.from('funnel_events')
            .select('id,created_at,session_id,visitor_id,lead_id,lead_claimed,event,step,answer,meta,lang,ua,utm_source,utm_campaign,referrer')
            .eq('site', site).gte('created_at', since).order('created_at', { ascending: true }).range(from, from + 999);
        if (error) return res.status(500).json({ error: 'events_read_failed', detail: error.message });
        events.push.apply(events, data || []);
        if (!data || data.length < 1000) break;
    }
    const { data: subs } = await pub.from('funnel_submissions')
        .select('id,created_at,session_id,lead_id,lead_created,name,business,phone,email,lang,segment,interest,medical,timeline,quoted,motive,path_pref,booked_at,meeting_at')
        .eq('site', site).gte('created_at', since).order('created_at', { ascending: false }).limit(2000);

    // --- sessions ---------------------------------------------------------------
    const sessions = {};
    events.forEach(function (e) {
        const k = e.session_id || ('anon-' + e.id);
        let s = sessions[k];
        if (!s) {
            s = sessions[k] = { session_id: k, visitor_id: e.visitor_id, lead_id: null, first: e.created_at, last: e.created_at, ua: e.ua, lang: e.lang,
                utm_source: e.utm_source, utm_campaign: e.utm_campaign, referrer: e.referrer, events: [], rank: -1, furthest: 'view', maxStep: 0, pct: 0, answers: {}, bot: null };
            s.bot = F.botReason(e.ua);
        }
        s.last = e.created_at;
        if (e.lead_id != null && e.lead_claimed) s.lead_id = e.lead_id;
        if (e.lang) s.lang = e.lang;
        s.events.push(e.event);
        if (e.event === 'quiz_step' && e.step) { s.maxStep = Math.max(s.maxStep, e.step); if (e.meta && e.meta.q && e.answer) s.answers[e.meta.q] = e.answer; }
        if (e.event === 'video_progress' && e.step) s.pct = Math.max(s.pct, e.step);
        if (e.event === 'video_complete') s.pct = 100;
        const r = RANK[e.event] == null ? 0 : RANK[e.event];
        if (r > s.rank) { s.rank = r; s.furthest = e.event; }
    });
    const subBySession = {};
    (subs || []).forEach(function (x) { if (x.session_id && !subBySession[x.session_id]) subBySession[x.session_id] = x; });

    const all = Object.keys(sessions).map(function (k) { return sessions[k]; });
    const human = all.filter(function (s) { return includeBots || !s.bot; });

    function count(pred) { return human.filter(pred).length; }
    const has = function (ev) { return function (s) { return s.events.indexOf(ev) !== -1; }; };
    const numbers = {
        days: days,
        sessions_all: all.length,
        sessions: human.length,
        visitors: new Set(human.map(function (s) { return s.visitor_id || s.session_id; })).size,
        known_leads: new Set(human.filter(function (s) { return s.lead_id != null; }).map(function (s) { return s.lead_id; })).size,
        plays: count(has('video_play')),
        video_50: count(function (s) { return s.pct >= 50; }),
        video_75: count(function (s) { return s.pct >= 75; }),
        video_done: count(has('video_complete')),
        cta_clicks: count(has('cta_click')),
        quiz_start: count(has('quiz_start')),
        steps: [1, 2, 3, 4, 5].map(function (n) { return count(function (s) { return s.maxStep >= n; }); }),
        quiz_complete: count(has('quiz_complete')),
        contact_view: count(has('contact_view')),
        contacts: count(has('contact_submitted')),
        calendar_open: count(has('calendar_open')),
        bookings: count(has('booking_confirmed')),
        bots_excluded: all.length - human.length,
        by_lang: human.reduce(function (o, s) { const l = s.lang || 'en'; o[l] = (o[l] || 0) + 1; return o; }, {}),
        answers: F.QUIZ_KEYS.reduce(function (o, q) {
            const dist = {};
            human.forEach(function (s) { const v = s.answers[q]; if (v) dist[v] = (dist[v] || 0) + 1; });
            o[q] = Object.keys(dist).sort(function (a, b) { return dist[b] - dist[a]; }).map(function (k) { return { key: k, label: F.label(q, k), n: dist[k] }; });
            return o;
        }, {}),
        by_day: (function () {
            const d = {};
            human.forEach(function (s) {
                const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(s.first));
                const row = d[day] || (d[day] = { day: day, sessions: 0, plays: 0, quiz_complete: 0, contacts: 0, bookings: 0 });
                row.sessions++;
                if (s.events.indexOf('video_play') !== -1) row.plays++;
                if (s.events.indexOf('quiz_complete') !== -1) row.quiz_complete++;
                if (s.events.indexOf('contact_submitted') !== -1) row.contacts++;
                if (s.events.indexOf('booking_confirmed') !== -1) row.bookings++;
            });
            return Object.keys(d).sort().map(function (k) { return d[k]; });
        })(),
    };

    // --- worklist ----------------------------------------------------------------
    const actionable = human.filter(function (s) { return s.lead_id != null || subBySession[s.session_id]; });
    const leadIds = Array.from(new Set(actionable.map(function (s) { return s.lead_id || (subBySession[s.session_id] || {}).lead_id; }).filter(function (x) { return x != null; })));
    const leads = {};
    for (let i = 0; i < leadIds.length; i += 200) {
        const { data } = await pros.from('leads')
            .select('id,name,owner_name,owner_phone,phone,owner_email,stage,last_called_at,last_called_outcome,next_step,meeting_scheduled_at,primary_language,address,category')
            .in('id', leadIds.slice(i, i + 200));
        (data || []).forEach(function (l) { leads[l.id] = l; });
    }
    const worklist = actionable.map(function (s) {
        const sub = subBySession[s.session_id] || null;
        const lid = s.lead_id || (sub && sub.lead_id) || null;
        const L = leads[lid] || null;
        const answers = Object.assign({}, s.answers, sub ? { interest: sub.interest, quoted: sub.quoted, medical: sub.medical, motive: sub.motive, path_pref: sub.path_pref, segment: sub.segment, timeline: sub.timeline } : {});
        Object.keys(answers).forEach(function (k) { if (!answers[k]) delete answers[k]; });
        return {
            session_id: s.session_id, lead_id: lid, first_seen: s.first, last_seen: s.last, lang: s.lang || 'en',
            furthest: s.furthest, rank: s.rank, quiz_step: s.maxStep, video_pct: s.pct,
            answers: answers,
            answers_labels: Object.keys(answers).map(function (k) { return F.label(k, answers[k]); }),
            contact: sub ? { name: sub.name, business: sub.business, phone: sub.phone, email: sub.email, booked_at: sub.booked_at, meeting_at: sub.meeting_at } : null,
            lead: L ? { id: L.id, name: L.name, owner_name: L.owner_name, owner_phone: L.owner_phone, phone: L.phone, owner_email: L.owner_email, stage: L.stage,
                last_called_at: L.last_called_at, last_called_outcome: L.last_called_outcome, next_step: L.next_step, meeting_scheduled_at: L.meeting_scheduled_at, category: L.category } : null,
            utm_source: s.utm_source, utm_campaign: s.utm_campaign,
        };
    }).sort(function (a, b) { return (b.rank - a.rank) || (new Date(b.last_seen) - new Date(a.last_seen)); });

    return res.status(200).json({ ok: true, site: site, numbers: numbers, worklist: worklist, anonymous_sessions: human.length - actionable.length, labels: F.LABELS });
};
