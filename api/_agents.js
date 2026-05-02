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

/**
 * onboardingSchema field types
 * --------------------------------------------------------------
 * Each step in onboardingSchema is { step, fields: [...] }. The
 * step number lines up with the step names in onboardingSteps.
 *
 * Field shape:
 *   { key, label, type, required?, help?, options? }
 *
 * Supported types:
 *   text         single-line input
 *   textarea     multi-line
 *   email
 *   phone
 *   number
 *   url
 *   boolean      checkbox / yes-no
 *   select       requires options: [{ value, label }]
 *   time-range   { open, close } per day key (key must end in "_hours")
 *   csv-upload   file picker, value is the uploaded file path
 *   key-value-list  array of { key, value } pairs (e.g. REVIVE offer tiers)
 *
 * The wizard renderer in app/index.html picks the right control per type.
 * Steps that don't appear here (or agents without an onboardingSchema)
 * fall back to the legacy JSON-textarea editor.
 *
 * Editable post-activation fields are tagged with `editable: true`. Those
 * are the ones surfaced in the per-agent detail page edit mode. Fields
 * without that flag are setup-only.
 */

var AGENTS = {
  echo: {
    code: 'echo',
    name: 'ECHO - AI Receptionist',
    shortName: 'ECHO',
    setupFeeCents: 200000,
    monthlyFeeCents: 100000,
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
    onboardingSchema: [
      { step: 1, fields: [
        { key: 'business_name', label: 'Business name', type: 'text', required: true, editable: true },
        { key: 'industry', label: 'Business type', type: 'select', required: true, editable: true,
          help: 'ECHO uses this to answer calls the right way for your industry.',
          options: [
            { value: 'real-estate', label: 'Real Estate' },
            { value: 'plumbing', label: 'Plumbing' },
            { value: 'roofing', label: 'Roofing' },
            { value: 'hvac', label: 'HVAC (Heating & Air)' },
            { value: 'veterinary', label: 'Veterinary / Animal Hospital' },
            { value: 'dental', label: 'Dental Practice' },
            { value: 'orthodontics', label: 'Orthodontics' },
            { value: 'chiropractic', label: 'Chiropractic' },
            { value: 'med-spa', label: 'Med Spa / Aesthetics' },
            { value: 'legal-personal-injury', label: 'Law Firm: Personal Injury' },
            { value: 'legal-family-law', label: 'Law Firm: Family Law' },
            { value: 'auto-repair', label: 'Auto Repair' },
            { value: 'landscaping', label: 'Landscaping / Lawn Care' },
            { value: 'home-cleaning', label: 'Home Cleaning' },
            { value: 'gym-fitness', label: 'Gym / Fitness Studio' },
            { value: 'solar', label: 'Solar Installation' },
            { value: 'insurance-agency', label: 'Insurance Agency' },
            { value: 'general', label: 'Other service business' },
          ],
        },
        { key: 'address', label: 'Street address', type: 'text', editable: true,
          help: 'What ECHO will read back when a caller asks "where are you located?"' },
        { key: 'website', label: 'Website', type: 'url', editable: true },
        { key: 'main_phone', label: 'Main business phone (the number you currently give out)', type: 'phone', required: true, editable: true,
          help: 'ECHO routes complex calls here when it cannot help.' },
      ]},
      { step: 2, fields: [
        { key: 'services', label: 'Services and pricing', type: 'key-value-list', required: true, editable: true,
          help: 'List each service and its price. Example: "Haircut" / "$45". ECHO uses this to answer pricing questions.' },
        { key: 'booking_required_services', label: 'Which services require booking (vs walk-in)?', type: 'textarea', editable: true },
      ]},
      { step: 3, fields: [
        { key: 'monday_hours', label: 'Monday', type: 'time-range', editable: true },
        { key: 'tuesday_hours', label: 'Tuesday', type: 'time-range', editable: true },
        { key: 'wednesday_hours', label: 'Wednesday', type: 'time-range', editable: true },
        { key: 'thursday_hours', label: 'Thursday', type: 'time-range', editable: true },
        { key: 'friday_hours', label: 'Friday', type: 'time-range', editable: true },
        { key: 'saturday_hours', label: 'Saturday', type: 'time-range', editable: true },
        { key: 'sunday_hours', label: 'Sunday', type: 'time-range', editable: true },
        { key: 'closed_holidays', label: 'Closed on federal holidays', type: 'boolean', editable: true },
        { key: 'after_hours_message', label: 'After-hours message', type: 'textarea', editable: true,
          help: 'What ECHO says when someone calls outside business hours.' },
      ]},
      { step: 4, fields: [
        { key: 'booking_system', label: 'Booking system', type: 'select', required: true, editable: true, options: [
          { value: 'square', label: 'Square Appointments' },
          { value: 'calendly', label: 'Calendly' },
          { value: 'acuity', label: 'Acuity Scheduling' },
          { value: 'google_calendar', label: 'Google Calendar (manual)' },
          { value: 'sms_booking_link', label: 'I send a booking link by SMS' },
          { value: 'none', label: 'No booking system yet' },
        ]},
        { key: 'booking_link', label: 'Booking link (or schedule URL)', type: 'url', editable: true,
          help: 'ECHO texts this to callers who want to book.' },
        { key: 'booking_sms_template', label: 'SMS template ECHO sends after a call', type: 'textarea', editable: true,
          help: 'Defaults to "Hi {first_name}, here is your booking link: {booking_link}".' },
      ]},
      { step: 5, fields: [
        { key: 'forwarding_phone', label: 'Forward calls FROM this number to ECHO', type: 'phone', required: true,
          help: 'Your existing business number. We will provision a Retell number and you forward calls to it.' },
        { key: 'forwarding_method', label: 'How will you forward calls?', type: 'select', editable: true, options: [
          { value: 'always', label: 'Always forward (ECHO answers everything)' },
          { value: 'no_answer', label: 'Forward when you do not pick up' },
          { value: 'busy', label: 'Forward when busy' },
        ]},
        { key: 'transfer_phone', label: 'Number to TRANSFER to when ECHO cannot help', type: 'phone', editable: true,
          help: 'Your cell or main line. ECHO transfers if the caller asks for a human.' },
      ]},
      { step: 6, fields: [
        { key: 'voice', label: 'Voice', type: 'select', required: true, editable: true, options: [
          { value: 'female_warm', label: 'Female, warm' },
          { value: 'female_pro', label: 'Female, professional' },
          { value: 'male_warm', label: 'Male, warm' },
          { value: 'male_pro', label: 'Male, professional' },
        ]},
        { key: 'greeting', label: 'Custom greeting (optional)', type: 'textarea', editable: true,
          help: 'First sentence ECHO says. Defaults to "Thanks for calling {business_name}, this is {voice_name}, how can I help?"' },
        { key: 'persona_notes', label: 'Anything else ECHO should know about your brand voice?', type: 'textarea', editable: true },
      ]},
      { step: 7, fields: [
        { key: 'confirm_review', label: 'I have reviewed everything above and ECHO is ready to go live', type: 'boolean', required: true },
      ]},
    ],
  },
  ignite: {
    code: 'ignite',
    name: 'IGNITE - Lead Response Agent',
    shortName: 'IGNITE',
    setupFeeCents: 250000,
    monthlyFeeCents: 150000,
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
    onboardingSchema: [
      { step: 1, fields: [
        { key: 'business_name', label: 'Business name', type: 'text', required: true, editable: true },
        { key: 'industry', label: 'Industry / niche', type: 'select', required: true, editable: true,
          help: 'IGNITE uses a niche-specific playbook so the voice calls and emails match your exact business type.',
          options: [
            { value: 'real-estate', label: 'Real Estate' },
            { value: 'plumbing', label: 'Plumbing' },
            { value: 'roofing', label: 'Roofing' },
            { value: 'hvac', label: 'HVAC (Heating & Air)' },
            { value: 'veterinary', label: 'Veterinary / Animal Hospital' },
            { value: 'dental', label: 'Dental Practice' },
            { value: 'orthodontics', label: 'Orthodontics' },
            { value: 'chiropractic', label: 'Chiropractic' },
            { value: 'med-spa', label: 'Med Spa / Aesthetics' },
            { value: 'legal-personal-injury', label: 'Law Firm: Personal Injury' },
            { value: 'legal-family-law', label: 'Law Firm: Family Law' },
            { value: 'auto-repair', label: 'Auto Repair' },
            { value: 'landscaping', label: 'Landscaping / Lawn Care' },
            { value: 'home-cleaning', label: 'Home Cleaning' },
            { value: 'gym-fitness', label: 'Gym / Fitness Studio' },
            { value: 'solar', label: 'Solar Installation' },
            { value: 'insurance-agency', label: 'Insurance Agency' },
            { value: 'general', label: 'Other service business' },
          ],
        },
        { key: 'website', label: 'Website', type: 'url', editable: true },
        { key: 'main_offer', label: 'Your main offer in one sentence', type: 'textarea', editable: true,
          help: 'IGNITE leads with this in the first reply.' },
      ]},
      { step: 2, fields: [
        { key: 'webhook_url', label: 'Your IGNITE webhook URL', type: 'webhook-url',
          help: 'Point your CRM, ad platform, or website form to this URL. IGNITE picks up the lead in under 2 minutes.' },
        { key: 'lead_sources', label: 'Where will leads come from?', type: 'select', required: true, editable: true,
          help: 'Pick your primary source. You can add more later.',
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel (CRM)' },
            { value: 'facebook_lead_ads', label: 'Facebook / Instagram Lead Ads' },
            { value: 'website_form', label: 'Website contact form' },
            { value: 'zapier', label: 'Zapier or Make (multi-source)' },
            { value: 'google_ads', label: 'Google Ads lead form' },
            { value: 'other', label: 'Other / not sure yet' },
          ],
        },
        { key: 'expected_volume', label: 'Roughly how many leads per week?', type: 'number', editable: true },
        { key: 'webhook_confirmed', label: 'I\'ve connected at least one lead source to the webhook URL above', type: 'boolean', required: true },
      ]},
      { step: 3, fields: [
        { key: 'current_offer', label: 'Current promo / lead magnet', type: 'textarea', required: true, editable: true,
          help: 'Example: "20% off first service" or "Free 15-min consult". IGNITE mentions this in the first reply.' },
        { key: 'offer_expires', label: 'Offer expires (optional)', type: 'text', editable: true,
          help: 'Free text. Example: "End of month" or "May 31, 2026".' },
      ]},
      { step: 4, fields: [
        { key: 'reply_speed', label: 'How fast should IGNITE reply?', type: 'select', editable: true, options: [
          { value: 'immediate', label: 'Immediately (within 60 seconds)' },
          { value: 'within_5min', label: 'Within 5 minutes' },
          { value: 'within_15min', label: 'Within 15 minutes' },
        ]},
        { key: 'tone', label: 'Tone', type: 'select', editable: true, options: [
          { value: 'casual', label: 'Casual and friendly' },
          { value: 'professional', label: 'Professional' },
          { value: 'concise', label: 'Concise (very short replies)' },
        ]},
        { key: 'cta_url', label: 'Default CTA link (booking, calendar, etc.)', type: 'url', editable: true },
        { key: 'escalate_after', label: 'Escalate to you after how many client replies without booking?', type: 'number', editable: true,
          help: 'Default: 3' },
        { key: 'escalation_email', label: 'Email to escalate to', type: 'email', editable: true },
      ]},
      { step: 5, fields: [
        { key: 'confirm_review', label: 'I have reviewed everything and IGNITE is ready to start replying', type: 'boolean', required: true },
      ]},
    ],
  },
  revive: {
    code: 'revive',
    name: 'REVIVE - Customer Reactivation',
    shortName: 'REVIVE',
    setupFeeCents: 250000,
    monthlyFeeCents: 150000,
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
    onboardingSchema: [
      { step: 1, fields: [
        { key: 'industry', label: 'Business type', type: 'select', required: true,
          help: 'REVIVE uses industry-specific timing and offer language. A gym reactivates customers differently than a dental office.',
          options: [
            { value: 'real-estate', label: 'Real Estate' },
            { value: 'plumbing', label: 'Plumbing' },
            { value: 'roofing', label: 'Roofing' },
            { value: 'hvac', label: 'HVAC (Heating & Air)' },
            { value: 'veterinary', label: 'Veterinary / Animal Hospital' },
            { value: 'dental', label: 'Dental Practice' },
            { value: 'orthodontics', label: 'Orthodontics' },
            { value: 'chiropractic', label: 'Chiropractic' },
            { value: 'med-spa', label: 'Med Spa / Aesthetics' },
            { value: 'legal-personal-injury', label: 'Law Firm: Personal Injury' },
            { value: 'legal-family-law', label: 'Law Firm: Family Law' },
            { value: 'auto-repair', label: 'Auto Repair' },
            { value: 'landscaping', label: 'Landscaping / Lawn Care' },
            { value: 'home-cleaning', label: 'Home Cleaning' },
            { value: 'gym-fitness', label: 'Gym / Fitness Studio' },
            { value: 'solar', label: 'Solar Installation' },
            { value: 'insurance-agency', label: 'Insurance Agency' },
            { value: 'general', label: 'Other service business' },
          ],
        },
        { key: 'customer_csv', label: 'Customer database (CSV or XLSX)', type: 'csv-upload', required: true,
          help: 'Export from your POS, booking system, or CRM. Needs at minimum: name, email, last visit date.' },
      ]},
      { step: 2, fields: [
        { key: 'col_name', label: 'Column for customer name', type: 'text', required: true,
          help: 'Type the exact column header from your CSV.' },
        { key: 'col_email', label: 'Column for email', type: 'text', required: true },
        { key: 'col_last_visit', label: 'Column for last visit / last purchase date', type: 'text', required: true },
        { key: 'col_ltv', label: 'Column for lifetime value (optional)', type: 'text' },
        { key: 'col_phone', label: 'Column for phone (optional)', type: 'text' },
      ]},
      { step: 3, fields: [
        { key: 'offer_3_month', label: '3-month lapsed offer', type: 'textarea', required: true, editable: true,
          help: 'Example: "We miss you! 15% off your next visit, this month only."' },
        { key: 'offer_6_month', label: '6-month lapsed offer', type: 'textarea', required: true, editable: true,
          help: 'Example: "It has been a while. 20% off + complimentary consult."' },
        { key: 'offer_1_year', label: '1-year+ lapsed offer', type: 'textarea', required: true, editable: true,
          help: 'Strongest offer. Example: "Bring a friend, both get 25% off."' },
        { key: 'offer_cancelled', label: 'Cancelled customer offer (optional)', type: 'textarea', editable: true },
        { key: 'booking_link', label: 'Booking link (where the offer points)', type: 'url', required: true, editable: true },
      ]},
      { step: 4, fields: [
        { key: 'sender_name', label: 'Email sender name', type: 'text', required: true, editable: true,
          help: 'Example: "Ana from Glamour Hair Studio".' },
        { key: 'sender_email', label: 'Sender email address', type: 'email', required: true,
          help: 'You verify ownership in the next step. We use Resend to send.' },
        { key: 'reply_to', label: 'Reply-to email (where customer replies land)', type: 'email', editable: true },
        { key: 'send_rate_per_hour', label: 'Max emails per hour', type: 'number', editable: true,
          help: 'Default: 80. Lower if your domain is new.' },
      ]},
      { step: 5, fields: [
        { key: 'preview_3_month', label: 'Preview the 3-month email (read-only)', type: 'textarea',
          help: 'We render the offer text into the template. Edit step 3 if you want changes.' },
        { key: 'segment_review_ok', label: 'The segment counts and preview look right', type: 'boolean', required: true },
      ]},
      { step: 6, fields: [
        { key: 'confirm_launch', label: 'Launch the campaign now', type: 'boolean', required: true,
          help: 'On launch, REVIVE sends the first batch within an hour and continues at the rate you set.' },
      ]},
    ],
  },
  scout: {
    code: 'scout',
    name: 'SCOUT - Lead Generator',
    shortName: 'SCOUT',
    setupFeeCents: 300000,
    monthlyFeeCents: 200000,
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
    monthlyFeeCents: 200000,
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
