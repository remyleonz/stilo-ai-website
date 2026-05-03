/**
 * POST /api/agents-crm-test
 *
 * Validates the CRM credentials a client just entered in the IGNITE wizard
 * (Step 5). Returns {ok, message} so the wizard can show a green check or
 * surface the error inline before the client moves on.
 *
 * Body:
 *   {
 *     client_agent_id: uuid,
 *     crm_choice: 'gohighlevel' | 'follow_up_boss' | 'google_sheets' | 'generic_webhook' | ...,
 *     credentials: { ... CRM-specific fields collected by the wizard ... }
 *   }
 *
 * Auth: Bearer access_token. Owner of the agent or admin.
 *
 * What it does:
 *   1. Auth + ownership check.
 *   2. Pings the chosen CRM with the supplied creds. Each CRM has its own
 *      cheap "is this token valid" call (e.g. GHL: GET /locations/{id};
 *      FUB: GET /v1/identity).
 *   3. On success, stamps crm_test_passed: true into client_agents.config so
 *      the wizard's blocking gate knows the step is satisfied.
 *
 * Note: this endpoint duplicates the test-connection logic from
 * Lead Reply Agent/python/crm_bridge.py, but we keep it in JS so it can run
 * inline on Vercel without booting a Python worker.
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

const HTTP_TIMEOUT_MS = 12000;

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

async function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after ' + ms + 'ms')), ms)),
  ]);
}

// ---------- CRM probes ----------

async function probeGoHighLevel(creds) {
  if (!creds.api_key || !creds.location_id) {
    return { ok: false, message: 'Missing api_key or location_id' };
  }
  try {
    const resp = await withTimeout(fetch(
      'https://services.leadconnectorhq.com/locations/' + encodeURIComponent(creds.location_id),
      {
        headers: {
          'Authorization': 'Bearer ' + creds.api_key,
          'Version': '2021-07-28',
        },
      }
    ), HTTP_TIMEOUT_MS);
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const name = (data.location && data.location.name) || 'OK';
      return { ok: true, message: 'Connected to GHL: ' + name };
    }
    const text = await resp.text();
    return { ok: false, message: 'GHL returned ' + resp.status + ': ' + text.slice(0, 160) };
  } catch (e) {
    return { ok: false, message: 'Connection error: ' + e.message };
  }
}

async function probeFollowUpBoss(creds) {
  if (!creds.api_key) return { ok: false, message: 'Missing api_key' };
  try {
    const headers = { 'Authorization': 'Basic ' + Buffer.from(creds.api_key + ':').toString('base64') };
    if (creds.x_system) headers['X-System'] = creds.x_system;
    if (creds.x_system_key) headers['X-System-Key'] = creds.x_system_key;
    const resp = await withTimeout(
      fetch('https://api.followupboss.com/v1/identity', { headers }),
      HTTP_TIMEOUT_MS
    );
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return { ok: true, message: 'Connected to FUB: ' + (data.name || 'OK') };
    }
    return { ok: false, message: 'FUB returned ' + resp.status };
  } catch (e) {
    return { ok: false, message: 'Connection error: ' + e.message };
  }
}

async function probeWebhook(creds) {
  const url = creds.webhook_url;
  if (!url) return { ok: false, message: 'Missing webhook_url' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (creds.bearer_token) headers['Authorization'] = 'Bearer ' + creds.bearer_token;
    const resp = await withTimeout(
      fetch(url, { method: 'POST', headers, body: JSON.stringify({ _test: true }) }),
      HTTP_TIMEOUT_MS
    );
    if (resp.status < 500) {
      return { ok: true, message: 'Webhook reachable (HTTP ' + resp.status + ')' };
    }
    return { ok: false, message: 'Webhook returned ' + resp.status };
  } catch (e) {
    return { ok: false, message: 'Connection error: ' + e.message };
  }
}

const PROBES = {
  gohighlevel: probeGoHighLevel,
  ghl: probeGoHighLevel,
  follow_up_boss: probeFollowUpBoss,
  fub: probeFollowUpBoss,
  google_sheets: probeWebhook,
  sheets: probeWebhook,
  generic_webhook: probeWebhook,
  webhook: probeWebhook,
};

// ---------- Handler ----------

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = await readJsonBody(req);
    const { client_agent_id, crm_choice, credentials } = body;

    if (!client_agent_id) return res.status(400).json({ error: 'client_agent_id required' });
    if (!crm_choice) return res.status(400).json({ error: 'crm_choice required' });

    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: 'Missing bearer token' });

    const supa = admin();
    const { data: userData, error: userErr } = await supa.auth.getUser(auth);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
    const callerEmail = (userData.user.email || '').toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(callerEmail);

    const { data: agent, error: aErr } = await supa
      .from('client_agents')
      .select('id, client_id, agent_code, config, clients!inner(owner_user_id)')
      .eq('id', client_agent_id)
      .single();
    if (aErr || !agent) return res.status(404).json({ error: 'Agent not found' });

    if (!isAdmin) {
      if (agent.clients?.owner_user_id !== userData.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const probe = PROBES[String(crm_choice).toLowerCase()];
    if (!probe) {
      return res.status(400).json({
        ok: false,
        message: 'Unknown CRM. Supported: ' + Object.keys(PROBES).join(', '),
      });
    }

    const creds = credentials || {};
    const result = await probe(creds);

    // Persist the result onto the agent config so the wizard's go-live gate can see it.
    if (result.ok) {
      const config = Object.assign({}, agent.config || {});
      config.crm_choice = crm_choice;
      config.crm_credentials = creds;  // TODO Phase B: move to Secret Manager, not raw config.
      config.crm_test_passed = true;
      config.crm_test_message = result.message;
      config.crm_test_at = new Date().toISOString();
      await supa.from('client_agents').update({ config }).eq('id', client_agent_id);
    } else {
      const config = Object.assign({}, agent.config || {});
      config.crm_test_passed = false;
      config.crm_test_message = result.message;
      config.crm_test_at = new Date().toISOString();
      await supa.from('client_agents').update({ config }).eq('id', client_agent_id);
    }

    return res.status(result.ok ? 200 : 200).json(result);

  } catch (e) {
    console.error('crm-test error', e);
    return res.status(500).json({ error: e.message });
  }
};
