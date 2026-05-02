/**
 * POST /api/admin/impersonate-action
 *
 * Records a single mutation taken during an impersonation session. The
 * client dashboard wraps key mutation calls (saveOnboardingStep, edit
 * config, pause/resume, send support message) and pings this endpoint
 * to drop a row into impersonation_audit. The mutation itself happens
 * via the regular admin RLS policies — we just want the trail.
 *
 * Body:
 *   {
 *     session_id: uuid,        // from /api/admin/impersonate
 *     client_id: uuid,
 *     action: string,          // e.g. update_agent_config, save_onboarding_step
 *     target_table: string,
 *     target_id: uuid,
 *     payload: object
 *   }
 *
 * Auth: Bearer admin token.
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const sb = admin();
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'Invalid session' });
  const adminEmail = (userData.user.email || '').toLowerCase();
  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const body = await readJsonBody(req);
  if (!body.client_id || !body.action) {
    return res.status(400).json({ error: 'client_id and action required' });
  }

  const { error } = await sb.from('impersonation_audit').insert({
    admin_email: adminEmail,
    client_id: body.client_id,
    action: body.action,
    target_table: body.target_table || null,
    target_id: body.target_id || null,
    payload: Object.assign({}, body.payload || {}, { session_id: body.session_id }),
  });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
};
