/**
 * GET  /api/admin/deals?stage=PAID&sdr_id=...    list deals (admin)
 * POST /api/admin/deals                          create a new deal (the Close Deal action)
 *
 * Create body:
 *   {
 *     source_lead_id: <number>,
 *     business_name, contact_email, contact_name?, contact_phone?,
 *     agent_codes: [...],
 *     upfront_fee_cents, monthly_retainer_cents,
 *     discount_pct?,
 *     sdr_id?,                          // defaults to the lead's assigned_to → sdr_users
 *     payment_method: 'stripe_checkout' | 'stripe_invoice' | 'manual',
 *     notes?
 *   }
 *
 * Returns: { deal, proposal_url, payment_link }
 *
 * On create:
 *   1. Insert deal (stage = PROPOSAL_SENT)
 *   2. Generate Stripe checkout link (if payment_method != manual)
 *   3. Generate proposal PDF, upload to storage
 *   4. Log deal_event 'proposal_sent'
 *   5. Update prospecting.leads.stage = CLOSED_WON
 *   6. Return deal + proposal URL + payment link (admin emails this to client)
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');
const { buildProposalPdf, uploadProposal } = require('./_pdf');
const { ensureStripeProduct, normalizeLineItems } = require('./_catalog');

let stripeClient = null;
function getStripe() {
    if (stripeClient) return stripeClient;
    if (!process.env.STRIPE_SECRET_KEY) return null;
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return stripeClient;
}

async function createStripeCheckout(sb, deal) {
    const stripe = getStripe();
    if (!stripe) return null;

    // Resolve agent price IDs from env (same pattern as create-checkout-session.js)
    const { AGENTS } = require('../../_agents');
    const lineItems = [];
    const setupInvoiceItems = [];
    let hasRecurring = false;
    for (const code of (deal.agent_codes || [])) {
        const a = AGENTS[code];
        if (!a) continue;
        if (a.monthlyFeeCents > 0 && a.stripeMonthlyPriceEnv) {
            lineItems.push({ price: process.env[a.stripeMonthlyPriceEnv], quantity: 1 });
            setupInvoiceItems.push({ price: process.env[a.stripeSetupPriceEnv], quantity: 1 });
            hasRecurring = true;
        } else if (a.stripeSetupPriceEnv) {
            lineItems.push({ price: process.env[a.stripeSetupPriceEnv], quantity: 1 });
        }
    }
    if (lineItems.length === 0) return null;

    const origin = process.env.SITE_URL || 'https://stiloaipartners.com';
    const metadata = {
        deal_id: deal.id,
        source: 'admin_close_deal',
        business_name: deal.business_name,
        contact_email: deal.contact_email,
        monthly_retainer_cents: String(deal.monthly_retainer_cents || 0),
        upfront_fee_cents: String(deal.upfront_fee_cents || 0)
    };
    const successUrl = origin + '/auth.html?welcome=1&deal=' + deal.id + '&session_id={CHECKOUT_SESSION_ID}';

    const session = await stripe.checkout.sessions.create(Object.assign(
        {
            mode: hasRecurring ? 'subscription' : 'payment',
            payment_method_types: ['card'],
            line_items: lineItems,
            customer_email: deal.contact_email,
            allow_promotion_codes: true,
            success_url: successUrl,
            cancel_url: origin + '/',
            metadata
        },
        hasRecurring
            ? { subscription_data: { metadata, add_invoice_items: setupInvoiceItems } }
            : { payment_intent_data: { receipt_email: deal.contact_email } }
    ));

    // Snapshot checkout session id on the deal so the webhook can look it up directly
    await sb.from('deals').update({
        stripe_checkout_session_id: session.id,
        invoice_sent_at: new Date().toISOString(),
        stage: 'INVOICE_SENT'
    }).eq('id', deal.id);

    return session.url;
}

/**
 * Find or create the Stripe customer for a deal.
 */
