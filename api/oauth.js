/**
 * /api/oauth?provider={p}&action={start|callback}
 *
 * Single endpoint OAuth dispatcher used by every wizard `oauth-button` field.
 * Two actions:
 *   - start    -> redirects to provider auth page
 *   - callback -> exchanges code for tokens, persists to client_agents.config,
 *                 closes the popup
 *
 * The original wizard fields point at /api/oauth/{provider}/start; we accept
 * that pattern via path-segment fallback too. Local serve.js only resolves
 * literal file paths, so we use query params as the primary contract.
 *
 * Supported providers (clients fall back gracefully when env vars missing):
 *   google-calendar, gmail, google-business, google-analytics, google-ads,
 *   quickbooks, meta-ads, gohighlevel, calendly
 *
 * State token (CSRF): HMAC-signed using SUPABASE_SERVICE_KEY.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROVIDERS = {
  'google-calendar': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'booking_credentials.google_oauth',
  },
  // Read-only access to Google Meet conference records + transcripts, used by
  // /api/prospects/sync-meet-transcripts. SEPARATE from 'google-calendar' on
  // purpose: re-authorizing transcripts must never clobber the booking
  // calendar's refresh token, or bookings go offline.
  //
  // Requires Workspace Business Standard or higher on the account that ORGANISES
  // the meetings (remyleon@stiloaipartners.com). Start this while signed in as
  // that account.
  'google-meet': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/meetings.space.readonly'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'google_meet_oauth',
  },
  'gmail': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'gmail_oauth',
  },
  // STILO-owned read-only connection to the master reply inbox
  // (remyleon@stiloaipartners.com). Used by /api/prospects/capture-replies to
  // read inbound cold-email replies. This is a SEPARATE oauth_tokens row from
  // 'google-calendar' on purpose: authorizing it does NOT touch or clobber the
  // calendar refresh token. Start it while signed into Google as
  // remyleon@stiloaipartners.com (the inbox that STILO_REPLY_TO points at).
  'gmail-inbox': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'gmail_inbox_oauth',
  },
  'google-business': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'gbp_oauth',
  },
  'google-analytics': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'analytics_oauth',
  },
  'google-ads': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'google_ads_oauth',
  },
  'quickbooks': {
    auth_url: 'https://appcenter.intuit.com/connect/oauth2',
    token_url: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scopes: ['com.intuit.quickbooks.accounting'],
    client_id_env: 'QUICKBOOKS_CLIENT_ID',
    client_secret_env: 'QUICKBOOKS_CLIENT_SECRET',
    config_key: 'quickbooks_oauth',
  },
  'meta-ads': {
    auth_url: 'https://www.facebook.com/v18.0/dialog/oauth',
    token_url: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: ['ads_read', 'business_management'],
    client_id_env: 'META_OAUTH_CLIENT_ID',
    client_secret_env: 'META_OAUTH_CLIENT_SECRET',
    config_key: 'meta_ads_oauth',
  },
  'gohighlevel': {
    auth_url: 'https://marketplace.gohighlevel.com/oauth/chooselocation',
    token_url: 'https://services.leadconnectorhq.com/oauth/token',
    scopes: ['contacts.write', 'contacts.readonly', 'calendars.write', 'conversations.write'],
    client_id_env: 'GHL_OAUTH_CLIENT_ID',
    client_secret_env: 'GHL_OAUTH_CLIENT_SECRET',
    config_key: 'ghl_oauth',
  },
  'calendly': {
    auth_url: 'https://auth.calendly.com/oauth/authorize',
    token_url: 'https://auth.calendly.com/oauth/token',
    scopes: [],
    client_id_env: 'CALENDLY_CLIENT_ID',
    client_secret_env: 'CALENDLY_CLIENT_SECRET',
    config_key: 'calendly_oauth',
  },
};

function admin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function signState(payload) {
  const secret = process.env.SUPABASE_SERVICE_KEY || 'dev-secret';
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  return b64 + '.' + sig;
}

function verifyState(token) {
  const secret = process.env.SUPABASE_SERVICE_KEY || 'dev-secret';
  if (!token || token.indexOf('.') === -1) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) { return null; }
}

function getRedirectUri(req, providerKey) {
  const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host + '/api/oauth?provider=' + encodeURIComponent(providerKey) + '&action=callback';
}

function setNestedKey(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function closeWindowHtml(res, message) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><body style="background:#0a0a0f;color:#e5e5e5;font-family:system-ui,sans-serif;padding:48px;text-align:center;">'
    + '<h2 style="color:#2563EB;">STILO AI Partners</h2>'
    + '<p>' + escape(message) + '</p>'
    + '<p style="color:#999;font-size:14px;">This tab closes automatically.</p>'
    + '<script>setTimeout(function(){ try { window.close(); } catch(e) {} }, 1500);</script>'
    + '</body></html>');
}

function escape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const provider = url.searchParams.get('provider');
  const action = url.searchParams.get('action');

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    return res.status(404).json({ error: 'Unknown OAuth provider', got: provider, supported: Object.keys(PROVIDERS) });
  }

  const clientId = process.env[cfg.client_id_env];
  const clientSecret = process.env[cfg.client_secret_env];
  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'OAuth not configured on server',
      detail: 'Missing ' + cfg.client_id_env + ' or ' + cfg.client_secret_env,
      hint: 'Add these env vars to .env.local + Vercel project settings.',
    });
  }

  if (action === 'start') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let userId = null;
    if (token) {
      const sb = admin();
      const { data: ud } = await sb.auth.getUser(token);
      if (ud && ud.user) userId = ud.user.id;
    }
    const aid = url.searchParams.get('aid');

    const state = signState({ aid: aid, uid: userId, provider: provider, ts: Date.now() });
    const redirect = getRedirectUri(req, provider);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: cfg.scopes.join(' '),
      state: state,
      access_type: 'offline',
      prompt: 'consent',
    });
    res.statusCode = 302;
    res.setHeader('Location', cfg.auth_url + '?' + params.toString());
    return res.end();
  }

  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) return closeWindowHtml(res, 'OAuth error: ' + error);
    if (!code || !stateRaw) return closeWindowHtml(res, 'Missing code or state');
    const state = verifyState(stateRaw);
    if (!state) return closeWindowHtml(res, 'Invalid state token');

    const redirect = getRedirectUri(req, provider);
    let tokenJson;
    try {
      const tokenResp = await fetch(cfg.token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirect,
          grant_type: 'authorization_code',
        }).toString(),
      });
      tokenJson = await tokenResp.json().catch(function() { return {}; });
      if (!tokenResp.ok || !tokenJson.access_token) {
        return closeWindowHtml(res, 'Token exchange returned ' + tokenResp.status + ': ' + (tokenJson.error_description || ''));
      }
    } catch (e) {
      return closeWindowHtml(res, 'Token exchange failed: ' + e.message);
    }

    if (state.aid) {
      try {
        const sb = admin();
        const { data: row } = await sb.from('client_agents').select('config').eq('id', state.aid).maybeSingle();
        const cur = (row && row.config) || {};
        const next = Object.assign({}, cur);
        setNestedKey(next, cfg.config_key, {
          connected: true,
          access_token: tokenJson.access_token,
          refresh_token: tokenJson.refresh_token || null,
          expires_in: tokenJson.expires_in || null,
          scope: tokenJson.scope || null,
          provider: provider,
          connected_at: new Date().toISOString(),
        });
        await sb.from('client_agents').update({ config: next }).eq('id', state.aid);
      } catch (e) {
        console.warn('[oauth] could not persist tokens:', e.message);
      }
    } else {
      // No client-agent context => this is a STILO-owned connection (the
      // booking calendar for remyleon@stiloaipartners.com). Persist the
      // refresh token to public.oauth_tokens so calendar-availability +
      // book-meeting can read it. A re-auth here just overwrites the row —
      // no env var redeploy needed.
      if (tokenJson.refresh_token) {
        try {
          const sb = admin();
          await sb.from('oauth_tokens').upsert({
            provider: provider,
            refresh_token: tokenJson.refresh_token,
            access_token: tokenJson.access_token || null,
            scope: tokenJson.scope || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'provider' });
        } catch (e) {
          console.warn('[oauth] could not persist owned token:', e.message);
        }
      } else {
        return closeWindowHtml(res, 'Connected, but Google did not return a refresh token. Revoke STILO access at myaccount.google.com/permissions, then try the link again.');
      }
    }

    return closeWindowHtml(res, 'Connected. The STILO booking calendar is now linked. You can close this tab.');
  }

  return res.status(404).json({ error: 'Unknown action: ' + action });
};
