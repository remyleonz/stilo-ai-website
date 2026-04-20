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

async function handleCheckoutComplete(session) {
  const supabase = getSupabase();
  if (!supabase) {
    console.warn(
      '[stripe-webhook] Supabase not configured, logging only. Selected agents:',
      session.metadata && session.metadata.selected_agents
    );
    return;
  }

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
        redirectTo: siteUrl + '/dashboard.html',
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

  // Create one client_agents row per agent
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
