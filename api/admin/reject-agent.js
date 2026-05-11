/**
 * POST /api/admin/reject-agent
 *
 * Admin-only. Rejects a pending_admin_review agent: flips status back to
 * onboarding, stamps an admin_review_notes record, and emails the client
 * the rejection reason via Resend so they know what to fix.
 *
 * Body:
 *   {
 *     client_agent_id: uuid,
 *     reason: string (shown to the client)
 *     internal_notes?: string (admin-only)
 *   }
 *
 * Auth: Bearer access_token. Admin only.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAILS = [
  'remyleon11@gmail.com',
  'stiloaiconsulting@gmail.com',
  'remyleon@stiloaipartners.com',
  'davidcoira@stiloaipartners.com',
];

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

async function sendRejectionEmail(toEmail, agentType, reason) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[reject-agent] RESEND_API_KEY missing; skipping email');
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  const subject = 'Action needed on your STILO ' + agentType.toUpperCase() + ' setup';
  const html = ''
    + '<p>Hey,</p>'
    + '<p>Quick note on your <strong>' + agentType.toUpperCase() + '</strong> setup. We caught one or two things during pre-flight that need a tweak before we can flip it on.</p>'
    + '<p><strong>What to fix:</strong></p>'
    + '<blockquote style="border-left:3px solid #2563EB;padding:8px 14px;color:#444;">'
    + escapeHtml(reason).replace(/\n/g, '<br>')
    + '</blockquote>'
    + '<p>Open your dashboard at <a href="https://stiloaipartners.com/app/">stiloaipartners.com/app</a>, click Continue Setup on ' + agentType.toUpperCase() + ', address those items, and submit again. Usually takes 5 minutes.</p>'
    + '<p>Reach out if anything is unclear.</p>'
    + '<p>STILO AI Partners</p>';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'STILO AI Partners <hello@stiloaipartners.com>',
        to: toEmail,
        subject: subject,
        html: html,
      }),
    });
    if (resp.ok) return { sent: true };
    const txt = await resp.text();
    return { sent: false, reason: 'Resend HTTP ' + resp.status + ': ' + txt };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const sb = admin();
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: 'Invalid session' });
  const userEmail = (userData.user.email || '').toLowerCase();
  if (ADMIN_EMAILS.indexOf(userEmail) === -1) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const body = await readJsonBody(req);
  const clientAgentId = body.client_agent_id;
  const reason = (body.reason || '').trim();
  if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });
  if (!reason) return res.status(400).json({ error: 'reason required' });

  const { data: agentRow, error: agErr } = await sb
    .from('client_agents')
    .select('id, client_id, agent_type, status, config')
    .eq('id', clientAgentId)
    .maybeSingle();
  if (agErr || !agentRow) return res.status(404).json({ error: 'Agent not found' });

  // Look up the client email.
  const { data: client } = await sb.from('clients').select('email').eq('id', agentRow.client_id).maybeSingle();
  const clientEmail = client && client.email;

  // Stamp the rejection on the agent's config so the next admin can see history.
  const nextConfig = Object.assign({}, agentRow.config || {}, {
    last_rejection_reason: reason,
    last_rejection_at: new Date().toISOString(),
    last_rejection_by: userEmail,
    last_rejection_internal_notes: body.internal_notes || null,
  });

  await sb.from('client_agents').update({
    status: 'onboarding',
    config: nextConfig,
  }).eq('id', clientAgentId);

  // Re-open the final review step so the client lands back on it.
  await sb.from('onboarding_steps').update({ status: 'in_progress' })
    .eq('client_agent_id', clientAgentId)
    .order('step_number', { ascending: false })
    .limit(1);

  const emailResult = clientEmail
    ? await sendRejectionEmail(clientEmail, agentRow.agent_type, reason)
    : { sent: false, reason: 'No client email on file' };

  return res.status(200).json({
    ok: true,
    client_agent_id: clientAgentId,
    status: 'onboarding',
    email: emailResult,
  });
};
