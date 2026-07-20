/**
 * GET /api/prospects/vsl-leads?flow=campaign|confirm&days=60
 *
 * The per-lead roster behind the VSL funnel counts on the admin Sales tab.
 *
 * vsl-analytics.js answers "how many". This answers "which ones, and where did
 * each one stop". A count with no roster is unactionable: "22 leads viewed" does
 * not tell a rep who to call, and it cannot be audited when the number looks
 * wrong. Every stat on the funnel card is clickable and filters this roster.
 *
 * Returns ONE row per lead with a flag per stage, rather than one endpoint per
 * stage. Volumes are in the low hundreds, so the whole roster fits in a single
 * round trip and clicking a stat filters instantly client-side.
 *
 * Stage flags are cumulative in the funnel sense but recorded independently: a
 * lead can have played=true with opened=false, because the confirmation SMS
 * carries the same link and an SMS click fires a view with no email open. Do not
 * "repair" that by inferring earlier stages -- the gaps are the real signal.
 *
 * Auth: admin/SDR JWT.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { AGENTS, agentKey } = require('./_vsl');

// The dashboard used to print the raw vsl_events.agent slug ('b2bleadgen',
// 'lead-reply'), which is a URL path, not a product name. _vsl.js already owns
// the canonical display names; use them so the funnel table and the email copy
// the prospect received say the same thing.
function agentLabel(slug) {
    if (!slug) return 'Unknown';
    const k = agentKey(slug);
    return (AGENTS[k] && AGENTS[k].name) || slug;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const flow = q.flow === 'confirm' ? 'confirm' : 'campaign';
    const days = Math.min(Math.max(parseInt(q.days || '60', 10), 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    const warnings = [];
    const rows = new Map(); // lead_id -> row

    const touch = function (leadId) {
        if (leadId == null) return null;
        if (!rows.has(leadId)) {
            rows.set(leadId, {
                lead_id: leadId,
                business: null, owner: null, email: null, phone: null,
                assigned_to: null, stage: null, agent: null, agent_label: null,
                sent_at: null, bounced_at: null, opened_at: null,
                viewed_at: null, played_at: null, confirmed_at: null,
                booked_at: null, meeting_scheduled_at: null,
                view_count: 0, play_count: 0,
                furthest: 'sent',
            });
        }
        return rows.get(leadId);
    };
    // Keep the earliest timestamp per stage. A lead who viewed five times has one
    // "first viewed" moment; the count lives separately.
    const stamp = function (row, field, at) {
        if (!row || !at) return;
        if (!row[field] || new Date(at) < new Date(row[field])) row[field] = at;
    };

    // ---- who we sent to ------------------------------------------------------
    // campaign: lead_messages variant='vsl_campaign' is authoritative.
    // confirm:  leads.meeting_confirmation_sent_at is the idempotency stamp and
    //           predates send-confirmations.js writing lead_messages rows, so it
    //           covers sends the messages table never recorded.
    if (flow === 'campaign') {
        try {
            const { data, error } = await pro.from('lead_messages')
                .select('lead_id,sent_at,bounced_at,opened_at')
                .eq('variant', 'vsl_campaign').gte('sent_at', since).limit(20000);
            if (error) throw error;
            (data || []).forEach(function (m) {
                const r = touch(m.lead_id);
                if (!r) return;
                stamp(r, 'sent_at', m.sent_at);
                if (m.bounced_at) stamp(r, 'bounced_at', m.bounced_at);
                if (m.opened_at) stamp(r, 'opened_at', m.opened_at);
            });
        } catch (e) {
            warnings.push('campaign sends read failed: ' + (e.message || e));
        }
    } else {
        try {
            const { data, error } = await pro.from('leads')
                .select('id,meeting_confirmation_sent_at')
                .gte('meeting_confirmation_sent_at', since).limit(20000);
            if (error) throw error;
            (data || []).forEach(function (l) {
                const r = touch(l.id);
                if (r) stamp(r, 'sent_at', l.meeting_confirmation_sent_at);
            });
        } catch (e) {
            warnings.push('confirm sends read failed: ' + (e.message || e));
        }
        // Bounces for the confirm flow still live in lead_messages.
        try {
            const { data, error } = await pro.from('lead_messages')
                .select('lead_id,bounced_at,opened_at')
                .eq('variant', 'meeting_confirm').gte('sent_at', since).limit(20000);
            if (error) throw error;
            (data || []).forEach(function (m) {
                const r = rows.get(m.lead_id);
                if (!r) return;
                if (m.bounced_at) stamp(r, 'bounced_at', m.bounced_at);
                if (m.opened_at) stamp(r, 'opened_at', m.opened_at);
            });
        } catch (e) {
            warnings.push('confirm bounces read failed: ' + (e.message || e));
        }
    }

    // ---- engagement ----------------------------------------------------------
    // Events can exist for leads we have no send row for (organic arrival, or a
    // send older than the window). Include them: hiding a real viewer because the
    // send fell outside the window is how a funnel starts lying.
    try {
        const { data, error } = await pub.from('vsl_events')
            .select('lead_id,event,agent,created_at')
            .eq('flow', flow).not('lead_id', 'is', null)
            .gte('created_at', since).limit(50000);
        if (error) throw error;
        (data || []).forEach(function (e) {
            const r = touch(e.lead_id);
            if (!r) return;
            if (!r.agent && e.agent) { r.agent = e.agent; r.agent_label = agentLabel(e.agent); }
            if (e.event === 'email_open') stamp(r, 'opened_at', e.created_at);
            else if (e.event === 'view') { stamp(r, 'viewed_at', e.created_at); r.view_count++; }
            else if (e.event === 'play') { stamp(r, 'played_at', e.created_at); r.play_count++; }
            else if (e.event === 'confirm' || e.event === 'confirm_open') stamp(r, 'confirmed_at', e.created_at);
        });
    } catch (e) {
        warnings.push('vsl_events read failed: ' + (e.message || e));
    }

    // ---- lead identity + booking --------------------------------------------
    const ids = Array.from(rows.keys());
    if (ids.length) {
        // Chunk the IN list: PostgREST puts it in the URL and a few hundred ids
        // will blow the URL length limit and 414.
        const CHUNK = 200;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            try {
                // The business name column is `name`, NOT `business_name` -- that
                // alias only exists after normalizeLead() in the API layer, and
                // selecting it here 400s the whole query and blanks every row.
                const { data, error } = await pro.from('leads')
                    .select('id,name,owner_name,email,owner_email,phone,owner_phone,assigned_to,stage,pitch_agent,meeting_booked_at,meeting_scheduled_at,meeting_confirmed_at,nurture_stage')
                    .in('id', slice);
                if (error) throw error;
                (data || []).forEach(function (l) {
                    const r = rows.get(l.id);
                    if (!r) return;
                    r.business = l.name || null;
                    r.owner = l.owner_name || null;
                    r.email = l.owner_email || l.email || null;
                    r.phone = l.owner_phone || l.phone || null;
                    r.assigned_to = l.assigned_to || null;
                    r.stage = l.stage || null;
                    r.nurture_stage = l.nurture_stage || null;
                    r.meeting_scheduled_at = l.meeting_scheduled_at || null;
                    // meeting_confirmed_at is the authoritative confirm signal.
                    // A 'confirm' vsl_event has literally never fired in prod, so
                    // relying on events alone reports 0 confirms forever.
                    if (l.meeting_confirmed_at) stamp(r, 'confirmed_at', l.meeting_confirmed_at);
                    // Only credit a booking the campaign actually earned: booked
                    // STRICTLY AFTER we mailed them. vsl-campaign.js gates on
                    // stage != 'MEETING_BOOKED' and stage lags meeting_booked_at,
                    // so it has already mailed leads who booked the day before.
                    if (l.meeting_booked_at && (!r.sent_at || new Date(l.meeting_booked_at) > new Date(r.sent_at))) {
                        r.booked_at = l.meeting_booked_at;
                    }
                    // Fall back to the lead's pitch_agent when no event carried one.
                    if (!r.agent && l.pitch_agent) { r.agent = l.pitch_agent; r.agent_label = agentLabel(l.pitch_agent); }
                });
            } catch (e) {
                warnings.push('leads read failed: ' + (e.message || e));
            }
        }
    }

    // ---- furthest stage reached ---------------------------------------------
    const out = Array.from(rows.values()).map(function (r) {
        if (!r.agent_label) r.agent_label = 'Unknown';
        r.furthest = r.booked_at ? 'booked'
            : r.confirmed_at ? 'confirmed'
            : r.played_at ? 'played'
            : r.viewed_at ? 'viewed'
            : r.opened_at ? 'opened'
            : r.bounced_at ? 'bounced'
            : 'sent';
        return r;
    });

    // Most-engaged first: that is the call list.
    const RANK = { booked: 6, confirmed: 5, played: 4, viewed: 3, opened: 2, sent: 1, bounced: 0 };
    out.sort(function (a, b) {
        const d = (RANK[b.furthest] || 0) - (RANK[a.furthest] || 0);
        if (d) return d;
        return new Date(b.sent_at || 0) - new Date(a.sent_at || 0);
    });

    return res.status(200).json({ flow: flow, days: days, since: since, count: out.length, leads: out, warnings: warnings });
};
