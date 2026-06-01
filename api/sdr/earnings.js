/**
 * GET /api/sdr/earnings?sdr_id=<uuid>
 *
 * Returns the SDR's commission ledger and totals:
 *   - clients: [{ business_name, upfront_fee, monthly_retainer, commission_pct,
 *                 commission_upfront, commission_monthly, payout_status, closed_at }]
 *   - totals:  { mrr_closed, lifetime_revenue, commission_pending,
 *                commission_paid, commission_lifetime }
 *
 * MRR closed = sum of monthly_retainer for primary attribution rows.
 * Commission upfront = upfront_fee * commission_pct        (one-time, setup fee)
 * Commission monthly = monthly_retainer * commission_mrr_pct (recurring while active)
 */
const { authSdr, resolveScope, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const caller = await authSdr(req, res);
    if (!caller.ok) return;

    const scope = await resolveScope(req, caller);

    let q = caller.sb
        .from('client_attribution')
        .select(`
            id,
            client_id,
            sdr_id,
            role,
            upfront_fee_cents,
            monthly_retainer_cents,
            commission_pct,
            commission_mrr_pct,
            payout_status,
            payout_pending_cents,
            payout_paid_cents,
            closed_at,
            paid_at,
            notes,
            clients ( business_name, contact_name, email, status )
        `)
        .order('closed_at', { ascending: false });

    if (scope.sdrId) q = q.eq('sdr_id', scope.sdrId);

    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const fallbackPct = scope.sdr && scope.sdr.commission_pct != null ? Number(scope.sdr.commission_pct) : 0.25;
    const fallbackMrrPct = scope.sdr && scope.sdr.commission_mrr_pct != null ? Number(scope.sdr.commission_mrr_pct) : 0.10;

    let mrrCents = 0;
    let revenueCents = 0;
    let commissionPendingCents = 0;          // confirmed-paid by client, owed to SDR
    let commissionPaidCents = 0;             // already cut to SDR
    let commissionLifetimeCents = 0;

    // Awaiting-payment count comes from `deals` table (stage = PROPOSAL_SENT
    // or INVOICE_SENT). attribution rows don't exist until the deal is paid,
    // so we can't infer this from client_attribution alone.
    let awaitingPaymentCount = 0;
    if (scope.sdrId) {
        const { count } = await caller.sb
            .from('deals')
            .select('id', { count: 'exact', head: true })
            .eq('sdr_id', scope.sdrId)
            .in('stage', ['PROPOSAL_SENT', 'INVOICE_SENT']);
        awaitingPaymentCount = count || 0;
    } else if (caller.isAdmin) {
        const { count } = await caller.sb
            .from('deals')
            .select('id', { count: 'exact', head: true })
            .in('stage', ['PROPOSAL_SENT', 'INVOICE_SENT']);
        awaitingPaymentCount = count || 0;
    }

    const items = (rows || []).map(r => {
        const pct = r.commission_pct != null ? Number(r.commission_pct) : fallbackPct;
        const mrrPct = r.commission_mrr_pct != null ? Number(r.commission_mrr_pct) : fallbackMrrPct;
        const upfront = r.upfront_fee_cents || 0;
        const retainer = r.monthly_retainer_cents || 0;
        const commissionUpfront = Math.round(upfront * pct);
        const commissionMonthly = Math.round(retainer * mrrPct);

        // payout_status === 'pending' means client hasn't paid yet → commission is "awaiting payment"
        // (visibility-only on SDR dashboard, no dollar amount per Remy's choice).
        // Any other status (unpaid|paid) means client paid → commission is real.
        const clientPaid = r.payout_status && r.payout_status !== 'pending';

        const clientActive = r.clients && r.clients.status !== 'cancelled' && r.clients.status !== 'paused';
        if (r.role === 'primary' && clientActive && clientPaid) {
            mrrCents += retainer;
        }
        if (r.role === 'primary' && clientPaid) {
            revenueCents += upfront;
        }

        const paid = r.payout_paid_cents || 0;
        if (clientPaid) {
            const owedNow = (r.payout_pending_cents || 0);
            commissionPaidCents += paid;
            commissionPendingCents += Math.max(0, owedNow);
            commissionLifetimeCents += paid + Math.max(0, owedNow);
        }

        return {
            id: r.id,
            client_id: r.client_id,
            business_name: r.clients ? r.clients.business_name : null,
            contact_name: r.clients ? r.clients.contact_name : null,
            email: r.clients ? r.clients.email : null,
            client_status: r.clients ? r.clients.status : null,
            role: r.role,
            upfront_fee_cents: upfront,
            monthly_retainer_cents: retainer,
            commission_pct: pct,
            commission_mrr_pct: mrrPct,
            commission_upfront_cents: commissionUpfront,
            commission_monthly_cents: commissionMonthly,
            payout_status: r.payout_status,
            payout_paid_cents: paid,
            payout_pending_cents: r.payout_pending_cents || 0,
            closed_at: r.closed_at,
            paid_at: r.paid_at,
            notes: r.notes
        };
    });

    // Agents deployed for the clients this SDR closed — so the Revenue tab can
    // show an Agents section mapped back to the clients they sold.
    const agentsByClient = {};
    const agentSummary = {};
    let agentsTotal = 0;
    const clientIds = items.map(i => i.client_id).filter(Boolean);
    if (clientIds.length) {
        const { data: ags } = await caller.sb
            .from('client_agents')
            .select('client_id, agent_type, status')
            .in('client_id', clientIds);
        (ags || []).forEach(a => {
            (agentsByClient[a.client_id] = agentsByClient[a.client_id] || []).push({ agent_type: a.agent_type, status: a.status });
            agentSummary[a.agent_type] = (agentSummary[a.agent_type] || 0) + 1;
            agentsTotal += 1;
        });
    }
    items.forEach(i => { i.agents = agentsByClient[i.client_id] || []; });

    return res.status(200).json({
        scope: {
            sdr_id: scope.sdrId,
            sdr_name: scope.sdr ? scope.sdr.display_name : 'All SDRs',
            is_all: scope.isAllScope,
            commission_pct: fallbackPct,
            commission_mrr_pct: fallbackMrrPct
        },
        agents_summary: agentSummary,
        agents_total: agentsTotal,
        totals: {
            mrr_closed_cents: mrrCents,
            lifetime_revenue_cents: revenueCents,
            commission_pending_cents: commissionPendingCents,
            commission_paid_cents: commissionPaidCents,
            commission_lifetime_cents: commissionLifetimeCents,
            client_count: items.filter(i => i.role === 'primary').length,
            // Visibility-only: how many deals you closed that haven't been paid
            // by the client yet. Dollar amount intentionally hidden until payment.
            awaiting_payment_count: awaitingPaymentCount
        },
        clients: items
    });
};
