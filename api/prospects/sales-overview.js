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
    const cold_calls = await count(prospect.from('lead_calls').select('id', { count: 'exact', head: true }));
    // "Booked" = the lead has a scheduled meeting. Keyed on meeting_scheduled_at,
    // NOT last_called_outcome — a later call (reminder, callback) overwrites the
    // outcome and would silently drop a still-booked meeting from the count.
    const booked = await count(prospect.from('leads').select('id', { count: 'exact', head: true }).not('meeting_scheduled_at', 'is', null));

    // Deals by stage (full rows for the expand panels).
    const { data: deals } = await pub.from('deals')
        .select('id, business_name, contact_name, sdr_id, stage, agent_codes, upfront_fee_cents, monthly_retainer_cents, paid_at, churned_at, churn_reason, created_at')
        .order('created_at', { ascending: false });
    const byStage = function (s) { return (deals || []).filter(function (d) { return d.stage === s; }); };
    const onboarding = byStage('ONBOARDING');
    const active = byStage('LIVE');
    const churned = byStage('CHURNED');
    const mrr_cents = active.reduce(function (s, d) { return s + (Number(d.monthly_retainer_cents) || 0); }, 0);

    // Booked meetings (with time + Meet link) for that card's panel.
    const { data: bookedLeads } = await prospect.from('leads')
        .select('id, name, owner_name, meeting_scheduled_at, meeting_meet_link, meeting_booked_by_sdr')
        .not('meeting_scheduled_at', 'is', null)
        .order('meeting_scheduled_at', { ascending: true, nullsFirst: false })
        .limit(100);

    // Per-SDR leaderboard, keyed by rep email. Dials + emails + booked.
    const board = {};
    const bump = function (email, k, n) {
        if (!email) return;
        const e = String(email).toLowerCase();
        if (!board[e]) board[e] = { sdr: e, dials: 0, emails: 0, booked: 0 };
        board[e][k] += (n || 1);
    };
    try {
        const { data: calls } = await prospect.from('lead_calls').select('logged_by').not('logged_by', 'is', null).limit(5000);
        (calls || []).forEach(function (c) { bump(c.logged_by, 'dials'); });
    } catch (_) {}
    try {
        const { data: msgs } = await prospect.from('lead_messages').select('sent_by').eq('channel', 'email').not('sent_by', 'is', null).limit(5000);
        (msgs || []).forEach(function (m) { bump(m.sent_by, 'emails'); });
    } catch (_) {}
    try {
        const { data: bk } = await prospect.from('leads').select('meeting_booked_by_sdr').not('meeting_scheduled_at', 'is', null).not('meeting_booked_by_sdr', 'is', null).limit(2000);
        (bk || []).forEach(function (l) { bump(l.meeting_booked_by_sdr, 'booked'); });
    } catch (_) {}
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
        leaderboard: leaderboard
    });
};
