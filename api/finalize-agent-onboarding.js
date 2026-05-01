/**
 * POST /api/finalize-agent-onboarding
 *
 * Called by the dashboard when a client finishes the last step of an agent's
 * onboarding wizard. Does four things:
 *   1. Marks any still-in-progress onboarding steps as completed (defensive).
 *   2. Aggregates every step's response_data into a flat config object so
 *      fields like `industry`, `business_name`, and `booking_system` end up
 *      in client_agents.config (not stranded in the step rows).
 *   3. Flips client_agents.status from 'onboarding' to 'active' and sets
 *      activated_at.
 *   4. Triggers a file-sync for IGNITE/REVIVE when STILO_CLIENTS_DIR is set
 *      so the Python agents pick up the config immediately.
 *
 * Body: { client_agent_id: uuid }
 * Auth: Supabase access_token in Authorization: Bearer header. The endpoint
 *       validates the caller owns the agent (or is an admin) before flipping.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 * Optional:
 *   STILO_CLIENTS_DIR  -- absolute path to Clients/ folder on the agent server.
 *                         When set, writes agent_config.json to disk for
 *                         IGNITE and REVIVE so they pick up config on next tick.
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const ADMIN_EMAILS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com'];

function admin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
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

// Mirror of the sync logic in agent-config.js. Writes the final merged config
// to Clients/{slug}/agents/{folder}/config/agent_config.json so Python agents
// pick it up on their next cron tick without needing a separate API call.
function syncConfigToDisk(agentType, clientId, mergedConfig) {
  const result = { synced: false, note: null };
  if (agentType !== 'ignite' && agentType !== 'revive') return result;

  const baseDir = process.env.STILO_CLIENTS_DIR;
  if (!baseDir) {
    result.note = 'STILO_CLIENTS_DIR not set — DB config written, run manual sync to push to disk.';
    return result;
  }

  const slug = mergedConfig.client_slug || clientId;
  const folder = agentType === 'ignite' ? 'lead-reply' : 'lcr';
  const file = path.join(baseDir, slug, 'agents', folder, 'config', 'agent_config.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const next = Object.assign({}, existing, mergedConfig, {
      config_version: (existing.config_version || 0) + 1,
      last_updated: new Date().toISOString(),
    });
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    result.synced = true;
  } catch (e) {
    result.note = 'File write failed: ' + e.message;
  }
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server' });
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
  const userEmail = (userData.user.email || '').toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  const body = await readJsonBody(req);
  const clientAgentId = body.client_agent_id;
  if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });

  // Ownership check: either the caller owns the client_agents row, or is an admin.
  const { data: row, error: rowErr } = await sb
    .from('client_agents')
    .select('id, client_id, status, config, agent_type')
    .eq('id', clientAgentId)
    .maybeSingle();
  if (rowErr || !row) return res.status(404).json({ error: 'Agent not found' });
  if (!isAdmin && row.client_id !== userId) {
    return res.status(403).json({ error: 'Not authorized for this agent' });
  }

  // Fetch all onboarding steps (we need their data to aggregate into config).
  const { data: steps } = await sb
    .from('onboarding_steps')
    .select('id, step_number, status, data')
    .eq('client_agent_id', clientAgentId)
    .order('step_number', { ascending: true });

  // Mark any still-in-progress step as completed (defensive).
  if (steps && steps.length) {
    const openIds = steps
      .filter(function (s) { return s.status !== 'completed'; })
      .map(function (s) { return s.id; });
    if (openIds.length) {
      await sb
        .from('onboarding_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .in('id', openIds);
    }
  }

  // Aggregate all step response_data into a flat config. Later steps win on
  // key conflicts (same field appearing in step 1 and step 3 uses step 3's value).
  const aggregated = {};
  if (steps && steps.length) {
    for (const step of steps) {
      const rd = step.data && step.data.response_data;
      if (rd && typeof rd === 'object' && !Array.isArray(rd)) {
        Object.assign(aggregated, rd);
      }
    }
  }

  // Merge: existing config + aggregated wizard answers + completion receipt.
  // Existing config fields (set by a previous partial save) are preserved unless
  // the wizard explicitly provides a newer value.
  const nextConfig = Object.assign(
    {},
    row.config || {},
    aggregated,
    {
      onboarding_completed_at: new Date().toISOString(),
      onboarding_completed_by: userEmail || 'unknown',
    }
  );

  const { error: updateErr } = await sb
    .from('client_agents')
    .update({
      status: 'active',
      activated_at: new Date().toISOString(),
      config: nextConfig,
    })
    .eq('id', clientAgentId);
  if (updateErr) {
    console.error('[finalize-agent-onboarding] update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to activate agent' });
  }

  // Write config to disk for IGNITE/REVIVE when running on a server with a
  // local Clients/ directory. Soft-fails so a file error doesn't roll back
  // the DB write.
  const sync = syncConfigToDisk(row.agent_type, row.client_id, nextConfig);

  return res.status(200).json({
    ok: true,
    client_agent_id: clientAgentId,
    agent_type: row.agent_type,
    status: 'active',
    industry: nextConfig.industry || null,
    sync,
  });
};
