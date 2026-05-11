/**
 * POST /api/ensure-business-profile
 *
 * Idempotent: ensures the calling client has a `business_profile` row in
 * client_agents plus its 8 onboarding_steps rows. Run on every dashboard
 * load before fetching agent data so the Business Profile tile always shows
 * up first, even for clients who signed up before this migration.
 *
 * The Business Profile is a pseudo-agent: free, mandatory, gates the rest.
 * It uses the same client_agents + onboarding_steps tables as paid agents so
 * the existing wizard infrastructure handles it without changes.
 *
 * Body: {}
 * Auth: Bearer access_token (Supabase). The user's own row is created.
 *
 * Returns:
 *   {
 *     ok: true,
 *     created: bool,            // true on first run, false on re-runs
 *     client_agent_id: uuid,
 *     status: 'onboarding' | 'active',
 *     complete_pct: 0-100,
 *     missing_required: [...]
 *   }
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { AGENTS, evaluateBusinessProfile } = require('./_agents');

function admin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const sb = admin();
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  const userId = userData.user.id;

  // 1) Look for an existing business_profile row owned by this client.
  const { data: existing, error: existingErr } = await sb
    .from('client_agents')
    .select('id, status, config')
    .eq('client_id', userId)
    .eq('agent_type', 'business_profile')
    .maybeSingle();

  if (existingErr) {
    console.error('[ensure-business-profile] lookup failed:', existingErr.message);
    return res.status(500).json({ error: 'Profile lookup failed' });
  }

  const profileMeta = AGENTS.business_profile;
  if (!profileMeta) {
    return res.status(500).json({ error: 'Server missing business_profile schema' });
  }
  const stepNames = profileMeta.onboardingSteps || [];

  if (existing) {
    // Already exists. Compute current completion + return.
    const status = evaluateBusinessProfile(existing.config || {});
    return res.status(200).json({
      ok: true,
      created: false,
      client_agent_id: existing.id,
      status: existing.status,
      complete_pct: status.complete_pct,
      missing_required: status.missing_required,
      profile_active: status.active,
    });
  }

  // 2) Create the client_agents row.
  const { data: created, error: createErr } = await sb
    .from('client_agents')
    .insert({
      client_id: userId,
      agent_type: 'business_profile',
      status: 'onboarding',
      stripe_subscription_id: null, // free, no Stripe
      onboarding_progress: {},
      config: {},
    })
    .select('id')
    .single();

  if (createErr || !created) {
    console.error('[ensure-business-profile] insert failed:', createErr && createErr.message);
    return res.status(500).json({ error: 'Could not create profile' });
  }

  const clientAgentId = created.id;

  // 3) Seed the 8 onboarding_steps rows. The first is in_progress, the rest
  //    are pending. Mirrors how stripe-webhook seeds steps for paid agents.
  const steps = stepNames.map(function(name, idx) {
    return {
      client_agent_id: clientAgentId,
      step_number: idx + 1,
      step_name: name,
      status: idx === 0 ? 'in_progress' : 'pending',
      data: { response_data: {} },
    };
  });

  const { error: stepsErr } = await sb.from('onboarding_steps').insert(steps);
  if (stepsErr) {
    console.error('[ensure-business-profile] steps insert failed:', stepsErr.message);
    // Don't roll back the row; the wizard can still seed missing steps lazily.
  }

  return res.status(201).json({
    ok: true,
    created: true,
    client_agent_id: clientAgentId,
    status: 'onboarding',
    complete_pct: 0,
    missing_required: [],
    profile_active: false,
  });
};
