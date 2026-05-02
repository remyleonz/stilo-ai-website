/**
 * POST /api/agent-status
 *
 * Pause or resume an agent. Wired to Pause/Resume buttons on the client
 * dashboard agent cards and on app/agents/?agent=X. Admin can call it
 * for any client_agents row.
 *
 * Body: { client_agent_id: uuid, action: 'pause' | 'resume' }
 *
 * Effects:
 *   - Sets client_agents.status to 'paused' or 'active' and stamps
 *     config.last_status_change_at + history entry.
 *   - For ECHO: tries to disable/enable the Retell number. Soft-fails.
 *   - For IGNITE/REVIVE: writes paused: true|false into the on-disk
 *     agent_config.json. The Python agents check this flag at the top of
 *     each cron tick and exit early when paused.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Optional env: RETELL_API_KEY, STILO_CLIENTS_DIR
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const ADMIN_EMAILS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

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

async function syncStatusToAgent(agentCode, clientId, paused, mergedConfig) {
  const result = { synced: false, target: null, note: null };

  if (agentCode === 'echo') {
    result.target = 'retell';
    if (!process.env.RETELL_API_KEY || !mergedConfig.retell_phone_number_id) {
      result.note = 'Retell phone number not provisioned yet — DB status updated.';
      return result;
    }
    try {
      // Retell phone numbers can be enabled/disabled by patching the inbound webhook.
      // We toggle inbound_agent_id off when paused, and back on when resumed.
      const targetAgent = paused ? null : (mergedConfig.retell_agent_id || null);
      const resp = await fetch(
        'https://api.retellai.com/update-phone-number/' + encodeURIComponent(mergedConfig.retell_phone_number_id),
        {
          method: 'PATCH',
          headers: {
            'Authorization': 'Bearer ' + process.env.RETELL_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inbound_agent_id: targetAgent }),
        }
      );
      if (!resp.ok) result.note = 'Retell returned ' + resp.status;
      else result.synced = true;
    } catch (e) {
      result.note = 'Retell call failed: ' + e.message;
    }
    return result;
  }

  if (agentCode === 'ignite' || agentCode === 'revive') {
    result.target = 'file';
    const baseDir = process.env.STILO_CLIENTS_DIR;
    if (!baseDir) {
      result.note = 'STILO_CLIENTS_DIR not set. DB status updated; the Python agent reads from DB on next tick once cron is wired.';
      return result;
    }
    const slug = mergedConfig.client_slug || clientId;
    const folder = agentCode === 'ignite' ? 'lead-reply' : 'lcr';
    const file = path.join(baseDir, slug, 'agents', folder, 'config', 'agent_config.json');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      const next = Object.assign({}, existing, { paused: !!paused, last_updated: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
      result.synced = true;
    } catch (e) {
      result.note = 'File write failed: ' + e.message;
    }
    return result;
  }

  result.note = 'No status sync target for agent_type=' + agentCode;
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
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'Invalid session' });

  const userId = userData.user.id;
  const userEmail = (userData.user.email || '').toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  const body = await readJsonBody(req);
  const clientAgentId = body.client_agent_id;
  const action = String(body.action || '').toLowerCase();
  if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });
  if (action !== 'pause' && action !== 'resume') {
    return res.status(400).json({ error: 'action must be "pause" or "resume"' });
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
  if (row.status === 'onboarding') {
    return res.status(400).json({ error: 'Agent is still in onboarding. Finish setup before pausing or resuming.' });
  }
  if (row.status === 'cancelled') {
    return res.status(400).json({ error: 'Agent is cancelled. Cannot pause or resume.' });
  }

  const nextStatus = action === 'pause' ? 'paused' : 'active';
  if (row.status === nextStatus) {
    return res.status(200).json({ ok: true, status: nextStatus, note: 'No change' });
  }

  const prevConfig = row.config || {};
  const prevHistory = Array.isArray(prevConfig.history) ? prevConfig.history : [];
  const merged = Object.assign({}, prevConfig, {
    paused: nextStatus === 'paused',
    last_status_change_at: new Date().toISOString(),
    history: prevHistory.concat([{
      at: new Date().toISOString(),
      by: userEmail,
      via: isAdmin ? 'admin' : 'client',
      action: action,
    }]).slice(-20),
  });

  const { error: updateErr } = await sb
    .from('client_agents')
    .update({ status: nextStatus, config: merged })
    .eq('id', clientAgentId);
  if (updateErr) {
    console.error('[agent-status] update failed:', updateErr);
    return res.status(500).json({ error: 'Failed to update agent status' });
  }

  const sync = await syncStatusToAgent(row.agent_type, row.client_id, nextStatus === 'paused', merged);

  return res.status(200).json({ ok: true, status: nextStatus, sync });
};
