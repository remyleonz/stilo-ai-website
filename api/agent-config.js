/**
 * PATCH /api/agent-config
 *
 * Edits an agent's config after onboarding has completed. Used both by:
 *   - the client (from app/agents/?agent=X edit panel) for fields the schema
 *     marks editable: true
 *   - the admin (from admin/index.html client drawer) for any field
 *
 * Body: { client_agent_id: uuid, patch: { ...partial config keys } }
 * Auth: Bearer token. Validates ownership unless caller is in ADMIN_EMAILS.
 *
 * What it does:
 *   1. Auth + ownership/admin check.
 *   2. Validates the patch keys against the agent's onboardingSchema. Only
 *      fields tagged editable: true (or any field, when caller is admin) may
 *      be set. Unknown keys are rejected.
 *   3. Merges the patch into client_agents.config and bumps config_version.
 *      Records an audit entry into config.history (last 20 changes).
 *   4. Triggers a downstream sync: ECHO -> Retell update_agent; IGNITE/REVIVE
 *      -> rewrite Clients/{slug}/agents/{type}/config/agent_config.json so the
 *      Python agents pick up the change on their next cron tick.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 * Optional env vars (used only when present, soft-fail otherwise):
 *   RETELL_API_KEY            -- for ECHO live push
 *   STILO_CLIENTS_DIR         -- absolute path to the Clients/ folder. When set,
 *                                writes IGNITE/REVIVE config to disk for the
 *                                Python agents. Skipped on Vercel (read-only fs).
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { AGENTS } = require('./_agents');

const ADMIN_EMAILS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

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

// Build the set of allowed keys for a given agent. When isAdmin, every schema
// key is allowed; for client callers, only fields tagged editable: true.
function allowedKeys(agentCode, isAdmin) {
  const meta = AGENTS[agentCode];
  if (!meta || !Array.isArray(meta.onboardingSchema)) return null; // null = any key
  const keys = new Set();
  for (const step of meta.onboardingSchema) {
    for (const f of (step.fields || [])) {
      if (isAdmin || f.editable === true) keys.add(f.key);
    }
  }
  return keys;
}

// Push a config change to the running agent. Soft-fails (logs + continues) so
// a Retell hiccup doesn't block the DB save. The dashboard will surface a
// warning via the response.sync field.
async function syncToRunningAgent(agentCode, clientId, mergedConfig) {
  const result = { synced: false, target: null, note: null };

  if (agentCode === 'echo') {
    result.target = 'retell';
    if (!process.env.RETELL_API_KEY || !mergedConfig.retell_agent_id) {
      result.note = 'Retell not configured for this deployment yet — DB updated, agent will pick up at next provision.';
      return result;
    }
    try {
      // Retell PATCH /update-agent reference: https://docs.retellai.com/api-references/update-agent
      const resp = await fetch('https://api.retellai.com/update-agent/' + encodeURIComponent(mergedConfig.retell_agent_id), {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + process.env.RETELL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_name: mergedConfig.business_name || undefined,
          // The full prompt/voice rebuild lives in retell_agent_provisioner.py;
          // for in-flight edits we update the directly-mappable fields.
          voice_id: mergedConfig.voice || undefined,
          general_prompt: mergedConfig.greeting || undefined,
        }),
      });
      if (!resp.ok) {
        result.note = 'Retell returned ' + resp.status;
      } else {
        result.synced = true;
      }
    } catch (e) {
      result.note = 'Retell call failed: ' + e.message;
    }
    return result;
  }

  if (agentCode === 'ignite' || agentCode === 'revive') {
    result.target = 'file';
    const baseDir = process.env.STILO_CLIENTS_DIR;
    if (!baseDir) {
      result.note = 'STILO_CLIENTS_DIR not set (running on read-only filesystem). DB updated, run a manual sync to push to disk.';
      return result;
    }
    const slug = mergedConfig.client_slug || clientId;
    const folder = agentCode === 'ignite' ? 'lead-reply' : 'lcr';
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

  result.note = 'No sync target for agent_type=' + agentCode;
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    res.setHeader('Allow', 'PATCH, POST');
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
  const patch = body.patch || {};
  if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return res.status(400).json({ error: 'patch must be a JSON object' });
  }

  const { data: row, error: rowErr } = await sb
    .from('client_agents')
    .select('id, client_id, status, config, agent_type')
    .eq('id', clientAgentId)
    .maybeSingle();
  if (rowErr || !row) return res.status(404).json({ error: 'Agent not found' });
  if (!isAdmin && row.client_id !== userId) {
    return res.status(403).json({ error: 'Not authorized for this agent' });
  }

  // Validate keys against the schema. Reject unknown or non-editable fields.
  const allowed = allowedKeys(row.agent_type, isAdmin);
  if (allowed) {
    const rejected = Object.keys(patch).filter(k => !allowed.has(k));
    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Some fields are not editable',
        rejected_keys: rejected,
      });
    }
  }

  const prevConfig = row.config || {};
  const prevHistory = Array.isArray(prevConfig.history) ? prevConfig.history : [];
  const nextHistory = prevHistory.concat([{
    at: new Date().toISOString(),
    by: userEmail,
    via: isAdmin ? 'admin' : 'client',
    keys: Object.keys(patch),
  }]).slice(-20);

  const merged = Object.assign({}, prevConfig, patch, {
    config_version: (prevConfig.config_version || 0) + 1,
    last_updated: new Date().toISOString(),
    history: nextHistory,
  });

  const { error: updateErr } = await sb
    .from('client_agents')
    .update({ config: merged })
    .eq('id', clientAgentId);
  if (updateErr) {
    console.error('[agent-config] update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to update agent config' });
  }

  // Push to the running agent. Soft-fails so a Retell/file outage does not
  // roll back the DB write — the dashboard surfaces the sync result and the
  // client can retry the sync later from a banner.
  const sync = await syncToRunningAgent(row.agent_type, row.client_id, merged);

  return res.status(200).json({
    ok: true,
    client_agent_id: clientAgentId,
    config_version: merged.config_version,
    sync,
  });
};
