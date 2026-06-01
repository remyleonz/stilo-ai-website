/**
 * POST /api/agents-provision
 *
 * Admin-side approve-and-go-live trigger. Dispatches per-agent provisioning
 * handlers from `_provision-handlers.js`, then flips client_agents.status to
 * 'active' and stamps activation metadata.
 *
 * All handlers are idempotent — admin can re-approve to push updated config.
 *
 * Body: { client_agent_id: uuid }
 * Auth: Bearer access_token. Admin only.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Optional env (per-agent):
 *   STILO_PROVISIONER_URL, PROVISIONER_AUTH_TOKEN  (echo / ignite Retell flow)
 *   STILO_AGENT_ROOT                                (local-dev shell-out path)
 *   STILO_CLIENTS_DIR                               (write configs to disk)
 *   STILO_FORGE_QUEUE_DIR                           (forge deployment queue)
 *   PROSPECTING_API_URL, PROSPECTING_API_TOKEN     (scout)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN           (revive 10DLC)
 *   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD          (signal rank tracking)
 */

const { createClient } = require('@supabase/supabase-js');
const { HANDLERS } = require('./_provision-handlers');

const ADMIN_EMAILS = [
  'remyleon11@gmail.com',
  'stiloaiconsulting@gmail.com',
  'remyleon@stiloaipartners.com',
  'davidcoira@stiloaipartners.com',
];

function admin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8') || '{}';
  try { return JSON.parse(raw); } catch { return {}; }
}

// Per-agent blocking-gate check. Mirrors the wizard's `blocking: true` steps so
// admin can't accidentally approve an agent missing critical inputs. Each entry
// returns the list of UNSATISFIED gates.
function checkBlockingGates(agentType, config) {
  const missing = [];
  const safe = config || {};
  switch (agentType) {
    case 'echo':
      if (!safe.phone_strategy) missing.push('phone_strategy');
      if (safe.booking_method && safe.booking_method !== 'no_booking' && !safe.calendar_test_passed) missing.push('calendar_connection');
      if (safe.crm_choice && !['none','email_summary'].includes(safe.crm_choice) && !safe.crm_test_passed) missing.push('crm_connection');
      if (!safe.test_call_passed) missing.push('test_call');
      break;
    case 'ignite':
      if (!safe.compliance_confirmed) missing.push('compliance');
      if (safe.crm_choice && safe.crm_choice !== 'none' && !safe.crm_test_passed) missing.push('crm_connection');
      if (safe.booking_method && safe.booking_method !== 'manual_via_transfer' && !safe.calendar_test_passed) missing.push('calendar_connection');
      if (!safe.test_call_passed) missing.push('test_call');
      break;
    case 'revive':
      if (!safe.email_domain_verified) missing.push('email_domain_verified');
      if (!safe.tcpa_acknowledgment) missing.push('tcpa_acknowledgment');
      if (!safe.test_send_completed) missing.push('test_send');
      break;
    case 'scout':
      if (!safe.owner_email_rule_acknowledged) missing.push('owner_email_rule');
      break;
    case 'forge':
      if (!safe.domain_strategy) missing.push('domain_strategy');
      break;
    case 'signal':
      if (!safe.site_url) missing.push('site_url');
      break;
    case 'oracle':
      if (!safe.data_sources_minimum_check) missing.push('data_sources');
      break;
    case 'pitch':
      if (!safe.source_connection_test) missing.push('source_connection_test');
      if (!safe.consent_to_process_transcripts) missing.push('consent_to_process_transcripts');
      break;
    default:
      // business_profile, flux: handler refuses anyway
      break;
  }
  return missing;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = await readJsonBody(req);
    const clientAgentId = body.client_agent_id;
    if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });

    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: 'Missing bearer token' });

    const supa = admin();
    const { data: userData, error: userErr } = await supa.auth.getUser(auth);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
    const callerEmail = (userData.user.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(callerEmail)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { data: agent, error: aErr } = await supa
      .from('client_agents')
      .select('id, client_id, agent_type, status, config')
      .eq('id', clientAgentId)
      .single();
    if (aErr || !agent) return res.status(404).json({ error: 'Agent not found' });

    const handler = HANDLERS[agent.agent_type];
    if (!handler) {
      return res.status(400).json({ error: 'No provisioning handler for agent_type=' + agent.agent_type });
    }

    const config = agent.config || {};
    const missing = checkBlockingGates(agent.agent_type, config);
    if (missing.length) {
      return res.status(412).json({ error: 'Blocking gates not satisfied', missing });
    }

    // Pull the business profile + niche so handlers don't have to refetch
    const { data: profileRow } = await supa
      .from('client_agents')
      .select('config')
      .eq('client_id', agent.client_id)
      .eq('agent_type', 'business_profile')
      .maybeSingle();
    const profile = (profileRow && profileRow.config) || {};
    const niche = config.niche || profile.niche || 'general';

    // Run the handler
    let result;
    try {
      result = await handler.run({ supabase: supa, agent, config, profile, niche });
    } catch (e) {
      console.error('[agents-provision]', agent.agent_type, 'handler threw:', e);
      return res.status(502).json({ error: 'Provisioning failed: ' + e.message });
    }

    // Merge handler updates into config + flip status
    const newConfig = Object.assign({}, config, (result && result.updates) || {}, {
      provisioned: true,
      provisioned_at: new Date().toISOString(),
      provisioned_by: callerEmail,
      config_version: (config.config_version || 0) + 1,
    });

    await supa
      .from('client_agents')
      .update({
        config: newConfig,
        status: 'active',
        activated_at: new Date().toISOString(),
      })
      .eq('id', clientAgentId);

    return res.status(200).json({
      ok: true,
      client_agent_id: clientAgentId,
      agent_type: agent.agent_type,
      provisioned: !!(result && result.provisioned),
      updates: (result && result.updates) || {},
      human_review: (result && result.human_review) || null,
      // Backwards-compat fields (older admin UI checks these specifically)
      retell_agent_id: newConfig.retell_agent_id || null,
      phone_number: newConfig.phone_number || null,
      voice_id: newConfig.voice_id || null,
    });
  } catch (e) {
    console.error('provision error', e);
    return res.status(500).json({ error: e.message });
  }
};
