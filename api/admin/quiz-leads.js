/**
 * GET /api/admin/quiz-leads
 *
 * Admin-only listing of inbound quiz submissions from the marketing site.
 * Returns the most recent leads with their recommended agents, scores,
 * and full quiz answers so an admin can triage / call / email manually.
 *
 * Query params:
 *   ?cta_type=quiz_complete|audit|purchase  (default: all)
 *   ?limit=N                                (default: 200, max 500)
 *   ?since=ISO_TIMESTAMP                    (default: 60 days ago)
 *
 * Auth: requires Bearer token from an admin Supabase user.
 */
const { assertAdmin, methodNotAllowed } = require('./deals/_shared');

module.exports = async function handleQuizLeads(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const gate = await assertAdmin(req, res);
  if (!gate.ok) return;

  const url = new URL(req.url, 'http://x');
  const ctaType = url.searchParams.get('cta_type'); // optional filter
  let limit = parseInt(url.searchParams.get('limit') || '200', 10);
  if (!limit || limit < 1) limit = 200;
  if (limit > 500) limit = 500;
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw
    ? sinceRaw
    : new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

  let q = gate.sb
    .from('quiz_submissions')
    .select('id, created_at, cta_type, contact_name, email, phone, business_name, website, quiz_answers, tier, selected_agents, agent_scores, estimated_price, page_url, referrer')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (ctaType) q = q.eq('cta_type', ctaType);

  const { data, error } = await q;
  if (error) {
    console.error('[admin/quiz-leads] supabase error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.status(200).json({
    ok: true,
    count: data.length,
    leads: data
  });
};
