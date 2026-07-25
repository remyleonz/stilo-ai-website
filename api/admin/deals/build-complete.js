/**
 * POST /api/admin/deals/build-complete
 *
 * Body: { deal_id }
 *
 * Phased billing, steps 2 + 3. The admin clicks "Build finished" on a deal
 * when the agents are built and live:
 *   2. Sends the FINAL setup invoice (the remaining 50% of each agent's
 *      install fee).
 *   3. Creates the monthly subscription with the deal's custom monthly
 *      prices, first charge exactly 14 days from now (billed by emailed
 *      invoice, no card on file required).
 *
 * Idempotent: refuses to run twice (build_completed_at is the stamp).
 * Admin-only, same gate as every other deals endpoint.
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');
const { ensureStripeProduct } = require('./_catalog');

let stripeClient = null;
function getStripe() {
    if (stripeClient) return stripeClient;
    if (!process.env.STRIPE_SECRET_KEY) return null;
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return stripeClient;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const sb = gate.sb;
    const body = await readJsonBody(req);
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id_required' });

    const { data: deal, error } = await sb.from('deals').select('*').eq('id', body.deal_id).maybeSingle();
    if (error || !deal) return res.status(404).json({ error: 'deal_not_found' });
    if (deal.build_completed_at) {
        return res.status(409).json({ error: 'already_completed', build_completed_at: deal.build_completed_at });
    }
    const items = deal.line_items || [];
    if (!items.length) {
        return res.status(400).json({ error: 'no_line_items', detail: 'This deal predates the cart flow. Bill it manually or recreate it.' });
    }
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'stripe_not_configured' });
    if (!deal.stripe_customer_id) return res.status(400).json({ error: 'no_stripe_customer', detail: 'No deposit invoice was ever created for this deal.' });

    const now = new Date();
    const monthlyStart = new Date(now.getTime() + 14 * 86400000);
    const out = { final_invoice_url: null, subscription_id: null, monthly_starts_at: null };

    // Step 2: final invoice — the remaining half of each install fee.
    // The deposit took floor(install/2); the final takes the rest, so the two
    // always sum to the exact agreed price even on odd amounts.
    const finalItems = items.filter(function (i) { return i.install_cents > 0; });
    if (finalItems.length) {
        const invoice = await stripe.invoices.create({
            customer: deal.stripe_customer_id,
            collection_method: 'send_invoice',
            days_until_due: 7,
            description: 'Your build is finished. This is the remaining 50% of setup. Monthly service billing begins ' + monthlyStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + '.',
            metadata: { deal_id: deal.id, phase: 'final', business_name: deal.business_name }
        });
        for (const item of finalItems) {
            const productId = await ensureStripeProduct(stripe, item.code);
            const remainder = item.install_cents - Math.floor(item.install_cents / 2);
            await stripe.invoiceItems.create({
                customer: deal.stripe_customer_id, invoice: invoice.id,
                price_data: { currency: 'usd', product: productId, unit_amount: remainder },
                description: item.name + ' setup completion (remaining 50% of $' + (item.install_cents / 100).toLocaleString('en-US') + ')'
            });
        }
        const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
        await stripe.invoices.sendInvoice(finalized.id);
        out.final_invoice_url = finalized.hosted_invoice_url;
        await sb.from('deals').update({ stripe_final_invoice_id: finalized.id, stripe_invoice_id: finalized.id }).eq('id', deal.id);
    }

    // Step 3: monthly subscription, first charge in exactly 14 days.
    const monthlyItems = items.filter(function (i) { return i.monthly_cents > 0; });
    if (monthlyItems.length) {
        const subItems = [];
        for (const item of monthlyItems) {
            const productId = await ensureStripeProduct(stripe, item.code);
            subItems.push({
                price_data: {
                    currency: 'usd', product: productId,
                    recurring: { interval: 'month' },
                    unit_amount: item.monthly_cents
                }
            });
        }
        const sub = await stripe.subscriptions.create({
            customer: deal.stripe_customer_id,
            items: subItems,
            collection_method: 'send_invoice',
            days_until_due: 7,
            trial_end: Math.floor(monthlyStart.getTime() / 1000),
            metadata: { deal_id: deal.id, phase: 'monthly', business_name: deal.business_name }
        });
        out.subscription_id = sub.id;
        out.monthly_starts_at = monthlyStart.toISOString();
        await sb.from('deals').update({ stripe_subscription_id: sub.id }).eq('id', deal.id);
    }

    const { error: upErr } = await sb.from('deals').update({
        build_completed_at: now.toISOString(),
        monthly_starts_at: monthlyItems.length ? monthlyStart.toISOString() : null,
        stage: 'BUILD_DONE',
        updated_at: now.toISOString()
    }).eq('id', deal.id);
    if (upErr) {
        // Invoices/subscription already exist in Stripe at this point; surface
        // the failure loudly instead of pretending the deal record is current.
        console.error('[build-complete] deal update failed:', upErr.message);
        return res.status(500).json(Object.assign({ error: 'deal_update_failed', detail: upErr.message }, out));
    }

    await logEvent(sb, deal.id, 'build_complete', {
        body: 'Build marked finished. '
            + (out.final_invoice_url ? 'Final 50% invoice sent. ' : 'No install balance due. ')
            + (out.subscription_id
                ? 'Monthly billing ($' + (monthlyItems.reduce(function (s, i) { return s + i.monthly_cents; }, 0) / 100).toLocaleString('en-US') + '/mo) starts ' + monthlyStart.toLocaleDateString('en-US') + '.'
                : 'No monthly component.'),
        actorUserId: gate.userId
    });

    return res.status(200).json(Object.assign({ ok: true }, out));
};
