/**
 * Single source of truth for all 8 STILO AI Partners agents.
 *
 * Shared between:
 *   - api/create-checkout-session.js (to build Stripe line items)
 *   - api/stripe-webhook.js (to write client_agents rows + onboarding steps)
 *   - app/index.html + index.html (via a future /api/agents GET endpoint)
 *
 * Agent IDs use the codenames from the memory catalog and schema.sql
 * (echo, ignite, ...) — never the legacy descriptive names.
 *
 * Stripe price IDs come from environment variables so Remy can rotate them
 * between test and live without code changes. Missing env vars surface as
 * a clear error in the checkout endpoint.
 */

var AGENTS = {
  echo: {
    code: 'echo',
    name: 'ECHO - AI Receptionist',
    shortName: 'ECHO',
    setupFeeCents: 150000,
    monthlyFeeCents: 45000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_ECHO_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_ECHO_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Business info',
      'Services & pricing',
      'Business hours',
      'Booking system connection',
      'Phone setup',
      'Voice personality',
      'Review & activate',
    ],
  },
  ignite: {
    code: 'ignite',
    name: 'IGNITE - Lead Response Agent',
    shortName: 'IGNITE',
    setupFeeCents: 200000,
    monthlyFeeCents: 65000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_IGNITE_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_IGNITE_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Business info',
      'Lead sources',
      'Current offers',
      'Response preferences',
      'Review & activate',
    ],
  },
  revive: {
    code: 'revive',
    name: 'REVIVE - Customer Reactivation',
    shortName: 'REVIVE',
    setupFeeCents: 250000,
    monthlyFeeCents: 80000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_REVIVE_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_REVIVE_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Upload customer database',
      'Map columns',
      'Set win-back offers',
      'Email sender config',
      'Review segments',
      'Launch',
    ],
  },
  scout: {
    code: 'scout',
    name: 'SCOUT - Lead Generator',
    shortName: 'SCOUT',
    setupFeeCents: 250000,
    monthlyFeeCents: 100000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_SCOUT_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_SCOUT_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Target criteria',
      'Outreach preferences',
      'Email setup',
      'Review & launch',
    ],
  },
  forge: {
    code: 'forge',
    name: 'FORGE - AI Website',
    shortName: 'FORGE',
    setupFeeCents: 125000,
    monthlyFeeCents: 20000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_FORGE_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_FORGE_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Business info',
      'Design preferences',
      'Content requirements',
      'Review & approve',
    ],
  },
  signal: {
    code: 'signal',
    name: 'SIGNAL - AI SEO (GEO)',
    shortName: 'SIGNAL',
    setupFeeCents: 100000,
    monthlyFeeCents: 0,
    stripeSetupPriceEnv: 'STRIPE_PRICE_SIGNAL_SETUP',
    stripeMonthlyPriceEnv: null,
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Website audit',
      'Keyword targets',
      'Review & implement',
    ],
  },
  oracle: {
    code: 'oracle',
    name: 'ORACLE - Growth Intelligence',
    shortName: 'ORACLE',
    setupFeeCents: 300000,
    monthlyFeeCents: 100000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_ORACLE_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_ORACLE_MONTHLY',
    purchaseMode: 'self_serve',
    onboardingSteps: [
      'Data source mapping',
      'KPI selection',
      'Reporting cadence',
      'Baseline analysis',
      'Review & activate',
    ],
  },
  flux: {
    code: 'flux',
    name: 'FLUX - Custom Automations',
    shortName: 'FLUX',
    setupFeeCents: 100000, // starting at, scoped per project
    monthlyFeeCents: 0,
    stripeSetupPriceEnv: null,
    stripeMonthlyPriceEnv: null,
    purchaseMode: 'consult_only',
    onboardingSteps: [
      'Requirements gathering',
      'Solution design',
      'Build & test',
      'Review & deploy',
    ],
  },
};

/**
 * Legacy ID map. The old checkout endpoint and some UI used underscored names
 * like `lead_reply` and `ontology`. New agent IDs are codenames. This map
 * normalizes any incoming legacy ID so old browser clients keep working.
 */
var LEGACY_ID_MAP = {
  receptionist: 'echo',
  lead_reply: 'ignite',
  'lead-response': 'ignite',
  lcr: 'revive',
  reactivation: 'revive',
  'lead-gen': 'scout',
  lead_gen: 'scout',
  website: 'forge',
  seo: 'signal',
  'growth-intel': 'oracle',
  ontology: 'oracle',
  custom: 'flux',
};

function normalizeAgentId(id) {
  if (!id) return null;
  var lower = String(id).toLowerCase();
  if (AGENTS[lower]) return lower;
  if (LEGACY_ID_MAP[lower]) return LEGACY_ID_MAP[lower];
  return null;
}

function calculateTotals(codes) {
  var setupCents = 0;
  var monthlyCents = 0;
  for (var i = 0; i < codes.length; i++) {
    var a = AGENTS[codes[i]];
    if (a && a.purchaseMode === 'self_serve') {
      setupCents += a.setupFeeCents;
      monthlyCents += a.monthlyFeeCents;
    }
  }
  return { setupCents: setupCents, monthlyCents: monthlyCents };
}

module.exports = {
  AGENTS: AGENTS,
  LEGACY_ID_MAP: LEGACY_ID_MAP,
  normalizeAgentId: normalizeAgentId,
  calculateTotals: calculateTotals,
};
