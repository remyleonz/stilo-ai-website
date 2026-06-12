/**
 * POST /api/deals/update-stage
 * Body: { deal_id, stage, churn_reason? }
 *
 * Manually move a deal along the lifecycle (the admin Sales tab cards):
 *   ONBOARDING (closed + paid half, implementing) -> LIVE (fully paid + retainer,
 *   active client) -> CHURNED. Keeps public.clients.status in sync.
 *
 * Admin only. Stage is validated against the deals_stage_check enum.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

const STAGES = ['PROPOSAL_SENT', 'INVOICE_SENT', 'PAID', 'ONBOARDING', 'LIVE', 'CHURNED', 'CLOSED_LOST'];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const body = await readJsonBody(req);
    const dealId = body.deal_id;
    const stage = String(body.stage || '').toUpperCase();
    if (!dealId) return res.status(400).json({ error: 'missing_deal_id' });
    if (STAGES.indexOf(stage) === -1) return res.status(400).json({ error: 'invalid_stage', allowed: STAGES });
    if (stage === 'CLOSED_LOST' && !body.churn_reason && !body.lost_reason) {
        return res.status(400).json({ error: 'lost_requires_reason' });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const patch = { stage: stage, updated_at: new Date().toISOString() };
    if (stage === 'LIVE') { patch.paid_at = new Date().toISOString(); patch.churned_at = null; patch.churn_reason = null; }
    if (stage === 'CHURNED') { patch.churned_at = new Date().toISOString(); if (body.churn_reason) patch.churn_reason = String(body.churn_reason); }
    if (stage === 'CLOSED_LOST' && (body.lost_reason || body.churn_reason)) patch.lost_reason = String(body.lost_reason || body.churn_reason);

    const { data: deal, error } = await sb.from('deals').update(patch).eq('id', dealId)
        .select('id, client_id, business_name, stage').maybeSingle();
    if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });
    if (!deal) return res.status(404).json({ error: 'deal_not_found' });

    // Keep the client roster status in step with the deal lifecycle.
    if (deal.client_id) {
        const clientStatus = stage === 'CHURNED' ? 'churned' : (stage === 'LIVE' ? 'active' : 'onboarding');
        try { await sb.from('clients').update({ status: clientStatus }).eq('id', deal.client_id); } catch (_) {}
    }

    return res.status(200).json({ ok: true, deal_id: deal.id, stage: deal.stage });
};