async function ensureCustomer(stripe, deal) {
    const existing = await stripe.customers.list({ email: deal.contact_email, limit: 1 });
    if (existing.data.length) return existing.data[0];
    return stripe.customers.create({
        email: deal.contact_email,
        name: deal.contact_name || deal.business_name,
        metadata: { business_name: deal.business_name, deal_id: deal.id }
    });
}

/**
 * Phased billing, step 1 of 3: the setup deposit invoice.
 * 50% of every agent's install fee, due on receipt, emailed by Stripe.
 * Step 2 (remaining 50%) and step 3 (monthly, starting build+14d) happen in
 * build-complete.js when the admin marks the build finished.
 */
async function createDepositInvoice(sb, deal, userId) {
    const stripe = getStripe();
    if (!stripe) throw new Error('stripe_not_configured');

    const installItems = (deal.line_items || []).filter(function (i) { return i.install_cents > 0; });
    if (!installItems.length) return null; // monthly-only deal: nothing due until build completion

    const customer = await ensureCustomer(stripe, deal);
    const invoice = await stripe.invoices.create({
        customer: customer.id,
        collection_method: 'send_invoice',
        days_until_due: 7,
        description: 'Setup deposit: 50% to begin your build. The remaining 50% is invoiced when the build is finished, and monthly service billing starts two weeks after that.',
        metadata: { deal_id: deal.id, phase: 'deposit', business_name: deal.business_name }
    });
    for (const item of installItems) {
        const productId = await ensureStripeProduct(stripe, item.code);
        const half = Math.floor(item.install_cents / 2);
        await stripe.invoiceItems.create({
            customer: customer.id, invoice: invoice.id,
            price_data: { currency: 'usd', product: productId, unit_amount: half },
            description: item.name + ' setup deposit (50% of $' + (item.install_cents / 100).toLocaleString('en-US') + ')'
        });
    }
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    // Note: no stripe.invoices.sendInvoice here. The confirm-send screen in the
    // admin owns client communication (the closer's own Gmail + optional SMS),
    // so Stripe's generic invoice email would be a duplicate from a cold sender.
    await sb.from('deals').update({
        stripe_deposit_invoice_id: finalized.id,
        stripe_invoice_id: finalized.id, // legacy field: latest invoice, keeps mark-paid working
        stripe_customer_id: customer.id,
        invoice_sent_at: new Date().toISOString(),
        stage: 'INVOICE_SENT'
    }).eq('id', deal.id);

    await logEvent(sb, deal.id, 'invoice_sent', {
        body: 'Deposit invoice created: $' + (installItems.reduce(function (s, i) { return s + Math.floor(i.install_cents / 2); }, 0) / 100).toLocaleString('en-US')
            + ' (50% of setup). Awaiting email/SMS to ' + deal.contact_email + ' from the confirm-send screen.',
        actorUserId: userId
    });
    return { url: finalized.hosted_invoice_url, pdf: finalized.invoice_pdf, id: finalized.id };
}

async function handleList(sb, req, res) {
    const q = req.query || {};
    // The Close Deal cart pulls its agent list + default prices from here so
    // the server-side catalog stays the single source of truth.
    if (String(q.catalog || '') === '1') {
        const { DEAL_CATALOG } = require('./_catalog');
        return res.status(200).json({ catalog: DEAL_CATALOG });
    }
    let qb = sb.from('deals')
        .select(`
            *,
            sdr_users ( id, display_name, sdr_key, initials, avatar_color ),
            clients ( id, business_name, status )
        `)
        .order('closed_at', { ascending: false });
    if (q.stage) qb = qb.eq('stage', q.stage);
    if (q.sdr_id) qb = qb.eq('sdr_id', q.sdr_id);
    if (q.client_id) qb = qb.eq('client_id', q.client_id);
    const { data, error } = await qb.limit(500);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ deals: data || [] });
}

