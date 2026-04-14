/**
 * Stripe Webhook Handler
 *
 * This handles Stripe webhook events for payment confirmation.
 * Deploy as a serverless function (Vercel, Netlify, or standalone Express).
 *
 * Setup:
 * 1. npm install stripe @supabase/supabase-js
 * 2. Set environment variables: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
 * 3. Register webhook URL in Stripe Dashboard > Webhooks
 * 4. Subscribe to events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key for admin access
);

// Agent type to readable name mapping
const AGENT_NAMES = {
  receptionist: 'AI Receptionist',
  lead_reply: 'Lead Response Agent',
  lcr: 'Customer Reactivation (LCR)',
  website: 'AI Website',
  seo: 'AI SEO (GEO)',
  ontology: 'Growth Intelligence',
  lead_gen: 'Lead Generator',
  custom: 'Custom Automation'
};

// Onboarding steps per agent type
const ONBOARDING_STEPS = {
  receptionist: [
    'Business info',
    'Services & pricing',
    'Business hours',
    'Booking system connection',
    'Phone setup',
    'Voice personality',
    'Review & activate'
  ],
  lcr: [
    'Upload customer database',
    'Map columns',
    'Set win-back offers',
    'Email sender config',
    'Review segments',
    'Launch'
  ],
  lead_reply: [
    'Business info',
    'Lead sources',
    'Current offers',
    'Response preferences',
    'Review & activate'
  ],
  website: [
    'Business info',
    'Design preferences',
    'Content requirements',
    'Review & approve'
  ],
  seo: [
    'Website audit',
    'Keyword targets',
    'Review & implement'
  ],
  ontology: [
    'Data source mapping',
    'KPI selection',
    'Reporting cadence',
    'Baseline analysis',
    'Review & activate'
  ],
  lead_gen: [
    'Target criteria',
    'Outreach preferences',
    'Email setup',
    'Review & launch'
  ],
  custom: [
    'Requirements gathering',
    'Solution design',
    'Build & test',
    'Review & deploy'
  ]
};

async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

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

  res.status(200).json({ received: true });
}

async function handleCheckoutComplete(session) {
  const clientId = session.metadata.client_id;
  const agentType = session.metadata.agent_type;

  if (!clientId || !agentType) {
    console.error('Missing metadata in checkout session');
    return;
  }

  // Create the agent record
  const { data: agent, error: agentError } = await supabase
    .from('client_agents')
    .insert({
      client_id: clientId,
      agent_type: agentType,
      status: 'onboarding',
      stripe_subscription_id: session.subscription || null
    })
    .select()
    .single();

  if (agentError) {
    console.error('Error creating agent:', agentError);
    return;
  }

  // Create onboarding steps
  const steps = ONBOARDING_STEPS[agentType] || ONBOARDING_STEPS.custom;
  const stepRecords = steps.map(function(name, index) {
    return {
      client_agent_id: agent.id,
      step_number: index + 1,
      step_name: name,
      status: index === 0 ? 'in_progress' : 'pending'
    };
  });

  const { error: stepsError } = await supabase
    .from('onboarding_steps')
    .insert(stepRecords);

  if (stepsError) {
    console.error('Error creating onboarding steps:', stepsError);
  }

  // Activate client status
  await supabase
    .from('clients')
    .update({ status: 'active' })
    .eq('id', clientId);

  console.log('Agent ' + agentType + ' created for client ' + clientId);
}

async function handleSubscriptionUpdate(subscription) {
  const { error } = await supabase
    .from('client_agents')
    .update({
      status: subscription.status === 'active' ? 'active' : 'paused'
    })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    console.error('Error updating subscription:', error);
  }
}

async function handleSubscriptionCancelled(subscription) {
  const { error } = await supabase
    .from('client_agents')
    .update({ status: 'cancelled' })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    console.error('Error cancelling subscription:', error);
  }
}

module.exports = handleWebhook;
