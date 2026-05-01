/**
 * Support messages endpoint.
 *
 * GET /api/support/messages?thread_id=<uuid>
 *   Lists messages in a thread. Caller must own the thread (client) or be
 *   an admin. Marks unread admin messages as read (read_at) when a client
 *   reads them, and vice versa.
 *
 * POST /api/support/messages
 *   Body: { thread_id: uuid, body: string }
 *   Appends a message. sender_type derived from caller (admin email lookup).
 *
 * Auth: Bearer token.
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

async function loadThread(sb, threadId) {
  const { data, error } = await sb
    .from('support_threads')
    .select('id, client_id, client_agent_id, status')
    .eq('id', threadId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { notFound: true };
  return { thread: data };
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
    const threadId = req.query && req.query.thread_id;
    if (!threadId) return res.status(400).json({ error: 'thread_id required' });

    const { thread, error: tErr, notFound } = await loadThread(sb, threadId);
    if (tErr) return res.status(500).json({ error: tErr });
    if (notFound) return res.status(404).json({ error: 'Thread not found' });
    if (!isAdmin && thread.client_id !== userId) return res.status(403).json({ error: 'Not authorized for this thread' });

    const { data: messages, error } = await sb
      .from('support_messages')
      .select('id, thread_id, sender_type, sender_id, body, created_at, read_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Mark counterparty's unread messages as read.
    const otherSide = isAdmin ? 'client' : 'admin';
    const unreadIds = (messages || []).filter(m => m.sender_type === otherSide && !m.read_at).map(m => m.id);
    if (unreadIds.length > 0) {
      await sb.from('support_messages')
        .update({ read_at: new Date().toISOString() })
        .in('id', unreadIds);
    }

    return res.status(200).json({ thread, messages: messages || [] });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const threadId = body.thread_id;
    const messageBody = (body.body || '').toString().trim();
    if (!threadId) return res.status(400).json({ error: 'thread_id required' });
    if (!messageBody) return res.status(400).json({ error: 'body required' });
    if (messageBody.length > 5000) return res.status(400).json({ error: 'message too long (max 5000 chars)' });

    const { thread, error: tErr, notFound } = await loadThread(sb, threadId);
    if (tErr) return res.status(500).json({ error: tErr });
    if (notFound) return res.status(404).json({ error: 'Thread not found' });
    if (!isAdmin && thread.client_id !== userId) return res.status(403).json({ error: 'Not authorized for this thread' });

    const senderType = isAdmin ? 'admin' : 'client';
    const { data: message, error } = await sb
      .from('support_messages')
      .insert({
        thread_id: threadId,
        sender_type: senderType,
        sender_id: userId,
        body: messageBody,
      })
      .select('id, thread_id, sender_type, body, created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // If a client wrote and the thread was resolved, re-open it.
    if (senderType === 'client' && thread.status === 'resolved') {
      await sb.from('support_threads').update({ status: 'open' }).eq('id', threadId);
    }

    return res.status(200).json({ message });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
