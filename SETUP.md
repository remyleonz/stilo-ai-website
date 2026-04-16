# STILO AI Partners — Site Setup

End-to-end setup for stiloaipartners.com: Stripe bundle checkout + Supabase client database + Vercel deployment. Follow the phases in order.

---

## 0. Prereqs

- Node 18+ (`node -v`)
- A Stripe account (test mode first)
- A Supabase project (free tier is fine)
- Vercel account with this repo linked
- The Stripe CLI installed locally for webhook testing (`brew install stripe/stripe-cli/stripe`)

---

## 1. Supabase

### 1a. Create the project

1. Go to https://supabase.com/dashboard, create a new project (region = closest to Miami, e.g. us-east-1).
2. Copy from Project Settings → API:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_ANON_KEY` (used client-side, safe to expose)
   - `SUPABASE_SERVICE_KEY` (service role, server-only, never ship to browser)

### 1b. Deploy the schema

```bash
# From sites/stilo-ai/
psql "<your supabase connection string>" -f api/schema.sql
```

Or: paste `api/schema.sql` into the Supabase SQL editor and run. This creates `clients`, `client_agents`, `onboarding_steps`, `agent_metrics`, `contracts`, plus RLS policies and the `handle_new_user()` auth trigger.

### 1c. Enable email auth

Authentication → Providers → Email: enable. Set "Confirm email" to off for the magic-link flow to work on first click, or on if you want double opt-in.

Authentication → URL Configuration:
- Site URL = `https://stiloaipartners.com`
- Redirect URLs = add `https://stiloaipartners.com/dashboard.html`, `http://localhost:8081/dashboard.html`

---

## 2. Stripe

### 2a. Create one Product per agent

In the Stripe dashboard (test mode), Products → Add product. Create one product for each of the 7 self-serve agents. For each product add the two prices below. FLUX is consult-only, no Stripe product needed.

| Agent   | Product name                   | Setup price (one-time) | Monthly price (recurring) |
|---------|--------------------------------|-----------------------:|--------------------------:|
| ECHO    | ECHO — AI Receptionist         |              $1,500.00 |                   $450.00 |
| IGNITE  | IGNITE — Lead Response         |              $2,000.00 |                   $650.00 |
| REVIVE  | REVIVE — Customer Reactivation |              $2,500.00 |                   $800.00 |
| SCOUT   | SCOUT — Lead Generator         |              $2,500.00 |                 $1,000.00 |
| FORGE   | FORGE — AI Website             |              $1,250.00 |                   $200.00 |
| SIGNAL  | SIGNAL — AI SEO (GEO)          |              $1,000.00 |             (none, skip)  |
| ORACLE  | ORACLE — Growth Intelligence   |              $3,000.00 |                 $1,000.00 |

Copy each `price_...` ID. You will need 13 of them (7 setup + 6 monthly; SIGNAL has no monthly).

### 2b. Keys

Developers → API keys: copy `STRIPE_SECRET_KEY` (starts with `sk_test_...`). You do NOT need the publishable key because we're using hosted Checkout.

### 2c. Webhook (local dev)

```bash
stripe listen --forward-to localhost:8081/api/stripe-webhook
```

Copy the `whsec_...` signing secret it prints. That's `STRIPE_WEBHOOK_SECRET` for local dev.

### 2d. Webhook (production)

Developers → Webhooks → Add endpoint:
- URL: `https://stiloaipartners.com/api/stripe-webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

Copy the production signing secret and set it as `STRIPE_WEBHOOK_SECRET` on Vercel.

---

## 3. Env vars

Create `.env` locally (this file is gitignored; never commit). Mirror the same vars in Vercel → Project → Settings → Environment Variables.

```
# Core
SITE_URL=http://localhost:8081

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Stripe price IDs (from step 2a)
STRIPE_PRICE_ECHO_SETUP=price_...
STRIPE_PRICE_ECHO_MONTHLY=price_...
STRIPE_PRICE_IGNITE_SETUP=price_...
STRIPE_PRICE_IGNITE_MONTHLY=price_...
STRIPE_PRICE_REVIVE_SETUP=price_...
STRIPE_PRICE_REVIVE_MONTHLY=price_...
STRIPE_PRICE_SCOUT_SETUP=price_...
STRIPE_PRICE_SCOUT_MONTHLY=price_...
STRIPE_PRICE_FORGE_SETUP=price_...
STRIPE_PRICE_FORGE_MONTHLY=price_...
STRIPE_PRICE_SIGNAL_SETUP=price_...
STRIPE_PRICE_ORACLE_SETUP=price_...
STRIPE_PRICE_ORACLE_MONTHLY=price_...

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
```

On Vercel set `SITE_URL=https://stiloaipartners.com`.

---

## 4. Local run

```bash
cd sites/stilo-ai
npm install
node serve.js
# in a second terminal:
stripe listen --forward-to localhost:8081/api/stripe-webhook
```

Open http://localhost:8081.

---

## 5. End-to-end test (fake Planet Fitness)

1. Open the site, scroll to "Find your AI team", complete the 10-question quiz as Jessica @ Planet Fitness Miami (email = a Stripe test inbox you control).
2. On the recommendation screen, make sure ECHO + IGNITE + SCOUT + SIGNAL are ticked.
3. Click **Proceed to Checkout**. You land on Stripe hosted Checkout.
4. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
5. You're redirected to `/dashboard.html?welcome=true&session_id=...`.
6. Check the terminal running `stripe listen`: a `checkout.session.completed` event fires.
7. In Supabase, verify:
   - `clients` row exists (linked by email via `handle_new_user()` when Jessica signs up, OR parked in the webhook logs until she does)
   - 4 `client_agents` rows, all `status=onboarding`
   - `onboarding_steps` rows for each agent (ECHO has 7, IGNITE has 5, SCOUT has 4, SIGNAL has 3)

If Jessica hasn't signed up yet (no Supabase auth user), the webhook logs `Parked purchase` and exits. She signs up via `auth.html` with the same email, `handle_new_user()` creates the `clients` row, and you re-run a reconciliation (future: admin-dashboard button).

---

## 6. Deploy to Vercel

```bash
vercel --prod
```

Serverless functions at `api/*.js` are auto-detected. The `vercel.json` already maps routes. Make sure every env var from step 3 is set in the Vercel dashboard for the production environment.

---

## 7. Things still TODO after this phase

- Magic-link auto-signin on `/dashboard.html` when arriving with `?session_id=...` (Phase 4 of the plan)
- Dashboard reads `client_agents` + `onboarding_steps` and renders the onboarding agent chat (Phase 5)
- Per-agent `/gather-requirements` + `/provision` skills (Phase 6)
- CEO watchdog scheduled job (Phase 7)
- `FLUX` consult-only flow: "Book a call" button that does NOT hit Stripe
- Bundle discount currently applies to the entire session including monthly fees; see comment in `api/create-checkout-session.js` if you want setup-only discount
