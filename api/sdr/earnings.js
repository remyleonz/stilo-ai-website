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
 * Commission upfront = upfront_fee * commission_pct (one-time)
 * Commission monthly = monthly_retainer * commission_pct (recurring while active)
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

    const fallbackPct = scope.sdr && scope.sdr.commission_pct ? Number(scope.sdr.commission_pct) : 0.25;

    let mrrCents = 0;
    let revenueCents = 0;
    let commissionPendingCents = 0;
    let commissionPaidCents = 0;
    let commissionLifetimeCents = 0;

    const items = (rows || []).map(r => {
        const pct = r.commission_pct != null ? Number(r.commission_pct) : fallbackPct;
        const upfront = r.upfront_fee_cents || 0;
        const retainer = r.monthly_retainer_cents || 0;
        const commissionUpfront = Math.round(upfront * pct);
        const commissionMonthly = Math.round(retainer * pct);

        // MRR + lifetime revenue only count primary, currently-active clients
        const clientActive = r.clients && r.clients.status !== 'cancelled' && r.clients.status !== 'paused';
        if (r.role === 'primary' && clientActive) {
            mrrCents += retainer;
        }
        if (r.role === 'primary') {
            revenueCents += upfront;
        }

        // Commission ledger
        const paid = r.payout_paid_cents || 0;
        const pending = (r.payout_pending_cents || 0) + (r.payout_status === 'pending' ? (commissionUpfront - paid) : 0);
        commissionPaidCents += paid;
        commissionPendingCents += Math.max(0, pending);
        commissionLifetimeCents += paid + Math.max(0, pending);

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

    return res.status(200).json({
        scope: {
            sdr_id: scope.sdrId,
            sdr_name: scope.sdr ? scope.sdr.display_name : 'All SDRs',
            is_all: scope.isAllScope,
            commission_pct: fallbackPct
        },
        totals: {
            mrr_closed_cents: mrrCents,
            lifetime_revenue_cents: revenueCents,
            commission_pending_cents: commissionPendingCents,
            commission_paid_cents: commissionPaidCents,
            commission_lifetime_cents: commissionLifetimeCents,
            client_count: items.filter(i => i.role === 'primary').length
        },
        clients: items
    });
};
