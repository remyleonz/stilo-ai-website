/**
 * POST /api/admin/deals/mark-paid
 *
 * Body: { deal_id, paid_at?, note? }
 *
 * Manual payment confirmation for wires, ACH, checks, friends-and-family,
 * or any deal that bypassed Stripe. Flips the deal to PAID + invokes the
 * client provisioning pipeline + flips client_attribution payout to unpaid.
 *
 * If the deal has a stripe_invoice_id, we also mark the invoice 'paid_out_of_band'
 * in Stripe so the books match.
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');

let stripeClient = null;
function getStripe() {
    if (stripeClient) return stripeClient;
    if (!process.env.STRIPE_SECRET_KEY) return null;
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return stripeClient;
}

async function provisionFromDeal(sb, deal, paidAt) {
    // 1. Ensure client_id exists. Look up by email first, then invite.
    let clientId = deal.client_id;
    if (!clientId && deal.contact_email) {
        const { data: existing } = await sb
            .from('clients')
            .select('id')
            .eq('email', deal.contact_email)
            .maybeSingle();
        if (existing) clientId = existing.id;
    }
    if (!clientId) {
        const siteUrl = process.env.SITE_URL || 'https://stiloaipartners.com';
        const { data: invite, error: inviteErr } = await sb.auth.admin.inviteUserByEmail(
            deal.contact_email,
            {
                redirectTo: siteUrl + '/app/',
                data: { business_name: deal.business_name, contact_name: deal.contact_name }
            }
        );
        if (inviteErr) {
            throw new Error('invite_failed: ' + inviteErr.message);
        }
        clientId = invite.user.id;
        if (deal.contact_phone) {
            await sb.from('clients').update({ phone: deal.contact_phone }).eq('id', clientId);
        }
    }

    // 2. Update the client with business + contact info (in case it's outdated)
    await sb.from('clients').update({
        business_name: deal.business_name,
        contact_name: deal.contact_name || undefined,
        phone: deal.contact_phone || undefined,
        status: 'active'
    }).eq('id', clientId);

    // 3. Seed client_agents for every purchased agent
    const { AGENTS } = require('../../_agents');
    const agentRows = [];
    for (const code of (deal.agent_codes || [])) {
        if (!AGENTS[code]) continue;
        // Idempotency: skip if already provisioned for this client
        const { data: ex } = await sb.from('client_agents')
            .select('id')
            .eq('client_id', clientId)
            .eq('agent_type', code)
            .maybeSingle();
        if (ex) continue;
        agentRows.push({
            client_id: clientId,
            agent_type: code,
            status: 'onboarding',
            stripe_subscription_id: deal.stripe_subscription_id || null,
            config: {
                deal_id: deal.id,
                stripe_session_id: deal.stripe_checkout_session_id || null,
                provisioned_via: 'admin_mark_paid'
            }
        });
    }
    let insertedAgents = [];
    if (agentRows.length) {
        const { data, error } = await sb.from('client_agents').insert(agentRows).select('*');
        if (error) throw new Error('agent_insert_failed: ' + error.message);
        insertedAgents = data || [];
    }

    // 4. Seed onboarding_steps
    const stepRows = [];
    for (const row of insertedAgents) {
        const meta = AGENTS[row.agent_type];
        if (!meta || !meta.onboardingSteps) continue;
        meta.onboardingSteps.forEach(function (name, idx) {
            stepRows.push({
                client_agent_id: row.id,
                step_number: idx + 1,
                step_name: name,
                status: idx === 0 ? 'in_progress' : 'pending'
            });
        });
    }
    if (stepRows.length) {
        await sb.from('onboarding_steps').insert(stepRows);
    }

    // 5. Create / update client_attribution so SDR gets commission
    if (deal.sdr_id) {
        const { data: sdr } = await sb.from('sdr_users').select('commission_pct').eq('id', deal.sdr_id).maybeSingle();
        const pct = sdr ? Number(sdr.commission_pct) : 0.25;
        const commissionTotal = Math.round(((deal.upfront_fee_cents || 0) + (deal.monthly_retainer_cents || 0)) * pct);

        const { data: existingAttr } = await sb.from('client_attribution')
            .select('id')
            .eq('client_id', clientId)
            .eq('role', 'primary')
            .maybeSingle();

        const attrPayload = {
            client_id: clientId,
            sdr_id: deal.sdr_id,
            source_lead_id: deal.source_lead_id || null,
            role: 'primary',
            upfront_fee_cents: deal.upfront_fee_cents || 0,
            monthly_retainer_cents: deal.monthly_retainer_cents || 0,
            commission_pct: pct,
            // The DB check on payout_status allows exactly ('pending','paid'):
            // it describes the PAYOUT to the SDR, not the client's payment.
            // 'unpaid' violates the constraint — this insert has been silently
            // dying, which is why no commission row would have appeared when
            // the first real deal was marked paid.
            payout_status: 'pending',     // client paid → payout to SDR is owed
            payout_pending_cents: commissionTotal,
            payout_paid_cents: 0,
            stripe_customer_id: deal.stripe_customer_id || null,
            stripe_subscription_id: deal.stripe_subscription_id || null,
            closed_at: paidAt,
            notes: 'Auto-created on mark-paid from deal ' + deal.id,
            updated_at: new Date().toISOString()
        };
        if (existingAttr) {
            await sb.from('client_attribution').update(attrPayload).eq('id', existingAttr.id);
        } else {
            await sb.from('client_attribution').insert(attrPayload);
        }
    }

    // 6. Update the deal with client_id + stage = ONBOARDING
    await sb.from('deals').update({
        client_id: clientId,
        paid_at: paidAt,
        // A deal is closed when the client pays. This was only ever stamped on
        // the attribution row, never on the deal itself, so the Team tab's
        // revenue buckets (which key on deals.closed_at) would have put every
        // real deal in NO period at all.
        closed_at: paidAt,
        stage: 'ONBOARDING',
        updated_at: new Date().toISOString()
    }).eq('id', deal.id);

    return { clientId, agentsProvisioned: insertedAgents.length };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);

    const dealId = body.deal_id;
    if (!dealId) return res.status(400).json({ error: 'deal_id_required' });
    const paidAt = body.paid_at ? new Date(body.paid_at).toISOString() : new Date().toISOString();

    const { data: deal, error } = await gate.sb.from('deals').select('*').eq('id', dealId).maybeSingle();
    if (error || !deal) return res.status(404).json({ error: 'deal_not_found' });

    // Optional: mark the Stripe invoice paid_out_of_band so our books reconcile
    if (deal.stripe_invoice_id) {
        const stripe = getStripe();
        if (stripe) {
            try {
                await stripe.invoices.pay(deal.stripe_invoice_id, { paid_out_of_band: true });
            } catch (e) {
                // already paid or not finalized — fine
                console.warn('[mark-paid] stripe invoice update failed:', e.message);
            }
        }
    }

    try {
        const result = await provisionFromDeal(gate.sb, deal, paidAt);
        await logEvent(gate.sb, dealId, 'marked_paid', {
            body: 'Marked paid manually. ' + result.agentsProvisioned + ' agents provisioned. Client id: ' + result.clientId + '. ' + (body.note || ''),
            actorUserId: gate.userId
        });
        await logEvent(gate.sb, dealId, 'payment_received', {
            body: 'Payment confirmed (' + (deal.payment_method || 'manual') + ')',
            actorUserId: gate.userId
        });
        return res.status(200).json({ ok: true, client_id: result.clientId, agents_provisioned: result.agentsProvisioned });
    } catch (e) {
        console.error('[mark-paid]', e);
        return res.status(500).json({ error: 'provisioning_failed', detail: e.message });
    }
};
module.exports.provisionFromDeal = provisionFromDeal;
