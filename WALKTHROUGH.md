# STILO AI Partners — Beginner Walkthrough

You don't need to be a coder. Do one section at a time. Total time: about 90 minutes. Keep this document open and check boxes as you go.

---

## What we're doing, in plain English

Your website needs 3 services wired together:

1. **Supabase** — the database that stores your clients and which agents they bought. (Already set up.)
2. **Stripe** — the company that processes payments. We use their "hosted checkout" which means when a customer clicks "Proceed to Checkout", they get sent to a Stripe page to enter their card, then sent back to your site.
3. **Vercel** — the server that runs your website. It needs to know your Supabase and Stripe credentials (called "environment variables" or "env vars").

The word **env var** just means "a secret string your server needs, stored in a safe place, not in the code". Every env var is a Name and a Value. Example:
- Name: `STRIPE_SECRET_KEY`
- Value: `sk_test_51Abc...`

That's it. You copy values from Stripe/Supabase and paste them into Vercel. No coding.

---

## Part 1. Get your Supabase keys (5 minutes)

Supabase is already set up. You just need to grab 3 strings from it.

1. Open https://supabase.com/dashboard
2. Click on the project named **stilo-ai-partners**
3. In the left sidebar, click the **gear icon** near the bottom (Settings)
4. Under Settings, click **API**
5. You will see 3 things we need. Keep this tab open.

### The 3 values

| Label on the page | What we call it | Example |
|---|---|---|
| Project URL | `SUPABASE_URL` | `https://zsrskphpvgautfgklgxf.supabase.co` |
| `anon` `public` key (under "Project API keys") | `SUPABASE_ANON_KEY` | starts with `eyJ...` |
| `service_role` `secret` key | `SUPABASE_SERVICE_KEY` | starts with `eyJ...` |

To copy the `service_role` key you may need to click "Reveal" first. Treat it like a password, anyone with it can read and write your whole database.

**You don't need to paste these anywhere yet**. Just make sure you can find them. We'll paste them into Vercel later.

---

## Part 2. Create a Stripe account (10 minutes)

1. Go to https://stripe.com
2. Click **Start now** (top right)
3. Fill in: email, full name, country = United States, password
4. It will ask for business details. You can use:
   - Business name: **STILO AI Partners**
   - Industry: **Software**
   - Website: **stiloaipartners.com**
5. Finish signup. Verify your email.

After signup, you land on the Stripe Dashboard. You'll see a sidebar with **Home, Balances, Transactions, Customers, Products**, etc.

### Turn on Test Mode (important!)

Look at the **top right** of the Stripe dashboard. You'll see a toggle that says either **Test mode** or a small black/orange switch. Click it so it shows **Test mode** (the Stripe dashboard will turn slightly orange at the top to remind you).

**Until you're ready to take real money, stay in Test mode.** Everything you do now will be in the test universe. No real cards, no real money.

---

## Part 3. Create your 7 products in Stripe (30 minutes)

This is the longest part. You're going to create 7 "products" (one per agent you sell). Each product gets 1 or 2 "prices" (a setup fee, and a monthly fee where applicable).

### Open the products page

1. In the Stripe dashboard (still in Test mode), click **Product catalog** in the left sidebar. If you don't see it, click **More** first, then **Product catalog**.
2. Click the blue **+ Create product** button (top right).

### Create product 1: ECHO — AI Receptionist

A new form appears. Fill it in like this:

- **Name**: `ECHO — AI Receptionist`
- **Description**: `24/7 voice agent that answers, books, and captures every call.`
- **Image**: skip

Scroll down to the **Pricing** section. Stripe pre-creates one price. We need TWO prices, so:

**Price 1 (one-time setup fee):**
- Pricing model: **One-time**
- Price: `1500.00` USD
- Click **Add another price** underneath to add a second price.

**Price 2 (monthly recurring):**
- Pricing model: **Recurring**
- Billing period: **Monthly**
- Price: `450.00` USD

Click **Add product** (bottom right).

After creation, Stripe shows you the product page with the 2 prices listed. Each price has an ID that starts with `price_...`. Click the `...` menu next to each price and click **Copy price ID**, or just click on the price row to see the ID and copy it.

