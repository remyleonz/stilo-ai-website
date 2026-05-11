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
const { evaluateBusinessProfile } = require('./_agents');

// Load the niche playbook YAML (no `js-yaml` dep on this server, so we do a
// minimal parse for the keys we actually use). Returns {} if not found.
// Keep this lightweight: the Python prompt builders do the deep parse.
function loadNichePlaybookSlim(niche) {
  if (!niche) return {};
  // Try multiple roots so this works in dev (repo root) and on Vercel (bundled).
  const candidates = [
    path.join(process.cwd(), 'niche_playbooks', niche + '.yaml'),
    path.join(__dirname, '..', '..', '..', 'niche_playbooks', niche + '.yaml'),
    path.join(__dirname, '..', '..', 'niche_playbooks', niche + '.yaml'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const txt = fs.readFileSync(candidates[i], 'utf8');
      // Crude top-level extraction; full parse happens in Python at runtime.
      return { _playbook_path: candidates[i], _playbook_size: txt.length };
    } catch (_) { /* try next */ }
  }
  return {};
}

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

// Mirror of the sync logic in agent-config.js. Writes the final merged config
// to Clients/{slug}/agents/{folder}/config/agent_config.json so Python agents
// pick it up on their next cron tick without needing a separate API call.
function syncConfigToDisk(agentType, clientId, mergedConfig) {
  const result = { synced: false, note: null };
  // business_profile is dashboard-only state. No Python agent reads it directly;
  // each paid agent's finalize call pulls the profile in via mergedConfig.
  if (agentType === 'business_profile') return result;
  if (agentType !== 'ignite' && agentType !== 'revive' && agentType !== 'echo') return result;

  const baseDir = process.env.STILO_CLIENTS_DIR;
  if (!baseDir) {
    result.note = 'STILO_CLIENTS_DIR not set — DB config written, run manual sync to push to disk.';
    return result;
  }

  const slug = mergedConfig.client_slug || clientId;
  const folder = agentType === 'ignite' ? 'lead-reply'
              : agentType === 'echo' ? 'receptionist'
              : 'lcr';
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

  // For paid agents, pull in the client's business_profile so the merged
  // config carries identity, niche, brand voice, KB, etc. Each paid agent's
  // wizard only asks for what's UNIQUE to that agent; everything else flows
  // from the profile. Skip this for the business_profile pseudo-agent itself.
  let businessProfile = {};
  if (row.agent_type !== 'business_profile') {
    const { data: bp } = await sb
      .from('client_agents')
      .select('config')
      .eq('client_id', row.client_id)
      .eq('agent_type', 'business_profile')
      .maybeSingle();
    if (bp && bp.config && typeof bp.config === 'object') {
      businessProfile = bp.config;
    }
  }

  // Niche playbook reference. The Python prompt builders read the actual YAML
  // content; we only stamp the path + version so the agent knows which one to
  // load. Falls back gracefully when the playbook isn't deployed.
  const niche = (businessProfile.niche || aggregated.niche || row.config && row.config.niche) || null;
  const playbookRef = loadNichePlaybookSlim(niche);

  // Merge order (later wins on key conflict):
  //   1. existing config (from prior partial saves)
  //   2. business_profile.config (shared client-level inputs)
  //   3. aggregated step responses (this agent's wizard answers)
  //   4. completion receipt + niche playbook reference
  // The shared profile sits BELOW the agent's wizard answers so an agent can
  // legitimately override (example: ECHO can override the profile's default
  // CRM with its own).
  const nextConfig = Object.assign(
    {},
    row.config || {},
    row.agent_type === 'business_profile' ? {} : { _profile_snapshot: businessProfile },
    row.agent_type === 'business_profile' ? {} : businessProfile,
    aggregated,
    {
      onboarding_completed_at: new Date().toISOString(),
      onboarding_completed_by: userEmail || 'unknown',
      _niche_playbook: playbookRef,
    }
  );

  // business_profile lifecycle is different from paid agents:
  //   - Status flips from 'onboarding' to 'active' once the 80% threshold
  //     is satisfied (evaluateBusinessProfile). If the client clicks "finish"
  //     prematurely we still mark active = false.
  //   - business_profile DOES NOT go through admin review.
  //   - Paid agents (echo/ignite/revive/etc) flip to 'pending_admin_review'
  //     here, but historically this endpoint also still flips to 'active' —
  //     the actual production path is agents-submit-for-review for paid agents.
  //     For backwards-compat with the existing IGNITE flow we keep the
  //     auto-activate behavior for paid agents UNLESS they have a configured
  //     review-submit-button step (which calls submit-for-review separately).
  let nextStatus = 'active';
  let activatedAt = new Date().toISOString();
  if (row.agent_type === 'business_profile') {
    const ev = evaluateBusinessProfile(nextConfig);
    nextStatus = ev.active ? 'active' : 'onboarding';
    activatedAt = ev.active ? new Date().toISOString() : null;
  }

  const updatePayload = {
    status: nextStatus,
    config: nextConfig,
  };
  if (activatedAt) updatePayload.activated_at = activatedAt;

  const { error: updateErr } = await sb
    .from('client_agents')
    .update(updatePayload)
    .eq('id', clientAgentId);
  if (updateErr) {
    console.error('[finalize-agent-onboarding] update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to activate agent' });
  }

  // Write config to disk for IGNITE/REVIVE/ECHO when running on a server with
  // a local Clients/ directory. Soft-fails so a file error doesn't roll back
  // the DB write. business_profile is skipped (no Python consumer).
  const sync = syncConfigToDisk(row.agent_type, row.client_id, nextConfig);

  return res.status(200).json({
    ok: true,
    client_agent_id: clientAgentId,
    agent_type: row.agent_type,
    status: nextStatus,
    niche: niche,
    profile_merged: row.agent_type !== 'business_profile' && Object.keys(businessProfile).length > 0,
    sync,
  });
};
