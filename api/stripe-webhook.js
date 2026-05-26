/**
 * POST /api/stripe-webhook
 *
 * Handles Stripe events for multi-agent bundle purchases.
 *
 * On checkout.session.completed:
 *   1. Read `selected_agents` (comma-separated codes) from session metadata
 *   2. Create one client_agents row per agent, each with status="onboarding"
 *   3. Create the per-agent onboarding_steps for each
 *   4. If client_id was passed, link to existing Supabase user; otherwise
 *      just log — the client will sign up on dashboard and get linked via
 *      customer_email match later.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { AGENTS, normalizeAgentId } = require('./_agents');

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return null;
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Failed to read raw webhook body:', err);
    return res.status(400).send('Webhook Error: could not read body');
  }

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;
      default:
        console.log('Unhandled event type:', event.type);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Still 200 so Stripe doesn't retry forever; log for investigation
  }

  res.status(200).json({ received: true });
};

// Try every matching strategy in order: stripe_checkout_session_id (exact),
// then business_name (case-insensitive), then phone (digits only), then email.
// Returns the deal row or null. The order matches the design doc — business
// name survives the most common identity drift (personal Gmail at checkout).
async function findDealForSession(supabase, session) {
  const md = session.metadata || {};

  // 1. Explicit deal_id passed in metadata (new admin flow puts it there)
  if (md.deal_id) {
    const { data } = await supabase.from('deals').select('*').eq('id', md.deal_id).maybeSingle();
    if (data) return { deal: data, matchedBy: 'deal_id_metadata' };
  }

  // 2. Stripe checkout session id snapshot (admin Close Deal flow sets this)
  const { data: bySession } = await supabase
    .from('deals')
    .select('*')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();
  if (bySession) return { deal: bySession, matchedBy: 'stripe_session_id' };

  // 3. business_name (admin Close Deal stores this canonically)
  const bizName = md.business_name || '';
  if (bizName) {
    const { data: byBiz } = await supabase
      .from('deals')
      .select('*')
      .ilike('business_name', bizName)
      .order('closed_at', { ascending: false })
      .limit(1);
    if (byBiz && byBiz[0]) return { deal: byBiz[0], matchedBy: 'business_name' };
  }

  // 4. phone (digits only, last 10)
  const rawPhone = md.phone || (session.customer_details && session.customer_details.phone) || '';
  const phoneDigits = String(rawPhone).replace(/\D/g, '').slice(-10);
  if (phoneDigits.length >= 7) {
    const { data: byPhone } = await supabase
      .from('deals')
      .select('*')
      .ilike('contact_phone', '%' + phoneDigits + '%')
      .order('closed_at', { ascending: false })
      .limit(1);
    if (byPhone && byPhone[0]) return { deal: byPhone[0], matchedBy: 'phone' };
  }

  // 5. email (least reliable — prospect often uses personal Gmail at checkout)
  const customerEmail = (session.customer_details && session.customer_details.email)
    || session.customer_email || md.contact_email || null;
  if (customerEmail) {
    const { data: byEmail } = await supabase
      .from('deals')
      .select('*')
      .ilike('contact_email', customerEmail)
      .order('closed_at', { ascending: false })
      .limit(1);
    if (byEmail && byEmail[0]) return { deal: byEmail[0], matchedBy: 'email' };
  }

  return { deal: null, matchedBy: null };
}

async function handleCheckoutComplete(session) {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(
      '[stripe-webhook] Supabase not configured, logging only. Selected agents:',
      session.metadata && session.metadata.selected_agents
    );
    return;
  }

  // ── New flow: admin Close Deal created a deal row first. Find it and mark it paid.
  const { deal, matchedBy } = await findDealForSession(supabase, session);
  if (deal) {
    console.log('[stripe-webhook] deal matched via %s for session %s (deal=%s)', matchedBy, session.id, deal.id);
    try {
      const { provisionFromDeal } = require('./admin/deals/mark-paid');
      await provisionFromDeal(supabase, {
        ...deal,
        stripe_customer_id: session.customer || deal.stripe_customer_id,
        stripe_subscription_id: session.subscription || deal.stripe_subscription_id
      }, new Date().toISOString());
      await supabase.from('deal_events').insert({
        deal_id: deal.id,
        event_type: 'payment_received',
        body: 'Stripe checkout completed (matched by ' + matchedBy + ')',
        actor_role: 'system'
      });
      return;
    } catch (e) {
      console.error('[stripe-webhook] deal provisioning failed:', e);
      // Fall through to legacy flow as belt-and-suspenders
    }
  }

  // ── Legacy fallback: no deal row exists (old direct-checkout link from before
  //    the admin Close Deal flow). Provision agents the old way + log a warning
  //    so the admin sees an orphan in the Activity feed.
  console.warn('[stripe-webhook] no deal row matched session %s, using legacy path', session.id);

  const md = session.metadata || {};
  const rawCodes = (md.selected_agents || md.agent_type || '').split(',');
  const agentCodes = rawCodes
    .map(function (c) { return normalizeAgentId(c.trim()); })
    .filter(function (c) { return !!c && AGENTS[c]; });

  if (agentCodes.length === 0) {
    console.error('Checkout session has no valid agents in metadata', md);
    return;
  }

  // Idempotency: if we've already processed this session, bail out.
  // Stripe may resend events; we must not duplicate client_agents rows.
  const { data: existingForSession } = await supabase
    .from('client_agents')
    .select('id')
    .contains('config', { stripe_session_id: session.id })
    .limit(1);
  if (existingForSession && existingForSession.length > 0) {
    console.log('[stripe-webhook] Session %s already processed, skipping', session.id);
    return;
  }

  const clientId = md.client_id || null;
  const customerEmail =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    null;

  // If we don't have a client_id, try to find one by email. If no match,
  // invite the user and link on signup via the handle_new_user trigger.
  let linkedClientId = clientId;
  if (!linkedClientId && customerEmail) {
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .eq('email', customerEmail)
      .maybeSingle();
    if (existing) linkedClientId = existing.id;
  }

  if (!linkedClientId) {
    if (!customerEmail) {
      console.error('[stripe-webhook] No email and no client_id — cannot provision. session=%s', session.id);
      return;
    }
    const siteUrl = process.env.SITE_URL || 'https://stiloaipartners.com';
    const { data: invite, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
      customerEmail,
      {
        redirectTo: siteUrl + '/app/',
        data: {
          business_name: md.business_name || '',
          contact_name: md.contact_name || '',
        },
      }
    );
    if (inviteErr) {
      console.error('[stripe-webhook] Failed to invite user %s: %s session=%s', customerEmail, inviteErr.message, session.id);
      return;
    }
    linkedClientId = invite.user.id;
    // The on_auth_user_created trigger creates the clients row.
    // Update phone since the trigger doesn't set it.
    if (md.phone) {
      await supabase.from('clients').update({ phone: md.phone }).eq('id', linkedClientId);
    }
    console.log('[stripe-webhook] Invited new user %s (id=%s) for session %s', customerEmail, linkedClientId, session.id);
  }

  // Make sure the Business Profile pseudo-agent exists for this client BEFORE
  // we seed paid agents. The dashboard auto-creates it on first login too,
  // but seeding it here means the gate is in place even if the client gets
  // their welcome email and clicks straight to a paid agent's setup.
  try {
    const { data: existingProfile } = await supabase
      .from('client_agents')
      .select('id')
      .eq('client_id', linkedClientId)
      .eq('agent_type', 'business_profile')
      .maybeSingle();
    if (!existingProfile) {
      const profileMeta = AGENTS.business_profile;
      const { data: bp } = await supabase
        .from('client_agents')
        .insert({
          client_id: linkedClientId,
          agent_type: 'business_profile',
          status: 'onboarding',
          stripe_subscription_id: null,
          config: {},
        })
        .select('id')
        .single();
      if (bp && profileMeta && profileMeta.onboardingSteps) {
        const profileSteps = profileMeta.onboardingSteps.map(function (name, idx) {
          return {
            client_agent_id: bp.id,
            step_number: idx + 1,
            step_name: name,
            status: idx === 0 ? 'in_progress' : 'pending',
            data: { response_data: {} },
          };
        });
        await supabase.from('onboarding_steps').insert(profileSteps);
      }
    }
  } catch (e) {
    console.warn('[stripe-webhook] could not seed business_profile:', e.message);
  }

  // Create one client_agents row per paid agent
  const rows = agentCodes.map(function (code) {
    return {
      client_id: linkedClientId,
      agent_type: code,
      status: 'onboarding',
      stripe_subscription_id: session.subscription || null,
      config: {
        stripe_session_id: session.id,
        amount_total_cents: session.amount_total || 0,
      },
    };
  });

  const { data: inserted, error: insertErr } = await supabase
    .from('client_agents')
    .insert(rows)
    .select();

  if (insertErr) {
    console.error('Error creating client_agents rows:', insertErr);
    return;
  }

  // Build onboarding_steps for every newly-created agent
  const stepRows = [];
  for (const row of inserted) {
    const agent = AGENTS[row.agent_type];
    if (!agent) continue;
    agent.onboardingSteps.forEach(function (name, index) {
      stepRows.push({
        client_agent_id: row.id,
        step_number: index + 1,
        step_name: name,
        status: index === 0 ? 'in_progress' : 'pending',
      });
    });
  }

  if (stepRows.length > 0) {
    const { error: stepsErr } = await supabase
      .from('onboarding_steps')
      .insert(stepRows);
    if (stepsErr) console.error('Error creating onboarding_steps:', stepsErr);
  }

  // Flip client to active status
  await supabase
    .from('clients')
    .update({ status: 'active' })
    .eq('id', linkedClientId);

  // ---------------------------------------------------------------------
  // SDR commission attribution
  // ---------------------------------------------------------------------
  // If this customer's email matches a prospecting lead that's currently
  // assigned to an active SDR, create a client_attribution row so that SDR
  // gets credit (and their commission_pct snapshot is locked in).
  // Idempotent: skips if an attribution row already exists for this client.
  try {
    const { data: existingAttr } = await supabase
      .from('client_attribution')
      .select('id')
      .eq('client_id', linkedClientId)
      .eq('role', 'primary')
      .maybeSingle();

    if (!existingAttr && customerEmail) {
      // Find the lead matching this email. prospecting.leads has owner_email
      // and is_assigned_to columns. We match on lower(owner_email)=email.
      const pSb = getSupabase();
      const { data: matchedLead } = await pSb
        .schema('prospecting')
        .from('leads')
        .select('id, assigned_to')
        .ilike('owner_email', customerEmail)
        .maybeSingle();

      const ownerEmail = matchedLead && matchedLead.assigned_to;
      if (ownerEmail) {
        const { data: sdr } = await supabase
          .from('sdr_users')
          .select('id, commission_pct')
          .eq('email', ownerEmail.toLowerCase())
          .eq('active', true)
          .maybeSingle();

        if (sdr) {
          // Compute upfront + monthly from the session
          const upfrontCents = session.amount_total || 0;
          // Best-effort: read the first line item's recurring amount for monthly.
          // Stripe doesn't include this on the session by default, so we rely on
          // metadata.monthly_retainer_cents from the checkout-session creator.
          const monthlyCents = parseInt(md.monthly_retainer_cents || '0', 10) || 0;

          await supabase.from('client_attribution').insert({
            client_id: linkedClientId,
            sdr_id: sdr.id,
            source_lead_id: matchedLead.id,
            role: 'primary',
            upfront_fee_cents: upfrontCents,
            monthly_retainer_cents: monthlyCents,
            commission_pct: sdr.commission_pct,
            payout_status: 'pending',
            stripe_customer_id: session.customer || null,
            stripe_subscription_id: session.subscription || null,
            notes: 'Auto-attributed from prospecting.leads.assigned_to'
          });
          console.log('[stripe-webhook] Attributed client %s to SDR %s (lead %s)',
            linkedClientId, sdr.id, matchedLead.id);
        }
      }
    }
  } catch (e) {
    // Attribution is best-effort — never block the main provisioning path.
    console.warn('[stripe-webhook] attribution failed:', e.message);
  }

  console.log(
    '[stripe-webhook] Provisioned %d agents for client %s: %s',
    inserted.length,
    linkedClientId,
    agentCodes.join(',')
  );
}

async function handleSubscriptionUpdate(subscription) {
  const supabase = getSupabase();
  if (!supabase) return;

  // Only react to billing-problem transitions. Do NOT flip to 'active' here:
  // Stripe marks a subscription active immediately after checkout, but an
  // agent is only truly 'active' once its onboarding_steps are all complete.
  // That transition is owned by the onboarding flow, not by billing state.
  const s = subscription.status;
  let nextStatus = null;
  if (s === 'past_due' || s === 'unpaid' || s === 'paused') nextStatus = 'paused';
  else if (s === 'canceled') nextStatus = 'cancelled';

  if (!nextStatus) return;

  const { error } = await supabase
    .from('client_agents')
    .update({ status: nextStatus })
    .eq('stripe_subscription_id', subscription.id)
    .in('status', ['active', 'onboarding']);
  if (error) console.error('Error updating subscription:', error);
}

async function handleSubscriptionCancelled(subscription) {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from('client_agents')
    .update({ status: 'cancelled' })
    .eq('stripe_subscription_id', subscription.id);
  if (error) console.error('Error cancelling subscription:', error);
}

// Vercel's default body parser mutates the request body into a parsed JSON
// object, which breaks Stripe signature verification: the HMAC is computed
// over the raw bytes Stripe sent, not the re-serialized JSON. Disable the
// parser so our handler can read the raw request stream.
module.exports.config = {
  api: { bodyParser: false },
};