**Write both price IDs down somewhere (a note, a Google Doc, anywhere):**

```
ECHO setup price ID:   price_1TMttw0BxnILdaJWA1aQNx0k
ECHO monthly price ID:  price_1TMttw0BxnILdaJWVIjqcPbc
```

### Create products 2-7 the same way

Use this table. For each row, create a product, add 2 prices (one-time setup + recurring monthly), and save the 2 price IDs.

| Product name                     | Setup (one-time) | Monthly (recurring) |
|----------------------------------|-----------------:|--------------------:|
| IGNITE — Lead Response           |         2000.00  |             650.00  |
| REVIVE — Customer Reactivation   |         2500.00  |             800.00  |
| SCOUT — Lead Generator           |         2500.00  |            1000.00  |
| FORGE — AI Website               |         1250.00  |             200.00  |
| ORACLE — Growth Intelligence     |         3000.00  |            1000.00  |

### Special case: SIGNAL

SIGNAL is a one-time purchase only, no monthly. Create it with ONE price:

- **Name**: `SIGNAL — AI SEO (GEO)`
- Price 1: **One-time**, `1000.00` USD
- (No second price)

### Special case: FLUX

FLUX is "consult-only" (no Stripe product). The website already prevents people from buying FLUX through checkout. **Skip FLUX entirely.**

### When you're done

You should have 13 price IDs total:
- 7 setup prices (one per agent except FLUX)
- 6 monthly prices (everyone except SIGNAL and FLUX)

Double-check them in a note file like this:

```
STRIPE_PRICE_ECHO_SETUP     = price_1TMttw0BxnILdaJWA1aQNx0k
STRIPE_PRICE_ECHO_MONTHLY   = price_1TMttw0BxnILdaJWVIjqcPbc
STRIPE_PRICE_IGNITE_SETUP   = price_1TMtwG0BxnILdaJWSEXWbI2m
STRIPE_PRICE_IGNITE_MONTHLY = price_1TMtwG0BxnILdaJWhN4k6DGj
STRIPE_PRICE_REVIVE_SETUP   = price_1TMtx40BxnILdaJWfEVEuFBg
STRIPE_PRICE_REVIVE_MONTHLY = price_1TMtxM0BxnILdaJW22YLLwfi
STRIPE_PRICE_SCOUT_SETUP    = price_1TMtyQ0BxnILdaJWE3pZ4qwf
STRIPE_PRICE_SCOUT_MONTHLY  = price_1TMtye0BxnILdaJWDghb4oHr
STRIPE_PRICE_FORGE_SETUP    = price_1TMu0i0BxnILdaJWKC0E80CX
STRIPE_PRICE_FORGE_MONTHLY  = price_1TMu0x0BxnILdaJW5g4S8PZl
STRIPE_PRICE_SIGNAL_SETUP   = price_1TMu2C0BxnILdaJW1SCWH0Je
STRIPE_PRICE_ORACLE_SETUP   = price_1TMu300BxnILdaJWQ8ZVnrjw
STRIPE_PRICE_ORACLE_MONTHLY = price_1TMu3n0BxnILdaJWkU7tkvl6
```

---

## Part 4. Get your Stripe API key (2 minutes)

1. In the Stripe dashboard, left sidebar, click **Developers** (you may need to click the 3-dot menu).
2. Click **API keys**.
3. You'll see two keys:
   - **Publishable key** (starts with `pk_test_...`): we don't need this since we use hosted checkout
   - **Secret key** (starts with `sk_test_...`): this is `STRIPE_SECRET_KEY`

Click **Reveal test key** or the eye icon next to the secret key, then **copy** it. Save it with your other notes.

```
STRIPE_SECRET_KEY = sk_test_...  (paste your key here, never commit it)
```

**Never share your secret key** and never paste it into a chat or email. Treat it like a password.

---

## Part 5. Set up the Stripe webhook (10 minutes)

A "webhook" is how Stripe tells your server that a payment succeeded. Your server then creates the client's database rows and activates their agents.

We'll create the webhook AFTER deploying to Vercel (Part 7), because we need a live URL. But to be thorough, here's how it works so you know what's coming:

