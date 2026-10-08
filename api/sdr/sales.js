/**
 * GET /api/sdr/sales?range=today|7d|30d[&sdr_id=] (admin may pick a rep)
 *
 * The rep's Sales tab: everything that happened on THEIR leads, by channel,
 * so a rep (and Remy looking at a rep) sees the whole funnel on one screen.
 * Attribution rule: a lead belongs to leads.assigned_to; calls are the rep's
 * own dials (lead_calls.logged_by); emails and texts count when they went out
 * on the rep's behalf (lead_messages.sent_by = rep OR the lead is theirs and
 * the send was automated); replies and video watches count on the rep's leads.
 *
 * Returns { range, since, sdr, cards: {...}, warm_response: {...} }
 */
const { authSdr, resolveScope, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function pro() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function pub() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function sinceFor(range) {
    const now = new Date();
    if (range === '7d') return new Date(now.getTime() - 7 * 86400000);
    if (range === '30d') return new Date(now.getTime() - 30 * 86400000);
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const off = now.getTime() - et.getTime(); et.setHours(0, 0, 0, 0);
    return new Date(et.getTime() + off);
}
const BOT_UA = /claude|bot|headless|crawler|spider|preview|facebookexternalhit|slackbot/i;

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const caller = await authSdr(req, res);
    if (!caller.ok) return;
    const scope = await resolveScope(req, caller);
    const sdr = scope.sdr;
    if (!sdr || !sdr.email) return res.status(400).json({ error: 'sdr_scope_required' });
    const email = String(sdr.email).toLowerCase();
    const range = ['today', '7d', '30d'].indexOf(req.query.range) >= 0 ? req.query.range : '7d';
    const since = sinceFor(range).toISOString();
    const db = pro(), pb = pub();

    // The rep's book: ids + tiers in one read (ids feed every other query).
    // Client-account reps are scoped to their client's pool, same as the board.
    let clientId = null;
    try { clientId = await require('../prospects/_shared').resolveClientScope(email); } catch (_) {}
    let bq = db.from('leads').select('id,engagement_tier,hot_at,hot_cleared_at,meeting_scheduled_at,last_called_outcome').eq('assigned_to', email).limit(5000);
    if (clientId) bq = bq.eq('client_id', clientId);
    const { data: book } = await bq;
    const ids = (book || []).map(function (l) { return l.id; });
    const tiers = { cold: 0, warm: 0, hot: 0 };
    (book || []).forEach(function (l) { tiers[l.engagement_tier || 'cold'] = (tiers[l.engagement_tier || 'cold'] || 0) + 1; });
    const inIds = function (q) { return ids.length ? q.in('lead_id', ids) : q.eq('lead_id', -1); };

    const [calls, msgs, inbound, ig, funnel, sales] = await Promise.all([
        db.from('lead_calls').select('lead_id,called_at,duration_seconds,outcome,decision_maker,direction').eq('logged_by', email).gte('called_at', since).limit(5000),
        inIds(db.from('lead_messages').select('lead_id,channel,direction,sent_by,sent_at,replied_at,opened_at,bounced_at').eq('direction', 'outbound').gte('sent_at', since).limit(10000)),
        inIds(db.from('lead_messages').select('lead_id,channel,sent_at').eq('direction', 'inbound').gte('sent_at', since).limit(5000)),
        db.from('ig_dm_queue').select('id,lead_id,status,sent_at,replied_at,booked_at,sent_by,assigned_to').or('sent_by.eq.' + email + ',assigned_to.eq.' + email).limit(5000),
        inIds(pb.from('funnel_events').select('lead_id,event,ua,created_at').eq('site', 'blason').gte('created_at', since).limit(10000)),
        inIds(db.from('client_sales').select('lead_id,sale_amount,commission_amount,sold_at').gte('sold_at', since.slice(0, 10)).limit(500)),
    ]);

    const c = (calls.data || []).filter(function (x) { return x.direction !== 'inbound'; });
    const dials = c.length, connects = c.filter(function (x) { return (x.duration_seconds || 0) >= 20; }).length;
    const dms = c.filter(function (x) { return x.decision_maker === true; }).length;
    const callbacks = c.filter(function (x) { return ['callback_requested', 'interested_followup'].indexOf(x.outcome) >= 0; }).length;
    const bookedCalls = c.filter(function (x) { return x.outcome === 'booked_meeting'; }).length;
    const em = (msgs.data || []).filter(function (m) { return m.channel === 'email'; });
    const sm = (msgs.data || []).filter(function (m) { return m.channel === 'sms'; });
    const emailReplies = em.filter(function (m) { return m.replied_at; }).length;
    const smsReplies = (inbound.data || []).filter(function (m) { return m.channel === 'sms'; }).length;
    const igRows = (ig.data || []);
    const igSent = igRows.filter(function (r) { return r.sent_at && r.sent_at >= since; }).length;
    const igReplied = igRows.filter(function (r) { return r.replied_at && r.replied_at >= since && ['replied', 'booked'].indexOf(r.status) >= 0; }).length;
    const igBooked = igRows.filter(function (r) { return r.booked_at && r.booked_at >= since; }).length;
    const igQueued = igRows.filter(function (r) { return r.status === 'queued' && r.assigned_to === email; }).length;
    const fe = (funnel.data || []).filter(function (e) { return !BOT_UA.test(e.ua || ''); });
    const watchers = new Set(fe.filter(function (e) { return e.event === 'page_view'; }).map(function (e) { return e.lead_id; })).size;
    const players = new Set(fe.filter(function (e) { return ['video_play', 'video_progress', 'video_complete'].indexOf(e.event) >= 0; }).map(function (e) { return e.lead_id; })).size;
    const sl = sales.data || [];
    const salesAmt = sl.reduce(function (a, s) { return a + Number(s.sale_amount || 0); }, 0);
    const commission = sl.reduce(function (a, s) { return a + Number(s.commission_amount || 0); }, 0);
    const bookedLeads = (book || []).filter(function (l) { return l.meeting_scheduled_at && l.meeting_scheduled_at >= since; }).length;

    // Speed to the warm lead: minutes from hot_at to the first dial after it.
    const hotLeads = (book || []).filter(function (l) { return l.hot_at && l.hot_at >= since; });
    let answered = 0, within5 = 0, totalMin = 0;
    if (hotLeads.length) {
        const { data: after } = await db.from('lead_calls').select('lead_id,called_at').in('lead_id', hotLeads.map(function (l) { return l.id; })).eq('direction', 'outbound').gte('called_at', since).order('called_at', { ascending: true }).limit(5000);
        hotLeads.forEach(function (l) {
            const first = (after || []).find(function (x) { return x.lead_id === l.id && x.called_at > l.hot_at; });
            if (first) { answered++; const min = (new Date(first.called_at) - new Date(l.hot_at)) / 60000; totalMin += min; if (min <= 5) within5++; }
        });
    }

    return res.status(200).json({
        ok: true, range: range, since: since, sdr: { id: sdr.id, email: email, name: sdr.display_name || email },
        cards: {
            dials: dials, connects: connects, decision_makers: dms, callbacks: callbacks,
            emails_sent: em.length, email_replies: emailReplies, email_bounced: em.filter(function (m) { return m.bounced_at; }).length,
            sms_sent: sm.length, sms_replies: smsReplies,
            ig_sent: igSent, ig_replies: igReplied, ig_booked: igBooked, ig_queued: igQueued,
            video_watchers: watchers, video_players: players,
            booked: Math.max(bookedCalls, bookedLeads), sales: sl.length, sales_amount: salesAmt, commission: commission,
            warm: tiers.warm || 0, hot: tiers.hot || 0, cold: tiers.cold || 0,
        },
        warm_response: { signals: hotLeads.length, called: answered, within_5_min: within5, avg_minutes: answered ? Math.round(totalMin / answered) : null },
    });
};
