/**
 * POST /api/agents-submit-for-review
 *
 * Client-facing submission. The client clicks this on Step 12 of the IGNITE
 * wizard. It does NOT provision the Retell agent. It flips the agent into a
 * `pending_admin_review` state. STILO Partners (admin) does a final pre-flight
 * check, then approves -> the existing /api/agents-provision endpoint runs.
 *
 * Body: { client_agent_id: uuid }
 *
 * Auth: Bearer access_token. Owner of the agent (or admin).
 *
 * What it does:
 *   1. Auth + ownership check.
 *   2. Validates the same blocking gates the provision endpoint enforces
 *      (compliance, CRM, calendar, test call). If any are missing, the wizard
 *      should not have allowed Submit, but we re-check defensively.
 *   3. Sets client_agents.status = 'pending_admin_review',
 *      stamps submitted_for_review_at + submitted_by_email.
 *   4. Returns { ok: true, status: 'pending_admin_review', message: ... }.
 *
 * The client dashboard then renders a "thank you, in review" state and
 * disables further wizard edits.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

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

function checkBlockingGates(config) {
  const missing = [];
  if (!config.compliance_confirmed) missing.push('compliance');
  const crm = (config.crm_choice || '').toLowerCase();
  if (crm && crm !== 'none' && !config.crm_test_passed) missing.push('crm_connection');
  const booking = (config.booking_method || '').toLowerCase();
  if (booking && booking !== 'manual_via_transfer' && !config.calendar_test_passed) {
    missing.push('calendar_connection');
  }
  if (!config.webhook_confirmed) missing.push('webhook');
  if (!config.test_call_passed) missing.push('test_call');
  if (!config.ready_for_review) missing.push('ready_for_review');
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
    const isAdmin = ADMIN_EMAILS.includes(callerEmail);

    const { data: agent, error: aErr } = await supa
      .from('client_agents')
      .select('id, client_id, agent_code, status, config, clients!inner(owner_user_id, business_name)')
      .eq('id', clientAgentId)
      .single();
    if (aErr || !agent) return res.status(404).json({ error: 'Agent not found' });

    if (!isAdmin) {
      if (agent.clients?.owner_user_id !== userData.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const config = agent.config || {};
    const missing = checkBlockingGates(config);
    if (missing.length) {
      return res.status(412).json({
        error: 'You still need to complete these steps before submitting',
        missing,
      });
    }

    if (agent.status === 'active' || agent.status === 'pending_admin_review') {
      return res.status(409).json({
        error: 'Agent is already ' + agent.status,
        status: agent.status,
      });
    }

    const newConfig = Object.assign({}, config, {
      submitted_for_review_at: new Date().toISOString(),
      submitted_by_email: callerEmail,
      config_version: (config.config_version || 0) + 1,
    });

    const { error: uErr } = await supa
      .from('client_agents')
      .update({
        status: 'pending_admin_review',
        config: newConfig,
      })
      .eq('id', clientAgentId);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({
      ok: true,
      status: 'pending_admin_review',
      business_name: agent.clients?.business_name || null,
      message: 'Submitted. STILO Partners will review your setup and email you when your Outbound Lead Reply is live.',
    });

  } catch (e) {
    console.error('submit-for-review error', e);
    return res.status(500).json({ error: e.message });
  }
};
