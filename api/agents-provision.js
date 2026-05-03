/**
 * POST /api/agents-provision
 *
 * Admin-side approve-and-go-live trigger. Re-runs the idempotent Python
 * provisioner (which is safe to call any number of times: it updates the
 * existing Retell agent in place if one exists, otherwise creates one) and
 * flips the client_agents row to status='active'.
 *
 * Most clients will already have a Retell agent provisioned by this point,
 * because /api/agents-test-call auto-provisions when the client first hits
 * Step 11. This endpoint exists for admin approval (final pre-flight pass)
 * and to push any final config changes the admin made.
 *
 * Body: { client_agent_id: uuid }
 *   - client_agent_id is the row in client_agents.
 *
 * Auth: Bearer access_token. Phase A: admin-only.
 *
 * What it does:
 *   1. Auth + admin check + agent lookup.
 *   2. Verifies the agent passed all blocking gates (compliance, CRM, calendar,
 *      test_call) at submission time.
 *   3. Calls the idempotent Python provisioner. Locally, shells out to
 *      `retell_agent_provisioner.py --setup outbound {slug}`. In production,
 *      POSTs to STILO_PROVISIONER_URL (Cloud Run service). Existing Retell
 *      agent + phone are reused.
 *   4. On success, updates client_agents.config with the latest IDs, flips
 *      status to 'active', stamps activated_at + provisioned_at.
 *   5. Returns the agent_id + phone_number so the dashboard can show them.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Optional env:
 *   STILO_PROVISIONER_URL    -- Cloud Run URL of the provisioner. Preferred in prod.
 *   STILO_AGENT_ROOT         -- when running on a host with the Python repo
 *                                checked out, will shell out to the local script.
 *   PROVISIONER_AUTH_TOKEN   -- bearer token sent to the Cloud Run provisioner.
 */

const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const path = require('path');

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

// Hard gate: the wizard must mark these passed before we burn money provisioning a Retell agent.
function checkBlockingGates(config) {
  const missing = [];
  if (!config.compliance_confirmed) missing.push('compliance');
  const crm = (config.crm_choice || '').toLowerCase();
  if (crm && crm !== 'none' && !config.crm_test_passed) missing.push('crm_connection');
  const booking = (config.booking_method || '').toLowerCase();
  if (booking && booking !== 'manual_via_transfer' && !config.calendar_test_passed) {
    missing.push('calendar_connection');
  }
  if (!config.test_call_passed) missing.push('test_call');
  return missing;
}

// Production path: POST to Cloud Run provisioner service.
async function provisionViaCloudRun(clientSlug) {
  const url = process.env.STILO_PROVISIONER_URL.replace(/\/$/, '') + '/provision/outbound/' + encodeURIComponent(clientSlug);
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PROVISIONER_AUTH_TOKEN) {
    headers['Authorization'] = 'Bearer ' + process.env.PROVISIONER_AUTH_TOKEN;
  }
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Provisioner returned ' + resp.status + ': ' + text.slice(0, 400));
  }
  return await resp.json();
}

// Local-dev path: shell out to the python script. Only enabled when STILO_AGENT_ROOT
// is set (the agent repo is checked out next to the site). On Vercel this won't run.
function provisionViaShell(clientSlug) {
  const agentRoot = process.env.STILO_AGENT_ROOT;
  if (!agentRoot) return Promise.reject(new Error('STILO_AGENT_ROOT not set'));
  const script = path.join(agentRoot, 'AI Receptionist Agent', 'python', 'retell_agent_provisioner.py');
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [script, '--setup', 'outbound', clientSlug], {
      env: process.env,
      cwd: path.join(agentRoot, 'AI Receptionist Agent', 'python'),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('Provisioner exited ' + code + ': ' + stderr.slice(0, 400)));
      // Result not parseable from stdout reliably; return success and let caller re-read config.
      resolve({ ok: true, stdout: stdout.slice(-400) });
    });
  });
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
      // Phase A: admin only. Phase B will allow the owner once test_call_passed.
      return res.status(403).json({ error: 'Admin only in Phase A' });
    }

    const { data: agent, error: aErr } = await supa
      .from('client_agents')
      .select('id, client_id, agent_code, status, config')
      .eq('id', clientAgentId)
      .single();
    if (aErr || !agent) return res.status(404).json({ error: 'Agent not found' });
    if (agent.agent_code !== 'ignite') {
      return res.status(400).json({ error: 'Only IGNITE supported in Phase A. agent_code=' + agent.agent_code });
    }

    const config = agent.config || {};
    const missing = checkBlockingGates(config);
    if (missing.length) {
      return res.status(412).json({ error: 'Blocking gates not satisfied', missing });
    }

    const clientSlug = config.client_slug || config.business_slug;
    if (!clientSlug) return res.status(400).json({ error: 'config.client_slug missing' });

    // Pick provisioning path
    let result;
    try {
      if (process.env.STILO_PROVISIONER_URL) {
        result = await provisionViaCloudRun(clientSlug);
      } else {
        result = await provisionViaShell(clientSlug);
      }
    } catch (e) {
      return res.status(502).json({ error: 'Provisioner call failed: ' + e.message });
    }

    // Re-read lead-config.json to get the new retell_agent_id + phone_number.
    // In Cloud Run mode, the provisioner returns these directly.
    const newConfig = Object.assign({}, config);
    if (result && result.retell_agent_id) {
      newConfig.retell_agent_id = result.retell_agent_id;
      newConfig.phone_number = result.phone_number;
      newConfig.voice_id = result.voice_id;
    }
    newConfig.provisioned = true;
    newConfig.provisioned_at = new Date().toISOString();
    newConfig.config_version = (config.config_version || 0) + 1;

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
      client_slug: clientSlug,
      retell_agent_id: newConfig.retell_agent_id || null,
      phone_number: newConfig.phone_number || null,
      voice_id: newConfig.voice_id || null,
    });

  } catch (e) {
    console.error('provision error', e);
    return res.status(500).json({ error: e.message });
  }
};