- After your site is live at stiloaipartners.com, you'll go to Stripe → Developers → Webhooks → Add endpoint
- URL = `https://stiloaipartners.com/api/stripe-webhook`
- Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- Stripe gives you a "signing secret" starting with `whsec_...`
- You paste that secret into Vercel as `STRIPE_WEBHOOK_SECRET`

We'll do this in Part 7 below.

---

## Part 6. Set up Vercel and paste everything in (20 minutes)

Vercel is the service that hosts your website and runs the backend code in `api/`. It reads your GitHub repo, deploys it, and re-deploys every time you push new code.

### 6a. Sign up and connect your repo

1. Go to https://vercel.com
2. Sign up with your **GitHub account**. This gives Vercel permission to read your repos.
3. On the Vercel dashboard, click **Add New... → Project**.
4. Vercel shows a list of your GitHub repos. Find **stilo-ai-website** and click **Import**.
5. On the configuration screen:
   - Framework Preset: **Other** (Vercel auto-detects plain HTML)
   - Root Directory: leave as **./**
   - Build Command: leave empty
   - Output Directory: leave empty
   - Install Command: Vercel will run `npm install` automatically because of `package.json`. Leave it.
6. **Don't click Deploy yet.** Scroll down to **Environment Variables**.

### 6b. Paste your env vars

In the Environment Variables section, you'll add each of these. For each one, type the **Name** on the left and the **Value** on the right, then click **Add**.

```
SITE_URL                      = https://stiloaipartners.com
STRIPE_SECRET_KEY             = sk_test_... (from Part 4)
STRIPE_WEBHOOK_SECRET         = placeholder-will-fill-in-part-7

STRIPE_PRICE_ECHO_SETUP       = price_... (from your notes)
STRIPE_PRICE_ECHO_MONTHLY     = price_...
STRIPE_PRICE_IGNITE_SETUP     = price_...
STRIPE_PRICE_IGNITE_MONTHLY   = price_...
STRIPE_PRICE_REVIVE_SETUP     = price_...
STRIPE_PRICE_REVIVE_MONTHLY   = price_...
STRIPE_PRICE_SCOUT_SETUP      = price_...
STRIPE_PRICE_SCOUT_MONTHLY    = price_...
STRIPE_PRICE_FORGE_SETUP      = price_...
STRIPE_PRICE_FORGE_MONTHLY    = price_...
STRIPE_PRICE_SIGNAL_SETUP     = price_...
STRIPE_PRICE_ORACLE_SETUP     = price_...
STRIPE_PRICE_ORACLE_MONTHLY   = price_...

SUPABASE_URL                  = https://zsrskphpvgautfgklgxf.supabase.co
SUPABASE_ANON_KEY             = eyJ... (from Part 1)
SUPABASE_SERVICE_KEY          = eyJ... (from Part 1)
```

That's **17 env vars**. Yes, it's tedious. Just power through it.

Tip: for each one, pick **All environments** (or check Production, Preview, Development) so they're available everywhere.

### 6c. Deploy

Click the big **Deploy** button. Vercel will:
- Install dependencies (stripe, @supabase/supabase-js)
- Upload your site
- Give you a live URL

In ~60 seconds you'll see **Congratulations!** and a link like `https://stilo-ai-website-xxxx.vercel.app`. Click it and confirm your site loads.

### 6d. Point your domain at Vercel (if you haven't already)

If you already own `stiloaipartners.com`:

1. On the Vercel project, click **Settings** → **Domains**
2. Type `stiloaipartners.com` and click **Add**
3. Vercel tells you which DNS records to add at your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.). Add them.
4. Wait ~10 minutes for DNS to propagate, then refresh. Your site should now load at stiloaipartners.com.

---

## Part 7. Create the Stripe webhook (5 minutes)

Now that your site is live:

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. **Endpoint URL**: `https://stiloaipartners.com/api/stripe-webhook`
3. **Listen to events**: click **Select events**, then check these 3:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Click **Add endpoint**.
5. On the webhook's page, find **Signing secret**. Click **Reveal** and copy the `whsec_...` string.

### Update the placeholder env var

1. Vercel → your project → Settings → Environment Variables
2. Find `STRIPE_WEBHOOK_SECRET`, click the 3-dot menu → Edit
3. Paste the `whsec_...` value. Save.
4. **Redeploy**: go to the **Deployments** tab, find the latest deployment, click the 3-dot menu → **Redeploy**. This is required for env var changes to take effect.

---

## Part 8. Test the full flow as fake Planet Fitness (10 minutes)

1. Open https://stiloaipartners.com in your browser (incognito window is cleanest)
2. Scroll to the quiz and click to start
3. Fill in:
   - Name: Jessica Smith
   - Email: **use an email YOU can check** (your own Gmail or a plus-addressed variant like `yourname+pf@gmail.com`)
   - Phone: any
   - Business: Planet Fitness Miami
4. Click through the 10 quiz questions, picking any answers. Choose the highest-revenue option on the revenue question to trigger the "Partner" tier (all 7 agents pre-selected).
5. On the results screen, confirm the agent cards show (ECHO, IGNITE, REVIVE, SCOUT, FORGE, SIGNAL, ORACLE). FLUX should NOT be checked.
6. Click **Proceed to Checkout**.
7. Stripe's checkout page loads. Pay with:
   - Card number: `4242 4242 4242 4242`
   - Expiry: any future date (e.g. `12/30`)
   - CVC: any 3 digits (e.g. `123`)
   - ZIP: any 5 digits (e.g. `33101`)
8. After payment, you land on your dashboard page.

### Verify in Stripe

Stripe dashboard → **Payments** (while still in Test mode): you should see a successful payment.

Stripe dashboard → **Developers** → **Webhooks** → click your endpoint: you should see events firing with status 200 (green).

### Verify in Supabase

Supabase dashboard → **Table Editor**:

- **clients**: should have a row for Jessica (or be "parked" if Jessica hasn't signed up yet; check Vercel function logs)
- **client_agents**: should have 7 rows, one per agent, status = `onboarding`
- **onboarding_steps**: should have a bunch of rows, organized by agent

If the `clients` row is empty: that's because Jessica hasn't created a Supabase auth account. Have her sign up on `auth.html` with the same email. The schema's auto-trigger will then create the `clients` row, and you'll need to re-run the reconciliation (or manually link from the admin dashboard — we build that in Phase 4).

---

## You're done

If you got this far:
- Stripe is processing payments (in test mode, no real money)
- Your database fills with real client and agent records when someone buys
- Your webhook fires and provisions agents
- You can switch to live mode the same way when you're ready: toggle Stripe to live, create the products again with the same prices, copy the new `sk_live_...` secret, update Vercel env vars, redeploy.

---

## Troubleshooting cheat sheet

**Quiz loads but Proceed to Checkout does nothing.**
Open the browser console (right-click → Inspect → Console). Look for red errors. Most likely cause: a missing env var in Vercel. Check the Vercel function logs: Vercel → Deployments → latest → Functions → click `create-checkout-session` → Logs.

**Stripe checkout page shows "price ID not found".**
One of your `STRIPE_PRICE_*` env vars is wrong or points to a price ID from the other Stripe mode (live vs test). Check that every price ID was copied from Test mode products.

**Webhook shows status 400 or 500.**
The `STRIPE_WEBHOOK_SECRET` is wrong, or the webhook is pointed at the wrong URL. Check both.

**Nothing appears in Supabase tables after payment.**
Supabase service key is probably wrong. Go to Vercel logs for `stripe-webhook` and look for errors. The webhook logs a "Parked purchase" message if it can't find a matching client; that's expected if Jessica hasn't signed up yet.

**Where are the Vercel function logs?**
Vercel dashboard → your project → **Deployments** → click the latest deployment → **Functions** tab. Each API file (`create-checkout-session`, `stripe-webhook`) has its own log.

---

## What's next (after this works)

Once Part 8 is successful, you've completed **Iteration 1** of the plan. The next iterations are:
- **Iteration 2**: Magic-link auto-signin on the dashboard + dashboard shows purchased agents
- **Iteration 3**: Onboarding agent chat drives the client through setup
- **Iteration 4**: CEO watchdog starts hourly health checks on all active agents

Each of these is a separate build, not needed to start selling.
