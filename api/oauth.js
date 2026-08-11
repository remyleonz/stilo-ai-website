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
 * State token (CSRF): HMAC-signed using SUPABASE_SERVICE_KEY. The state now
 * carries a ts that verifyState enforces (15-minute expiry).
 *
 * ── Admin gate on STILO-owned connections (audit 2026-08-10) ────────────────
 * action=start WITHOUT personal=1 and WITHOUT aid writes the STILO-owned rows
 * in public.oauth_tokens (google-calendar, gmail, gmail-inbox, google-meet...).
 * That used to be anonymous: anyone hitting the URL could complete Google
 * consent with THEIR account and rebind our tokens to their mailbox/calendar.
 * Now the start of an owned flow requires ONE of:
 *   a) a Supabase admin Bearer JWT (same check as prospects/_shared assertAdmin)
 *      — use with &mode=json from an authenticated fetch, or
 *   b) a signed link param k=<HMAC(provider+UTC date)> keyed with
 *      UNSUBSCRIBE_SIGNING_SECRET (or CRON_SECRET as fallback). Valid for the
 *      current + previous UTC day. This keeps the flow browser-friendly: a
 *      plain browser nav can't send a Bearer header.
 *
 * How an admin completes an owned grant (e.g. the gmail-inbox grant):
 *   1. While logged into /admin/, fetch (with your session's Bearer token):
 *        GET /api/oauth?provider=gmail-inbox&action=link
 *      -> { url: "https://.../api/oauth?provider=gmail-inbox&action=start&k=..." }
 *   2. Open that url in the browser, signed into the right Google account
 *      (remyleon@stiloaipartners.com for gmail-inbox), and finish consent.
 * The admin's email (or 'signed-link') is bound into the signed state and the
 * callback refuses to upsert an owned oauth_tokens row without it.
 *
 * personal=1 and aid flows are unchanged.
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
    // readonly  -> read conference records + transcripts.
    // settings  -> turn AUTO-TRANSCRIPTION on for a space. Added by Google in
    //              Feb 2025 specifically so an app can set auto-artifacts on
    //              spaces created by OTHER apps, including Google Calendar,
    //              which is exactly how book-meeting.js creates them.
    //              This is what stops transcription being a thing a human has
    //              to remember to click at the start of every call.
    scopes: [
      'https://www.googleapis.com/auth/meetings.space.readonly',
      'https://www.googleapis.com/auth/meetings.space.settings'
    ],
    client_id_env: 'GOOGLE_OAUTH_CLIENT_ID',
    client_secret_env: 'GOOGLE_OAUTH_CLIENT_SECRET',
    config_key: 'google_meet_oauth',
  },
  'gmail': {
    auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    // gmail.send ONLY. It is the narrowest Gmail scope there is: it can send a
    // message and nothing else, it cannot read the mailbox. gmail.compose was
    // also requested here but adds draft create/read, which nothing uses --
    // api/prospects/_gmail_send.js only sends. Asking for less makes the consent
    // screen honest and keeps the grant out of Google's restricted-scope review.
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
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

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function verifyState(token) {
  const secret = process.env.SUPABASE_SERVICE_KEY || 'dev-secret';
  if (!token || token.indexOf('.') === -1) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
  if (sig !== expected) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) { return null; }
  // ts was always signed but never checked; enforce a 15-minute window so an
  // old state token can't be replayed (audit 2026-08-10). A normal consent
  // roundtrip takes well under a minute.
  if (!payload || typeof payload.ts !== 'number' || Date.now() - payload.ts > STATE_MAX_AGE_MS || payload.ts > Date.now() + 60 * 1000) {
    return null;
  }
  return payload;
}

// ── Signed browser link for owned connections ───────────────────────────────
// k = HMAC(provider + UTC date) with UNSUBSCRIBE_SIGNING_SECRET/CRON_SECRET.
// Minted only by action=link (admin JWT required); valid today + yesterday UTC.
function linkSecret() {
  return process.env.UNSUBSCRIBE_SIGNING_SECRET || process.env.CRON_SECRET || '';
}
function linkKey(providerKey, dateStr) {
  const secret = linkSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('oauth-link:' + providerKey + ':' + dateStr).digest('base64url').slice(0, 32);
}
function verifyLinkKey(providerKey, k) {
  if (!k) return false;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [today, yesterday].some(function (d) {
    const good = linkKey(providerKey, d);
    if (!good) return false;
    const a = Buffer.from(String(k));
    const b = Buffer.from(good);
    try { return a.length === b.length && crypto.timingSafeEqual(a, b); }
    catch (_) { return false; }
  });
}

