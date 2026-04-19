/**
 * Create Stripe Payment Link
 *
 * Generates a shareable Stripe Payment Link for cold outreach closes.
 * Call this after a sales call to get a link to send the prospect.
 *
 * Usage:
 *   POST /api/create-payment-link
 *   Body: { agents: ["receptionist", "lcr"], client_email: "john@acme.com", client_name: "Acme Plumbing" }
 *   Returns: { url: "https://buy.stripe.com/..." }
 *
 * Or run directly from the command line:
 *   node create-payment-link.js receptionist lcr
 *
 * Setup:
 *   npm install stripe
 *   Set STRIPE_SECRET_KEY environment variable
 *   Update PRICE_IDS below with real IDs from stripe_products.json
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- Fill these in from stripe_products.json after running stripe_setup.py ---
const PRICE_IDS = {
  receptionist: {
    installation: 'price_receptionist_install', // $1,500 one-time
    monthly: 'price_receptionist_monthly'       // $450/mo recurring
  },
  lead_reply: {
    installation: 'price_lead_reply_install',   // $2,000 one-time
    monthly: 'price_lead_reply_monthly'         // $650/mo recurring
  },
  website: {
    installation: 'price_website_install',      // $1,250 one-time
    monthly: 'price_website_monthly'            // $200/mo recurring
  },
  seo: {
    installation: 'price_seo_install'           // $1,000 one-time
  },
  ontology_t1: {
    installation: 'price_ontology_t1_install'   // $1,000 one-time
  },
  ontology_t2: {
    monthly: 'price_ontology_t2_monthly'        // $3,250/mo recurring
  },
  ontology_t3: {
    monthly: 'price_ontology_t3_monthly'        // $6,000/mo recurring
  },
  lcr: {
    installation: 'price_lcr_install',          // $2,500 one-time
    monthly: 'price_lcr_monthly'                // $800/mo recurring
  },
  lead_gen: {
    installation: 'price_lead_gen_install',     // $2,500 one-time
    monthly: 'price_lead_gen_monthly'           // $1,000/mo recurring
  },
  custom: {
    installation: 'price_custom_install'        // $1,000+ variable
  }
};

// Agent display names (for the payment link description)
const AGENT_NAMES = {
  receptionist: 'AI Receptionist',
  lead_reply: 'Lead Response Agent',
  website: 'AI Website Builder',
  seo: 'AI SEO (GEO)',
  ontology_t1: 'Growth Intelligence - Data Audit',
  ontology_t2: 'Growth Intelligence - Monthly',
  ontology_t3: 'Growth Intelligence - Full Partner',
  lcr: 'Customer Reactivation (LCR)',
  lead_gen: 'Lead Generator',
  custom: 'Custom Automations'
};

/**
 * Build line items for a Payment Link from an array of agent IDs.
 * Includes both installation (one-time) and monthly (recurring) prices.
 * Note: Stripe Payment Links support mixed billing modes, but if you mix
 * one-time and recurring, you must use a custom flow. This defaults to
 * recurring mode and skips installation fees -- see note below.
 *
 * For deals with setup fees, use createCheckoutSession instead, which
 * supports mixed line items.
 */
function buildLineItems(agents) {
  var lineItems = [];
  var hasRecurring = false;
  var hasOneTime = false;

  agents.forEach(function(agentId) {
    var prices = PRICE_IDS[agentId];
    if (!prices) {
      throw new Error('Unknown agent type: ' + agentId);
    }

    if (prices.installation) {
      lineItems.push({ price: prices.installation, quantity: 1 });
      hasOneTime = true;
    }
    if (prices.monthly) {
      lineItems.push({ price: prices.monthly, quantity: 1 });
      hasRecurring = true;
    }
  });

  return { lineItems: lineItems, hasRecurring: hasRecurring, hasOneTime: hasOneTime };
}

/**
 * Create a Stripe Payment Link for the given agent IDs.
 *
 * If agents have BOTH setup fees and monthly prices, two links are created:
 *   - setupUrl: one-time payment for all installation fees
 *   - monthlyUrl: subscription for all monthly retainers
 *
 * Send the client BOTH links. They pay setup first, then subscribe monthly.
 *
 * If agents only have one-time prices, only setupUrl is returned.
 * If agents only have recurring prices, only monthlyUrl is returned.
 */
async function createPaymentLinks(agents, clientEmail, clientName) {
  if (!agents || agents.length === 0) {
    throw new Error('No agents specified');
  }

  var setupPrices = [];
  var monthlyPrices = [];

  agents.forEach(function(agentId) {
    var prices = PRICE_IDS[agentId];
    if (!prices) throw new Error('Unknown agent: ' + agentId);
    if (prices.installation) setupPrices.push({ price: prices.installation, quantity: 1 });
    if (prices.monthly) monthlyPrices.push({ price: prices.monthly, quantity: 1 });
  });

  var agentLabel = agents.map(function(id) { return AGENT_NAMES[id] || id; }).join(' + ');
  var result = { agents: agentLabel };

  // Create setup fee link (one-time payment)
  if (setupPrices.length > 0) {
    var setupLink = await stripe.paymentLinks.create({
      line_items: setupPrices,
      metadata: {
        type: 'setup',
        agents: agents.join(','),
        client_name: clientName || '',
        client_email: clientEmail || ''
      },
      after_completion: {
        type: 'redirect',
        redirect: { url: (process.env.SITE_URL || 'https://stiloaipartners.com') + '/dashboard.html?welcome=true' }
      }
    });
    result.setupUrl = setupLink.url;
    result.setupDescription = 'One-time setup fee for: ' + agentLabel;
  }

  // Create monthly subscription link
  if (monthlyPrices.length > 0) {
    var monthlyLink = await stripe.paymentLinks.create({
      line_items: monthlyPrices,
      metadata: {
        type: 'subscription',
        agents: agents.join(','),
        client_name: clientName || '',
        client_email: clientEmail || ''
      },
      after_completion: {
        type: 'redirect',
        redirect: { url: (process.env.SITE_URL || 'https://stiloaipartners.com') + '/dashboard.html' }
      }
    });
    result.monthlyUrl = monthlyLink.url;
    result.monthlyDescription = 'Monthly retainer for: ' + agentLabel;
  }

  return result;
}

// --- HTTP handler (for Vercel API route) ---
async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var agents = req.body.agents;
  var clientEmail = req.body.client_email || '';
  var clientName = req.body.client_name || '';

  if (!agents || !Array.isArray(agents) || agents.length === 0) {
    return res.status(400).json({ error: 'agents must be a non-empty array of agent IDs' });
  }

  try {
    var links = await createPaymentLinks(agents, clientEmail, clientName);
    res.status(200).json(links);
  } catch (err) {
    console.error('Error creating payment links:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// --- CLI mode: node create-payment-link.js receptionist lcr ---
if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node create-payment-link.js <agent1> [agent2] ...');
    console.log('Available agents:', Object.keys(PRICE_IDS).join(', '));
    process.exit(1);
  }

  createPaymentLinks(args, '', '')
    .then(function(result) {
      console.log('\nPayment Links Generated');
      console.log('========================');
      console.log('Agents:', result.agents);
      if (result.setupUrl) {
        console.log('\nStep 1 - Setup fee link (send this first):');
        console.log(result.setupUrl);
        console.log('(' + result.setupDescription + ')');
      }
      if (result.monthlyUrl) {
        console.log('\nStep 2 - Monthly subscription link:');
        console.log(result.monthlyUrl);
        console.log('(' + result.monthlyDescription + ')');
      }
      console.log('\nPaste both links into your follow-up email.');
    })
    .catch(function(err) {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = handler;
