/**
 * GET /api/agent-readiness-score?client_agent_id={uuid}
 *
 * Returns a 0-100 readiness score for an agent in pending_admin_review,
 * plus a list of red flags. Powers the admin "Pending Review" panel so
 * Remy can approve/reject in under 2 minutes per agent without scrolling
 * every form field.
 *
 * Score components (weighted):
 *   - 40 pts: required-field completion across all wizard steps
 *   - 30 pts: integration tests passed (CRM, calendar, phone-verify, webhook)
 *   - 20 pts: niche playbook customization (KB Qs, objections edited)
 *   - 10 pts: TCPA / consent / compliance fields satisfied
 *
 * Red flags (auto-flagged):
 *   - any required field empty
 *   - any *_test_passed boolean still false
 *   - TCPA acknowledgment missing
 *   - test call / test send not yet performed
 *   - business_profile not active (paid agent shouldn't be in review at all)
 *
 * Auth: Bearer access_token. Admin only.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { AGENTS, evaluateBusinessProfile } = require('./_agents');

const ADMIN_EMAILS = [
  'remyleon11@gmail.com',
  'stiloaiconsulting@gmail.com',
  'remyleon@stiloaipartners.com',
  'davidcoira@stiloaipartners.com',
];

function admin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function isFieldFilled(v) {
  if (typeof v === 'boolean') return v === true;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function scoreAgent(agentRow, schema, businessProfile) {
  const config = agentRow.config || {};
  const flags = [];
  let requiredScore = 0;
  let integrationScore = 0;
  let customizationScore = 0;
  let complianceScore = 0;

  // 1) Required-field completion (40 pts)
  let totalRequired = 0;
  let satisfiedRequired = 0;
  (schema || []).forEach(function(step) {
    (step.fields || []).forEach(function(f) {
      if (!f.required) return;
      // Skip showIf-gated fields when the gate isn't active.
      if (f.showIf) {
        for (const k in f.showIf) {
          if (config[k] !== f.showIf[k]) return;
        }
      }
      if (f.showIf_not) {
        for (const k in f.showIf_not) {
          if (config[k] === f.showIf_not[k]) return;
        }
      }
      totalRequired++;
      const key = f.key.indexOf('.') >= 0 ? f.key.split('.')[0] : f.key;
      const v = config[key];
      if (isFieldFilled(v)) satisfiedRequired++;
      else flags.push('Missing required: ' + (f.label || f.key));
    });
  });
  if (totalRequired > 0) {
    requiredScore = Math.round((satisfiedRequired / totalRequired) * 40);
  } else {
    requiredScore = 40;
  }

  // 2) Integration tests (30 pts: 7.5 each for the four common test types)
  const testFlags = ['crm_test_passed', 'calendar_test_passed', 'phone_verification_passed', 'email_domain_verified'];
  let passed = 0;
  testFlags.forEach(function(k) {
    if (config[k] === true) passed++;
  });
  integrationScore = Math.round((passed / testFlags.length) * 30);
  if (config.crm_test_passed === false) flags.push('CRM test never passed');
  if (config.calendar_test_passed === false) flags.push('Calendar test never passed');

  // 3) Customization (20 pts: did the client edit the niche playbook seeds?)
  if (Array.isArray(config.top_questions) && config.top_questions.length >= 5) customizationScore += 8;
  if (Array.isArray(config.top_objections) && config.top_objections.length >= 3) customizationScore += 6;
  if (config.main_offer && config.main_offer.length > 20) customizationScore += 3;
  if (config.greeting_style === 'custom' && config.custom_greeting) customizationScore += 3;
  // Cap at 20.
  if (customizationScore > 20) customizationScore = 20;

  // 4) Compliance & consent (10 pts)
  if (config.tcpa_consent_acknowledgment === true) complianceScore += 4;
  else flags.push('TCPA acknowledgment missing');
  if (config.owner_consent === true) complianceScore += 3;
  else flags.push('Owner consent missing');
  if (config.required_disclosures && String(config.required_disclosures).trim() !== '') complianceScore += 3;

  // Test call gate
  if (config.test_call_passed === false || config.test_call_passed === undefined) {
    if (agentRow.agent_type === 'echo' || agentRow.agent_type === 'ignite') {
      flags.push('Test call never rated');
    }
  }
  if (config.test_send_completed === false || config.test_send_completed === undefined) {
    if (agentRow.agent_type === 'revive') {
      flags.push('Test send never confirmed');
    }
  }

  // Profile gate
  if (agentRow.agent_type !== 'business_profile') {
    const ev = evaluateBusinessProfile(businessProfile || {});
    if (!ev.active) flags.push('Business Profile not active (' + ev.complete_pct + '% complete)');
  }

  const total = requiredScore + integrationScore + customizationScore + complianceScore;

  return {
    score: total,
    breakdown: {
      required: requiredScore,
      integrations: integrationScore,
      customization: customizationScore,
      compliance: complianceScore,
    },
    red_flags: flags,
    is_ready: total >= 80 && flags.length === 0,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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

  // Pull the agent + business profile in parallel.
  const url = new URL(req.url, 'http://localhost');
  const clientAgentId = url.searchParams.get('client_agent_id');
  if (!clientAgentId) return res.status(400).json({ error: 'client_agent_id required' });

  const [{ data: agentRow }, { data: agentList }] = await Promise.all([
    sb.from('client_agents').select('id, client_id, agent_type, status, config').eq('id', clientAgentId).maybeSingle(),
    Promise.resolve({ data: null }),
  ]);
  if (!agentRow) return res.status(404).json({ error: 'Agent not found' });

  const { data: profileRow } = await sb
    .from('client_agents')
    .select('config')
    .eq('client_id', agentRow.client_id)
    .eq('agent_type', 'business_profile')
    .maybeSingle();
  const businessProfile = profileRow ? (profileRow.config || {}) : {};

  const meta = AGENTS[agentRow.agent_type];
  const schema = meta ? meta.onboardingSchema : [];

  const result = scoreAgent(agentRow, schema, businessProfile);
  result.client_agent_id = clientAgentId;
  result.agent_type = agentRow.agent_type;
  result.status = agentRow.status;

  return res.status(200).json(result);
};
