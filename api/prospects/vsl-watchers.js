/**
 * GET /api/prospects/vsl-watchers[?client=blason]
 *
 * Every lead that has ever opened the Blason video page, with what they did
 * and where they stand: source (email / text / Instagram), views, play,
 * how far, quiz, contact, last seen, who it is assigned to, whether anyone
 * called after the first view, booked, next step. Bots and our own test
 * devices are filtered. Visible to every rep: the Blason pool is a shared
 * calling list (Remy, 2026-10-07: "so Ale can call all of them today").
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const BLASON = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const BOT_UA = /claude|bot|headless|crawler|spider|preview|facebookexternalhit|slackbot/i;

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    const { data: ev, error } = await pub.from('funnel_events')
        .select('lead_id,event,step,utm_source,ua,created_at')
        .eq('site', 'blason').not('lead_id', 'is', null)
        .order('created_at', { ascending: true }).limit(20000);
    if (error) return res.status(500).json({ error: error.message });

    const agg = {};
    (ev || []).forEach(function (e) {
        if (BOT_UA.test(e.ua || '')) return;
        const a = agg[e.lead_id] = agg[e.lead_id] || { views: 0, plays: 0, pct: 0, quiz: false, contact: false, booked: false, sources: {}, first: e.created_at, last: e.created_at, mobile: false };
        a.last = e.created_at;
        if (e.event === 'page_view') { a.views++; a.sources[e.utm_source || 'direct'] = (a.sources[e.utm_source || 'direct'] || 0) + 1; }
        if (e.event === 'video_play') a.plays++;
        if (e.event === 'video_progress') a.pct = Math.max(a.pct, e.step || 0);
        if (e.event === 'video_complete') a.pct = 100;
        if (e.event === 'quiz_complete') a.quiz = true;
        if (e.event === 'contact_submitted') a.contact = true;
        if (e.event === 'booked') a.booked = true;
        if (/iPhone|Android|iPad/.test(e.ua || '')) a.mobile = true;
    });
    const ids = Object.keys(agg).map(Number);
    if (!ids.length) return res.status(200).json({ ok: true, rows: [] });

    const { data: leads } = await pro.from('leads')
        .select('id,name,owner_name,phone,owner_phone,owner_phone_e164,address,primary_language,assigned_to,stage,next_step,next_step_due,meeting_booked_at,hot_at,hot_cleared_at,do_not_call,client_id')
        .in('id', ids).eq('client_id', BLASON);
    const minFirst = ids.reduce(function (m, id) { return agg[id].first < m ? agg[id].first : m; }, agg[ids[0]].first);
    const { data: calls } = await pro.from('lead_calls').select('lead_id,called_at,duration_seconds,outcome,logged_by')
        .in('lead_id', ids).eq('direction', 'outbound').gte('called_at', minFirst).order('called_at', { ascending: false });
    const lastCall = {};
    (calls || []).forEach(function (c) { if (!lastCall[c.lead_id]) lastCall[c.lead_id] = c; });

    const rows = (leads || []).filter(function (l) { return l.stage !== 'CLOSED_LOST' || !l.do_not_call; }).map(function (l) {
        const a = agg[l.id];
        const c = lastCall[l.id];
        const calledAfter = c && c.called_at > a.first ? c : null;
        const status = l.meeting_booked_at ? 'booked'
            : a.contact ? 'left their number'
            : calledAfter ? 'called ' + (calledAfter.duration_seconds >= 20 ? 'and spoke' : ', no answer')
            : 'not called yet';
        const m = String(l.address || '').match(/,\s*([^,]+),\s*FL\b/i);
        return {
            id: l.id, business: l.name, owner: l.owner_name, phone: l.owner_phone_e164 || l.owner_phone || l.phone || '',
            city: m ? m[1].trim() : '', lang: l.primary_language || 'en', assigned_to: l.assigned_to,
            first_view: a.first, last_seen: a.last, views: a.views, plays: a.plays, pct: a.pct, quiz: a.quiz, contact: a.contact,
            sources: Object.keys(a.sources).join(', '), mobile: a.mobile,
            status: status, called_at: calledAfter ? calledAfter.called_at : null, called_by: calledAfter ? calledAfter.logged_by : null,
            next_step: l.next_step || '', next_step_due: l.next_step_due, hot: !!(l.hot_at && !l.hot_cleared_at),
        };
    }).sort(function (x, y) { return (y.pct - x.pct) || (y.plays - x.plays) || (y.last_seen > x.last_seen ? 1 : -1); });
    return res.status(200).json({ ok: true, rows: rows, total: rows.length });
};
