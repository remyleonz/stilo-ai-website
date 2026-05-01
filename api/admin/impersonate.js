/**
 * POST /api/admin/impersonate
 *
 * Issues an "impersonation session" for an admin to act as one of their
 * clients. Practical implementation note: existing admin RLS policies on
 * clients/client_agents/onboarding_steps already allow admins to read and
 * update any row, so we don't need to mint a forged JWT — the admin keeps
 * their own session. What this endpoint does is the part that matters:
 *
 *   1. Verify the caller is an admin via Supabase auth + ADMIN_EMAILS.
 *   2. Verify the target client_id exists.
 *   3. Insert a 'session_start' row into impersonation_audit so we have a
 *      durable record that this happened.
 *   4. Return the target client info + a session_id the dashboard can echo
 *      back when logging individual mutation rows.
 *
 * Body: { client_id: uuid }
 * Auth: Bearer admin token.
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const ADMIN_EMAILS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com'];

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
  const clientId = body.client_id;
  if (!clientId) return res.status(400).json({ error: 'client_id required' });

  const { data: client, error: cErr } = await sb
    .from('clients')
    .select('id, business_name, contact_name, email')
    .eq('id', clientId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const sessionId = crypto.randomUUID();
  const { error: auditErr } = await sb.from('impersonation_audit').insert({
    admin_email: adminEmail,
    client_id: clientId,
    action: 'session_start',
    target_table: 'clients',
    target_id: clientId,
    payload: { session_id: sessionId },
  });
  if (auditErr) {
    console.error('[impersonate] audit insert failed:', auditErr);
    // Soft-fail — the session can still happen; better than blocking.
  }

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    client: {
      id: client.id,
      business_name: client.business_name,
      contact_name: client.contact_name,
      email: client.email,
    },
  });
};
