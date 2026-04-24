/**
 * POST /api/finalize-agent-onboarding
 *
 * Called by the dashboard when a client finishes the last step of an agent's
 * onboarding wizard. Does three things:
 *   1. Marks the final onboarding_step completed (defensive; the wizard should
 *      have done this already).
 *   2. Flips client_agents.status from 'onboarding' to 'active' and sets
 *      activated_at.
 *   3. Records a completion receipt in client_agents.config under
 *      `onboarding_completed_at` so agent-pages and the CEO audit can tell the
 *      difference between "was always active" and "just flipped from onboarding".
 *
 * Body: { client_agent_id: uuid }
 * Auth: Supabase access_token in Authorization: Bearer header. The endpoint
 *       validates the caller owns the agent (or is an admin) before flipping.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

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

  // Defensive: mark any still-in-progress step as completed.
  const { data: steps } = await sb
    .from('onboarding_steps')
    .select('id, status')
    .eq('client_agent_id', clientAgentId);
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

  // Flip agent to active and stamp activation receipt into config.
  const nextConfig = Object.assign({}, row.config || {}, {
    onboarding_completed_at: new Date().toISOString(),
    onboarding_completed_by: userEmail || 'unknown',
  });

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

  return res.status(200).json({
    ok: true,
    client_agent_id: clientAgentId,
    agent_type: row.agent_type,
    status: 'active',
  });
};
