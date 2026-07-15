/**
 * GET /api/prospects/vsl-analytics?days=60
 *
 * The two VSL funnels for the admin Sales tab. They share the /agents/<slug>
 * pages but are different campaigns to different audiences, so they are reported
 * separately (see api/migrations/vsl_events_flow.sql):
 *
 *   campaign — cold VSL blast (vsl-campaign.js) to never-contacted leads.
 *              sent -> delivered -> viewed -> played -> booked
 *   confirm  — post-booking confirmation (send-confirmations.js) to people who
 *              already booked. sent -> opened -> viewed -> confirmed
 *
 * HEADLINE METRIC IS UNIQUE LEADS, NOT RAW EVENTS. Raw views overstate reach by
 * ~5x: corporate mail scanners fetch every link in an email, and one lead can
 * fire 20+ views. Both are returned; the UI leads with leads.
 *
 * Auth: admin/SDR JWT.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '60', 10), 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    const warnings = [];

    // ---- page/video events, split by flow -----------------------------------
    // Aggregate in JS: volumes are in the hundreds and this keeps one round trip.
    const agg = {};   // flow -> { event -> { events, leads:Set } }
    const byAgent = {}; // flow -> agent -> { event -> count }
    const bump = function (flow, event, agent, leadId) {
        agg[flow] = agg[flow] || {};
        agg[flow][event] = agg[flow][event] || { events: 0, leads: new Set() };
        agg[flow][event].events++;
        if (leadId != null) agg[flow][event].leads.add(leadId);
        if (agent) {
            byAgent[flow] = byAgent[flow] || {};
            byAgent[flow][agent] = byAgent[flow][agent] || {};
            byAgent[flow][agent][event] = (byAgent[flow][agent][event] || 0) + 1;
        }
    };
    try {
        const { data, error } = await pub.from('vsl_events')
            .select('event,agent,flow,lead_id').gte('created_at', since).limit(50000);
        if (error) throw error;
        (data || []).forEach(function (r) {
            bump(r.flow || 'organic', r.event || 'unknown', r.agent, r.lead_id);
        });
    } catch (e) {
        // Never swallow this. The old handler caught every error into a silent
        // zero, which is how "0 emails sent" sat on the dashboard unnoticed.
        warnings.push('vsl_events read failed: ' + (e.message || e));
    }

    const ev = function (flow, event) {
        const x = (agg[flow] || {})[event];
        return { events: x ? x.events : 0, leads: x ? x.leads.size : 0 };
    };

    // ---- email counts --------------------------------------------------------
    // NOTE: filter on sent_at. lead_messages has no created_at column -- the old
    // handler filtered on it, PostgREST 400'd, the catch swallowed it, and the
    // card reported 0 emails sent against 100 real sends.
    const countMsgs = async function (build) {
        try {
            const { count, error } = await build(
                pro.from('lead_messages').select('id', { count: 'exact', head: true }).gte('sent_at', since)
            );
            if (error) throw error;
            return count || 0;
        } catch (e) {
            warnings.push('lead_messages count failed: ' + (e.message || e));
            return null;
        }
    };

    const campaignSent = await countMsgs(function (q) { return q.eq('variant', 'vsl_campaign'); });
    const campaignBounced = await countMsgs(function (q) { return q.eq('variant', 'vsl_campaign').not('bounced_at', 'is', null); });

    // Confirmation sends come from leads.meeting_confirmation_sent_at, which is
    // the authoritative idempotency stamp and covers sends made before
    // send-confirmations.js started writing a lead_messages row.
    let confirmSent = null;
    try {
        const { count, error } = await pro.from('leads')
            .select('id', { count: 'exact', head: true })
            .gte('meeting_confirmation_sent_at', since);
        if (error) throw error;
        confirmSent = count || 0;
    } catch (e) {
        warnings.push('confirm sends count failed: ' + (e.message || e));
    }

    // Bookings the cold campaign actually earned: booked STRICTLY AFTER we mailed
    // them. "Campaigned and has a meeting" is not the same thing -- vsl-campaign.js
    // gates on stage != 'MEETING_BOOKED', but stage lags meeting_booked_at, so it
    // has already mailed a lead who booked the day before. Counting that as a
    // campaign win would invent a conversion the campaign never produced.
    let campaignBooked = null;
    try {
        const { data, error } = await pro.from('lead_messages')
            .select('lead_id,sent_at').eq('variant', 'vsl_campaign').gte('sent_at', since).limit(20000);
        if (error) throw error;
        const firstSend = new Map();
        (data || []).forEach(function (r) {
            if (!r.lead_id) return;
            const prev = firstSend.get(r.lead_id);
            if (!prev || new Date(r.sent_at) < new Date(prev)) firstSend.set(r.lead_id, r.sent_at);
        });
        const ids = Array.from(firstSend.keys());
        if (!ids.length) campaignBooked = 0;
        else {
            const { data: booked, error: e2 } = await pro.from('leads')
                .select('id,meeting_booked_at').in('id', ids).not('meeting_booked_at', 'is', null).limit(20000);
            if (e2) throw e2;
            campaignBooked = (booked || []).filter(function (l) {
                return new Date(l.meeting_booked_at) > new Date(firstSend.get(l.id));
            }).length;
        }
    } catch (e) {
        warnings.push('campaign bookings count failed: ' + (e.message || e));
    }

    const cView = ev('campaign', 'view'), cPlay = ev('campaign', 'play');
    const fView = ev('confirm', 'view');

    return res.status(200).json({
        since: since, days: days,
        campaign: {
            label: 'Interested lead (cold VSL)',
            emails_sent: campaignSent,
            bounced: campaignBounced,
            delivered: (campaignSent != null && campaignBounced != null) ? campaignSent - campaignBounced : null,
            // vsl-campaign.js sends plain text with no pixel on purpose, to stay
            // out of Promotions. There is no open rate to report and a 0 here
            // would read as "nobody opened it" rather than "we don't measure it".
            email_opens: null,
            email_opens_tracked: false,
            views: cView.events, view_leads: cView.leads,
            plays: cPlay.events, play_leads: cPlay.leads,
            booked: campaignBooked,
            by_agent: byAgent.campaign || {},
        },
        confirm: {
            label: 'Meeting confirmation',
            emails_sent: confirmSent,
            email_opens: ev('confirm', 'email_open').events,
            email_opens_tracked: true,
            views: fView.events, view_leads: fView.leads,
            confirm_opens: ev('confirm', 'confirm_open').events,
            confirms: ev('confirm', 'confirm').events,
            by_agent: byAgent.confirm || {},
        },
        organic: {
            label: 'Organic / direct',
            views: ev('organic', 'view').events,
            plays: ev('organic', 'play').events,
        },
        warnings: warnings,
    });
};
