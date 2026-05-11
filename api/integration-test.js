/**
 * POST /api/integration-test
 *
 * Universal integration-test endpoint used by the wizard's `connection-test`,
 * `phone-verify`, and `webhook-test` field types. Dispatches to one of several
 * sub-probes based on `test_type` and returns { ok, message } that the wizard
 * surfaces inline.
 *
 * Body:
 *   {
 *     test_type: 'webhook' | 'calendar' | 'phone-verify' | 'crm' | 'email-domain',
 *     client_agent_id?: uuid,        // optional; if present, success is stamped
 *     payload: { ... type-specific ... }
 *   }
 *
 * Auth: Bearer access_token. Owner of the agent or admin.
 *
 * Sub-probes:
 *   - webhook:   POST {ping:true} to payload.url, accept 200-299.
 *   - calendar:  HEAD/GET payload.url for Calendly; GET cal.com API for Cal.com.
 *   - phone-verify: Twilio Lookup the number, validate format + carrier.
 *   - crm:       per-CRM token-validity probe (GHL, FUB, HubSpot, Pipedrive,
 *                Salesforce, Google Sheets webhook, generic webhook).
 *   - email-domain: DNS lookup for SPF + DKIM records on payload.domain.
 *
 * If `client_agent_id` is supplied, a successful result also flips the
 * matching `*_test_passed` boolean inside client_agents.config so subsequent
 * wizard reloads remember the green check.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *               TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (optional, for phone-verify).
 */

const { createClient } = require('@supabase/supabase-js');
const dns = require('dns').promises;

const ADMIN_EMAILS = [
  'remyleon11@gmail.com',
  'stiloaiconsulting@gmail.com',
  'remyleon@stiloaipartners.com',
  'davidcoira@stiloaipartners.com',
];

const HTTP_TIMEOUT_MS = 12000;

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

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise(function(_, rej) { setTimeout(function() { rej(new Error('Timeout after ' + ms + 'ms')); }, ms); }),
  ]);
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-probes
// ────────────────────────────────────────────────────────────────────────────

async function probeWebhook(payload) {
  const url = (payload && payload.url) || '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, message: 'Provide a webhook URL starting with https://' };
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (payload.bearer_token) headers['Authorization'] = 'Bearer ' + payload.bearer_token;
    const resp = await withTimeout(fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        ping: true,
        from: 'STILO AI Partners',
        sent_at: new Date().toISOString(),
        note: 'This is a connection test. Safe to ignore in your logs.',
      }),
    }), HTTP_TIMEOUT_MS);
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, message: 'Webhook accepted the ping (' + resp.status + ').' };
    }
    return { ok: false, message: 'Webhook returned HTTP ' + resp.status + '. Check the URL and access controls.' };
  } catch (e) {
    return { ok: false, message: 'Could not reach webhook: ' + e.message };
  }
}

async function probeCalendar(payload) {
  const method = payload.booking_method || payload.method;
  if (!method) return { ok: false, message: 'No booking method specified' };

  if (method === 'cal_com') {
    const username = payload.cal_com_username;
    const slug = payload.event_slug;
    if (!username || !slug) {
      return { ok: false, message: 'Cal.com requires both username and event slug' };
    }
    try {
      const resp = await withTimeout(fetch('https://cal.com/' + encodeURIComponent(username) + '/' + encodeURIComponent(slug), {
        method: 'GET',
      }), HTTP_TIMEOUT_MS);
      if (resp.status === 200) return { ok: true, message: 'Cal.com event reachable.' };
      if (resp.status === 404) return { ok: false, message: 'Cal.com returned 404. Check the username and event slug.' };
      return { ok: false, message: 'Cal.com returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach Cal.com: ' + e.message };
    }
  }

  if (method === 'calendly') {
    const url = payload.booking_url;
    if (!url) return { ok: false, message: 'Provide your public Calendly URL' };
    try {
      const resp = await withTimeout(fetch(url, { method: 'GET' }), HTTP_TIMEOUT_MS);
      if (resp.status === 200) return { ok: true, message: 'Calendly URL is live.' };
      return { ok: false, message: 'Calendly returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach Calendly: ' + e.message };
    }
  }

  if (method === 'google_calendar') {
    if (payload.google_oauth && (payload.google_oauth === 'connected' || payload.google_oauth.connected)) {
      return { ok: true, message: 'Google Calendar OAuth connection on file.' };
    }
    return { ok: false, message: 'Click "Connect Google Calendar" to authorize first.' };
  }

  if (method === 'gohighlevel_calendar') {
    if (!payload.ghl_calendar_id) return { ok: false, message: 'Provide the GHL calendar ID' };
    return { ok: true, message: 'Calendar ID stored. Live check runs at provision time.' };
  }

  if (method === 'sms_booking_link') {
    const url = payload.sms_link_url;
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, message: 'Provide a valid booking link URL' };
    return { ok: true, message: 'Booking link saved.' };
  }

  return { ok: false, message: 'Unknown booking method: ' + method };
}

