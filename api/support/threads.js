/**
 * Support threads endpoint.
 *
 * GET /api/support/threads
 *   Returns the threads visible to the caller. Client sees their own;
 *   admin sees all. Sorted by last_message_at desc.
 *   Optional ?status=open|resolved filter.
 *
 * POST /api/support/threads
 *   Body: { client_agent_id?: uuid, subject?: string, first_message: string }
 *   Creates a thread (optionally tagged to an agent) and inserts the first
 *   message in one shot. Caller must be the client owning the agent (or an
 *   admin).
 *
 * Auth: Bearer token in Authorization header.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

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
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured on server' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const sb = admin();
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'Invalid session' });
  const userId = userData.user.id;
  const userEmail = (userData.user.email || '').toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  if (req.method === 'GET') {
    const status = req.query && req.query.status;
    let q = sb
      .from('support_threads')
      .select('id, client_id, client_agent_id, subject, status, created_at, last_message_at')
      .order('last_message_at', { ascending: false })
      .limit(200);
    if (!isAdmin) q = q.eq('client_id', userId);
    if (status === 'open' || status === 'resolved') q = q.eq('status', status);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ threads: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const clientAgentId = body.client_agent_id || null;
    const subject = (body.subject || '').toString().slice(0, 200) || null;
    const firstMessage = (body.first_message || '').toString().trim();
    if (!firstMessage) return res.status(400).json({ error: 'first_message required' });
    if (firstMessage.length > 5000) return res.status(400).json({ error: 'message too long (max 5000 chars)' });

    // Resolve which client_id this thread belongs to. For client callers it's
    // their own user id. For admin callers we use the agent's client_id when
    // tagged; otherwise the body must include client_id explicitly.
    let threadClientId = userId;
    if (isAdmin) {
      if (clientAgentId) {
        const { data: ca } = await sb
          .from('client_agents')
          .select('client_id')
          .eq('id', clientAgentId)
          .maybeSingle();
        if (ca && ca.client_id) threadClientId = ca.client_id;
      } else if (body.client_id) {
        threadClientId = body.client_id;
      }
    } else if (clientAgentId) {
      // Validate the agent belongs to this client.
      const { data: ca } = await sb
        .from('client_agents')
        .select('client_id')
        .eq('id', clientAgentId)
        .maybeSingle();
      if (!ca || ca.client_id !== userId) {
        return res.status(403).json({ error: 'Not authorized for this agent' });
      }
    }

    const { data: thread, error: threadErr } = await sb
      .from('support_threads')
      .insert({
        client_id: threadClientId,
        client_agent_id: clientAgentId,
        subject: subject,
        status: 'open',
      })
      .select('id, client_id, client_agent_id, subject, status, created_at, last_message_at')
      .single();
    if (threadErr) return res.status(500).json({ error: threadErr.message });

    const { data: message, error: msgErr } = await sb
      .from('support_messages')
      .insert({
        thread_id: thread.id,
        sender_type: isAdmin ? 'admin' : 'client',
        sender_id: userId,
        body: firstMessage,
      })
      .select('id, thread_id, sender_type, body, created_at')
      .single();
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    return res.status(200).json({ thread: thread, message: message });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
