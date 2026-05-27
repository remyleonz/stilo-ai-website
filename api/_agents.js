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

// ──────────────────────────────────────────────────────────────────────────
// Niche list. Drives industry pickers across Business Profile and every agent
// wizard. Each value matches a YAML in /niche_playbooks/{niche}.yaml that the
// Python agents load at runtime for terminology, objections, KPIs, and routing
// rules. Kept short on purpose: 10 Miami-focused niches + General.
// ──────────────────────────────────────────────────────────────────────────
var NICHE_OPTIONS = [
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'med_spa', label: 'Med Spa & Aesthetics' },
  { value: 'dental', label: 'Dental & Orthodontics' },
  { value: 'law', label: 'Law (PI, Family, Immigration)' },
  { value: 'hvac', label: 'HVAC' },
  { value: 'plumbing_roofing', label: 'Plumbing & Roofing' },
  { value: 'auto_repair', label: 'Auto Repair & Body Shop' },
  { value: 'restaurant_hospitality', label: 'Restaurants & Hospitality' },
  { value: 'fitness', label: 'Fitness & Gyms' },
  { value: 'professional_services', label: 'Professional Services' },
  { value: 'general', label: 'Other / General' },
];

var US_STATE_OPTIONS = [
  { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' }, { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' }, { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' }, { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' }, { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' }, { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' }, { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' }, { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' }, { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' }, { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' }, { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
];

var TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (ET) — Miami, NYC' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
];