async function handleCreate(sb, userId, req, res) {
    const body = await readJsonBody(req);

    // New cart flow: line_items with per-deal prices replaces
    // agent_codes + flat fees. Totals are derived, never trusted from input.
    let lineItems = null;
    if (body.line_items) {
        const norm = normalizeLineItems(body.line_items);
        if (norm.error) return res.status(400).json({ error: norm.error, code: norm.code });
        lineItems = norm.items;
        body.agent_codes = lineItems.map(function (i) { return i.code; });
        body.upfront_fee_cents = lineItems.reduce(function (s, i) { return s + i.install_cents; }, 0);
        body.monthly_retainer_cents = lineItems.reduce(function (s, i) { return s + i.monthly_cents; }, 0);
        body.payment_method = 'phased_invoice';
    }

    // Required fields
    const required = ['business_name', 'contact_email', 'agent_codes', 'payment_method'];
    for (const k of required) {
        if (!body[k] || (Array.isArray(body[k]) && body[k].length === 0)) {
            return res.status(400).json({ error: 'missing_field', field: k });
        }
    }

    // Resolve SDR from source_lead_id if not provided
    let sdrId = body.sdr_id || null;
    if (!sdrId && body.source_lead_id) {
        const { data: lead } = await sb
            .schema('prospecting').from('leads')
            .select('assigned_to')
            .eq('id', body.source_lead_id)
            .maybeSingle();
        if (lead && lead.assigned_to) {
            const { data: sdr } = await sb.from('sdr_users')
                .select('id')
                .eq('email', lead.assigned_to.toLowerCase())
                .maybeSingle();
            if (sdr) sdrId = sdr.id;
        }
    }

    // Insert the deal
    const dealPayload = {
        source_lead_id: body.source_lead_id || null,
        sdr_id: sdrId,
        business_name: String(body.business_name).slice(0, 200),
        contact_name: body.contact_name ? String(body.contact_name).slice(0, 200) : null,
        contact_email: String(body.contact_email).toLowerCase().slice(0, 200),
        contact_phone: body.contact_phone ? String(body.contact_phone).slice(0, 50) : null,
        agent_codes: body.agent_codes,
        upfront_fee_cents: parseInt(body.upfront_fee_cents || 0, 10),
        monthly_retainer_cents: parseInt(body.monthly_retainer_cents || 0, 10),
        discount_pct: body.discount_pct ? Number(body.discount_pct) : 0,
        payment_method: body.payment_method,
        notes: body.notes ? String(body.notes).slice(0, 5000) : null,
        closed_by: userId,
        stage: 'PROPOSAL_SENT'
    };
    if (lineItems) dealPayload.line_items = lineItems;

    const { data: deal, error: insErr } = await sb.from('deals')
        .insert(dealPayload)
        .select('*')
        .single();
    if (insErr) return res.status(500).json({ error: 'deal_insert_failed', detail: insErr.message });

    // Stripe checkout link (skip for manual)
    let paymentLink = null;
    let invoicePdf = null;
    if (body.payment_method === 'phased_invoice') {
        try {
            const inv = await createDepositInvoice(sb, deal, userId);
            if (inv) { paymentLink = inv.url; invoicePdf = inv.pdf; }
        } catch (e) {
            console.error('[close-deal] deposit invoice failed', e);
            await logEvent(sb, deal.id, 'warning', {
                body: 'Deposit invoice creation failed: ' + e.message,
                actorUserId: userId
            });
        }
    } else if (body.payment_method === 'stripe_checkout') {
        try {
            paymentLink = await createStripeCheckout(sb, deal);
        } catch (e) {
            console.error('[close-deal] stripe failed', e);
            await logEvent(sb, deal.id, 'warning', {
                body: 'Stripe checkout creation failed: ' + e.message,
                actorUserId: userId
            });
        }
    } else if (body.payment_method === 'stripe_invoice') {
        // Invoice flow: create a draft + finalize + send
        const stripe = getStripe();
        if (stripe) {
            try {
                // Look up or create the customer
                let customer = null;
                const existing = await stripe.customers.list({ email: deal.contact_email, limit: 1 });
                if (existing.data.length) customer = existing.data[0];
                else customer = await stripe.customers.create({
                    email: deal.contact_email,
                    name: deal.contact_name || deal.business_name,
                    metadata: { business_name: deal.business_name, deal_id: deal.id }
                });
                const invoice = await stripe.invoices.create({
                    customer: customer.id,
                    collection_method: 'send_invoice',
                    days_until_due: 14,
                    metadata: { deal_id: deal.id, business_name: deal.business_name }
                });
                // Add line items
                const { AGENTS: AGENT_DEFS } = require('../../_agents');
                const agentNames = (deal.agent_codes || [])
                    .map(function (c) { return (AGENT_DEFS[c] && AGENT_DEFS[c].name) || c; })
                    .join(', ');
                if (deal.upfront_fee_cents > 0) {
                    await stripe.invoiceItems.create({
                        customer: customer.id, invoice: invoice.id,
                        amount: deal.upfront_fee_cents,
                        currency: 'usd',
                        description: 'STILO AI: Setup fee (' + agentNames + ')'
                    });
                }
                if (deal.monthly_retainer_cents > 0) {
                    await stripe.invoiceItems.create({
                        customer: customer.id, invoice: invoice.id,
                        amount: deal.monthly_retainer_cents,
                        currency: 'usd',
                        description: 'STILO AI: Monthly retainer (first month)'
                    });
                }
                const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
                await stripe.invoices.sendInvoice(finalized.id);
                paymentLink = finalized.hosted_invoice_url;
                await sb.from('deals').update({
                    stripe_invoice_id: finalized.id,
                    stripe_customer_id: customer.id,
                    invoice_sent_at: new Date().toISOString(),
                    stage: 'INVOICE_SENT'
                }).eq('id', deal.id);
            } catch (e) {
                console.error('[close-deal] invoice failed', e);
                await logEvent(sb, deal.id, 'warning', {
                    body: 'Stripe invoice creation failed: ' + e.message,
                    actorUserId: userId
                });
            }
        }
    }
    // For 'manual', no payment link; admin handles billing out-of-band

    // Generate the proposal PDF
    let proposalUrl = null;
    try {
        const pdfBytes = await buildProposalPdf(deal, paymentLink);
        proposalUrl = await uploadProposal(sb, deal.id, deal.business_name, pdfBytes);
        await sb.from('deals').update({ proposal_pdf_url: proposalUrl }).eq('id', deal.id);
    } catch (e) {
        console.error('[close-deal] pdf failed', e);
        await logEvent(sb, deal.id, 'warning', {
            body: 'Proposal PDF generation failed: ' + e.message,
            actorUserId: userId
        });
    }

    // Log proposal_sent event
    await logEvent(sb, deal.id, 'proposal_sent', {
        body: 'Proposal sent via ' + body.payment_method + (paymentLink ? ' (with payment link)' : ' (manual)'),
        attachments: proposalUrl ? [{ name: 'proposal.pdf', url: proposalUrl, mime_type: 'application/pdf' }] : [],
        actorUserId: userId
    });

    // Move the source lead to CLOSED_WON if it exists
    if (body.source_lead_id) {
        try {
            await sb.schema('prospecting').from('leads')
                .update({ stage: 'CLOSED_WON', closed_at: new Date().toISOString() })
                .eq('id', body.source_lead_id);
        } catch (e) { /* best-effort */ }
    }

    // Re-fetch with relations for the response
    const { data: full } = await sb.from('deals')
        .select(`*, sdr_users(id, display_name, sdr_key, initials, avatar_color)`)
        .eq('id', deal.id)
        .single();

    return res.status(200).json({
        deal: full,
        proposal_url: proposalUrl,
        payment_link: paymentLink,
        invoice_pdf: invoicePdf
    });
}

module.exports = async function handler(req, res) {
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    if (req.method === 'GET') return handleList(gate.sb, req, res);
    if (req.method === 'POST') return handleCreate(gate.sb, gate.userId, req, res);
    return methodNotAllowed(res, 'GET, POST');
};
