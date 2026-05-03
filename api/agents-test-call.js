/**
 * POST /api/agents-test-call
 *
 * Self-serve test call. The client (or admin) enters their own phone number,
 * picks a scenario, and we route a synthetic lead through the same webhook
 * pipeline that production leads use. The Retell agent fires a real call to
 * the test number. The recording + transcript come back like any other call.
 *
 * Body:
 *   {
 *     client_agent_id: uuid,
 *     test_phone_number: '+13055551234',
 *     scenario: 'hot_buyer' | 'cold_lead' | 'voicemail' | 'seller_inquiry'
 *   }
 *
 * Auth: Bearer access_token. Owner of the agent or admin.
 *
 * Effects:
 *   - Posts a synthetic lead payload (with test_mode: true) to the production
 *     lead webhook for the client. The lead processor handles it like any
 *     other inbound, but tags the resulting call as test=true so reports can
 *     filter it out.
 *   - Returns the lead_id so the dashboard can poll for the recording.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STILO_WEBHOOK_BASE_URL
 *   STILO_WEBHOOK_BASE_URL defaults to https://api.stiloaipartners.com
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

// ─── Auto-provisioning helpers ────────────────────────────────────────────
// Mirror of the logic in agents-provision.js. We need to call into the
// idempotent Python provisioner before the test webhook fires, so that the
// client (or admin) hears a real Retell call rather than a queued-but-never-dialed lead.
//
// Same as in agents-provision.js: production uses Cloud Run, local dev shells out.

async function provisionViaCloudRun(clientSlug) {
  const url = process.env.STILO_PROVISIONER_URL.replace(/\/$/, '') +
    '/provision/outbound/' + encodeURIComponent(clientSlug);
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PROVISIONER_AUTH_TOKEN) {
    headers['Authorization'] = 'Bearer ' + process.env.PROVISIONER_AUTH_TOKEN;
  }
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
  if (!resp.ok) {
    throw new Error('Provisioner returned ' + resp.status + ': ' + (await resp.text()).slice(0, 400));
  }
  return await resp.json();
}

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
      resolve({ ok: true, stdout: stdout.slice(-400) });
    });
  });
}

async function ensureProvisioned(supa, clientAgentId, config) {
  // If a Retell agent already exists for this client, no action needed.
  if (config && config.voice_config && config.voice_config.retell_agent_id) {
    return { provisioned: false, message: 'Agent already provisioned' };
  }
  // Otherwise call the idempotent Python provisioner. It creates an agent +
  // phone the first time, and is a no-op (update path) on every subsequent call.
  const clientSlug = (config && (config.client_slug || config.business_slug)) || null;
  if (!clientSlug) throw new Error('client_slug missing from config — cannot provision');

  let result;
  if (process.env.STILO_PROVISIONER_URL) {
    result = await provisionViaCloudRun(clientSlug);
  } else {
    result = await provisionViaShell(clientSlug);
  }

  // Re-read the config from the DB so subsequent steps see the new IDs.
  // (The Python provisioner writes lead-config.json on disk; the Vercel API
  // reads from Supabase. For now we rely on the disk → Supabase sync running
  // separately. We bubble up the IDs from the provisioner result.)
  return {
    provisioned: true,
    retell_agent_id: result && result.retell_agent_id,
    phone_number: result && result.phone_number,
    raw: result,
  };
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

// Synthetic lead payloads. The voice agent treats these like real leads, so
// the scripts behave naturally. Tweak phrasing per scenario to exercise
// different branches of the playbook.
function syntheticLead(scenario, testPhone, businessIndustry) {
  const base = {
    test_mode: true,
    name: 'Test Lead (' + scenario + ')',
    phone: testPhone,
    email: 'test+' + scenario + '@stiloaipartners.com',
    source: 'STILO_TEST',
  };

  if (businessIndustry === 'real-estate' || businessIndustry === 'real_estate') {
    if (scenario === 'hot_buyer') {
      return Object.assign({}, base, {
        message: "Hi, I'm pre-approved for $500k and want to see 456 Oak Ave in Coral Gables this Saturday. Ready to make an offer fast.",
        property_address: '456 Oak Ave, Coral Gables, FL',
        price_range: '450k-550k',
        timeline: 'this week',
        financing_status: 'pre-approved',
        lead_type: 'buyer',
      });
    }
    if (scenario === 'cold_lead') {
      return Object.assign({}, base, {
        message: "Just browsing properties in Miami. No specific timeline yet, just curious about the market.",
        timeline: 'no rush',
        lead_type: 'buyer',
      });
    }
    if (scenario === 'seller_inquiry') {
      return Object.assign({}, base, {
        message: "What's my home worth at 789 Palm Way, Miami Beach? Thinking of selling next spring.",
        property_address: '789 Palm Way, Miami Beach, FL',
        timeline: 'spring',
        lead_type: 'seller',
      });
    }
    if (scenario === 'voicemail') {
      return Object.assign({}, base, {
        message: "Interested in 123 Brickell Ave listing.",
        property_address: '123 Brickell Ave, Miami, FL',
        lead_type: 'buyer',
        // No expectation that the test number picks up; voicemail flow exercised.
      });
    }
  }

  // Generic fallback for any industry
  return Object.assign({}, base, {
    message: 'Test lead for ' + scenario + ' scenario.',
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = await readJsonBody(req);
    const { client_agent_id, test_phone_number, scenario } = body;

    if (!client_agent_id) return res.status(400).json({ error: 'client_agent_id required' });
    if (!test_phone_number) return res.status(400).json({ error: 'test_phone_number required' });
    if (!/^\+?\d{10,15}$/.test(String(test_phone_number).replace(/[\s\-\(\)]/g, ''))) {
      return res.status(400).json({ error: 'test_phone_number must be a valid phone number' });
    }
    const sc = String(scenario || 'hot_buyer').toLowerCase();
    if (!['hot_buyer', 'cold_lead', 'voicemail', 'seller_inquiry'].includes(sc)) {
      return res.status(400).json({ error: 'invalid scenario' });
    }

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
      const ownerId = agent.clients?.owner_user_id;
      if (ownerId !== userData.user.id) return res.status(403).json({ error: 'Forbidden' });
    }

    if (agent.agent_code !== 'ignite') {
      return res.status(400).json({ error: 'Test calls only supported for IGNITE in Phase A' });
    }

    const config = agent.config || {};
    const clientSlug = config.client_slug || config.business_slug;
    if (!clientSlug) return res.status(400).json({ error: 'client_slug missing from config' });

    // Auto-provision-if-needed. The Retell agent must exist for the test call
    // to actually fire. The Python provisioner is idempotent: first call creates,
    // every subsequent call updates the same agent in place.
    let provisionInfo = null;
    try {
      provisionInfo = await ensureProvisioned(supa, client_agent_id, config);
      // If we just provisioned, persist the new IDs back into client_agents.config.
      if (provisionInfo.provisioned && provisionInfo.retell_agent_id) {
        const newConfig = Object.assign({}, config);
        newConfig.voice_config = Object.assign({}, config.voice_config || {}, {
          retell_agent_id: provisionInfo.retell_agent_id,
          phone_number: provisionInfo.phone_number,
          enabled: true,
        });
        newConfig.provisioned_at = new Date().toISOString();
        await supa.from('client_agents').update({ config: newConfig }).eq('id', client_agent_id);
      }
    } catch (e) {
      // Surface the failure clearly. Without a Retell agent, the test call
      // would silently queue forever — we'd rather fail loudly here.
      return res.status(503).json({
        error: 'Test call could not be queued: agent provisioning failed',
        detail: e.message,
        hint: 'Ensure STILO_AGENT_ROOT (local) or STILO_PROVISIONER_URL (prod) is set.',
      });
    }

    // Build payload and POST to the lead intake webhook.
    const webhookBase = (process.env.STILO_WEBHOOK_BASE_URL || 'https://api.stiloaipartners.com')
      .replace(/\/$/, '');
    const url = webhookBase + '/webhook/lead/' + encodeURIComponent(clientSlug) + '?source=stilo_test';

    const payload = syntheticLead(sc, test_phone_number, config.industry);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({
        error: 'Test webhook failed: ' + resp.status,
        detail: text.slice(0, 400),
      });
    }
    const result = await resp.json().catch(() => ({}));

    // Stamp the test event into client_agents.config so the dashboard can show it.
    const testLog = Array.isArray(config.test_calls_log) ? config.test_calls_log.slice(-9) : [];
    testLog.push({
      lead_id: result.lead_id || null,
      scenario: sc,
      test_phone: test_phone_number,
      triggered_at: new Date().toISOString(),
      status: 'queued',
    });
    await supa
      .from('client_agents')
      .update({ config: Object.assign({}, config, { test_calls_log: testLog }) })
      .eq('id', client_agent_id);

    return res.status(202).json({
      ok: true,
      scenario: sc,
      lead_id: result.lead_id || null,
      provisioned_now: !!(provisionInfo && provisionInfo.provisioned),
      retell_agent_id: (provisionInfo && provisionInfo.retell_agent_id) || (config.voice_config && config.voice_config.retell_agent_id) || null,
      message: 'Test lead queued. Expect a call within 90 seconds.'
        + (provisionInfo && provisionInfo.provisioned ? ' (Retell agent was provisioned just now.)' : ''),
    });

  } catch (e) {
    console.error('test-call error', e);
    return res.status(500).json({ error: e.message });
  }
};