async function probePhoneVerify(payload) {
  const phone = (payload && payload.phone) || '';
  if (!/^\+\d{10,15}$/.test(phone)) {
    return { ok: false, message: 'Phone must be E.164 format (example: +13055551234).' };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) {
    // Graceful degrade: allow the format check to pass when Twilio not configured.
    // Admin review will manually verify before the agent goes live.
    return {
      ok: true,
      message: 'Number format valid. Twilio Lookup is not configured on this server, so STILO will manually verify ownership during admin review.',
      manual_verification_required: true,
    };
  }

  try {
    const url = 'https://lookups.twilio.com/v2/PhoneNumbers/' + encodeURIComponent(phone) + '?Fields=line_type_intelligence';
    const resp = await withTimeout(fetch(url, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
      },
    }), HTTP_TIMEOUT_MS);
    if (!resp.ok) {
      return { ok: false, message: 'Twilio Lookup returned HTTP ' + resp.status };
    }
    const j = await resp.json();
    if (j && j.valid) {
      const lt = (j.line_type_intelligence && j.line_type_intelligence.type) || 'unknown';
      return { ok: true, message: 'Verified: ' + (j.calling_country_code || '') + ' ' + (lt) + ' line.' };
    }
    return { ok: false, message: 'Twilio reports this number is not valid.' };
  } catch (e) {
    return { ok: false, message: 'Lookup failed: ' + e.message };
  }
}

async function probeCRM(payload) {
  const choice = payload && payload.crm_choice;
  const creds = (payload && payload.credentials) || {};
  if (!choice) return { ok: false, message: 'crm_choice is required' };

  if (choice === 'gohighlevel') {
    if (!creds.api_key || !creds.location_id) return { ok: false, message: 'GHL needs api_key and location_id' };
    try {
      const resp = await withTimeout(fetch(
        'https://services.leadconnectorhq.com/locations/' + encodeURIComponent(creds.location_id),
        { headers: { 'Authorization': 'Bearer ' + creds.api_key, 'Version': '2021-07-28' } }
      ), HTTP_TIMEOUT_MS);
      if (resp.ok) return { ok: true, message: 'GHL token verified.' };
      if (resp.status === 401) return { ok: false, message: 'GHL says the token is invalid or expired.' };
      return { ok: false, message: 'GHL returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach GHL: ' + e.message };
    }
  }

  if (choice === 'follow_up_boss') {
    if (!creds.api_key) return { ok: false, message: 'Provide your Follow Up Boss API key' };
    try {
      const resp = await withTimeout(fetch('https://api.followupboss.com/v1/identity', {
        headers: { 'Authorization': 'Basic ' + Buffer.from(creds.api_key + ':').toString('base64') },
      }), HTTP_TIMEOUT_MS);
      if (resp.ok) return { ok: true, message: 'Follow Up Boss API key verified.' };
      if (resp.status === 401) return { ok: false, message: 'FUB rejected the API key.' };
      return { ok: false, message: 'FUB returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach FUB: ' + e.message };
    }
  }

  if (choice === 'hubspot') {
    if (!creds.api_key) return { ok: false, message: 'Provide your HubSpot Private App access token' };
    try {
      const resp = await withTimeout(fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
        headers: { 'Authorization': 'Bearer ' + creds.api_key },
      }), HTTP_TIMEOUT_MS);
      if (resp.ok) return { ok: true, message: 'HubSpot token verified.' };
      if (resp.status === 401) return { ok: false, message: 'HubSpot rejected the token.' };
      return { ok: false, message: 'HubSpot returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach HubSpot: ' + e.message };
    }
  }

  if (choice === 'pipedrive') {
    if (!creds.api_key) return { ok: false, message: 'Provide your Pipedrive API token' };
    try {
      const resp = await withTimeout(fetch('https://api.pipedrive.com/v1/users/me?api_token=' + encodeURIComponent(creds.api_key), {}), HTTP_TIMEOUT_MS);
      if (resp.ok) return { ok: true, message: 'Pipedrive token verified.' };
      if (resp.status === 401) return { ok: false, message: 'Pipedrive rejected the token.' };
      return { ok: false, message: 'Pipedrive returned HTTP ' + resp.status };
    } catch (e) {
      return { ok: false, message: 'Could not reach Pipedrive: ' + e.message };
    }
  }

  if (choice === 'google_sheets' || choice === 'generic_webhook') {
    return probeWebhook({ url: creds.webhook_url, bearer_token: creds.bearer_token });
  }

  if (choice === 'salesforce') {
    // Salesforce has many auth flows; defer real probe to provision time.
    if (!creds.api_key) return { ok: false, message: 'Provide your Salesforce access token' };
    return { ok: true, message: 'Token stored. Live check runs at provision time.' };
  }

  if (choice === 'email_summary' || choice === 'none') {
    return { ok: true, message: 'No CRM connection required for this option.' };
  }

  return { ok: false, message: 'Unknown CRM: ' + choice };
}

