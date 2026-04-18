/**
 * Create Stripe Checkout Session
 *
 * Called when a user clicks "Get Started Now" on the website.
 * Creates a Stripe Checkout session and returns the URL.
 *
 * Deploy as a serverless function (Vercel API route or standalone Express).
 *
 * Setup:
 * 1. npm install stripe
 * 2. Set environment variables: STRIPE_SECRET_KEY
 * 3. Create Stripe Price IDs for each agent (see PRICE_IDS below)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ============================================================
// PRICE IDS -- fill these in after running stripe_setup.py
// ============================================================
// 1. Run: python stripe_setup.py  (add your sk_live_ key first)
// 2. Open the generated stripe_products.json
// 3. Copy each price_id into the matching field below
//
// stripe_products.json structure:
//   products.receptionist.prices.Setup.price_id    -> installation
//   products.receptionist.prices.Monthly.price_id  -> monthly
// ============================================================
const PRICE_IDS = {
  receptionist: {
    installation: 'price_receptionist_install', // $1,500 one-time  <- replace
    monthly: 'price_receptionist_monthly'       // $450/mo recurring <- replace
  },
  lead_reply: {
    installation: 'price_lead_reply_install',   // $2,000 one-time  <- replace
    monthly: 'price_lead_reply_monthly'         // $650/mo recurring <- replace
  },
  website: {
    installation: 'price_website_install',      // $1,250 one-time  <- replace
    monthly: 'price_website_monthly'            // $200/mo recurring <- replace
  },
  seo: {
    installation: 'price_seo_install'           // $1,000 one-time  <- replace (no monthly)
  },
  ontology_t1: {
    installation: 'price_ontology_t1_install'   // $1,000 one-time  <- replace
  },
  ontology_t2: {
    monthly: 'price_ontology_t2_monthly'        // $3,250/mo        <- replace
  },
  ontology_t3: {
    monthly: 'price_ontology_t3_monthly'        // $6,000/mo        <- replace
  },
  lcr: {
    installation: 'price_lcr_install',          // $2,500 one-time  <- replace
    monthly: 'price_lcr_monthly'                // $800/mo recurring <- replace
  },
  lead_gen: {
    installation: 'price_lead_gen_install',     // $2,500 one-time  <- replace
    monthly: 'price_lead_gen_monthly'           // $1,000/mo        <- replace
  }
};

async function createCheckoutSession(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var agentId = req.body.agent_id;
  var clientId = req.body.client_id;
  var clientEmail = req.body.email;

  if (!agentId || !PRICE_IDS[agentId]) {
    return res.status(400).json({ error: 'Invalid agent type' });
  }

  var prices = PRICE_IDS[agentId];
  var lineItems = [];

  // Add installation fee (one-time)
  lineItems.push({
    price: prices.installation,
    quantity: 1
  });

  // Add monthly retainer (recurring) if applicable
  if (prices.monthly) {
    lineItems.push({
      price: prices.monthly,
      quantity: 1
    });
  }

  try {
    var session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: prices.monthly ? 'subscription' : 'payment',
      success_url: process.env.SITE_URL + '/dashboard.html?welcome=true&agent=' + agentId,
      cancel_url: process.env.SITE_URL + '/index.html#pricing',
      customer_email: clientEmail || undefined,
      metadata: {
        client_id: clientId || '',
        agent_type: agentId
      },
      subscription_data: prices.monthly ? {
        metadata: {
          client_id: clientId || '',
          agent_type: agentId
        }
      } : undefined,
      payment_intent_data: !prices.monthly ? {
        receipt_email: clientEmail || undefined
      } : undefined
    });

    res.status(200).json({ checkout_url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

module.exports = createCheckoutSession;
