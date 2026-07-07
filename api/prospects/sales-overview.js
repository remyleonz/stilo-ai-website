/**
 * GET /api/prospects/sales-overview
 *
 * Sitewide sales command-center metrics for the admin Sales tab. Six headline
 * cards + the detail behind each (so the UI can expand a panel per card):
 *   - emails_sent   (prospecting.lead_messages, channel='email')
 *   - cold_calls    (prospecting.lead_calls)
 *   - booked        (prospecting.leads, last_called_outcome='booked_meeting')
 *   - onboarding    (public.deals, stage='ONBOARDING')  paid half, implementing
 *   - active        (public.deals, stage='LIVE')        fully paid + retainer
 *   - churned       (public.deals, stage='CHURNED')
 * Plus total MRR (sum of LIVE monthly retainers) and a per-SDR leaderboard
 * (dials / emails / booked) keyed by rep email.
 *
 * Admin only.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function pc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function lc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

async function count(q) { const { count } = await q; return count || 0; }

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const prospect = lc();
    const pub = pc();

    // Headline counts (head:true → count only, no rows).
    const emails_sent = await count(prospect.from('lead_messages').select('id', { count: 'exact', head: true }).eq('channel', 'email'));
    // Cold calls = outbound DIALS only (outbound|outgoing), attributed to a rep.
    // Must match the per-rep tally below exactly, or the headline and the
    // "cold calls by rep" breakdown disagree. Inbound calls are NOT cold calls.
    const cold_calls = await count(prospect.from('lead_calls').select('id', { count: 'exact', head: true }).in('direction', ['outbound', 'outgoing']).not('logged_by', 'is', null));
    // Rep roster for display names + sdr_id->email (deals attribute by sdr_id).
    const { data: roster } = await pub.from('sdr_users').select('id, email, display_name');
    const nameByEmail = {}, emailById = {};
    (roster || []).forEach(function (r) {
        if (r.email) nameByEmail[String(r.email).toLowerCase()] = r.display_name || r.email;
        if (r.id) emailById[r.id] = String(r.email || '').toLowerCase();
    });

    // "Booked" = a lead with a scheduled meeting, fetched once and DEDUPED by
    // calendar event. One Google event can wrongly land on two leads (e.g. the
    // sync's title-vs-business-name fallback), which double-counted a single
    // meeting. Keyed on meeting_scheduled_at (not last_called_outcome, which a
    // later reminder/callback overwrites). Drives the card, panel, leaderboard.
    const { data: bookedRaw } = await prospect.from('leads')
        .select('id, name, owner_name, meeting_event_id, meeting_scheduled_at, meeting_meet_link, meeting_booked_by_sdr')
        .not('meeting_scheduled_at', 'is', null)
        .order('meeting_scheduled_at', { ascending: true, nullsFirst: false })
        .limit(500);
    const bookedByEvent = new Map();
    (bookedRaw || []).forEach(function (l) {
        const key = l.meeting_event_id || ('lead:' + l.id);
        if (!bookedByEvent.has(key)) bookedByEvent.set(key, l);
    });
    const bookedLeads = Array.from(bookedByEvent.values()).map(function (l) {
        return Object.assign({}, l, { booked_by_name: nameByEmail[String(l.meeting_booked_by_sdr || '').toLowerCase()] || l.meeting_booked_by_sdr || null });
    });
    const booked = bookedLeads.length;

    // Enrich each booked meeting with its outcome + transcript presence +
    // reschedule count (from prospecting.lead_meetings), so the drill-down shows
    // how every meeting went, not just that it exists.
    try {
        const bIds = bookedLeads.map(function (l) { return l.id; });
        if (bIds.length) {
            const { data: lm } = await prospect.from('lead_meetings')
                .select('lead_id, outcome, transcript, occurred_at')
                .in('lead_id', bIds)
                .order('occurred_at', { ascending: false });
            const outByLead = {}, transByLead = {}, reschedByLead = {};
            (lm || []).forEach(function (m) {
                if (m.outcome && !outByLead[m.lead_id]) outByLead[m.lead_id] = m.outcome; // latest wins
                if (m.transcript && String(m.transcript).length > 40) transByLead[m.lead_id] = true;
                if (m.outcome === 'rescheduled') reschedByLead[m.lead_id] = (reschedByLead[m.lead_id] || 0) + 1;
            });
            const nowMs = Date.now();
            bookedLeads.forEach(function (l) {
                l.outcome = outByLead[l.id] || null;
                l.has_transcript = !!transByLead[l.id];
                l.reschedule_count = reschedByLead[l.id] || 0;
                l.status = l.outcome === 'closed_won' ? 'won'
                    : l.outcome === 'closed_lost' ? 'lost'
                    : l.outcome === 'no_show' ? 'no_show'
                    : (l.meeting_scheduled_at && new Date(l.meeting_scheduled_at).getTime() > nowMs ? 'upcoming' : 'past');
            });
        }
    } catch (_) { /* enrichment best-effort */ }
    // Summary for the drill-down header (close rate on held meetings).
    const bs = { total: bookedLeads.length, upcoming: 0, held: 0, won: 0, lost: 0, no_show: 0, rescheduled: 0 };
    bookedLeads.forEach(function (l) {
        if (l.status === 'upcoming') bs.upcoming++;
        if (l.outcome === 'closed_won') bs.won++;
        if (l.outcome === 'closed_lost') bs.lost++;
        if (l.outcome === 'no_show') bs.no_show++;
        if (l.reschedule_count) bs.rescheduled += l.reschedule_count;
    });
    bs.held = bs.won + bs.lost + bs.no_show;
    bs.close_rate_pct = bs.held > 0 ? Math.round((bs.won / bs.held) * 1000) / 10 : 0;

    // Deals by stage (full rows for the expand panels).
    const { data: deals } = await pub.from('deals')
        .select('id, business_name, contact_name, sdr_id, stage, agent_codes, upfront_fee_cents, monthly_retainer_cents, paid_at, churned_at, churn_reason, created_at')
        .order('created_at', { ascending: false });
    const byStage = function (s) { return (deals || []).filter(function (d) { return d.stage === s; }); };
    const onboarding = byStage('ONBOARDING');
    const active = byStage('LIVE');
    const churned = byStage('CHURNED');
    const mrr_cents = active.reduce(function (s, d) { return s + (Number(d.monthly_retainer_cents) || 0); }, 0);

    // Per-SDR leaderboard, keyed by rep email. Dials + emails + booked + closed.
    const board = {};
    const bump = function (email, k, n) {
        if (!email) return;
        const e = String(email).toLowerCase();
        if (!board[e]) board[e] = { sdr: e, name: nameByEmail[e] || e, dials: 0, emails: 0, booked: 0, closed: 0 };
        board[e][k] += (n || 1);
    };
    // Tally per-rep dials. Supabase caps ANY response at 1000 rows regardless of
    // .limit(), so the old single-shot fetch only ever saw the first 1000 calls
    // and undercounted every rep (rows summed to exactly 1000 while the headline
    // count showed the true total). Paginate in 1000-row pages and count outbound
    // dials only, matching the headline definition.
    try {
        let from = 0;
        for (;;) {
            const { data: calls } = await prospect.from('lead_calls')
                .select('logged_by')
                .in('direction', ['outbound', 'outgoing'])
                .not('logged_by', 'is', null)
                .range(from, from + 999);
            if (!calls || !calls.length) break;
            calls.forEach(function (c) { bump(c.logged_by, 'dials'); });
            if (calls.length < 1000) break;
            from += 1000;
        }
    } catch (_) {}
    try {
        const { data: msgs } = await prospect.from('lead_messages').select('sent_by').eq('channel', 'email').not('sent_by', 'is', null).limit(5000);
        (msgs || []).forEach(function (m) { bump(m.sent_by, 'emails'); });
    } catch (_) {}
    // Booked per rep = distinct events (bookedLeads is already event-deduped).
    bookedLeads.forEach(function (l) { bump(l.meeting_booked_by_sdr, 'booked'); });
    // Closed per rep = paid deals (ONBOARDING/LIVE) attributed by sdr_id.
    (deals || []).forEach(function (d) {
        if (d.stage !== 'ONBOARDING' && d.stage !== 'LIVE') return;
        const em = emailById[d.sdr_id];
        if (em) bump(em, 'closed');
    });
    // Close rate per rep = closed / booked.
    Object.values(board).forEach(function (r) {
        r.close_pct = r.booked > 0 ? Math.round((r.closed / r.booked) * 1000) / 10 : 0;
    });
    const leaderboard = Object.values(board).sort(function (a, b) { return (b.dials + b.emails * 5 + b.booked * 20) - (a.dials + a.emails * 5 + a.booked * 20); });

    return res.status(200).json({
        cards: {
            emails_sent: emails_sent,
            cold_calls: cold_calls,
            booked: booked,
            onboarding: onboarding.length,
            active: active.length,
            churned: churned.length
        },
        mrr_cents: mrr_cents,
        deals: { onboarding: onboarding, active: active, churned: churned },
        booked_leads: bookedLeads || [],
        booked_summary: bs,
        leaderboard: leaderboard
    });
};