var AGENTS = {

  // ──────────────────────────────────────────────────────────────────────
  // BUSINESS_PROFILE — pseudo-agent. Auto-provisioned for every client on
  // first dashboard load. Captures everything the other 7 agents need (name,
  // niche, hours, brand voice, KB, compliance, systems-in-place) so each
  // agent wizard only asks for what is unique to that agent.
  //
  // Stored as a row in `client_agents` with agent_type='business_profile' so
  // it reuses the entire onboarding_steps + wizard infrastructure. It is
  // free, hidden from billing, and gates the other agents until status
  // becomes 'active' (≥80 % of fields filled).
  // ──────────────────────────────────────────────────────────────────────
  business_profile: {
    code: 'business_profile',
    name: 'Business Profile',
    shortName: 'PROFILE',
    setupFeeCents: 0,
    monthlyFeeCents: 0,
    stripeSetupPriceEnv: null,
    stripeMonthlyPriceEnv: null,
    purchaseMode: 'auto_provisioned', // never sold; created on signup
    onboardingSteps: [
      'Identity & contact',
      'Niche & services',
      'Hours & availability',
      'Brand voice',
      'Knowledge base',
      'Logo & assets',
      'Compliance & legal',
      'Systems already in place',
    ],
    onboardingSchema: [

      // Step 1: Identity & contact ─────────────────────────────────────
      { step: 1, fields: [
        { key: 'business_legal_name', label: 'Legal business name', type: 'text', required: true, editable: true },
        { key: 'business_dba', label: 'DBA / trade name (if different)', type: 'text', editable: true },
        { key: 'business_ein', label: 'EIN (optional)', type: 'text', editable: true,
          help: 'Used by REVIVE for 10DLC SMS brand registration. Skip for now if you do not have it handy.' },
        { key: 'website', label: 'Website', type: 'url', editable: true },
        { key: 'owner_first_name', label: 'Owner first name', type: 'text', required: true, editable: true },
        { key: 'owner_last_name', label: 'Owner last name', type: 'text', required: true, editable: true },
        { key: 'owner_cell', label: 'Owner cell phone (E.164)', type: 'tel', required: true, editable: true,
          help: 'Used for emergency transfers and admin notifications. Format: +13055551234' },
        { key: 'owner_email', label: 'Owner email', type: 'email', required: true, editable: true },
        { key: 'support_email', label: 'Customer support email', type: 'email', editable: true,
          help: 'Where customer replies should land. Defaults to owner email.' },
        { key: 'main_business_phone', label: 'Main business phone (the number you give to customers today)', type: 'tel', required: true, editable: true },
        { key: 'street_address', label: 'Street address', type: 'text', required: true, editable: true,
          help: 'What ECHO reads back when a caller asks for your location.' },
        { key: 'city', label: 'City', type: 'text', required: true, editable: true },
        { key: 'state', label: 'State', type: 'select', required: true, editable: true, options: US_STATE_OPTIONS },
        { key: 'zip', label: 'Zip code', type: 'text', required: true, editable: true },
        { key: 'service_area_zips', label: 'Zip codes you serve (comma-separated)', type: 'text', editable: true,
          help: 'Used by SCOUT, IGNITE, and SIGNAL to recognize in-market vs out-of-market.' },
        { key: 'timezone', label: 'Timezone', type: 'select', required: true, editable: true, options: TIMEZONE_OPTIONS },
      ]},

      // Step 2: Niche & services ───────────────────────────────────────
      { step: 2, fields: [
        { key: 'niche', label: 'Your niche', type: 'select', required: true, editable: true,
          help: 'Drives every agent\'s playbook. Pick the closest match. You can edit later.',
          options: NICHE_OPTIONS },
        // Sub-niches per niche. Only the relevant ones render.
        { key: 'sub_niche', label: 'Sub-specialty (real estate)', type: 'select', editable: true,
          showIf: { niche: 'real_estate' },
          options: [
            { value: 'buyer_rep', label: 'Buyer representation' },
            { value: 'seller_rep', label: 'Seller representation' },
            { value: 'luxury', label: 'Luxury' },
            { value: 'investment', label: 'Investment / flips' },
            { value: 'property_mgmt', label: 'Property management' },
            { value: 'mixed', label: 'Mixed / general' },
          ] },
        { key: 'sub_niche', label: 'Sub-specialty (med spa)', type: 'select', editable: true,
          showIf: { niche: 'med_spa' },
          options: [
            { value: 'injectables', label: 'Injectables (Botox, fillers)' },
            { value: 'lasers', label: 'Lasers & light therapy' },
            { value: 'body_sculpting', label: 'Body sculpting / contouring' },
            { value: 'hair_restoration', label: 'Hair restoration' },
            { value: 'weight_loss', label: 'Medical weight loss / GLP-1' },
            { value: 'mixed', label: 'Mixed / full-service' },
          ] },
        { key: 'sub_niche', label: 'Sub-specialty (dental)', type: 'select', editable: true,
          showIf: { niche: 'dental' },
          options: [
            { value: 'general', label: 'General dentistry' },
            { value: 'orthodontics', label: 'Orthodontics' },
            { value: 'cosmetic', label: 'Cosmetic / veneers' },
            { value: 'pediatric', label: 'Pediatric' },
            { value: 'mixed', label: 'Mixed' },
          ] },
        { key: 'sub_niche', label: 'Practice area (law)', type: 'select', editable: true,
          showIf: { niche: 'law' },
          options: [
            { value: 'pi', label: 'Personal Injury' },
            { value: 'family', label: 'Family / Divorce' },
            { value: 'immigration', label: 'Immigration' },
            { value: 'criminal', label: 'Criminal Defense' },
            { value: 'real_estate_law', label: 'Real Estate Law' },
            { value: 'mixed', label: 'Mixed' },
          ] },
        { key: 'top_services', label: 'Top services with pricing', type: 'key-value-list', required: true, editable: true,
          help: 'Service name → price or range. Example: "Botox" → "$12-15/unit". ECHO and IGNITE quote these to callers.' },
        { key: 'services_we_dont_do', label: 'Services you DO NOT offer', type: 'textarea', editable: true,
          help: 'IGNITE and ECHO use this to politely redirect leads asking for things outside your scope.' },
        { key: 'main_offer', label: 'Your one-sentence main offer', type: 'textarea', editable: true,
          help: 'What every agent leads with. Example: "Miami\'s only fully-licensed med spa with same-day Botox appointments."' },
      ]},

      // Step 3: Hours & availability ───────────────────────────────────
      { step: 3, fields: [
        { key: 'monday_hours', label: 'Monday', type: 'time-range', editable: true },
        { key: 'tuesday_hours', label: 'Tuesday', type: 'time-range', editable: true },
        { key: 'wednesday_hours', label: 'Wednesday', type: 'time-range', editable: true },
        { key: 'thursday_hours', label: 'Thursday', type: 'time-range', editable: true },
        { key: 'friday_hours', label: 'Friday', type: 'time-range', editable: true },
        { key: 'saturday_hours', label: 'Saturday', type: 'time-range', editable: true },
        { key: 'sunday_hours', label: 'Sunday', type: 'time-range', editable: true },
        { key: 'closed_federal_holidays', label: 'Closed on US federal holidays', type: 'boolean', editable: true },
        { key: 'after_hours_default', label: 'Default after-hours behavior', type: 'select', required: true, editable: true,
          help: 'Each agent can override, but this is the default rule.',
          options: [
            { value: 'voicemail', label: 'Take a voicemail' },
            { value: 'forward_to_cell', label: 'Forward to owner cell' },
            { value: 'sms_book_link', label: 'Send SMS with booking link' },
            { value: 'sms_callback', label: 'Promise a callback next morning' },
          ] },
        { key: 'max_daily_capacity', label: 'Max bookings/calls owner can handle per day', type: 'number', editable: true,
          help: 'Used by ECHO and IGNITE to avoid over-booking the calendar.' },
      ]},

      // Step 4: Brand voice ────────────────────────────────────────────
      { step: 4, fields: [
        { key: 'tone', label: 'Tone', type: 'select', required: true, editable: true,
          options: [
            { value: 'casual', label: 'Casual and warm' },
            { value: 'mixed', label: 'Mix of casual and professional' },
            { value: 'professional', label: 'Polished and professional' },
          ] },
        { key: 'pace', label: 'Speaking pace (for voice agents)', type: 'select', editable: true,
          options: [
            { value: 'slow', label: 'Slow and deliberate' },
            { value: 'conversational', label: 'Conversational (recommended)' },
            { value: 'brisk', label: 'Brisk and to the point' },
          ] },
        { key: 'formality', label: 'How should agents address customers?', type: 'select', editable: true,
          options: [
            { value: 'first_name', label: 'First name (Hi Sarah)' },
            { value: 'sir_maam', label: 'Sir/Ma\'am (formal)' },
            { value: 'mixed', label: 'Mixed: formal then warm' },
          ] },
        { key: 'words_to_avoid', label: 'Words or phrases agents should never say (comma-separated)', type: 'text', editable: true },
        { key: 'on_brand_phrases', label: 'Phrases that ARE on-brand (comma-separated)', type: 'text', editable: true,
          help: 'Examples: "absolutely", "happy to help", "let me grab that for you".' },
        { key: 'communication_samples', label: 'Paste 2-3 sample emails or texts you have actually sent', type: 'textarea', editable: true,
          help: 'Used to calibrate brand voice. Confidential. Separate samples with a blank line.' },
        { key: 'languages_spoken', label: 'Languages your business speaks (comma-separated)', type: 'text', editable: true,
          help: 'Miami: typically "English, Spanish". ECHO and IGNITE can auto-switch.' },
      ]},

      // Step 5: Knowledge base ─────────────────────────────────────────
      { step: 5, fields: [
        { key: 'top_questions', label: 'Top questions customers ask (with your approved answers)', type: 'array-of-objects', required: true, editable: true,
          help: 'Aim for 10. Every agent uses these verbatim.',
          schema: [
            { key: 'question', label: 'Question', type: 'text' },
            { key: 'answer', label: 'Approved answer', type: 'textarea' },
          ],
          minItems: 5 },
        { key: 'top_objections', label: 'Top customer objections + how YOU handle them', type: 'array-of-objects', required: true, editable: true,
          schema: [
            { key: 'objection', label: 'Objection', type: 'text' },
            { key: 'response', label: 'Your response', type: 'textarea' },
          ],
          minItems: 3 },
        { key: 'owner_story', label: 'Your story / why this business exists (1 paragraph)', type: 'textarea', editable: true,
          help: 'Used by REVIVE in nurture emails and FORGE on the About page.' },
        { key: 'credentials', label: 'Awards, certifications, licenses, or notable press', type: 'textarea', editable: true },
        { key: 'insurance_carriers', label: 'Insurance carriers you accept', type: 'text', editable: true,
          help: 'Comma-separated. Common pre-call question for med spa, dental, and law.',
          showIf: { niche: 'med_spa' } },
        { key: 'insurance_carriers', label: 'Insurance carriers you accept', type: 'text', editable: true,
          help: 'Comma-separated.',
          showIf: { niche: 'dental' } },
      ]},

      // Step 6: Logo & assets ──────────────────────────────────────────
      { step: 6, fields: [
        { key: 'logo_url', label: 'Logo URL (PNG or SVG, transparent background preferred)', type: 'url', editable: true,
          help: 'Drop your logo into your website CDN, Google Drive (public link), or Imgur and paste the URL.' },
        { key: 'logo_dark_url', label: 'Logo URL (dark background variant, optional)', type: 'url', editable: true },
        { key: 'brand_color_hex', label: 'Primary brand color (hex)', type: 'text', editable: true,
          help: 'Format: #2563EB. Used by FORGE for the website and REVIVE for email accents.' },
        { key: 'photo_urls', label: 'Photo URLs (comma-separated, 3-5 photos)', type: 'textarea', editable: true,
          help: 'Interior, team, work-product. Used by FORGE for the website hero and REVIVE for email content.' },
        { key: 'video_intro_url', label: 'Owner intro video URL (≤60 seconds, optional)', type: 'url', editable: true,
          help: 'YouTube, Vimeo, or direct mp4. Used in REVIVE win-back emails.' },
      ]},

      // Step 7: Compliance & legal ─────────────────────────────────────
      { step: 7, fields: [
        { key: 'state_of_operation', label: 'Primary state of operation', type: 'select', required: true, editable: true,
          help: 'Drives TCPA rules and recording disclosures for IGNITE/ECHO/REVIVE.',
          options: US_STATE_OPTIONS },
        // Niche-specific licenses
        { key: 'real_estate_license_number', label: 'Real estate license number', type: 'text', required: true, editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'real_estate_brokerage', label: 'Brokerage name', type: 'text', required: true, editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'bar_number', label: 'Bar number', type: 'text', required: true, editable: true,
          showIf: { niche: 'law' } },
        { key: 'bar_states', label: 'States licensed in (comma-separated)', type: 'text', required: true, editable: true,
          showIf: { niche: 'law' } },
        { key: 'medical_npi', label: 'Medical Director NPI', type: 'text', required: true, editable: true,
          help: 'Florida med spas require physician supervision. NPI is on the practitioner\'s license.',
          showIf: { niche: 'med_spa' } },
        { key: 'medical_npi', label: 'NPI number', type: 'text', required: true, editable: true,
          showIf: { niche: 'dental' } },
        { key: 'hvac_license_number', label: 'State contractor license number', type: 'text', required: true, editable: true,
          showIf: { niche: 'hvac' } },
        { key: 'hvac_license_number', label: 'State contractor license number', type: 'text', required: true, editable: true,
          showIf: { niche: 'plumbing_roofing' } },
        // Universal compliance
        { key: 'required_disclosures', label: 'Disclosures every agent must include', type: 'textarea', editable: true,
          help: 'Examples: "Individual results may vary.", "Paid for by [Firm].", state-specific recording notice. Read verbatim by every agent.' },
        { key: 'tcpa_consent_acknowledgment', label: 'I confirm my lead intake forms and customer database have collected proper TCPA consent for automated calls, SMS, and email', type: 'boolean', required: true,
          help: 'Required by FCC 2026 rules for IGNITE and REVIVE. Read more at stiloaipartners.com/legal/tcpa-template' },
        { key: 'owner_consent', label: 'I authorize STILO AI Partners agents to communicate with my customers and prospects on my behalf, in accordance with the inputs in this profile', type: 'boolean', required: true },
      ]},

      // Step 8: Systems already in place ───────────────────────────────
      { step: 8, fields: [
        { key: 'existing_crm', label: 'CRM you use today', type: 'select', editable: true,
          help: 'Every agent that writes records will log to this. Credentials are collected per-agent at activation.',
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'follow_up_boss', label: 'Follow Up Boss' },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'pipedrive', label: 'Pipedrive' },
            { value: 'salesforce', label: 'Salesforce' },
            { value: 'kvcore', label: 'kvCORE' },
            { value: 'lofty', label: 'Lofty / Chime' },
            { value: 'sierra_interactive', label: 'Sierra Interactive' },
            { value: 'google_sheets', label: 'Google Sheets' },
            { value: 'generic_webhook', label: 'Custom (webhook)' },
            { value: 'none', label: 'No CRM yet' },
          ] },
        { key: 'existing_calendar', label: 'Calendar you use for bookings', type: 'select', editable: true,
          options: [
            { value: 'cal_com', label: 'Cal.com' },
            { value: 'calendly', label: 'Calendly' },
            { value: 'google_calendar', label: 'Google Calendar' },
            { value: 'gohighlevel_calendar', label: 'GoHighLevel calendar' },
            { value: 'square_appointments', label: 'Square Appointments' },
            { value: 'acuity', label: 'Acuity Scheduling' },
            { value: 'none', label: 'No calendar tool' },
          ] },
        { key: 'email_sender_domain', label: 'Email domain you want REVIVE/IGNITE to send from', type: 'text', editable: true,
          help: 'Example: yourbusiness.com. We will help you add DKIM/SPF records. Leave blank if you only want SMS+voice.' },
        { key: 'phone_strategy', label: 'How should agents handle phone numbers?', type: 'select', editable: true,
          help: 'Each voice/SMS agent can override. This is the default.',
          options: [
            { value: 'use_existing', label: 'Use my existing number (forward calls to STILO)' },
            { value: 'new_stilo', label: 'Provision a new number through STILO' },
            { value: 'port_existing', label: 'Port my existing number to STILO' },
          ] },
        { key: 'stripe_connect_needed', label: 'Will any agent collect payments on my behalf?', type: 'boolean', editable: true,
          help: 'If yes, we will guide you through Stripe Connect at the relevant agent\'s setup.' },
      ]},

    ],
  },

  echo: {
    code: 'echo',
    name: 'ECHO - AI Receptionist',
    shortName: 'ECHO',
    setupFeeCents: 200000,
    monthlyFeeCents: 100000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_ECHO_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_ECHO_MONTHLY',
    purchaseMode: 'self_serve',
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Phone strategy',
      'Voice & greeting',
      'Booking integration',
      'Call routing & emergencies',
      'CRM logging',
      'Test call',
      'Review & go live',
    ],
    onboardingSchema: [

      // Step 1: Phone strategy ─────────────────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'ECHO answers calls on a phone number. You have three options:\n\n1. **Forward your existing number to ECHO** (easiest, recommended). Keep your current number. We give you a new STILO number, and you tell your phone carrier to forward all calls (or only when busy / no-answer) to that STILO number. Your customers still call your old number; ECHO picks up. Most carriers support call forwarding from the dial pad: `*72` to enable, `*73` to disable. We will give you your exact code after you pick this option.\n\n2. **Get a new number from STILO** (clean slate). Pick the area code (305, 786, 954 for Miami). We provision the number through Twilio and ECHO answers it directly. Use this if you do not have a business number yet, or you want to test ECHO on a new number first.\n\n3. **Port your existing number to STILO** (advanced). We legally move ownership of your number to Twilio. Takes 7-14 days, requires a recent phone bill and Letter of Authorization. Use this only if you are sure you want STILO to be the long-term owner of the number. Most clients pick option 1 instead.',
        fields: [
        { key: 'phone_strategy', label: 'How should ECHO get a phone number?', type: 'select', required: true, editable: true,
          options: [
            { value: 'forward_existing', label: 'Forward my existing number to ECHO (recommended)' },
            { value: 'new_stilo_number', label: 'Provision a new STILO number' },
            { value: 'port_existing', label: 'Port my existing number to STILO (7-14 days)' },
          ] },
        // forward_existing
        { key: 'existing_number_to_forward', label: 'Number you will forward to ECHO', type: 'tel', required: true, editable: true,
          showIf: { phone_strategy: 'forward_existing' },
          help: 'Format: +13055551234. We use this to confirm you own the number.' },
        { key: 'forwarding_method', label: 'When to forward', type: 'select', editable: true,
          showIf: { phone_strategy: 'forward_existing' },
          options: [
            { value: 'always', label: 'Always forward (ECHO answers everything)' },
            { value: 'no_answer', label: 'Forward when nobody picks up' },
            { value: 'busy', label: 'Forward when busy' },
            { value: 'no_answer_or_busy', label: 'Forward when busy OR nobody picks up' },
          ] },
        // new_stilo_number
        { key: 'preferred_area_code', label: 'Preferred area code', type: 'select', editable: true,
          showIf: { phone_strategy: 'new_stilo_number' },
          help: 'Local area codes get 4x higher pickup rates than 800 numbers.',
          options: [
            { value: '305', label: '305 (Miami-Dade)' },
            { value: '786', label: '786 (Miami-Dade)' },
            { value: '954', label: '954 (Broward)' },
            { value: '561', label: '561 (Palm Beach)' },
            { value: 'other', label: 'Other (we will ask in admin review)' },
          ] },
        // port_existing
        { key: 'port_number', label: 'Number to port', type: 'tel', editable: true,
          showIf: { phone_strategy: 'port_existing' } },
        { key: 'port_acknowledgment', label: 'I understand the port takes 7-14 days and I will lose service briefly during the cut-over', type: 'boolean', editable: true,
          showIf: { phone_strategy: 'port_existing' } },
        // Verify ownership of the number
        { key: 'phone_verification_passed', label: 'Verify number ownership', type: 'phone-verify',
          target: '/api/integration-test',
          help: 'We send a 6-digit code to the number above. Enter it to confirm ownership before we forward calls.',
          showIf: { phone_strategy: 'forward_existing' } },
      ]},

      // Step 2: Voice & greeting ───────────────────────────────────────
      { step: 2,
        tutorial: 'Pick the voice your callers will hear. Click each option to play a sample. Adrian and Amy are the most-tested for Miami inbound. We can swap voices at any time.\n\nThe greeting is what ECHO says first when picking up. Default works for most businesses. If you want a custom one, keep it under 12 seconds and include your business name. ECHO will read it word-for-word.\n\nBilingual: leave Spanish auto-detect ON if you serve a Miami market. ECHO listens to the first 2-3 seconds of the caller and switches to Spanish if needed. The voice stays the same; the language changes.',
        fields: [
        { key: 'voice_id', label: 'Pick ECHO\'s voice', type: 'audio-preview-select', required: true, editable: true,
          help: 'Click each option to hear a sample.',
          options: [
            { value: '11labs-Adrian', label: 'Adrian — warm male, professional', preview: 'https://retell.ai/voices/adrian.mp3' },
            { value: '11labs-Amy', label: 'Amy — friendly female, conversational', preview: 'https://retell.ai/voices/amy.mp3' },
            { value: '11labs-Cimo', label: 'Cimo — calm male, mature', preview: 'https://retell.ai/voices/cimo.mp3' },
            { value: '11labs-Hailey', label: 'Hailey — bright female, energetic', preview: 'https://retell.ai/voices/hailey.mp3' },
          ] },
        { key: 'greeting_style', label: 'Greeting style', type: 'select', required: true, editable: true,
          options: [
            { value: 'default', label: 'Default: "Thanks for calling [Business Name], this is [Voice], how can I help?"' },
            { value: 'custom', label: 'Custom greeting (write your own)' },
          ] },
        { key: 'custom_greeting', label: 'Your custom greeting', type: 'textarea', editable: true,
          showIf: { greeting_style: 'custom' },
          help: 'Keep under 12 seconds. Include your business name. Example: "Thanks for calling Glow Med Spa, this is Amy. Whether you\'re calling about Botox, lasers, or something new, I\'m here to help."' },
        { key: 'spanish_autoswitch', label: 'Auto-switch to Spanish if caller speaks Spanish', type: 'boolean', editable: true,
          help: 'Recommended ON for Miami. ECHO detects in 2-3 seconds and switches.' },
        { key: 'caller_id_display_name', label: 'Caller ID display name (15 chars max)', type: 'text', editable: true,
          help: 'What shows on the caller\'s phone when ECHO calls them back. Defaults to truncated business name.' },
        { key: 'voicemail_message', label: 'Voicemail message (if ECHO is busy or call drops)', type: 'textarea', editable: true,
          help: 'Defaults to: "You\'ve reached [Business Name]. Please leave your name, number, and a quick message and we\'ll get right back to you."' },
      ]},

      // Step 3: Booking integration ────────────────────────────────────
      { step: 3, blocking: true,
        tutorial: 'When a caller wants to book, ECHO needs a calendar to check availability and write the appointment. Pick the system you actually use.\n\n**Cal.com (recommended for new clients)**: free, native Retell integration. Sign up at cal.com → create an event type called "Consultation" or "New Patient" → paste your username and event slug below.\n\n**Calendly**: paste the public URL of your event type (e.g. calendly.com/yourname/consult).\n\n**Google Calendar**: click "Connect Google Calendar" below. We use OAuth — we never see your password. ECHO will read availability and write events to whichever calendar you select after connecting.\n\n**GoHighLevel calendar**: paste the calendar ID (Settings → Calendars → click your calendar → ID is at the end of the URL).\n\n**Square Appointments / Acuity**: not yet supported in Phase A. Pick "Send booking link by SMS" instead — ECHO will text the booking link to the caller.\n\n**Send booking link by SMS**: ECHO will offer to text your existing booking link to the caller, then end the call. Simplest if you do not want ECHO writing to your calendar directly.',
        fields: [
        { key: 'booking_method', label: 'How should ECHO book appointments?', type: 'select', required: true, editable: true,
          options: [
            { value: 'cal_com', label: 'Cal.com (recommended)' },
            { value: 'calendly', label: 'Calendly' },
            { value: 'google_calendar', label: 'Google Calendar' },
            { value: 'gohighlevel_calendar', label: 'GoHighLevel calendar' },
            { value: 'sms_booking_link', label: 'Send booking link by SMS (ECHO does not write to calendar)' },
            { value: 'no_booking', label: 'No booking — just take a message' },
          ] },
        // Cal.com
        { key: 'booking_credentials.cal_com_username', label: 'Cal.com username', type: 'text', editable: true,
          showIf: { booking_method: 'cal_com' } },
        { key: 'booking_credentials.event_slug', label: 'Cal.com event slug', type: 'text', editable: true,
          showIf: { booking_method: 'cal_com' },
          help: 'The part of the URL after your username. Example: "consult-30min".' },
        { key: 'booking_credentials.api_key', label: 'Cal.com API key (for live availability)', type: 'password', editable: true,
          showIf: { booking_method: 'cal_com' } },
        // Calendly
        { key: 'booking_credentials.booking_url', label: 'Public Calendly URL', type: 'url', editable: true,
          showIf: { booking_method: 'calendly' } },
        // Google Calendar
        { key: 'booking_credentials.google_oauth', label: 'Connect Google Calendar', type: 'oauth-button',
          target: '/api/oauth?provider=google-calendar&action=start',
          showIf: { booking_method: 'google_calendar' } },
        // GHL
        { key: 'booking_credentials.ghl_calendar_id', label: 'GHL calendar ID', type: 'text', editable: true,
          showIf: { booking_method: 'gohighlevel_calendar' } },
        // SMS booking link
        { key: 'booking_credentials.sms_link_url', label: 'Booking link to text callers', type: 'url', editable: true,
          showIf: { booking_method: 'sms_booking_link' } },
        // Common config
        { key: 'max_bookings_per_day', label: 'Max bookings per day (cap)', type: 'number', editable: true,
          help: 'Defaults to your Business Profile capacity. ECHO will say "we are fully booked" beyond this.' },
        { key: 'buffer_minutes', label: 'Buffer between bookings (minutes)', type: 'number', editable: true },
        { key: 'lead_time_hours', label: 'Minimum lead time before next slot (hours)', type: 'number', editable: true,
          help: 'Example: 24 means "no bookings within the next 24 hours, only same-week+1day."' },
        { key: 'calendar_test_passed', label: 'Test calendar connection', type: 'connection-test',
          target: '/api/integration-test',
          showIf_not: { booking_method: 'no_booking' } },
      ]},

      // Step 4: Call routing & emergencies ─────────────────────────────
      { step: 4,
        tutorial: 'Define what counts as an emergency for your business and what ECHO should do when a caller mentions one. For med spa, that might be allergic reaction or excessive bleeding. For HVAC, no AC at midnight. For real estate, contract issue requiring same-day response.\n\nWhen a caller says one of your emergency keywords, ECHO can: take a message and SMS the owner immediately, transfer the call live to the owner cell, or escalate based on time-of-day rules.\n\nDefaults below are pulled from your niche playbook. Edit to fit your operation.',
        fields: [
        { key: 'emergency_keywords', label: 'Emergency keywords (comma-separated)', type: 'text', editable: true,
          help: 'Niche defaults are loaded for you. Add or remove based on what counts as urgent in your operation.' },
        { key: 'emergency_action', label: 'What ECHO does on an emergency keyword', type: 'select', required: true, editable: true,
          options: [
            { value: 'transfer_to_owner', label: 'Transfer the call live to owner cell' },
            { value: 'sms_owner_keep_caller', label: 'SMS owner immediately and keep caller on the line until owner picks up' },
            { value: 'sms_owner_take_message', label: 'Take a detailed message and SMS owner with the transcript' },
            { value: 'voicemail_only', label: 'Send to voicemail (no escalation)' },
          ] },
        { key: 'emergency_phone', label: 'Emergency phone (where ECHO transfers or texts)', type: 'tel', editable: true,
          help: 'Defaults to owner cell from Business Profile.',
          showIf_not: { emergency_action: 'voicemail_only' } },
        { key: 'transfer_phrases', label: 'Phrases that trigger live transfer (comma-separated)', type: 'text', editable: true,
          help: 'Default: "talk to a person, speak to someone, transfer me, get me a human".' },
        { key: 'transfer_hours_text', label: 'Transfer hours (free text)', type: 'text', editable: true,
          help: 'Example: "Mon-Fri 9am-7pm, Sat 10am-3pm". Outside these hours ECHO uses your Business Profile after-hours rule.' },
        { key: 'do_not_transfer_callers', label: 'Callers ECHO should NEVER transfer (e.g. spam keywords)', type: 'textarea', editable: true,
          help: 'Comma-separated keywords. Example: "warranty, extended auto warranty, IRS, social security number".' },
      ]},

      // Step 5: CRM logging ────────────────────────────────────────────
      { step: 5, blocking: true,
        tutorial: 'After every call, ECHO writes a structured note to your CRM: caller info, what they wanted, what ECHO did, full transcript. Pick the CRM you use.\n\n**GoHighLevel**: Settings → Private Integrations → Create. Name it "STILO ECHO". Scopes: Contacts (read+write), Notes (write), Conversations (write). Copy the token. Your Location ID is in Settings → Business Profile.\n\n**Follow Up Boss**: Admin → API → Create API Key. Copy it.\n\n**HubSpot, Pipedrive, Salesforce**: provide the API key. We use the standard Contacts and Activities APIs.\n\n**Google Sheet**: Open a fresh sheet → Extensions → Apps Script. Paste our template (link below). Deploy → Web app → Anyone, anonymous. Copy the deployment URL.\n\n**No CRM (skip)**: ECHO will email you a daily call summary instead. Pick this if you do not have a CRM yet.\n\nClick "Run test" once you paste credentials. The wizard will not advance until the test passes.',
        fields: [
        { key: 'crm_choice', label: 'Where should ECHO log calls?', type: 'select', required: true, editable: true,
          help: 'Defaults to your Business Profile CRM. You can override here for ECHO specifically.',
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'follow_up_boss', label: 'Follow Up Boss' },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'pipedrive', label: 'Pipedrive' },
            { value: 'salesforce', label: 'Salesforce' },
            { value: 'google_sheets', label: 'Google Sheet (Apps Script webhook)' },
            { value: 'generic_webhook', label: 'Custom webhook' },
            { value: 'email_summary', label: 'Email me a daily summary (no CRM)' },
            { value: 'none', label: 'Skip CRM logging entirely' },
          ] },
        // Per-CRM credentials
        { key: 'crm_credentials.api_key', label: 'GHL Private Integration token', type: 'password', editable: true,
          showIf: { crm_choice: 'gohighlevel' } },
        { key: 'crm_credentials.location_id', label: 'GHL Location ID', type: 'text', editable: true,
          showIf: { crm_choice: 'gohighlevel' } },
        { key: 'crm_credentials.api_key', label: 'Follow Up Boss API key', type: 'password', editable: true,
          showIf: { crm_choice: 'follow_up_boss' } },
        { key: 'crm_credentials.api_key', label: 'HubSpot Private App access token', type: 'password', editable: true,
          showIf: { crm_choice: 'hubspot' } },
        { key: 'crm_credentials.api_key', label: 'Pipedrive API token', type: 'password', editable: true,
          showIf: { crm_choice: 'pipedrive' } },
        { key: 'crm_credentials.api_key', label: 'Salesforce access token', type: 'password', editable: true,
          showIf: { crm_choice: 'salesforce' } },
        { key: 'crm_credentials.webhook_url', label: 'Apps Script deployment URL', type: 'url', editable: true,
          showIf: { crm_choice: 'google_sheets' } },
        { key: 'crm_credentials.webhook_url', label: 'Webhook URL', type: 'url', editable: true,
          showIf: { crm_choice: 'generic_webhook' } },
        { key: 'crm_credentials.bearer_token', label: 'Bearer token (optional)', type: 'password', editable: true,
          showIf: { crm_choice: 'generic_webhook' } },
        { key: 'log_tags', label: 'Tags to apply to every ECHO-logged call', type: 'text', editable: true,
          help: 'Comma-separated. Default: "echo, ai-receptionist". Plus your niche.' },
        { key: 'crm_test_passed', label: 'Test the CRM connection', type: 'connection-test',
          target: '/api/integration-test',
          help: 'Click to verify your credentials. Wizard will not advance until this passes.',
          showIf_not: { crm_choice: 'none' } },
      ]},

      // Step 6: Test call ──────────────────────────────────────────────
      { step: 6, blocking: true,
        tutorial: 'You will not let ECHO answer real customer calls until you have heard it on the phone. This step makes sure of that.\n\n1. Enter a phone number you can answer right now (your cell is ideal).\n2. Click one of the test scenarios below. We trigger a real call from ECHO to your number within 90 seconds.\n3. Pick up. Talk to ECHO as if you were the caller in that scenario. Push back, ask off-script questions, raise objections.\n4. After the call, decide: did ECHO sound on-brand? Did it book correctly / route correctly / handle the emergency keyword?\n5. Check the box at the bottom only if you would be comfortable with ECHO answering your real customers tomorrow.\n\nRecommended: run all 3 niche scenarios.',
        fields: [
        { key: 'test_phone_number', label: 'Your phone number for test calls (E.164)', type: 'tel', required: true, editable: true,
          help: 'ECHO will call this number when you click a scenario.' },
        { key: 'test_scenarios', label: 'Run a test scenario', type: 'phone-test-trigger', required: true,
          target: '/api/agents-test-call',
          help: 'Pick at least one. The wizard unlocks once you rate one thumbs up. Scenarios are pulled from your niche playbook.',
          scenarios: [
            { value: 'booking_request', label: 'Booking request (typical caller)' },
            { value: 'pricing_question', label: 'Pricing / "how much" caller' },
            { value: 'emergency', label: 'Emergency keyword (route check)' },
            { value: 'spam_robocall', label: 'Spam / robocall (block check)' },
          ] },
        { key: 'test_calls_log', label: 'Test calls history', type: 'test-calls-log', editable: false },
        { key: 'test_call_passed', label: 'I rated at least one test call thumbs up', type: 'boolean', required: true,
          help: 'Hard gate. ECHO cannot go live without one passing test.' },
      ]},

      // Step 7: Review & go live ───────────────────────────────────────
      { step: 7, blocking: true, fields: [
        { key: 'review_summary', label: 'Final checklist', type: 'final-review', editable: false,
          help: 'Computed from previous steps.',
          checks: [
            { key: 'phone_strategy', label: 'Phone strategy chosen' },
            { key: 'voice_id', label: 'Voice picked' },
            { key: 'calendar_test_passed', label: 'Calendar connected (or skipped)' },
            { key: 'emergency_action', label: 'Emergency routing configured' },
            { key: 'crm_test_passed', label: 'CRM logging connected' },
            { key: 'test_call_passed', label: 'Test call passed' },
          ] },
        { key: 'ready_for_review', label: 'I have reviewed all my answers and want STILO to activate ECHO', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review',
          help: 'STILO Partners runs a final pre-flight check (phone provisioning, calendar, CRM, voice) before ECHO answers a real call. We aim for under 1 business day. You will receive an email the moment ECHO is live.' },
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
    // 12 steps, fully self-serve. Steps marked `blocking: true` enforce a gate
    // that the renderer locks until satisfied. Real-estate-specific fields use
    // `showIf: { industry: 'real-estate' }` so they only appear for real estate
    // clients. CRM credential fields use `showIf: { crm_choice: 'X' }` so the
    // wizard only asks for what's relevant to the selected CRM.
    onboardingSteps: [
      'Compliance gate',
      'Business identity',
      'Real estate playbook',
      'Lead sources',
      'CRM connection',
      'Calendar & booking',
      'Live transfer',
      'Voice & phone',
      'Knowledge base',
      'Brand voice',
      'Test your agent',
      'Review & go live',
    ],
    onboardingSchema: [

      // ── Step 1: Compliance Gate ───────────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'The FCC ruled in early 2026 that AI-generated voices fall under the same TCPA rules as live cold calls. That means before IGNITE can call your leads, your lead form must collect their explicit consent to be contacted by automated calls.\n\nIf your form already has a checkbox like "I agree to be contacted by phone, email, or text" that is enough.\n\nIf it does not, you have two easy options:\n\n1. Open your form builder (your website CMS, GoHighLevel, Typeform, etc.) and add a required checkbox above your submit button with this exact wording: **"By submitting, I agree to be contacted by [Your Business Name] via automated phone calls, SMS, or email at the contact info I provided. Consent is not required to purchase."**\n2. Or copy our template at [stiloaipartners.com/legal/tcpa-template](https://stiloaipartners.com/legal/tcpa-template), paste it into your form, and screenshot it for your records.\n\nOnce that is in place, paste the exact line you used into the field below. We keep it on file as proof.',
        fields: [
        { key: 'agent_state', label: 'Primary state of operation', type: 'select', required: true, editable: true,
          help: 'Drives state-specific recording disclosures and compliance language.',
          options: [
            { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
            { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
            { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
            { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
            { value: 'FL', label: 'Florida' }, { value: 'GA', label: 'Georgia' },
            { value: 'HI', label: 'Hawaii' }, { value: 'ID', label: 'Idaho' },
            { value: 'IL', label: 'Illinois' }, { value: 'IN', label: 'Indiana' },
            { value: 'IA', label: 'Iowa' }, { value: 'KS', label: 'Kansas' },
            { value: 'KY', label: 'Kentucky' }, { value: 'LA', label: 'Louisiana' },
            { value: 'ME', label: 'Maine' }, { value: 'MD', label: 'Maryland' },
            { value: 'MA', label: 'Massachusetts' }, { value: 'MI', label: 'Michigan' },
            { value: 'MN', label: 'Minnesota' }, { value: 'MS', label: 'Mississippi' },
            { value: 'MO', label: 'Missouri' }, { value: 'MT', label: 'Montana' },
            { value: 'NE', label: 'Nebraska' }, { value: 'NV', label: 'Nevada' },
            { value: 'NH', label: 'New Hampshire' }, { value: 'NJ', label: 'New Jersey' },
            { value: 'NM', label: 'New Mexico' }, { value: 'NY', label: 'New York' },
            { value: 'NC', label: 'North Carolina' }, { value: 'ND', label: 'North Dakota' },
            { value: 'OH', label: 'Ohio' }, { value: 'OK', label: 'Oklahoma' },
            { value: 'OR', label: 'Oregon' }, { value: 'PA', label: 'Pennsylvania' },
            { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
            { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
            { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
            { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' },
            { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
            { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
          ],
        },
        { key: 'form_has_tcpa_consent', label: 'My lead form already has TCPA consent language for AI calls', type: 'boolean', required: true,
          help: 'Required by FCC 2026 rules. Your form must say something like "By submitting, you agree to receive automated calls/texts from us."' },
        { key: 'consent_language_excerpt', label: 'Paste the exact consent line from your form', type: 'textarea', required: true, editable: true,
          help: 'We keep this on file as proof of compliance. If you do not have one, copy our template at stiloaipartners.com/legal/tcpa-template' },
        { key: 'understand_ai_disclosure', label: 'I understand IGNITE will identify itself as automated at the start of every call (per FCC 2026 rules)', type: 'boolean', required: true },
        { key: 'compliance_confirmed', label: 'All four boxes above are checked truthfully', type: 'boolean', required: true,
          help: 'This is a hard gate. The agent cannot go live without this.' },
      ]},

      // ── Step 2: Business Identity ──────────────────────────────────
      // Most fields here are now redundant with Business Profile and pre-fill
      // from the merged config. This step exists primarily to confirm IGNITE
      // is being deployed for the right niche (since IGNITE's playbook
      // selection drives every downstream behavior).
      { step: 2, fields: [
        { key: 'confirm_business_name', label: 'Confirm business name (from your profile)', type: 'text', editable: true },
        { key: 'niche', label: 'IGNITE niche (from your profile)', type: 'select', required: true, editable: true,
          help: 'IGNITE uses a niche-specific playbook for the call script, qualification framework, and objection handlers.',
          options: NICHE_OPTIONS },
        { key: 'main_offer', label: 'Your main offer in one sentence', type: 'textarea', editable: true,
          help: 'IGNITE leads with this in the first reply.' },
        { key: 'agent_count', label: 'Number of agents / reps on the team', type: 'number', editable: true,
          help: 'Drives how many concurrent leads IGNITE can transfer at peak.' },
      ]},

      // ── Step 3: Niche-specific playbook ───────────────────────────
      // The fields below are real-estate-specific (LPMAMA framework). Other
      // niches show their own conditional fields or a "skip this step" notice.
      // The niche playbook YAML at niche_playbooks/{niche}.yaml seeds the
      // qualification questions used at runtime — this step is for the few
      // niches where the questions need explicit owner choices.
      { step: 3,
        tutorial: 'For real estate: these answers shape how IGNITE qualifies leads on the first call using the LPMAMA framework (Location, Price, Motivation, Agent, Mortgage, Appointment).\n\nFor other niches: this step shows niche-specific qualification options pulled from your playbook. You confirm or override.',
        fields: [
        // Real estate fields
        { key: 'handle_buyer_leads', label: 'We handle buyer leads', type: 'boolean', editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'handle_seller_leads', label: 'We handle seller leads (home valuations)', type: 'boolean', editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'handle_investor_leads', label: 'We handle investor leads', type: 'boolean', editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'price_range_min', label: 'Typical minimum price ($)', type: 'number', editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'price_range_max', label: 'Typical maximum price ($)', type: 'number', editable: true,
          showIf: { niche: 'real_estate' } },
        { key: 'pre_approval_required', label: 'Require pre-approval before showing', type: 'boolean', editable: true,
          help: 'If yes, IGNITE asks early and offers a lender referral if not pre-approved.',
          showIf: { niche: 'real_estate' } },
        { key: 'working_with_other_agent_disqualifier', label: 'If lead is already working with another agent', type: 'select', editable: true,
          showIf: { niche: 'real_estate' },
          options: [
            { value: 'no', label: 'No problem, keep engaging' },
            { value: 'sometimes', label: 'Soft-pitch private listing alerts only' },
            { value: 'yes', label: 'Disqualify, end the call politely' },
          ],
        },
        // Med spa fields
        { key: 'med_spa_treatments_offered', label: 'Treatments offered (comma-separated)', type: 'textarea', editable: true,
          showIf: { niche: 'med_spa' },
          help: 'Botox, fillers, laser hair removal, CoolSculpting, etc. IGNITE quotes ranges per treatment.' },
        { key: 'med_spa_first_visit_required', label: 'First visit must be in-person consult', type: 'boolean', editable: true,
          showIf: { niche: 'med_spa' } },
        // Law fields
        { key: 'law_practice_areas_handled', label: 'Practice areas you accept', type: 'textarea', editable: true,
          showIf: { niche: 'law' } },
        { key: 'law_contingency_or_hourly', label: 'Fee structure', type: 'select', editable: true,
          showIf: { niche: 'law' },
          options: [
            { value: 'contingency', label: 'Contingency (PI)' },
            { value: 'hourly', label: 'Hourly + retainer' },
            { value: 'flat_fee', label: 'Flat fee per matter' },
            { value: 'mixed', label: 'Mixed (varies by matter)' },
          ] },
        // HVAC / Plumbing fields
        { key: 'service_24_7', label: 'Offer 24/7 emergency service', type: 'boolean', editable: true,
          showIf: { niche: 'hvac' } },
        { key: 'service_24_7', label: 'Offer 24/7 emergency service', type: 'boolean', editable: true,
          showIf: { niche: 'plumbing_roofing' } },
        // Generic catch-all when no niche-specific fields apply
        { key: 'qualification_notes', label: 'Anything special IGNITE should ask leads in your niche?', type: 'textarea', editable: true,
          help: 'Free-form. The niche playbook pre-loads default qualification questions; add anything specific to your operation.' },
        { key: 'service_area_zips', label: 'Service area zip codes (auto-loaded from profile)', type: 'text', editable: true,
          help: 'IGNITE recognizes when a lead is outside your market.' },
        { key: 'disqualifying_zip_codes', label: 'Zip codes you do NOT serve', type: 'text', editable: true,
          showIf: { niche: 'real_estate' } },
      ]},

      // ── Step 4: Lead Sources & Webhook ────────────────────────────
      { step: 4, fields: [
        { key: 'webhook_url', label: 'Your IGNITE webhook URL', type: 'webhook-url',
          help: 'Point your CRM, ad platform, or website form to this URL. IGNITE picks up the lead in under 2 minutes.' },
        { key: 'lead_sources', label: 'Where will leads come from?', type: 'select', required: true, editable: true,
          help: 'Pick your primary source. You can add more later.',
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel (CRM)' },
            { value: 'facebook_lead_ads', label: 'Facebook / Instagram Lead Ads' },
            { value: 'website_form', label: 'Website contact form' },
            { value: 'zillow', label: 'Zillow / Realtor.com (via Zapier)' },
            { value: 'zapier', label: 'Zapier or Make (multi-source)' },
            { value: 'google_ads', label: 'Google Ads lead form' },
            { value: 'other', label: 'Other / not sure yet' },
          ],
        },
        { key: 'expected_volume', label: 'Roughly how many leads per week?', type: 'number', editable: true },
        { key: 'webhook_confirmed', label: 'I\'ve connected at least one lead source to the webhook URL above', type: 'boolean', required: true },
      ]},

      // ── Step 5: CRM Connection ─────────────────────────────────────
      { step: 5, blocking: true,
        tutorial: 'IGNITE writes call notes, qualification details, and outcomes back to your CRM after every call so your team picks up exactly where the AI left off. Pick the CRM you actually use day-to-day. We will then ask only for the credentials that CRM needs.\n\n**GoHighLevel**: Log in. Settings → Private Integrations → Create. Name it "STILO IGNITE", check the boxes for Contacts (read+write) and Notes (write). Copy the token. Your Location ID is in Settings → Business Profile, near the bottom.\n\n**Follow Up Boss**: Log in. Admin → API. Click Create API Key. Copy it.\n\n**Google Sheet** (no real CRM): Open a fresh sheet → Extensions → Apps Script. Paste our template from [stiloaipartners.com/legal/sheets-template](https://stiloaipartners.com/legal/sheets-template). Click Deploy → New deployment → Web app. Anyone, anonymous. Copy the deployment URL.\n\n**Other / not sure**: pick "Other / use a webhook" and paste any URL that accepts a JSON POST. Zapier and Make both give you these.\n\nAfter you paste credentials, click "Run test" below. The wizard will not let you advance until the CRM responds with a green check.',
        fields: [
        { key: 'crm_choice', label: 'Which CRM do you use?', type: 'select', required: true, editable: true,
          help: 'IGNITE writes call notes, qualification, and outcomes back to your CRM after every call.',
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'follow_up_boss', label: 'Follow Up Boss (real estate)' },
            { value: 'kvcore', label: 'kvCORE (real estate, Phase B)' },
            { value: 'lofty', label: 'Lofty / Chime (real estate, Phase B)' },
            { value: 'sierra_interactive', label: 'Sierra Interactive (real estate, Phase B)' },
            { value: 'hubspot', label: 'HubSpot (Phase B)' },
            { value: 'pipedrive', label: 'Pipedrive (Phase B)' },
            { value: 'salesforce', label: 'Salesforce (Phase B)' },
            { value: 'google_sheets', label: 'Google Sheet (no real CRM)' },
            { value: 'generic_webhook', label: 'Other / use a webhook' },
            { value: 'none', label: 'I\'ll skip CRM write-back for now' },
          ],
        },
        // GoHighLevel
        { key: 'crm_credentials.api_key', label: 'GHL Private Integration token', type: 'password', editable: true,
          showIf: { crm_choice: 'gohighlevel' },
          help: 'In GHL: Settings → Private Integrations → Create. Needs scopes: Contacts (read/write), Notes (write).' },
        { key: 'crm_credentials.location_id', label: 'GHL Location ID', type: 'text', editable: true,
          showIf: { crm_choice: 'gohighlevel' } },
        // Follow Up Boss
        { key: 'crm_credentials.api_key', label: 'Follow Up Boss API key', type: 'password', editable: true,
          showIf: { crm_choice: 'follow_up_boss' },
          help: 'In FUB: Admin → API. Copy the key into here.' },
        // Google Sheets
        { key: 'crm_credentials.webhook_url', label: 'Apps Script webhook URL', type: 'url', editable: true,
          showIf: { crm_choice: 'google_sheets' },
          help: 'Deploy a Google Apps Script that appends rows to a sheet. Paste the deployment URL.' },
        // Generic Webhook
        { key: 'crm_credentials.webhook_url', label: 'Webhook URL', type: 'url', editable: true,
          showIf: { crm_choice: 'generic_webhook' } },
        { key: 'crm_credentials.bearer_token', label: 'Bearer token (optional)', type: 'password', editable: true,
          showIf: { crm_choice: 'generic_webhook' } },
        // Test connection (writes crm_test_passed when successful)
        { key: 'crm_test_passed', label: 'Test the connection', type: 'connection-test',
          help: 'Click to verify your credentials. The wizard will not let you continue until this succeeds.',
          target: '/api/agents-crm-test' },
      ]},

      // ── Step 6: Calendar & Booking ────────────────────────────────
      { step: 6,
        tutorial: 'When IGNITE talks to a lead and they want to book a showing, the AI books directly on your calendar. Pick whichever calendar you actually use.\n\n**Cal.com (recommended)**: Free at [cal.com](https://cal.com). Sign up, create an event type called "Showing 30min" or similar, then enter your username and the event slug below. Cal.com is the cleanest because Retell has a native integration, fewer moving parts.\n\n**Calendly**: Already using it? Just paste the public URL of the event type you want IGNITE to book on (something like `calendly.com/yourname/showing`).\n\n**Google Calendar**: Click Connect Google Calendar below. We use OAuth — you sign into Google, approve, and we get a token to write events. We never see your password.\n\n**GoHighLevel calendar**: If you already use GHL for booking, paste the calendar ID (Settings → Calendars → click your calendar → the ID is at the end of the URL).\n\n**No booking, just transfer**: Pick this if you want IGNITE to live-transfer the call to you when a lead wants to book. Skip the calendar test below.',
        fields: [
        { key: 'booking_method', label: 'How do leads book appointments / showings?', type: 'select', required: true, editable: true,
          options: [
            { value: 'cal_com', label: 'Cal.com (recommended, native Retell integration)' },
            { value: 'calendly', label: 'Calendly' },
            { value: 'google_calendar', label: 'Google Calendar' },
            { value: 'gohighlevel_calendar', label: 'GoHighLevel calendar' },
            { value: 'manual_via_transfer', label: 'No booking, just transfer to me live' },
          ],
        },
        // Cal.com
        { key: 'booking_credentials.cal_com_username', label: 'Your Cal.com username', type: 'text', editable: true,
          showIf: { booking_method: 'cal_com' } },
        { key: 'booking_credentials.event_slug', label: 'Cal.com event slug (e.g. showing-30min)', type: 'text', editable: true,
          showIf: { booking_method: 'cal_com' } },
        { key: 'booking_credentials.api_key', label: 'Cal.com API key (optional, for live availability checks)', type: 'password', editable: true,
          showIf: { booking_method: 'cal_com' } },
        // Calendly
        { key: 'booking_credentials.booking_url', label: 'Your public Calendly URL', type: 'url', editable: true,
          showIf: { booking_method: 'calendly' } },
        // Google Calendar
        { key: 'booking_credentials.google_oauth', label: 'Connect Google Calendar', type: 'oauth-button',
          showIf: { booking_method: 'google_calendar' },
          target: '/api/oauth?provider=google-calendar&action=start' },
        // GHL calendar
        { key: 'booking_credentials.ghl_calendar_id', label: 'GHL calendar ID', type: 'text', editable: true,
          showIf: { booking_method: 'gohighlevel_calendar' } },
        // Common
        { key: 'showings_per_week_max', label: 'Max showings/appointments per week', type: 'number', editable: true,
          help: 'IGNITE will not over-book your calendar.' },
        { key: 'buffer_minutes_between_showings', label: 'Buffer between bookings (minutes)', type: 'number', editable: true },
        { key: 'timezone', label: 'Timezone', type: 'select', required: true, editable: true,
          options: [
            { value: 'America/New_York', label: 'Eastern (ET)' },
            { value: 'America/Chicago', label: 'Central (CT)' },
            { value: 'America/Denver', label: 'Mountain (MT)' },
            { value: 'America/Phoenix', label: 'Arizona (no DST)' },
            { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
            { value: 'Pacific/Honolulu', label: 'Hawaii' },
          ],
        },
        { key: 'calendar_test_passed', label: 'Test calendar connection', type: 'connection-test',
          help: 'Verifies the calendar credentials are valid.',
          target: '/api/agents-calendar-test',
          showIf_not: { booking_method: 'manual_via_transfer' } },
      ]},

      // ── Step 7: Live Transfer ──────────────────────────────────────
      { step: 7, fields: [
        { key: 'transfer_enabled', label: 'Allow live transfer to a human agent', type: 'boolean', editable: true,
          help: 'When the lead asks to talk to someone, IGNITE warm-transfers the call.' },
        { key: 'agent_cell', label: 'Primary agent cell phone (E.164: +13055551234)', type: 'tel', editable: true,
          showIf: { transfer_enabled: true } },
        { key: 'backup_cell', label: 'Backup cell phone (optional)', type: 'tel', editable: true,
          showIf: { transfer_enabled: true } },
        { key: 'transfer_hours_text', label: 'Transfer hours (free text)', type: 'text', editable: true,
          help: 'Example: "Mon-Fri 9am-7pm, Sat 10am-3pm". IGNITE only transfers within these hours.',
          showIf: { transfer_enabled: true } },
        { key: 'outside_hours_behavior', label: 'Outside transfer hours, do this instead', type: 'select', editable: true,
          showIf: { transfer_enabled: true },
          options: [
            { value: 'voicemail', label: 'Take a voicemail' },
            { value: 'sms_callback', label: 'Send SMS, schedule callback' },
            { value: 'book_appointment_only', label: 'Book an appointment for next available time' },
          ],
        },
        { key: 'transfer_trigger_phrases', label: 'Phrases that trigger transfer (comma-separated)', type: 'text', editable: true,
          help: 'Default: "talk to agent, speak to a human, transfer me"',
          showIf: { transfer_enabled: true } },
      ]},

      // ── Step 8: Voice & Phone ──────────────────────────────────────
      { step: 8,
        tutorial: 'Pick the voice your leads will hear and the area code your IGNITE outbound calls come from.\n\n**Voice picker**: click each voice to play a 5-second sample. There is no right answer, just pick the one that sounds most like the agent you would hire to make these calls. Adrian (warm male, professional) is the safe default. Amy (friendly female, conversational) works well for high-end residential. We can swap voices any time.\n\n**Area code**: defaults to your office phone area code. Local area codes pick up 4x more often than 800 numbers, leave this matching your market.\n\n**Spanish auto-detect**: if your leads sometimes speak Spanish, leave this on. IGNITE detects the language in the first 2 seconds and switches automatically. The voice stays the same; the language changes.\n\n**Voicemail message**: IGNITE leaves this message if the lead does not pick up. Keep it short and personalized — mention the lead name and the property they inquired about, plus one reason to call back. Example: "Hi, this is calling from Premier Realty about your inquiry. Give us a quick call back when you get a chance, there are a few details about that property that are not on Zillow yet."',
        fields: [
        { key: 'voice_id', label: 'Pick a voice for IGNITE', type: 'audio-preview-select', required: true, editable: true,
          help: 'Click each voice to hear a sample.',
          options: [
            { value: '11labs-Adrian', label: 'Adrian — warm male, professional', preview: 'https://retell.ai/voices/adrian.mp3' },
            { value: '11labs-Amy', label: 'Amy — friendly female, conversational', preview: 'https://retell.ai/voices/amy.mp3' },
            { value: '11labs-Cimo', label: 'Cimo — calm male, mature', preview: 'https://retell.ai/voices/cimo.mp3' },
            { value: '11labs-Hailey', label: 'Hailey — bright female, energetic', preview: 'https://retell.ai/voices/hailey.mp3' },
          ],
        },
        { key: 'language_default', label: 'Primary language', type: 'select', editable: true,
          options: [
            { value: 'en', label: 'English' },
            { value: 'es', label: 'Spanish' },
          ],
        },
        { key: 'language_detection', label: 'Auto-switch to Spanish if lead speaks Spanish', type: 'boolean', editable: true },
        { key: 'area_code', label: 'Area code for your IGNITE outbound number', type: 'text', editable: true,
          help: 'Defaults to your office phone area code. Leads recognize local area codes 4x more often.' },
        { key: 'caller_id_display_name', label: 'Caller ID display name (15 chars max)', type: 'text', editable: true,
          help: 'Defaults to your business name truncated to 15 chars.' },
        { key: 'phone_provisioning', label: 'Phone number source', type: 'select', editable: true,
          help: 'Phase A only supports retell_managed. Other options queue for Phase B.',
          options: [
            { value: 'retell_managed', label: 'STILO provides the number (recommended)' },
            { value: 'byo_twilio', label: 'I have my own Twilio number (Phase B)' },
            { value: 'port_existing', label: 'Port my existing number (Phase B)' },
          ],
        },
        { key: 'voicemail_message', label: 'Voicemail message (if lead does not pick up)', type: 'textarea', editable: true,
          help: 'IGNITE leaves this if the lead\'s phone goes to voicemail.' },
      ]},

      // ── Step 9: Knowledge Base Supplement ─────────────────────────
      { step: 9,
        tutorial: 'IGNITE already knows your brand voice and basic FAQ from the universal onboarding. This step is where you teach it the questions specific to your inbound leads, plus the answers you want the AI to give.\n\nThink about the last 10 leads who called you. What questions did they ask in the first 60 seconds? Type each one into the list below and write the exact 1-2 sentence answer you want IGNITE to give. The AI will use these word-for-word.\n\nMinimum: 5 questions and 3 objections. Aim for 8-10 of each. The more specific you are, the better IGNITE handles your leads on day one.\n\nFor real estate clients, **active listings** is huge. Paste in the top 3-5 listings you want IGNITE aware of: address, price, beds/baths, key features. The AI will reference these naturally if a lead mentions a specific property.\n\nFor competitor brokerages, list the names you want IGNITE to acknowledge politely. If a lead says "I am working with Compass," IGNITE will say something like "Compass is a great firm. The reason a lot of buyers we work with come over to us is..." rather than disparaging them.',
        fields: [
        { key: 'common_lead_questions', label: 'Common questions leads ask + your approved answers', type: 'array-of-objects', editable: true,
          help: 'IGNITE uses these verbatim. Add at least 5.',
          schema: [
            { key: 'question', label: 'Question', type: 'text' },
            { key: 'approved_answer', label: 'Approved answer', type: 'textarea' },
          ],
          minItems: 5,
        },
        { key: 'objection_handlers', label: 'Common objections + how to respond', type: 'array-of-objects', editable: true,
          help: 'Add at least 3.',
          schema: [
            { key: 'objection', label: 'Objection', type: 'text' },
            { key: 'response', label: 'Approved response', type: 'textarea' },
          ],
          minItems: 3,
        },
        { key: 'properties_currently_listed', label: 'Active listings or top services (free text or paste a list)', type: 'textarea', editable: true,
          help: 'Real estate: paste 3-5 active listings. Other industries: paste your top services with prices.' },
        { key: 'competitor_brokerages_to_acknowledge', label: 'Competitors to acknowledge professionally (comma-separated)', type: 'text', editable: true,
          help: 'If a lead mentions any of these, IGNITE acknowledges without disparaging.' },
      ]},

      // ── Step 10: Brand Voice for Voice Channel ────────────────────
      { step: 10, fields: [
        { key: 'voice_pace', label: 'How fast should IGNITE talk?', type: 'select', editable: true,
          options: [
            { value: 'slow', label: 'Slow and deliberate' },
            { value: 'conversational', label: 'Conversational (recommended)' },
            { value: 'brisk', label: 'Brisk and to the point' },
          ],
        },
        { key: 'voice_formality', label: 'Formality on calls', type: 'select', editable: true,
          options: [
            { value: 'casual', label: 'Casual and warm' },
            { value: 'professional', label: 'Professional' },
            { value: 'concise', label: 'Concise and direct' },
          ],
        },
        { key: 'words_to_avoid_on_call', label: 'Words IGNITE should never say on calls (comma-separated)', type: 'text', editable: true },
        { key: 'mandatory_disclosures', label: 'Mandatory disclosures (state-specific or company-required)', type: 'textarea', editable: true,
          help: 'IGNITE will read these verbatim during the call when triggered. Leave blank if none.' },
      ]},

      // ── Step 11: Test Your Agent ──────────────────────────────────
      { step: 11, blocking: true,
        tutorial: 'You will not let IGNITE near a real lead until you have heard it talk. This step is your dress rehearsal.\n\n1. Enter a phone number you can answer right now (your cell is best).\n2. Click one of the scenario buttons. We send a synthetic lead through the same webhook your real leads will hit. Within 90 seconds, IGNITE calls the number you entered.\n3. Pick up. Talk to the AI as if you were the lead in that scenario. Push back, ask questions, raise objections.\n4. After the call, decide: did it sound on-brand? Did it ask the right qualifying questions? Did it handle objections well?\n5. Check the box at the bottom only if you would be comfortable with this AI talking to your real leads.\n\nRecommended: run all 4 scenarios at least once before you submit.\n\n**Hot Buyer**: pre-approved, ready to tour this weekend. Tests the booking flow.\n**Cold Lead**: just browsing, no timeline. Tests the soft-pitch private listing alerts flow.\n**Seller Inquiry**: home valuation request. Tests the seller branch.\n**Voicemail**: just hang up. Tests the voicemail message and follow-up cadence.',
        fields: [
        { key: 'test_phone_number', label: 'Your phone number for test calls', type: 'tel', required: true, editable: true,
          help: 'IGNITE will call this number when you click a scenario below.' },
        { key: 'test_scenarios', label: 'Run a test scenario', type: 'phone-test-trigger', required: true,
          help: 'Pick at least one scenario. The wizard unlocks once you rate one thumbs up.',
          target: '/api/agents-test-call',
          scenarios: [
            { value: 'hot_buyer', label: 'Hot Buyer (pre-approved, ready this weekend)' },
            { value: 'cold_lead', label: 'Cold Lead (just browsing, no timeline)' },
            { value: 'seller_inquiry', label: 'Seller Inquiry (home valuation)' },
            { value: 'voicemail', label: 'Voicemail (test the voicemail flow)' },
          ],
        },
        { key: 'test_calls_log', label: 'Test calls history', type: 'test-calls-log', editable: false,
          help: 'Read-only audit of test calls fired.' },
        { key: 'test_call_passed', label: 'I rated at least one test call thumbs up', type: 'boolean', required: true,
          help: 'Hard gate. The agent cannot go live without one passing test.' },
      ]},

      // ── Step 12: Submit for STILO Review ──────────────────────────
      { step: 12, blocking: true, fields: [
        { key: 'review_summary', label: 'Final checklist', type: 'final-review', editable: false,
          help: 'Computed from previous steps.' },
        { key: 'ready_for_review', label: 'I have reviewed all my answers and want STILO to activate IGNITE', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review',
          help: 'STILO Partners runs a final pre-flight check on every new IGNITE agent (compliance, CRM, calendar, brand voice, test call) before it talks to your real leads. We aim to have you live within 1 business day. You will receive an email the moment IGNITE is active.' },
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
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Upload customer database',
      'Map columns',
      'Segments & offers',
      'Email sender domain',
      'SMS / 10DLC',
      'Compliance & consent',
      'Cadence & frequency cap',
      'Test send & review',
    ],
    onboardingSchema: [

      // Step 1: Upload customer database ───────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'REVIVE works off a clean list of past customers. The fastest path is exporting from where they already live.\n\n**From your POS** (Square, Toast, Clover): Reports → Customers → Export CSV.\n\n**From your CRM** (GHL, Follow Up Boss, HubSpot): Contacts → All → Export.\n\n**From your booking system** (Cal.com, Acuity, Square Appointments): Customers → Export.\n\nMinimum required columns: name, email or phone, last interaction date. Lifetime value (LTV) is a major bonus, lets us prioritize VIPs first.',
        fields: [
        { key: 'source_choice', label: 'Where is your customer data coming from?', type: 'select', required: true, editable: true,
          options: [
            { value: 'csv_upload', label: 'I have a CSV file ready' },
            { value: 'crm_export', label: 'I want to pull it from my CRM (live sync)' },
            { value: 'pos_export', label: 'My POS system exports it' },
            { value: 'mixed', label: 'Multiple sources, I will combine first' },
          ] },
        { key: 'customer_csv', label: 'Customer database (CSV or XLSX)', type: 'csv-upload', required: true,
          help: 'Required columns: name, email or phone, last interaction date. Optional but valuable: lifetime value, treatment history, tags.',
          showIf: { source_choice: 'csv_upload' } },
        { key: 'crm_pull_choice', label: 'Pull from which CRM?', type: 'select', editable: true,
          showIf: { source_choice: 'crm_export' },
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'follow_up_boss', label: 'Follow Up Boss' },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'pipedrive', label: 'Pipedrive' },
          ] },
      ]},

      // Step 2: Map columns ────────────────────────────────────────────
      { step: 2,
        tutorial: 'Tell REVIVE which column in your CSV holds which piece of data. Type the EXACT header from your file (case-sensitive). If your CSV says "First Name", type "First Name", not "first_name".',
        fields: [
        { key: 'col_first_name', label: 'Column for first name', type: 'text', required: true, editable: true },
        { key: 'col_last_name', label: 'Column for last name', type: 'text', editable: true },
        { key: 'col_email', label: 'Column for email', type: 'text', required: true, editable: true },
        { key: 'col_phone', label: 'Column for phone', type: 'text', editable: true,
          help: 'Required if you want SMS reactivation.' },
        { key: 'col_last_interaction_date', label: 'Column for last visit / purchase date', type: 'text', required: true, editable: true },
        { key: 'col_ltv', label: 'Column for lifetime value (LTV)', type: 'text', editable: true,
          help: 'Lets REVIVE prioritize VIPs. Skip if you don\'t track this.' },
        { key: 'col_tags', label: 'Column for tags / segments / treatment type', type: 'text', editable: true },
        { key: 'col_consent_source', label: 'Column for consent record (TCPA)', type: 'text', editable: true,
          help: 'If your data has an "opted-in" or "consent_date" column, point to it. Otherwise leave blank — REVIVE will treat unknowns conservatively.' },
        { key: 'preview_count', label: 'How many records does the file contain?', type: 'number', editable: true },
      ]},

      // Step 3: Segments & offers ──────────────────────────────────────
      { step: 3,
        tutorial: 'Niche-specific segments are pre-loaded from your business profile. You can edit, delete, or add segments. Each segment fires its own message cadence.\n\nA segment is just a window of dormancy + an offer. Med spa example: 30-60 day dormant gets "your touch-up window is approaching"; 6+ month dormant gets "we have a new treatment".\n\nRule of thumb: at least one offer per segment. The offer can be discount-based, value-based ("free consult"), or curiosity-based ("we have something new"). Discount-only burns out fast.',
        fields: [
        { key: 'segments', label: 'Segments (auto-loaded from your niche)', type: 'array-of-objects', required: true, editable: true,
          help: 'Pre-filled from your niche playbook. Edit, add, or remove based on how you actually operate.',
          schema: [
            { key: 'name', label: 'Segment name', type: 'text' },
            { key: 'days_dormant_min', label: 'Days since last visit (min)', type: 'text' },
            { key: 'days_dormant_max', label: 'Days since last visit (max)', type: 'text' },
            { key: 'offer', label: 'Offer text', type: 'textarea' },
            { key: 'channel', label: 'Channel (email, sms, both)', type: 'text' },
          ],
          minItems: 1 },
        { key: 'booking_link', label: 'Where should every offer point?', type: 'url', required: true, editable: true,
          help: 'Defaults to your Business Profile booking system. Override here if you want a special REVIVE-only landing page.' },
        { key: 'reply_handler', label: 'When a customer replies, what should happen?', type: 'select', editable: true,
          options: [
            { value: 'route_to_owner', label: 'Email reply lands in owner inbox' },
            { value: 'auto_book', label: 'Try to auto-book if reply contains a date' },
            { value: 'crm_thread', label: 'Open a thread in our CRM' },
          ] },
      ]},

      // Step 4: Email sender domain ────────────────────────────────────
      { step: 4, blocking: true,
        tutorial: 'REVIVE sends emails from YOUR domain so they don\'t look like spam. We use Resend, which means you need to add two DNS records: SPF and DKIM. Most domain registrars (GoDaddy, Namecheap, Cloudflare) let you add these in 60 seconds.\n\n1. Click "Generate DNS records" below. We\'ll show you the exact records to copy.\n2. Log into your domain registrar.\n3. Add the SPF record (TXT type) and DKIM record (TXT type, prefix `resend._domainkey`).\n4. Save. DNS propagation takes 5 minutes to 48 hours, usually under 30 minutes.\n5. Click "Verify" below. If both records are detected, you\'re live.\n\nDNS still propagating? You can finish other steps and come back here. The wizard will let you submit once verification passes.',
        fields: [
        { key: 'sender_domain', label: 'Domain you want to send from', type: 'text', required: true, editable: true,
          help: 'Example: yourbusiness.com (NO https:// prefix).' },
        { key: 'sender_name', label: 'Sender name (the "From" line your customers see)', type: 'text', required: true, editable: true,
          help: 'Example: "Maria from Glow Med Spa".' },
        { key: 'sender_email', label: 'Sender email address', type: 'email', required: true, editable: true,
          help: 'Example: hello@yourbusiness.com. Must be on the domain above.' },
        { key: 'reply_to', label: 'Reply-to email', type: 'email', editable: true,
          help: 'Where replies land. Defaults to sender email.' },
        { key: 'email_domain_verified', label: 'Verify DNS records', type: 'connection-test',
          target: '/api/integration-test',
          help: 'Run after you\'ve added the SPF + DKIM records. The wizard cannot advance until this passes.' },
      ]},

      // Step 5: SMS / 10DLC ────────────────────────────────────────────
      { step: 5,
        tutorial: 'SMS reactivation is 4x more effective than email but requires 10DLC brand registration with Twilio. This takes 2-7 business days. You can finish onboarding without it; SMS will activate when the registration approves.\n\nYou\'ll need: legal business name, EIN, business address, website, expected volume. We pre-fill what we can from your Business Profile.',
        fields: [
        { key: 'enable_sms', label: 'Enable SMS reactivation', type: 'boolean', editable: true,
          help: 'If yes, we file the 10DLC brand registration on your behalf.' },
        { key: 'sms_brand_legal_name', label: 'Legal business name (matches your EIN filing)', type: 'text', editable: true,
          showIf: { enable_sms: true } },
        { key: 'sms_brand_ein', label: 'EIN', type: 'text', editable: true,
          showIf: { enable_sms: true } },
        { key: 'sms_expected_volume_per_day', label: 'Expected SMS volume per day', type: 'number', editable: true,
          showIf: { enable_sms: true },
          help: 'Realistic: 50-200 for most segments. Higher volume needs higher 10DLC tier.' },
        { key: 'sms_sample_message_1', label: 'Sample message #1 (used in 10DLC application)', type: 'textarea', editable: true,
          showIf: { enable_sms: true } },
        { key: 'sms_sample_message_2', label: 'Sample message #2', type: 'textarea', editable: true,
          showIf: { enable_sms: true } },
        { key: 'sms_optout_keyword', label: 'Opt-out keyword', type: 'text', editable: true,
          showIf: { enable_sms: true },
          help: 'Defaults to STOP. Required by FCC.' },
      ]},

      // Step 6: Compliance & consent ───────────────────────────────────
      { step: 6, blocking: true,
        tutorial: 'TCPA + CAN-SPAM make non-consented marketing illegal. This step locks down your compliance posture.\n\nFor each record in your CSV, we tag whether you have:\n- Express written consent (best, opt-in checkbox at signup)\n- Implied consent (existing business relationship)\n- No consent (must NOT receive marketing SMS; can receive transactional only)\n\nIf you don\'t have consent records, REVIVE defaults to email-only for those records and asks for SMS opt-in BEFORE sending any SMS.',
        fields: [
        { key: 'consent_status_default', label: 'For records without an explicit consent column', type: 'select', required: true, editable: true,
          options: [
            { value: 'assume_implied', label: 'Assume implied consent (existing customers, transactional history)' },
            { value: 'require_optin_first', label: 'Require explicit opt-in before any marketing message' },
            { value: 'email_only', label: 'Email only, no SMS for unknowns' },
          ] },
        { key: 'unsubscribe_footer', label: 'Unsubscribe / opt-out language', type: 'textarea', editable: true,
          help: 'Defaults to standard CAN-SPAM compliant footer.' },
        { key: 'do_not_contact_csv', label: 'Do-Not-Contact list upload (optional)', type: 'csv-upload', editable: true,
          help: 'Upload a CSV of emails or phones you must NEVER message. We exclude them.' },
        { key: 'tcpa_acknowledgment', label: 'I confirm I have valid TCPA/CAN-SPAM consent for the records I uploaded, OR I will require explicit opt-in before sending', type: 'boolean', required: true },
      ]},

      // Step 7: Cadence & frequency cap ────────────────────────────────
      { step: 7,
        tutorial: 'Sending too many messages burns your list. Sending too few and you miss the window. The defaults below are tuned per niche; edit if you have specific operational rules.',
        fields: [
        { key: 'max_per_customer_per_month', label: 'Max messages per customer per month', type: 'number', required: true, editable: true,
          help: 'Default: 4. Higher for restaurants, lower for legal/medical.' },
        { key: 'quiet_hours_start', label: 'Quiet hours start (no SMS)', type: 'text', editable: true,
          help: 'Default: 21:00 (9pm). Format HH:MM 24h.' },
        { key: 'quiet_hours_end', label: 'Quiet hours end', type: 'text', editable: true,
          help: 'Default: 09:00.' },
        { key: 'send_rate_per_hour', label: 'Email send rate per hour', type: 'number', editable: true,
          help: 'Default: 80. Lower for new domains (warm-up).' },
        { key: 'paused_days', label: 'Days to pause sending (comma-separated, optional)', type: 'text', editable: true,
          help: 'Examples: "2026-12-25, 2026-01-01". Use for known closures.' },
        { key: 'send_window_start', label: 'Send window start', type: 'text', editable: true,
          help: 'Default: 09:00. No emails / SMS before this hour.' },
        { key: 'send_window_end', label: 'Send window end', type: 'text', editable: true,
          help: 'Default: 19:00.' },
      ]},

      // Step 8: Test send & review ─────────────────────────────────────
      { step: 8, blocking: true,
        tutorial: 'Before REVIVE goes live to your real list, send yourself a copy of every segment\'s message. Confirm the offer text, sender, links, and unsubscribe footer all look right.',
        fields: [
        { key: 'test_email', label: 'Test email address (yours)', type: 'email', required: true, editable: true },
        { key: 'test_phone', label: 'Test phone (yours, E.164)', type: 'tel', editable: true,
          showIf: { enable_sms: true } },
        { key: 'test_send_completed', label: 'I sent test messages and they look right', type: 'boolean', required: true },
        { key: 'segment_count_review', label: 'Final segment counts (read-only)', type: 'final-review', editable: false,
          checks: [
            { key: 'email_domain_verified', label: 'Email domain verified' },
            { key: 'tcpa_acknowledgment', label: 'TCPA consent confirmed' },
            { key: 'test_send_completed', label: 'Test send passed' },
          ] },
        { key: 'ready_for_review', label: 'I have reviewed everything and want STILO to activate REVIVE', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
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
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Ideal customer profile',
      'Lead sources',
      'Output destination',
      'Volume & cadence',
      'Owner-email rule',
      'Test scrape & review',
    ],
    onboardingSchema: [

      // Step 1: Ideal customer profile ─────────────────────────────────
      { step: 1,
        tutorial: 'Defaults are pre-loaded from your niche playbook. Edit them to match exactly who you want SCOUT to scrape.\n\nSCOUT scrapes Google Maps + finds owner emails. The narrower the ICP, the higher the conversion. "All restaurants in Florida" returns garbage. "Independent Italian restaurants in Miami-Dade with 4.5+ star ratings, 100+ reviews, no chain affiliation" returns gold.',
        fields: [
        { key: 'icp_industry_terms', label: 'Search terms for what you sell to (comma-separated)', type: 'textarea', required: true, editable: true,
          help: 'Example for med spa lead-gen: "med spa, aesthetics clinic, dermatology, plastic surgery". 6-9 variations is the sweet spot.' },
        { key: 'icp_geography_zips', label: 'Target zip codes (comma-separated)', type: 'textarea', required: true, editable: true,
          help: 'Defaults to your service area zips from Business Profile. Override here if you want broader prospecting.' },
        { key: 'icp_geography_radius_miles', label: 'OR radius from your address (miles)', type: 'number', editable: true,
          help: 'Used when zip list is empty. Default: 25 miles.' },
        { key: 'icp_min_rating', label: 'Minimum Google rating', type: 'number', editable: true,
          help: 'Default: 4.0. Higher for premium prospects.' },
        { key: 'icp_min_reviews', label: 'Minimum review count', type: 'number', editable: true,
          help: 'Default: 25. Filters out brand-new businesses.' },
        { key: 'icp_exclude_chains', label: 'Exclude national chain locations', type: 'boolean', editable: true,
          help: 'Recommended for B2B sales to independent operators.' },
        { key: 'icp_exclude_terms', label: 'Exclude businesses with these terms (comma-separated)', type: 'text', editable: true,
          help: 'Example: "franchise, chain, headquarters".' },
        { key: 'icp_size_signals', label: 'Other ICP signals', type: 'textarea', editable: true,
          help: 'Free-form description: "minority-owned, women-owned, LGBTQ-owned, recent funding, hiring signal", etc. Used by the email-finder phase.' },
      ]},

      // Step 2: Lead sources ───────────────────────────────────────────
      { step: 2,
        tutorial: 'Google Maps is the primary source and the highest-yield. Yelp and BBB give additional B2C coverage. LinkedIn is for B2B (decision-makers). Niche-specific sources (RealSelf for med spa, Avvo for law, Zillow for real estate) appear if your niche has them.',
        fields: [
        { key: 'source_google_maps', label: 'Google Maps (primary)', type: 'boolean', required: true, editable: true,
          help: 'Recommended ON. ~80% of B2C leads come from here.' },
        { key: 'source_yelp', label: 'Yelp', type: 'boolean', editable: true },
        { key: 'source_bbb', label: 'Better Business Bureau', type: 'boolean', editable: true },
        { key: 'source_linkedin', label: 'LinkedIn (for B2B decision-maker enrichment)', type: 'boolean', editable: true,
          help: 'Used by the email-finder phase to attach a name to each lead.' },
        { key: 'source_facebook_pages', label: 'Facebook business pages', type: 'boolean', editable: true },
        { key: 'source_niche_specific', label: 'Niche-specific sources', type: 'text', editable: true,
          help: 'Comma-separated. Pre-filled per niche: med spa → RealSelf; law → Avvo; real estate → Zillow agent directory.' },
      ]},

      // Step 3: Output destination ─────────────────────────────────────
      { step: 3, blocking: true,
        tutorial: 'Where do enriched leads go? Three options, can combine.\n\n1. **CSV emailed weekly**: simple, no integration. You get a Friday email with the week\'s leads.\n2. **Push to your CRM**: leads land directly in GoHighLevel / Follow Up Boss / HubSpot / etc. as new contacts with tags.\n3. **Push to IGNITE**: if you also bought IGNITE, SCOUT can hand off leads as "synthetic inbound" so IGNITE calls them within 2 minutes. This is the highest-conversion path but requires both agents.',
        fields: [
        { key: 'destination_csv_email', label: 'Email me a weekly CSV', type: 'boolean', editable: true },
        { key: 'csv_email_recipient', label: 'CSV email recipient', type: 'email', editable: true,
          showIf: { destination_csv_email: true },
          help: 'Defaults to owner email from Business Profile.' },
        { key: 'destination_crm_push', label: 'Push leads to my CRM', type: 'boolean', editable: true },
        { key: 'crm_push_choice', label: 'Which CRM?', type: 'select', editable: true,
          showIf: { destination_crm_push: true },
          options: [
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'follow_up_boss', label: 'Follow Up Boss' },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'pipedrive', label: 'Pipedrive' },
            { value: 'salesforce', label: 'Salesforce' },
            { value: 'webhook', label: 'Custom webhook' },
          ] },
        { key: 'crm_push_credentials.api_key', label: 'CRM API key', type: 'password', editable: true,
          showIf: { destination_crm_push: true } },
        { key: 'crm_push_credentials.location_id', label: 'GHL Location ID', type: 'text', editable: true,
          showIf: { crm_push_choice: 'gohighlevel' } },
        { key: 'crm_push_credentials.webhook_url', label: 'Webhook URL', type: 'url', editable: true,
          showIf: { crm_push_choice: 'webhook' } },
        { key: 'crm_push_tags', label: 'Tags to apply on push', type: 'text', editable: true,
          help: 'Comma-separated. Default: "scout, prospecting, {niche}".' },
        { key: 'destination_ignite_handoff', label: 'Hand off to IGNITE for outbound calls', type: 'boolean', editable: true,
          help: 'Requires an active IGNITE agent. Highest-conversion path.' },
        { key: 'crm_push_test', label: 'Test CRM connection', type: 'connection-test',
          target: '/api/integration-test',
          showIf: { destination_crm_push: true } },
      ]},

      // Step 4: Volume & cadence ───────────────────────────────────────
      { step: 4,
        tutorial: 'SCOUT scrapes 24/7 and self-paces against your weekly target. The Cloud Run worker runs at off-peak hours so it doesn\'t hit Google rate-limits.',
        fields: [
        { key: 'leads_per_week_target', label: 'Target new leads per week', type: 'number', required: true, editable: true,
          help: 'Default: 100. SCOUT will pause if it hits this number; resumes Monday.' },
        { key: 'max_total_leads', label: 'Hard ceiling on total leads ever', type: 'number', editable: true,
          help: 'Optional. Defaults to unlimited. Set if you want to cap on-disk lead count.' },
        { key: 'paid_sources_budget_usd', label: 'Monthly budget for paid enrichment ($USD)', type: 'number', editable: true,
          help: 'Optional. Defaults to $0. Used only if you enable LinkedIn or premium enrichment APIs.' },
        { key: 'priority_signals', label: 'Prioritize leads with these signals', type: 'textarea', editable: true,
          help: 'Free-form. Examples: "recent funding", "hiring", "5-star reviews", "competitor reviewer". Used to score the queue.' },
      ]},

      // Step 5: Owner-email rule ───────────────────────────────────────
      { step: 5, blocking: true,
        tutorial: 'SCOUT only marks an owner email as "confirmed" when both are true:\n\n1. A NAME is found near "owner", "founder", "CEO", "president", or "principal" on the business website or a search result.\n2. An EMAIL whose prefix matches that name (john.smith@..., jsmith@..., john@... all match "John Smith"; info@, contact@, hello@ never match anyone).\n\nIf one without the other → not confirmed. Cold outreach to the wrong person burns the domain.\n\nThis rule cannot be relaxed. Confirm you understand it.',
        fields: [
        { key: 'owner_email_rule_acknowledged', label: 'I understand SCOUT will not mark an email as confirmed unless name + email match. info@/contact@/hello@ are never confirmed.', type: 'boolean', required: true },
        { key: 'unconfirmed_email_handling', label: 'For leads with no confirmed owner email', type: 'select', editable: true,
          options: [
            { value: 'exclude', label: 'Exclude from output (only confirmed-owner leads in CSV/CRM)' },
            { value: 'include_with_flag', label: 'Include but flag as "unconfirmed"' },
            { value: 'include_for_phone_only', label: 'Include for phone-only outreach (skip email)' },
          ] },
      ]},

      // Step 6: Test scrape & review ───────────────────────────────────
      { step: 6, blocking: true,
        tutorial: 'Before SCOUT runs at scale, fire a test scrape: 1 niche, 10 leads. Confirms the ICP filter works as you intended and the email-finder hits.',
        fields: [
        { key: 'test_scrape_niche', label: 'Test niche (one term from your ICP)', type: 'text', required: true, editable: true },
        { key: 'test_scrape_city', label: 'Test city', type: 'text', required: true, editable: true,
          help: 'Default: "Miami FL".' },
        { key: 'test_scrape_button', label: 'Run test scrape (10 leads)', type: 'connection-test',
          target: '/api/integration-test',
          help: 'Hits the SCOUT Cloud Run service with your config.' },
        { key: 'test_scrape_passed', label: 'Test results look right (real businesses, accurate filter)', type: 'boolean', required: true },
        { key: 'ready_for_review', label: 'I have reviewed and want STILO to activate SCOUT', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
      ]},

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
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Domain',
      'Site goals & archetype',
      'Pages',
      'Content sources',
      'Booking integration',
      'SEO basics',
      'Preview & deploy',
    ],
    onboardingSchema: [

      // Step 1: Domain ─────────────────────────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'Three options for your website\'s URL:\n\n1. **Use a domain you already own** (yourbusiness.com): you\'ll change one DNS record (CNAME) at your registrar after we deploy. Takes 5-30 minutes.\n2. **Buy a new domain through STILO**: we register and configure it. ~$15-25/year for a .com.\n3. **Free subdomain on stiloaipartners.com** (yourbusiness.stiloaipartners.com): instant, free. Switch to a custom domain later.',
        fields: [
        { key: 'domain_strategy', label: 'Domain strategy', type: 'select', required: true, editable: true,
          options: [
            { value: 'own_existing', label: 'I own my domain already' },
            { value: 'buy_new', label: 'Buy a new domain through STILO' },
            { value: 'subdomain', label: 'Use a free subdomain on stiloaipartners.com' },
          ] },
        { key: 'existing_domain', label: 'Your domain', type: 'text', editable: true,
          showIf: { domain_strategy: 'own_existing' },
          help: 'Format: yourbusiness.com (no https://, no www).' },
        { key: 'desired_domain', label: 'Desired domain to register', type: 'text', editable: true,
          showIf: { domain_strategy: 'buy_new' },
          help: '.com preferred. We check availability when you click "Verify availability".' },
        { key: 'subdomain_choice', label: 'Subdomain (your choice)', type: 'text', editable: true,
          showIf: { domain_strategy: 'subdomain' },
          help: 'Lowercase, letters/numbers/hyphens only. Example: "glow-medspa" → glow-medspa.stiloaipartners.com.' },
        { key: 'domain_verified', label: 'Verify domain availability / DNS access', type: 'connection-test',
          target: '/api/integration-test' },
      ]},

      // Step 2: Site goals & archetype ─────────────────────────────────
      { step: 2,
        tutorial: 'Your niche playbook seeds an archetype: a proven layout pattern for your industry. Med spa = before/after gallery hero. Law = consultation funnel. Restaurant = reservations + menu hero. You can override or customize, but the niche default is the highest-converting starting point.',
        fields: [
        { key: 'archetype', label: 'Site archetype (pre-loaded from niche)', type: 'select', required: true, editable: true,
          options: [
            { value: 'before_after_gallery', label: 'Before/after gallery + book CTA (med spa, dental cosmetic)' },
            { value: 'consultation_funnel', label: 'Free consult funnel (law, accounting, coaching)' },
            { value: 'service_areas_quote', label: 'Service area + free quote (HVAC, plumbing, roofing)' },
            { value: 'menu_reservations', label: 'Menu + reservations (restaurants)' },
            { value: 'class_schedule_trial', label: 'Class schedule + free trial (gyms, fitness)' },
            { value: 'listing_showcase', label: 'Listings showcase (real estate)' },
            { value: 'portfolio_proof', label: 'Portfolio + case studies (agencies, professional services)' },
            { value: 'storefront', label: 'Storefront (auto, retail)' },
          ] },
        { key: 'primary_goal', label: 'Primary visitor action', type: 'select', required: true, editable: true,
          options: [
            { value: 'book_appointment', label: 'Book an appointment / consult' },
            { value: 'request_quote', label: 'Request a quote' },
            { value: 'call_us', label: 'Call (click-to-call)' },
            { value: 'reserve_table', label: 'Reserve a table' },
            { value: 'start_trial', label: 'Start a free trial' },
            { value: 'view_listings', label: 'View listings' },
            { value: 'submit_form', label: 'Submit a contact form' },
          ] },
        { key: 'secondary_goal', label: 'Secondary action', type: 'text', editable: true,
          help: 'Example: "subscribe to email list", "follow on Instagram".' },
        { key: 'design_inspiration_urls', label: 'Sites you like (one per line)', type: 'textarea', editable: true,
          help: 'Up to 5. We look at structure, colors, typography. Won\'t copy.' },
      ]},

      // Step 3: Pages ──────────────────────────────────────────────────
      { step: 3,
        tutorial: 'Niche-must-have pages are pre-checked. Add or remove based on what you actually need. Simpler is better: most successful local sites have 5-8 pages, not 30.',
        fields: [
        { key: 'pages', label: 'Pages to include', type: 'textarea', required: true, editable: true,
          help: 'Pre-loaded from niche playbook. Edit the list (one page name per line). Examples: Home, Services, About, Gallery, FAQ, Contact, Booking.' },
        { key: 'has_blog', label: 'Include a blog', type: 'boolean', editable: true,
          help: 'Recommended for SEO (SIGNAL benefits).' },
        { key: 'has_gallery', label: 'Include a photo / before-after gallery', type: 'boolean', editable: true },
        { key: 'has_team_page', label: 'Include a team / about page', type: 'boolean', editable: true },
        { key: 'has_faq', label: 'Include an FAQ page (auto-generates from KB)', type: 'boolean', editable: true,
          help: 'Pulls from your Business Profile knowledge base. Editable per-question.' },
      ]},

      // Step 4: Content sources ────────────────────────────────────────
      { step: 4,
        tutorial: 'FORGE pulls 80% of content from your Business Profile (services, hours, photos, KB, brand voice). Use this step to add anything that isn\'t in the profile yet: testimonials, case studies, additional photos.',
        fields: [
        { key: 'testimonials', label: 'Testimonials (with consent)', type: 'array-of-objects', editable: true,
          schema: [
            { key: 'customer_name', label: 'Customer name', type: 'text' },
            { key: 'quote', label: 'Quote', type: 'textarea' },
            { key: 'service', label: 'Service / treatment', type: 'text' },
            { key: 'consent_obtained', label: 'Consent on file (YES/NO)', type: 'text' },
          ] },
        { key: 'case_studies_urls', label: 'Case study URLs (one per line)', type: 'textarea', editable: true,
          help: 'For agencies / professional services.' },
        { key: 'press_mentions', label: 'Press mentions / awards', type: 'textarea', editable: true },
        { key: 'extra_photos_urls', label: 'Additional photo URLs (one per line)', type: 'textarea', editable: true,
          help: 'Beyond what\'s in your Business Profile assets.' },
      ]},

      // Step 5: Booking integration ────────────────────────────────────
      { step: 5,
        tutorial: 'When a visitor books on the website, the appointment lands in your calendar — same calendar ECHO and IGNITE write to. The form also posts to your CRM with a tag.',
        fields: [
        { key: 'booking_method', label: 'Booking method (defaults to your Business Profile calendar)', type: 'select', editable: true,
          options: [
            { value: 'cal_com', label: 'Cal.com embed' },
            { value: 'calendly', label: 'Calendly embed' },
            { value: 'native_form', label: 'Native form posting to CRM' },
            { value: 'phone_only', label: 'Click-to-call only, no online booking' },
          ] },
        { key: 'lead_form_fields', label: 'Lead form fields (comma-separated)', type: 'text', editable: true,
          help: 'Default: "Name, Email, Phone, Service of interest, Notes". Add or remove.' },
        { key: 'lead_form_crm_destination', label: 'Where lead form submissions go', type: 'select', editable: true,
          help: 'Defaults to your Business Profile CRM.',
          options: [
            { value: 'business_profile_crm', label: 'My CRM (from Business Profile)' },
            { value: 'email_only', label: 'Email me only' },
            { value: 'both', label: 'Email me AND push to CRM' },
          ] },
      ]},

      // Step 6: SEO basics ─────────────────────────────────────────────
      { step: 6,
        tutorial: 'Pre-loaded keyword targets from your niche playbook. SIGNAL (if you have it) does the deep keyword research; FORGE just bakes the basics into the site so you\'re not starting from zero.',
        fields: [
        { key: 'target_keywords', label: 'Top 10 target keywords', type: 'textarea', required: true, editable: true,
          help: 'One per line. Pre-loaded from niche playbook. Example for med spa Miami: "med spa near me", "botox miami", "filler 33131".' },
        { key: 'meta_title_template', label: 'Page title template', type: 'text', editable: true,
          help: 'Default: "{page} | {business_name} | {city}".' },
        { key: 'has_signal_addon', label: 'I also have SIGNAL (deep SEO) for this site', type: 'boolean', editable: true,
          help: 'If yes, FORGE skips weekly keyword updates; SIGNAL handles it.' },
        { key: 'google_business_profile_url', label: 'Google Business Profile URL (if claimed)', type: 'url', editable: true },
      ]},

      // Step 7: Preview & deploy ───────────────────────────────────────
      { step: 7, blocking: true, fields: [
        { key: 'preview_check', label: 'I have reviewed the preview link STILO sent', type: 'boolean', editable: true,
          help: 'STILO emails a preview URL within 1 business day of submission. Approve here once it looks right.' },
        { key: 'ready_for_review', label: 'I am ready for STILO to deploy this site to my domain', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
      ]},

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
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Site to optimize',
      'Google Business Profile',
      'Keyword targets',
      'Competitor benchmarks',
      'AI search optimization',
    ],
    onboardingSchema: [

      // Step 1: Site to optimize ───────────────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'SIGNAL works on a website you own. Two paths:\n\n1. **You also have FORGE**: SIGNAL plugs straight into the FORGE site, no extra setup.\n2. **You have an existing site elsewhere**: paste the URL. SIGNAL crawls it to extract current content, meta, and schema. The crawl runs once and is read-only.',
        fields: [
        { key: 'site_source', label: 'Which site is SIGNAL optimizing?', type: 'select', required: true, editable: true,
          options: [
            { value: 'forge', label: 'My FORGE site (auto-linked)' },
            { value: 'external_wordpress', label: 'WordPress site (I have admin access)' },
            { value: 'external_squarespace', label: 'Squarespace site' },
            { value: 'external_shopify', label: 'Shopify site' },
            { value: 'external_other', label: 'Other / custom site' },
          ] },
        { key: 'site_url', label: 'Site URL', type: 'url', required: true, editable: true,
          help: 'Format: https://yourbusiness.com (full URL).' },
        { key: 'admin_access_method', label: 'How will SIGNAL push changes?', type: 'select', editable: true,
          showIf_not: { site_source: 'forge' },
          options: [
            { value: 'wp_admin', label: 'WordPress admin login' },
            { value: 'plugin', label: 'Custom plugin (we install)' },
            { value: 'manual', label: 'Manual: SIGNAL gives me a quarterly checklist, I implement' },
            { value: 'cms_api', label: 'CMS API access' },
          ] },
        { key: 'crawl_completed', label: 'Run baseline crawl', type: 'connection-test',
          target: '/api/integration-test',
          help: 'Read-only crawl of your homepage + top 5 pages.' },
      ]},

      // Step 2: Google Business Profile ────────────────────────────────
      { step: 2,
        tutorial: 'For local SEO, your Google Business Profile (GBP) matters more than your website. SIGNAL optimizes both.\n\nIf you don\'t have a GBP yet, we\'ll guide you through claiming one. The Google verification process takes 5-14 days (postcard) but you can start optimizing immediately.',
        fields: [
        { key: 'gbp_status', label: 'Google Business Profile status', type: 'select', required: true, editable: true,
          options: [
            { value: 'owned_verified', label: 'I own and have verified my GBP' },
            { value: 'owned_unverified', label: 'I own it but haven\'t verified yet' },
            { value: 'unclaimed', label: 'There\'s a listing but I haven\'t claimed it' },
            { value: 'none', label: 'No listing exists' },
          ] },
        { key: 'gbp_url', label: 'GBP listing URL', type: 'url', editable: true,
          showIf: { gbp_status: 'owned_verified' } },
        { key: 'gbp_oauth', label: 'Connect Google Business Profile', type: 'oauth-button',
          target: '/api/oauth?provider=google-business&action=start',
          showIf: { gbp_status: 'owned_verified' },
          help: 'OAuth lets SIGNAL post updates, respond to reviews, and update your hours.' },
        { key: 'gbp_claim_help_requested', label: 'I want STILO to help me claim and verify my listing', type: 'boolean', editable: true,
          showIf_not: { gbp_status: 'owned_verified' } },
        { key: 'review_response_strategy', label: 'How should SIGNAL handle reviews?', type: 'select', editable: true,
          options: [
            { value: 'auto_thank_positive', label: 'Auto-respond to 5-star reviews (positive only); flag the rest for me' },
            { value: 'all_for_review', label: 'Draft all responses but I approve before posting' },
            { value: 'no_responses', label: 'Don\'t touch reviews, just track them' },
          ] },
      ]},

      // Step 3: Keyword targets ────────────────────────────────────────
      { step: 3,
        tutorial: 'Niche-specific keywords are pre-loaded from your niche playbook (high-intent + local). SIGNAL also pulls live volume + difficulty from DataForSEO and shows the projected ranking opportunity for each.',
        fields: [
        { key: 'target_keywords', label: 'Target keywords', type: 'array-of-objects', required: true, editable: true,
          help: 'Pre-loaded from your niche playbook. Aim for 20 keywords: 8 high-intent, 8 local, 4 informational.',
          schema: [
            { key: 'keyword', label: 'Keyword', type: 'text' },
            { key: 'intent', label: 'Intent (transactional, informational, navigational)', type: 'text' },
            { key: 'priority', label: 'Priority (high, medium, low)', type: 'text' },
          ],
          minItems: 10 },
        { key: 'service_areas_for_geo', label: 'Cities or zip codes to rank in (comma-separated)', type: 'text', editable: true,
          help: 'SIGNAL builds a service-area page per city. Limit to 3-5 to start.' },
      ]},

      // Step 4: Competitor benchmarks ──────────────────────────────────
      { step: 4,
        tutorial: 'Pick 3-5 local competitors. SIGNAL tracks their rankings weekly and alerts you when they outrank you on a target keyword.',
        fields: [
        { key: 'competitors', label: 'Competitor URLs', type: 'textarea', required: true, editable: true,
          help: 'One URL per line. SIGNAL tracks their rank weekly.' },
        { key: 'competitor_alerts', label: 'Alert me when a competitor outranks me on a target keyword', type: 'boolean', editable: true },
      ]},

      // Step 5: AI search optimization ─────────────────────────────────
      { step: 5,
        tutorial: 'Ranking on Google is one game. Showing up when someone asks ChatGPT, Perplexity, or Claude "best med spa in Miami" is another. SIGNAL optimizes for both.\n\nThe AI assistants prefer pages that:\n- Have FAQ schema with the answer in the first 200 words\n- List structured business data (LocalBusiness schema)\n- Match high-authority citations across the web\n- Have unique, specific content (not boilerplate)',
        fields: [
        { key: 'enable_ai_search_optimization', label: 'Optimize for ChatGPT, Perplexity, and Claude visibility', type: 'boolean', required: true, editable: true,
          help: 'Recommended ON. No extra cost.' },
        { key: 'schema_types_to_add', label: 'Schema types to add (pre-loaded from niche)', type: 'text', editable: true,
          help: 'Examples for med spa: MedicalBusiness, MedicalProcedure, FAQPage, LocalBusiness.' },
        { key: 'citation_priorities', label: 'Citation sources to claim/optimize (pre-loaded from niche)', type: 'textarea', editable: true,
          help: 'One per line. SIGNAL helps you claim each.' },
        { key: 'test_query_check', label: 'Run an AI search visibility test', type: 'connection-test',
          target: '/api/integration-test',
          help: 'We query "best {your niche} in {your city}" against ChatGPT and Perplexity and report whether you appear.' },
        { key: 'ready_for_review', label: 'I have reviewed and want STILO to activate SIGNAL', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
      ]},

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
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Data sources',
      'KPIs & targets',
      'Reporting cadence',
      'Competitive set',
      'Strategic context',
      'Baseline & review',
    ],
    onboardingSchema: [

      // Step 1: Data sources ───────────────────────────────────────────
      { step: 1, blocking: true,
        tutorial: 'ORACLE works on real numbers. Connect the systems that hold your data, and ORACLE pulls weekly to build dashboards and reports.\n\nMost connections are OAuth (no password sharing). The rest use API keys.\n\nIf you skip a source, ORACLE works around it — but the more sources, the better the analysis.',
        fields: [
        { key: 'connect_quickbooks', label: 'Connect QuickBooks / Xero', type: 'oauth-button',
          target: '/api/oauth?provider=quickbooks&action=start',
          help: 'Revenue, expenses, margins.' },
        { key: 'connect_google_analytics', label: 'Connect Google Analytics', type: 'oauth-button',
          target: '/api/oauth?provider=google-analytics&action=start',
          help: 'Website traffic + conversions.' },
        { key: 'connect_meta_ads', label: 'Connect Meta Ads (Facebook + Instagram)', type: 'oauth-button',
          target: '/api/oauth?provider=meta-ads&action=start',
          help: 'Ad spend, ROAS, lead source attribution.' },
        { key: 'connect_google_ads', label: 'Connect Google Ads', type: 'oauth-button',
          target: '/api/oauth?provider=google-ads&action=start' },
        { key: 'connect_crm', label: 'Connect CRM (defaults to Business Profile CRM)', type: 'oauth-button',
          target: '/api/oauth?provider=gohighlevel&action=start',
          help: 'Pipeline, conversion stages, average deal size.' },
        { key: 'connect_pos', label: 'POS / payment processor', type: 'select', editable: true,
          help: 'For restaurants, retail, fitness with check-ins.',
          options: [
            { value: 'square', label: 'Square' },
            { value: 'toast', label: 'Toast (restaurants)' },
            { value: 'stripe', label: 'Stripe' },
            { value: 'mindbody', label: 'Mindbody (fitness/wellness)' },
            { value: 'none', label: 'No POS / not applicable' },
          ] },
        { key: 'pos_credentials.api_key', label: 'POS API key', type: 'password', editable: true,
          showIf_not: { connect_pos: 'none' } },
        { key: 'data_sources_minimum_check', label: 'I have connected at least 2 data sources', type: 'boolean', required: true,
          help: 'ORACLE needs at least 2 sources for cross-source analysis. Required.' },
      ]},

      // Step 2: KPIs & targets ─────────────────────────────────────────
      { step: 2,
        tutorial: 'Niche-specific KPI defaults are pre-loaded. Edit targets to match your goals. ORACLE tracks your performance against these targets every week and flags gaps in the report.',
        fields: [
        { key: 'kpis', label: 'KPIs to track (pre-loaded from niche)', type: 'array-of-objects', required: true, editable: true,
          help: 'Pre-filled from your niche playbook. Edit targets to match your goals.',
          schema: [
            { key: 'metric', label: 'Metric', type: 'text' },
            { key: 'target_value', label: 'Target', type: 'text' },
            { key: 'period', label: 'Period (daily/weekly/monthly)', type: 'text' },
            { key: 'priority', label: 'Priority (P1/P2/P3)', type: 'text' },
          ],
          minItems: 3 },
        { key: 'business_outcome_north_star', label: 'Your one north-star metric', type: 'text', editable: true,
          help: 'The single number that matters most. Example: "monthly recurring revenue", "consults booked", "average ticket".' },
        { key: 'comparison_period', label: 'Default comparison period', type: 'select', editable: true,
          options: [
            { value: 'wow', label: 'Week-over-week' },
            { value: 'mom', label: 'Month-over-month' },
            { value: 'yoy', label: 'Year-over-year' },
            { value: 'mixed', label: 'Mixed: weekly for ops, monthly for revenue, YoY for trend' },
          ] },
      ]},

      // Step 3: Reporting cadence ──────────────────────────────────────
      { step: 3,
        tutorial: 'Pick how often you want reports and how you want them. Most clients pick "weekly digest by email + monthly executive review (PDF)". The web app dashboard is always live regardless.',
        fields: [
        { key: 'daily_snapshot', label: 'Daily one-line snapshot via SMS', type: 'boolean', editable: true,
          help: 'Sends one SMS at 8am with yesterday\'s top 3 numbers.' },
        { key: 'weekly_digest', label: 'Weekly digest via email', type: 'boolean', editable: true,
          help: 'Recommended ON. Mondays at 9am: last week\'s performance vs targets.' },
        { key: 'monthly_executive_review', label: 'Monthly executive review (PDF)', type: 'boolean', editable: true,
          help: 'Comprehensive analysis with strategic recommendations. First Monday of each month.' },
        { key: 'quarterly_strategic_review', label: 'Quarterly strategic deep-dive', type: 'boolean', editable: true,
          help: 'STILO partner reviews your numbers + recommends what to change.' },
        { key: 'report_recipients', label: 'Recipients (comma-separated emails)', type: 'text', required: true, editable: true,
          help: 'Defaults to owner email. Add your accountant, partners, or coach.' },
        { key: 'report_alert_thresholds', label: 'Alert me when a P1 KPI is more than X% off target', type: 'number', editable: true,
          help: 'Default: 15%. ORACLE sends an immediate email if any P1 metric breaches this threshold.' },
      ]},

      // Step 4: Competitive set ────────────────────────────────────────
      { step: 4,
        tutorial: 'ORACLE benchmarks your numbers against typical performance for your niche AND your specific competitors. If you have SCOUT, we pull competitor data automatically.',
        fields: [
        { key: 'competitors', label: 'Competitors to benchmark against', type: 'textarea', editable: true,
          help: 'One per line: name + city. Auto-suggested from SCOUT if you have it.' },
        { key: 'use_niche_benchmarks', label: 'Compare me against niche benchmarks (peer averages)', type: 'boolean', editable: true,
          help: 'ORACLE has aggregate data on typical performance for each niche. Recommended ON.' },
      ]},

      // Step 5: Strategic context ──────────────────────────────────────
      { step: 5,
        tutorial: 'The single most important field in this whole wizard. ORACLE writes its monthly executive review around answering this question. Be specific.',
        fields: [
        { key: 'biggest_strategic_question', label: 'The one strategic question you want answered every month', type: 'textarea', required: true, editable: true,
          help: 'Examples: "Why is our show rate dropping?", "Are we charging enough?", "Which marketing channel actually works?", "Should we open a second location?"' },
        { key: 'current_growth_stage', label: 'Current stage', type: 'select', required: true, editable: true,
          options: [
            { value: 'launching', label: 'Launching (first 6 months)' },
            { value: 'finding_fit', label: 'Finding product/service fit' },
            { value: 'scaling', label: 'Scaling what works' },
            { value: 'optimizing', label: 'Optimizing margins' },
            { value: 'expanding', label: 'Expanding (new locations / services)' },
          ] },
        { key: 'recent_strategic_changes', label: 'Strategic changes in the last 6 months', type: 'textarea', editable: true,
          help: 'New service line, price increase, hire, location, marketing pivot. Helps ORACLE attribute changes correctly.' },
      ]},

      // Step 6: Baseline & review ──────────────────────────────────────
      { step: 6, blocking: true,
        tutorial: 'STILO pulls a baseline analysis from your connected data sources within 1 business day of submission. You\'ll get a preview report by email. Approve here once it looks accurate.',
        fields: [
        { key: 'baseline_preview_received', label: 'I have received and reviewed the baseline analysis preview', type: 'boolean', editable: true },
        { key: 'baseline_accurate', label: 'The baseline numbers match my own books', type: 'boolean', editable: true,
          help: 'If no, STILO will reconnect data sources or correct mappings before going live.' },
        { key: 'ready_for_review', label: 'I am ready for STILO to activate ORACLE', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
      ]},

    ],
  },
  pitch: {
    code: 'pitch',
    // Repositioned 2026-05-26: was "AI Sales Coach" ($1,500/mo, coaching-only).
    // Now bundles email automation on top of coaching — same codename, expanded
    // scope, $2,000/mo. Internal code stays 'pitch' so existing client_agents
    // rows, Stripe envs, and LEGACY_ID_MAP entries keep working.
    name: 'PITCH - AI Sales Agent',
    shortName: 'PITCH',
    setupFeeCents: 250000,
    monthlyFeeCents: 200000,
    stripeSetupPriceEnv: 'STRIPE_PRICE_PITCH_SETUP',
    stripeMonthlyPriceEnv: 'STRIPE_PRICE_PITCH_MONTHLY',
    purchaseMode: 'self_serve',
    requiresBusinessProfile: true,
    onboardingSteps: [
      'Sales motion & goals',
      'Connect your sources',
      'Team & pipeline',
      'Scripts & templates',
      'Coaching cadence',
      'Email automation',
      'Review & go live',
    ],
    onboardingSchema: [

      // Step 1: Sales motion & goals ──────────────────────────────────
      { step: 1,
        tutorial: 'PITCH is your AI Sales Agent. It listens to your cold calls + meetings + reads every email thread, rewrites scripts + email sequences against what actually converts, and (once you flip the switch in Step 6) sends the rewritten outbound emails on a cadence you control. Two halves: coaching (always on) + automation (opt-in). First job: tell us how you sell today.',
        fields: [
        { key: 'sales_motion', label: 'How do you primarily sell?', type: 'select', required: true, editable: true,
          options: [
            { value: 'outbound_cold', label: 'Mostly outbound cold calls and cold emails' },
            { value: 'inbound_close', label: 'Mostly inbound leads we close on the phone' },
            { value: 'mixed', label: 'Mix of outbound prospecting and inbound closing' },
            { value: 'in_person', label: 'Mostly in-person meetings or walk-ins' },
            { value: 'demo_heavy', label: 'Demo / discovery → proposal → close' },
          ] },
        { key: 'avg_deal_value_usd', label: 'Average deal value ($)', type: 'number', editable: true,
          help: 'PITCH uses this to weight which calls/emails matter most.' },
        { key: 'sales_cycle_days', label: 'Typical sales cycle (days from first touch to close)', type: 'number', editable: true },
        { key: 'current_close_rate_pct', label: 'Current close rate (% of qualified leads that buy)', type: 'number', editable: true,
          help: 'Best estimate. PITCH builds a baseline and tracks lift from here.' },
        { key: 'top_objections_today', label: 'Top 3 objections you hear right now', type: 'textarea', required: true, editable: true,
          help: 'One per line. Price, timing, "not the right person", etc.' },
        { key: 'biggest_sales_question', label: 'The one sales question you want answered every week', type: 'textarea', required: true, editable: true,
          help: 'Examples: "Why are we losing in the demo?", "Are my reps following the script?", "Which subject line gets opens?"' },
        { key: 'success_metric', label: 'How will we know PITCH is working?', type: 'select', required: true, editable: true,
          options: [
            { value: 'close_rate', label: 'Higher close rate on existing pipeline' },
            { value: 'reply_rate', label: 'Higher cold email reply rate' },
            { value: 'connect_rate', label: 'Higher cold call connect rate' },
            { value: 'cycle_speed', label: 'Shorter sales cycle' },
            { value: 'avg_deal_size', label: 'Bigger average deal size' },
          ] },
      ]},

      // Step 2: Connect your sources ──────────────────────────────────
      { step: 2, blocking: true,
        tutorial: 'PITCH needs raw material. Connect whichever sources you have. The more it sees, the sharper the coaching. Nothing is forwarded outside of STILO; transcripts and emails are stored encrypted.\n\nMinimum: one source. Recommended: call transcripts + email.\n\n**Call transcripts**: Gong, Fathom, Otter, Fireflies, Zoom Cloud, OpenPhone, or upload .txt/.vtt files manually. Most tools have a "share with API" toggle that gives a token.\n\n**Cold email**: connect Gmail/Outlook via OAuth, or paste an Apollo/Instantly/Smartlead API key. PITCH only reads the threads tagged with the labels you specify.\n\n**CRM notes**: defaults to the CRM from your Business Profile. PITCH pulls deal stages, lost reasons, and rep notes to correlate with what was said on the call.',
        fields: [
        { key: 'connect_call_source', label: 'Where do your call recordings/transcripts live?', type: 'select', required: true, editable: true,
          options: [
            { value: 'gong', label: 'Gong' },
            { value: 'fathom', label: 'Fathom' },
            { value: 'fireflies', label: 'Fireflies' },
            { value: 'otter', label: 'Otter.ai' },
            { value: 'zoom_cloud', label: 'Zoom Cloud Recording' },
            { value: 'openphone', label: 'OpenPhone' },
            { value: 'aircall', label: 'Aircall' },
            { value: 'retell_calls', label: 'STILO ECHO/IGNITE call recordings' },
            { value: 'manual_upload', label: 'I will upload transcripts manually' },
            { value: 'none_yet', label: 'No call recordings today (set up later)' },
          ] },
        { key: 'call_credentials.api_key', label: 'API key / access token for your call source', type: 'password', editable: true,
          showIf_not: { connect_call_source: 'manual_upload' },
          help: 'Skip if you picked manual upload or none.' },
        { key: 'call_credentials.workspace_id', label: 'Workspace / account ID (if your tool requires it)', type: 'text', editable: true,
          showIf_not: { connect_call_source: 'manual_upload' } },

        { key: 'connect_email_source', label: 'Where do your sales emails live?', type: 'select', required: true, editable: true,
          options: [
            { value: 'gmail_oauth', label: 'Gmail (OAuth)' },
            { value: 'outlook_oauth', label: 'Outlook / Microsoft 365 (OAuth)' },
            { value: 'apollo', label: 'Apollo.io sequences' },
            { value: 'instantly', label: 'Instantly.ai' },
            { value: 'smartlead', label: 'Smartlead' },
            { value: 'gohighlevel', label: 'GoHighLevel email' },
            { value: 'manual_paste', label: 'I will paste threads manually' },
            { value: 'none_yet', label: 'No outbound email today' },
          ] },
        { key: 'email_oauth_connect', label: 'Connect mailbox', type: 'oauth-button',
          target: '/api/oauth?provider=google-gmail&action=start',
          showIf: { connect_email_source: 'gmail_oauth' } },
        { key: 'email_oauth_connect_outlook', label: 'Connect Outlook', type: 'oauth-button',
          target: '/api/oauth?provider=microsoft-outlook&action=start',
          showIf: { connect_email_source: 'outlook_oauth' } },
        { key: 'email_credentials.api_key', label: 'API key for your sequencing tool', type: 'password', editable: true,
          showIf: { connect_email_source: 'apollo' } },
        { key: 'email_credentials.api_key', label: 'Instantly API key', type: 'password', editable: true,
          showIf: { connect_email_source: 'instantly' } },
        { key: 'email_credentials.api_key', label: 'Smartlead API key', type: 'password', editable: true,
          showIf: { connect_email_source: 'smartlead' } },
        { key: 'email_label_filter', label: 'Only read threads with these Gmail labels / tags (comma-separated)', type: 'text', editable: true,
          help: 'Optional. Example: "sales, outreach, demos". Leave blank to scan all sent mail.',
          showIf_not: { connect_email_source: 'none_yet' } },

        { key: 'crm_for_pitch', label: 'CRM to correlate deal outcomes (defaults to Business Profile)', type: 'select', editable: true,
          options: [
            { value: 'inherit', label: 'Use my Business Profile CRM' },
            { value: 'gohighlevel', label: 'GoHighLevel' },
            { value: 'hubspot', label: 'HubSpot' },
            { value: 'salesforce', label: 'Salesforce' },
            { value: 'pipedrive', label: 'Pipedrive' },
            { value: 'close', label: 'Close.com' },
            { value: 'none', label: 'No CRM — track outcomes manually' },
          ] },
        { key: 'crm_credentials_pitch.api_key', label: 'CRM API key (only if different from Business Profile)', type: 'password', editable: true,
          showIf_not: { crm_for_pitch: 'inherit' } },

        { key: 'source_connection_test', label: 'Test source connections', type: 'connection-test',
          target: '/api/integration-test',
          help: 'Pulls a sample call + a sample email thread to verify access. Required before advancing.' },
        { key: 'consent_to_process_transcripts', label: 'I have authority to share these transcripts and emails with STILO for sales coaching analysis', type: 'boolean', required: true,
          help: 'Standard. PITCH will not pull data without this.' },
      ]},

      // Step 3: Team & pipeline ───────────────────────────────────────
      { step: 3,
        tutorial: 'Tell PITCH about your sales team and pipeline stages. The coaching is per-rep: each rep gets their own scorecard, strengths, and gaps. If you sell solo, just enter yourself.',
        fields: [
        { key: 'sales_reps', label: 'Sales reps (one row per rep)', type: 'array-of-objects', required: true, editable: true,
          schema: [
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'email', label: 'Email', type: 'email' },
            { key: 'role', label: 'Role (SDR, AE, closer, owner)', type: 'text' },
            { key: 'experience_level', label: 'Experience (new, mid, senior)', type: 'text' },
          ],
          minItems: 1,
          help: 'PITCH builds a per-rep scorecard. Add everyone whose calls/emails you want analyzed.' },
        { key: 'pipeline_stages', label: 'Your pipeline stages (in order, comma-separated)', type: 'text', required: true, editable: true,
          help: 'Default: "Cold → Connected → Discovery → Proposal → Closed Won/Lost". Match what your CRM actually uses.' },
        { key: 'qualification_framework', label: 'Qualification framework you follow (if any)', type: 'select', editable: true,
          options: [
            { value: 'bant', label: 'BANT (Budget, Authority, Need, Timing)' },
            { value: 'meddic', label: 'MEDDIC / MEDDPICC' },
            { value: 'gpct', label: 'GPCT (Goals, Plans, Challenges, Timing)' },
            { value: 'spin', label: 'SPIN selling' },
            { value: 'custom', label: 'Custom (described below)' },
            { value: 'none', label: 'No formal framework' },
          ] },
        { key: 'qualification_notes', label: 'Custom qualification criteria (if not standard)', type: 'textarea', editable: true,
          showIf: { qualification_framework: 'custom' } },
        { key: 'lost_deal_reasons', label: 'The 3-5 most common reasons you lose deals', type: 'textarea', required: true, editable: true,
          help: 'One per line. PITCH cross-checks these against call transcripts to find which losses were preventable.' },
      ]},

      // Step 4: Scripts & templates ───────────────────────────────────
      { step: 4,
        tutorial: 'Paste what you use today. PITCH benchmarks every call/email against these baselines and rewrites weaker performers. Leave fields blank if you do not have one yet — PITCH will draft a first version from your niche playbook.',
        fields: [
        { key: 'current_cold_call_script', label: 'Current cold-call opener / script', type: 'textarea', editable: true,
          help: 'Paste your current opener. PITCH rewrites it after the first 20 calls of data.' },
        { key: 'current_cold_email_template', label: 'Current cold email subject + body', type: 'textarea', editable: true,
          help: 'Paste your best-performing template. PITCH generates A/B variants.' },
        { key: 'current_followup_sequence', label: 'Current follow-up cadence (number of touches + days)', type: 'textarea', editable: true,
          help: 'Example: "Day 1 email, Day 3 call, Day 7 email, Day 14 LinkedIn".' },
        { key: 'current_demo_outline', label: 'Demo or discovery call outline', type: 'textarea', editable: true,
          help: 'The structure you follow. PITCH scores adherence and flags drift.' },
        { key: 'current_closing_questions', label: 'How you ask for the sale', type: 'textarea', editable: true,
          help: 'Verbatim if possible. PITCH finds which phrasing converts.' },
        { key: 'objection_responses', label: 'Approved responses to your top objections', type: 'array-of-objects', editable: true,
          schema: [
            { key: 'objection', label: 'Objection', type: 'text' },
            { key: 'response', label: 'Your response', type: 'textarea' },
          ] },
        { key: 'brand_voice_constraints', label: 'Words or claims your reps must NEVER say', type: 'textarea', editable: true,
          help: 'Compliance, legal, or brand restrictions. PITCH flags any call/email that crosses them.' },
      ]},

      // Step 5: Coaching cadence ──────────────────────────────────────
      { step: 5,
        tutorial: 'Pick how PITCH delivers feedback. Most clients run "weekly team digest + per-rep coaching scorecard + real-time deal-risk alerts".',
        fields: [
        { key: 'rep_scorecard_frequency', label: 'Per-rep scorecard frequency', type: 'select', required: true, editable: true,
          options: [
            { value: 'after_every_call', label: 'After every call (heavy coaching mode)' },
            { value: 'daily', label: 'Daily summary email' },
            { value: 'weekly', label: 'Weekly scorecard (recommended)' },
            { value: 'biweekly', label: 'Every other week' },
          ] },
        { key: 'team_digest_frequency', label: 'Team digest frequency', type: 'select', editable: true,
          options: [
            { value: 'weekly', label: 'Weekly (Monday 8am ET) — recommended' },
            { value: 'biweekly', label: 'Every other week' },
            { value: 'monthly', label: 'Monthly executive review' },
          ] },
        { key: 'deal_risk_alerts', label: 'Real-time deal-risk alerts', type: 'boolean', editable: true,
          help: 'When PITCH detects a deal slipping (missed call commitments, stalled email threads, red-flag objections), it pings the rep + manager within 15 minutes.' },
        { key: 'script_refresh_cadence', label: 'How often should PITCH refresh your scripts and email templates?', type: 'select', editable: true,
          options: [
            { value: 'weekly', label: 'Weekly — fast iteration' },
            { value: 'biweekly', label: 'Every 2 weeks (recommended)' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'on_demand', label: 'Only when I ask' },
          ] },
        { key: 'coaching_recipients', label: 'Recipients for coaching reports (comma-separated emails)', type: 'text', required: true, editable: true,
          help: 'Defaults to owner email plus each rep email.' },
        { key: 'sample_size_target', label: 'Minimum calls/emails before PITCH ships a script rewrite', type: 'number', editable: true,
          help: 'Default: 20. Higher = more statistically grounded; lower = faster iteration.' },
      ]},

      // Step 6: Email automation ──────────────────────────────────────
      // Opt-in. PITCH-as-coach (steps 1-5) ships scorecards + rewrites; the
      // automation layer here actually SENDS the rewritten emails on a cadence
      // through the mailbox connected in step 2. Defaults to OFF — safer to
      // ship coaching first, flip automation on once trust is built.
      { step: 6,
        tutorial: 'Email automation (the "agent" half of AI Sales Agent). Optional. PITCH can send the rewritten cold emails + follow-ups from the same mailbox you connected in step 2. You set the rules; PITCH respects them. Start conservative — most clients run human-review-first for the first 30 days, then flip to auto-send once they trust the output.',
        fields: [
        { key: 'automation_enabled', label: 'Turn on email automation', type: 'boolean', editable: true,
          help: 'If off, PITCH stays in coaching-only mode and you get all the analytics + rewrites without any auto-send. You can flip this on later.' },
        { key: 'automation_mode', label: 'How aggressive should auto-send be?', type: 'select', editable: true,
          showIf: { automation_enabled: true },
          options: [
            { value: 'review_first', label: 'Human-review-first — PITCH drafts every email and waits for your approve/edit/decline before sending (recommended for first 30 days)' },
            { value: 'auto_send_low', label: 'Auto-send conservative — sends opener + 2 follow-ups, then hands off to a human for replies' },
            { value: 'auto_send_full', label: 'Auto-send aggressive — sends full sequence including reply handling on the safe-pattern responses (price, timing, "not the right person")' },
          ] },
        { key: 'daily_send_cap_per_mailbox', label: 'Max outbound emails per day, per mailbox', type: 'number', editable: true,
          showIf: { automation_enabled: true },
          help: 'Default: 50. Most cold-email tools recommend ≤80/day per mailbox to avoid spam triggers. Higher = faster; lower = safer for deliverability.' },
        { key: 'send_window_local', label: 'Send window (in your local time)', type: 'select', editable: true,
          showIf: { automation_enabled: true },
          options: [
            { value: '9_to_5', label: '9am – 5pm (recommended)' },
            { value: '8_to_6', label: '8am – 6pm (wider)' },
            { value: '7_to_4', label: '7am – 4pm (early)' },
            { value: '11_to_3', label: '11am – 3pm (tight, deliverability-safe)' },
          ] },
        { key: 'auto_reply_safe_patterns', label: 'Reply patterns PITCH may answer without asking', type: 'multi-select', editable: true,
          showIf_and: { automation_enabled: true, automation_mode: 'auto_send_full' },
          options: [
            { value: 'oop', label: 'Out-of-office bounces (queue retry)' },
            { value: 'wrong_person', label: '"Wrong person, talk to X"' },
            { value: 'send_more_info', label: '"Send me more info"' },
            { value: 'follow_up_later', label: '"Not now, follow up in N weeks"' },
            { value: 'unsubscribe_request', label: 'Unsubscribe / opt-out requests (auto-process always)' },
          ],
          help: 'Anything not on this list gets escalated to a human.' },
        { key: 'always_escalate_keywords', label: 'Reply phrases that ALWAYS escalate to a human (one per line)', type: 'textarea', editable: true,
          showIf: { automation_enabled: true },
          help: 'Default: "lawyer", "legal", "complaint", "lawsuit", "fraud", "scam". Add anything specific to your business.' },
        { key: 'dnc_list_url', label: 'URL or doc with your existing Do-Not-Contact list', type: 'text', editable: true,
          showIf: { automation_enabled: true },
          help: 'Optional. PITCH ingests this before the first send and never emails anyone on it.' },
        { key: 'automation_consent', label: 'I have authority to send outbound email from these mailboxes on behalf of this business', type: 'boolean', required: true,
          showIf: { automation_enabled: true },
          help: 'Required by law (CAN-SPAM in the US, similar elsewhere). PITCH will not auto-send without this checked.' },
        ]},

      // Step 7: Review & go live ──────────────────────────────────────
      { step: 7, blocking: true,
        tutorial: 'STILO partner reviews your baseline within 1 business day: scoreboard sanity check, source pull verification, and a sample script rewrite to confirm tone. You will receive an email when PITCH is fully active.',
        fields: [
        { key: 'review_summary', label: 'Final checklist', type: 'final-review', editable: false,
          checks: [
            { key: 'sales_motion', label: 'Sales motion defined' },
            { key: 'biggest_sales_question', label: 'Strategic question set' },
            { key: 'source_connection_test', label: 'Sources connected' },
            { key: 'sales_reps', label: 'Reps added' },
            { key: 'lost_deal_reasons', label: 'Lost-deal reasons captured' },
            { key: 'rep_scorecard_frequency', label: 'Coaching cadence chosen' },
          ] },
        { key: 'baseline_review_acknowledged', label: 'I understand STILO will analyze the first 7 days of calls/emails to build a baseline before recommendations flow', type: 'boolean', required: true },
        { key: 'ready_for_review', label: 'I am ready for STILO to activate PITCH', type: 'boolean', required: true },
        { key: 'submit_for_review_button', label: 'Submit for STILO review', type: 'review-submit-button',
          target: '/api/agents-submit-for-review' },
      ]},

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
  profile: 'business_profile',
  business: 'business_profile',
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
  sales: 'pitch',
  'sales-coach': 'pitch',
  sales_coach: 'pitch',
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

// ──────────────────────────────────────────────────────────────────────────
// Business Profile completion check.
//
// `business_profile` gates every other agent's wizard. We consider it "active"
// once the client has filled the first 4 steps in full plus the consent box on
// step 7. Steps 5/6/8 (KB, logo, payment systems) can be partial — they're
// per-agent enrichment that the relevant agent's wizard can also gather.
//
// Returns { active: bool, complete_pct: 0-100, missing_required: [...] }.
// Used by ensure-business-profile + the dashboard lock overlay.
// ──────────────────────────────────────────────────────────────────────────
function evaluateBusinessProfile(config) {
  config = config || {};
  // Step-by-step required keys (must be non-empty / true for booleans).
  // Mirrors the `required: true` flags in BUSINESS_PROFILE_SCHEMA above.
  var REQUIRED_BY_STEP = {
    1: ['business_legal_name', 'owner_first_name', 'owner_last_name', 'owner_cell',
        'owner_email', 'main_business_phone', 'street_address', 'city', 'state', 'zip', 'timezone'],
    2: ['niche', 'top_services'],
    3: ['after_hours_default'],
    4: ['tone'],
    5: ['top_questions', 'top_objections'],
    7: ['state_of_operation', 'tcpa_consent_acknowledgment', 'owner_consent'],
  };
  var missing = [];
  var totalRequired = 0;
  var satisfied = 0;
  Object.keys(REQUIRED_BY_STEP).forEach(function(stepKey) {
    REQUIRED_BY_STEP[stepKey].forEach(function(key) {
      totalRequired++;
      var v = config[key];
      var ok;
      if (typeof v === 'boolean') ok = v === true;
      else if (Array.isArray(v)) ok = v.length > 0;
      else if (v && typeof v === 'object') ok = Object.keys(v).length > 0;
      else ok = v !== undefined && v !== null && String(v).trim() !== '';
      if (ok) satisfied++;
      else missing.push(key);
    });
  });
  var pct = totalRequired === 0 ? 100 : Math.round((satisfied / totalRequired) * 100);
  return {
    active: pct >= 80 && missing.indexOf('owner_consent') === -1 && missing.indexOf('tcpa_consent_acknowledgment') === -1,
    complete_pct: pct,
    missing_required: missing,
  };
}

module.exports = {
  AGENTS: AGENTS,
  NICHE_OPTIONS: NICHE_OPTIONS,
  US_STATE_OPTIONS: US_STATE_OPTIONS,
  TIMEZONE_OPTIONS: TIMEZONE_OPTIONS,
  LEGACY_ID_MAP: LEGACY_ID_MAP,
  normalizeAgentId: normalizeAgentId,
  calculateTotals: calculateTotals,
  evaluateBusinessProfile: evaluateBusinessProfile,
};
