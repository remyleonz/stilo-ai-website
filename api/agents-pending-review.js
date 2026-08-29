/**
 * GET /api/agents-pending-review
 *
 * Admin-only. Returns the queue of client agents awaiting STILO Partners final
 * review and provisioning. Used by the Pending Review panel on the admin
 * dashboard.
 *
 * Response: { ok: true, items: [{
 *   client_agent_id, agent_code, business_name, owner_email, submitted_at,
 *   config_summary: { industry, lead_sources, crm_choice, booking_method,
 *                     test_call_passed, voice_id, area_code, expected_volume }
 * }, ...] }
 *
 * Auth: Bearer access_token. Admin emails only.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: 'Missing bearer token' });

    const supa = admin();
    const { data: userData, error: userErr } = await supa.auth.getUser(auth);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid token' });
    const callerEmail = (userData.user.email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(callerEmail)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { data, error } = await supa
      .from('client_agents')
      .select('id, agent_type, status, config, clients!inner(business_name)')
      .eq('status', 'pending_admin_review')
      .order('config->>submitted_for_review_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    const items = (data || []).map((row) => {
      const cfg = row.config || {};
      return {
        client_agent_id: row.id,
        // public.client_agents stores the agent as agent_type; the admin card
        // reads item.agent_code, so the wire name stays put.
        agent_code: row.agent_type,
        business_name: row.clients?.business_name || cfg.business_name || '(unnamed)',
        submitted_at: cfg.submitted_for_review_at || null,
        submitted_by_email: cfg.submitted_by_email || null,
        config_summary: {
          industry: cfg.industry || null,
          agent_state: cfg.agent_state || null,
          lead_sources: cfg.lead_sources || null,
          expected_volume: cfg.expected_volume || null,
          crm_choice: cfg.crm_choice || null,
          crm_test_passed: !!cfg.crm_test_passed,
          booking_method: cfg.booking_method || null,
          calendar_test_passed: !!cfg.calendar_test_passed,
          transfer_enabled: !!cfg.transfer_enabled,
          agent_cell: cfg.agent_cell || null,
          voice_id: cfg.voice_id || null,
          area_code: cfg.area_code || null,
          test_call_passed: !!cfg.test_call_passed,
          test_calls_log: Array.isArray(cfg.test_calls_log) ? cfg.test_calls_log.length : 0,
          compliance_confirmed: !!cfg.compliance_confirmed,
        },
      };
    });

    return res.status(200).json({ ok: true, count: items.length, items });

  } catch (e) {
    console.error('pending-review error', e);
    return res.status(500).json({ error: e.message });
  }
};