// Keep in sync with api/prospects/_shared.js ADMIN_EMAILS (not exported there).
const ADMIN_EMAILS = [
  'remyleon11@gmail.com',
  'stiloaiconsulting@gmail.com',
  'remyleon@stiloaipartners.com',
  'davidcoira@stiloaipartners.com'
];

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

  // Admin-only helper: mint the signed browser-friendly start URL for an
  // owned connection. See the header comment ("How an admin completes an
  // owned grant"). Returns JSON; never redirects.
  if (action === 'link') {
    const { assertAdmin } = require('./prospects/_shared');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return; // assertAdmin already wrote the 401/403
    if (!linkSecret()) {
      return res.status(500).json({ error: 'link_secret_missing', detail: 'Set UNSUBSCRIBE_SIGNING_SECRET or CRON_SECRET.' });
    }
    const k = linkKey(provider, new Date().toISOString().slice(0, 10));
    const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const startUrl = proto + '://' + host + '/api/oauth?provider=' + encodeURIComponent(provider) + '&action=start&k=' + encodeURIComponent(k);
    return res.status(200).json({ url: startUrl, valid_through: 'end of tomorrow (UTC)', minted_by: gate.email });
  }

  if (action === 'start') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let userId = null;
    let userEmail = null;
    let userIsAdmin = false;
    if (token) {
      const sb = admin();
      const { data: ud } = await sb.auth.getUser(token);
      if (ud && ud.user) {
        userId = ud.user.id;
        userEmail = ud.user.email || null;
        const role = (ud.user.app_metadata && ud.user.app_metadata.role) || null;
        userIsAdmin = role === 'admin' || (userEmail && ADMIN_EMAILS.includes(userEmail));
      }
    }
    const aid = url.searchParams.get('aid');

    // personal=1: a per-USER grant (e.g. David connecting his own Workspace
    // mailbox so invoice emails send as him). Stored under 'gmail:<email>'
    // instead of the shared row, so it can never clobber the STILO-owned
    // 'gmail' token that confirmations send from. Rides the same registered
    // redirect URI: the flag travels in the signed state, not the URL.
    const personal = url.searchParams.get('personal') === '1';
    if (personal && !userId) {
      return res.status(401).json({ error: 'personal_grant_requires_auth', hint: 'Call with your Supabase Bearer token and mode=json, then open the returned url.' });
    }

    // No personal flag + no aid => a STILO-owned connection whose callback
    // upserts public.oauth_tokens. Require an admin: either a verified admin
    // JWT or a valid signed link key (k=, minted via action=link). Without
    // this gate anyone could rebind our Google tokens to their own account
    // (audit 2026-08-10).
    let ownedAdmin = null;
    if (!personal && !aid) {
      if (userIsAdmin) {
        ownedAdmin = userEmail;
      } else if (verifyLinkKey(provider, url.searchParams.get('k'))) {
        ownedAdmin = 'signed-link';
      } else {
        return res.status(401).json({
          error: 'admin_required',
          hint: 'Owned connections need an admin. Either call with an admin Bearer token (add &mode=json and open the returned url), or have an admin mint a browser link via GET /api/oauth?provider=' + provider + '&action=link.'
        });
      }
    }

    const state = signState({ aid: aid, uid: userId, provider: provider, personal: personal || undefined, admin: ownedAdmin || undefined, ts: Date.now() });
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
    const authUrl = cfg.auth_url + '?' + params.toString();
    // mode=json lets an authenticated fetch retrieve the URL (a 302 can't carry
    // the Bearer header through window.open).
    if (url.searchParams.get('mode') === 'json') {
      return res.status(200).json({ url: authUrl });
    }
    res.statusCode = 302;
    res.setHeader('Location', authUrl);
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

    if (state.personal && state.uid) {
      // Per-user grant: resolve the STILO account email and store the token
      // under 'gmail:<email>'. apikey-only fetch because sb_secret keys break
      // supabase-js auth.admin Bearer calls.
      if (!tokenJson.refresh_token) {
        return closeWindowHtml(res, 'Connected, but Google did not return a refresh token. Revoke STILO access at myaccount.google.com/permissions, then try again.');
      }
      try {
        const ur = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + state.uid, {
          headers: { apikey: process.env.SUPABASE_SERVICE_KEY }
        });
        const uj = await ur.json();
        const email = uj && uj.email;
        if (!email) return closeWindowHtml(res, 'Could not resolve your STILO account. Try again.');
        const sb = admin();
        await sb.from('oauth_tokens').upsert({
          provider: provider + ':' + email.toLowerCase(),
          refresh_token: tokenJson.refresh_token,
          access_token: tokenJson.access_token || null,
          scope: tokenJson.scope || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'provider' });
        return closeWindowHtml(res, 'Connected. Invoice emails will now send from ' + email + '.');
      } catch (e) {
        return closeWindowHtml(res, 'Could not save the connection: ' + e.message);
      }
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
      //
      // The state must carry the admin marker that action=start binds after
      // its admin/link-key gate. A state without it means the flow was started
      // without authorization; refuse to overwrite our tokens.
      if (!state.admin) {
        console.warn('[oauth] owned callback without admin-bound state; refusing upsert', { provider: provider });
        return closeWindowHtml(res, 'This connection was not started by an admin, so it was not saved. Ask an admin for a fresh link (GET /api/oauth?provider=' + provider + '&action=link) and try again.');
      }
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
