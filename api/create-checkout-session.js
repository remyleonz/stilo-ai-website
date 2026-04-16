/**
 * POST /api/create-checkout-session
 *
 * Bundle checkout: customer can select 1..N agents and buy all of them in
 * a single Stripe Checkout Session.
 *
 * Body:
 *   {
 *     agent_ids:  ["echo", "ignite", "forge"]  // required, array of agent codenames
 *     email:      "jessica@planetfitnessmiami.com",
 *     client_id:  "<uuid from Supabase auth>" | null,  // optional, passed back in webhook metadata
 *     business_name: "Planet Fitness Miami"  // optional
 *   }
 *
 * Backward compatible: if a single `agent_id` is sent (old clients) we wrap it
 * in an array.
 *
 * Stripe requires subscription mode when ANY line item is recurring. So: if
 * any selected agent has a monthly fee, the session is mode=subscription and
 * the one-time setup fees ride along on the first invoice. Otherwise it's
 * mode=payment (happens when the cart is SIGNAL-only or FLUX-only).
 *
 * Required env vars (per agent, only for agents actually in the cart):
 *   STRIPE_PRICE_ECHO_SETUP, STRIPE_PRICE_ECHO_MONTHLY
 *   STRIPE_PRICE_IGNITE_SETUP, STRIPE_PRICE_IGNITE_MONTHLY
 *   ... (see api/_agents.js for full list)
 *   STRIPE_SECRET_KEY
 *   SITE_URL  (e.g. https://stiloaipartners.com)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { AGENTS, normalizeAgentId, calculateTotals } = require('./_agents');

module.exports = async function createCheckoutSession(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  let ids = Array.isArray(body.agent_ids) ? body.agent_ids.slice() : [];
  if (ids.length === 0 && body.agent_id) ids = [body.agent_id];

  const normalized = [];
  const rejected = [];
  for (const id of ids) {
    const code = normalizeAgentId(id);
    if (code && AGENTS[code].purchaseMode === 'self_serve') {
      if (!normalized.includes(code)) normalized.push(code);
    } else {
      rejected.push(id);
    }
  }

  if (normalized.length === 0) {
    return res.status(400).json({
      error:
        'No valid self-serve agents selected. FLUX is consult-only; book a call for custom work.',
      rejected: rejected,
    });
  }

  // Verify every agent has the Stripe price IDs it needs
  const missingEnv = [];
  for (const code of normalized) {
    const a = AGENTS[code];
    if (!a.stripeSetupPriceEnv || !process.env[a.stripeSetupPriceEnv]) {
      missingEnv.push(a.stripeSetupPriceEnv || `SETUP price env for ${code}`);
    }
    if (
      a.monthlyFeeCents > 0 &&
      (!a.stripeMonthlyPriceEnv || !process.env[a.stripeMonthlyPriceEnv])
    ) {
      missingEnv.push(a.stripeMonthlyPriceEnv || `MONTHLY price env for ${code}`);
    }
  }
  if (missingEnv.length > 0) {
    console.error('Missing Stripe price env vars:', missingEnv);
    return res.status(500).json({
      error:
        'Stripe is not fully configured. Missing price IDs for selected agents. See SETUP.md.',
      missing: missingEnv,
    });
  }

  // Build line items
  const lineItems = [];
  let hasRecurring = false;
  for (const code of normalized) {
    const a = AGENTS[code];
    lineItems.push({ price: process.env[a.stripeSetupPriceEnv], quantity: 1 });
    if (a.monthlyFeeCents > 0 && a.stripeMonthlyPriceEnv) {
      lineItems.push({
        price: process.env[a.stripeMonthlyPriceEnv],
        quantity: 1,
      });
      hasRecurring = true;
    }
  }

  const totals = calculateTotals(normalized);
  const origin = process.env.SITE_URL || req.headers.origin || '';

  const metadata = {
    selected_agents: normalized.join(','),
    client_id: body.client_id || '',
    business_name: body.business_name || '',
    source: 'stilo-ai-site',
  };

  try {
    const session = await stripe.checkout.sessions.create(
      Object.assign(
        {
          mode: hasRecurring ? 'subscription' : 'payment',
          payment_method_types: ['card'],
          line_items: lineItems,
          customer_email: body.email || undefined,
          allow_promotion_codes: true,
          success_url:
            (origin || '') +
            '/dashboard.html?welcome=true&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: (origin || '') + '/index.html#contact',
          metadata: metadata,
        },
        hasRecurring
          ? { subscription_data: { metadata: metadata } }
          : {}
      )
    );

    return res.status(200).json({
      checkout_url: session.url,
      session_id: session.id,
      totals: totals,
      agents: normalized,
    });
  } catch (err) {
    console.error('Stripe session error:', err);
    return res.status(500).json({
      error: 'Failed to create checkout session',
      detail: err && err.message ? err.message : String(err),
    });
  }
};