async function probeEmailDomain(payload) {
  const domain = (payload && payload.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) {
    return { ok: false, message: 'Provide a domain like yourbusiness.com (no protocol).' };
  }
  // Check SPF + DKIM presence. We do not verify the *value*, only the *existence*
  // because the client may still be in DNS-record-add mode. The presence check
  // tells them whether records have propagated yet.
  let spfOk = false;
  let dkimOk = false;
  try {
    const txt = await dns.resolveTxt(domain);
    spfOk = txt.some(function(r) { return r.join('').toLowerCase().includes('v=spf1'); });
  } catch (_) { /* no TXT records yet */ }
  try {
    const txt = await dns.resolveTxt('resend._domainkey.' + domain);
    dkimOk = txt && txt.length > 0;
  } catch (_) { /* no DKIM yet */ }
  if (spfOk && dkimOk) return { ok: true, message: 'SPF and DKIM records detected for ' + domain };
  if (spfOk) return { ok: false, message: 'SPF found but DKIM (resend._domainkey) is missing. Add the DKIM record from Resend.' };
  if (dkimOk) return { ok: false, message: 'DKIM found but SPF is missing. Add: v=spf1 include:_spf.resend.com ~all' };
  return { ok: false, message: 'Neither SPF nor DKIM detected. DNS may still be propagating (up to 48h).' };
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

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
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  const userId = userData.user.id;
  const userEmail = (userData.user.email || '').toLowerCase();
  const isAdmin = ADMIN_EMAILS.indexOf(userEmail) !== -1;

  const body = await readJsonBody(req);
  const testType = body.test_type;
  const payload = body.payload || {};
  const clientAgentId = body.client_agent_id || null;

  if (!testType) return res.status(400).json({ error: 'test_type required' });

  // If a client_agent_id is supplied, require ownership.
  if (clientAgentId) {
    const { data: row, error: rowErr } = await sb
      .from('client_agents')
      .select('id, client_id')
      .eq('id', clientAgentId)
      .maybeSingle();
    if (rowErr || !row) return res.status(404).json({ error: 'Agent not found' });
    if (!isAdmin && row.client_id !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }
  }

  let result;
  try {
    if (testType === 'webhook') result = await probeWebhook(payload);
    else if (testType === 'calendar') result = await probeCalendar(payload);
    else if (testType === 'phone-verify') result = await probePhoneVerify(payload);
    else if (testType === 'crm') result = await probeCRM(payload);
    else if (testType === 'email-domain') result = await probeEmailDomain(payload);
    else result = { ok: false, message: 'Unknown test_type: ' + testType };
  } catch (e) {
    console.error('[integration-test] probe threw:', e);
    result = { ok: false, message: 'Server error during test: ' + e.message };
  }

  // On success, stamp the matching boolean into client_agents.config so the
  // wizard remembers between reloads. Each test_type maps to a different key.
  if (result.ok && clientAgentId) {
    const flagKey = {
      webhook: 'webhook_test_passed',
      calendar: 'calendar_test_passed',
      'phone-verify': 'phone_verification_passed',
      crm: 'crm_test_passed',
      'email-domain': 'email_domain_verified',
    }[testType];
    if (flagKey) {
      try {
        const { data: cur } = await sb.from('client_agents').select('config').eq('id', clientAgentId).maybeSingle();
        const next = Object.assign({}, (cur && cur.config) || {}, { [flagKey]: true });
        await sb.from('client_agents').update({ config: next }).eq('id', clientAgentId);
      } catch (e) {
        // Stamp failure should not roll back the green check; the wizard already saw ok.
        console.warn('[integration-test] could not stamp flag:', e.message);
      }
    }
  }

  return res.status(200).json(result);
};
