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
      { step: 2, fields: [
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
        { key: 'office_phone', label: 'Office phone number', type: 'tel', editable: true,
          help: 'We use the area code as the default for your IGNITE outbound number.' },
        { key: 'agent_count', label: 'Number of agents on the team', type: 'number', editable: true },
        { key: 'service_area_zips', label: 'Service area zip codes (comma-separated)', type: 'text', editable: true,
          help: 'IGNITE uses these to recognize whether a lead is in your market.' },
      ]},

      // ── Step 3: Real Estate Playbook (real-estate only) ───────────
      { step: 3,
        tutorial: 'These answers shape how IGNITE qualifies real estate leads on the first call. It uses the LPMAMA framework: **Location** (zip codes you serve), **Price**, **Motivation** (timeline), **Agent** (already working with another?), **Mortgage** (pre-approved?), **Appointment** (book the showing).\n\nIf you only handle buyers, uncheck seller and investor below. IGNITE will politely decline leads outside your scope rather than waste their time and yours.\n\n**Pre-approval required**: if yes, IGNITE asks early in the call. If the lead is not pre-approved, IGNITE offers a lender referral instead of booking a showing. This saves your agents a ton of dead-end appointments.\n\n**Working with another agent disqualifier**: most brokerages set this to "soft-pitch private listing alerts" — IGNITE plants a seed about your private listing service without trying to steal the lead. If you set this to "disqualify, end the call", IGNITE thanks them and ends the call (cleanest, but you lose follow-up potential).\n\n**Service area zips**: paste the zip codes you actively serve (comma-separated). IGNITE recognizes when a lead is outside your market and politely refers them elsewhere.',
        fields: [
        { key: 'handle_buyer_leads', label: 'We handle buyer leads', type: 'boolean', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'handle_seller_leads', label: 'We handle seller leads (home valuations)', type: 'boolean', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'handle_investor_leads', label: 'We handle investor leads', type: 'boolean', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'price_range_min', label: 'Typical minimum price ($)', type: 'number', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'price_range_max', label: 'Typical maximum price ($)', type: 'number', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'pre_approval_required', label: 'Require pre-approval before showing', type: 'boolean', editable: true,
          help: 'If yes, IGNITE will ask early and offer a lender referral if not pre-approved.',
          showIf: { industry: 'real-estate' } },
        { key: 'working_with_other_agent_disqualifier', label: 'If lead is already working with another agent', type: 'select', editable: true,
          showIf: { industry: 'real-estate' },
          options: [
            { value: 'no', label: 'No problem, keep engaging' },
            { value: 'sometimes', label: 'Soft-pitch private listing alerts only' },
            { value: 'yes', label: 'Disqualify, end the call politely' },
          ],
        },
        { key: 'target_neighborhoods', label: 'Specialty neighborhoods (comma-separated)', type: 'text', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'disqualifying_zip_codes', label: 'Zip codes you do NOT serve (comma-separated)', type: 'text', editable: true,
          showIf: { industry: 'real-estate' } },
        { key: 'industry_step_skip_notice', label: 'This step is for real estate brokerages. You can skip it.', type: 'static-note',
          showIf: { industry_not: 'real-estate' } },
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
          target: '/api/oauth/google-calendar/start' },
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
