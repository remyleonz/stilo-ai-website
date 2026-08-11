/**
 * GET  /api/unsubscribe?t=<token>
 * POST /api/unsubscribe?t=<token>   (List-Unsubscribe one-click)
 *
 * Token format (HMAC-SHA256, base64url):
 *   payload = base64url(JSON.stringify({c: client_slug, e: email, ts: epoch_secs}))
 *   sig     = base64url(hmacSha256(payload, UNSUBSCRIBE_SIGNING_SECRET))
 *   token   = `${payload}.${sig}`
 *
 * The LCR Python email sender mints these tokens and embeds them in the
 * footer link AND the List-Unsubscribe header. On hit we:
 *   1. Verify the signature (otherwise anyone could unsub anyone).
 *   2. Insert the (client_slug, email) pair into the lcr_suppressions Supabase
 *      table that LCR Agent/python/suppressions.py reads before every send.
 *   3. Return a tiny confirmation page (GET) or 204 (POST one-click).
 *
 * Env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   UNSUBSCRIBE_SIGNING_SECRET   -- shared with LCR Agent/python/suppressions.py
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function verifyToken(token, secret) {
  if (!token || token.indexOf('.') === -1) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  // Constant-time compare; bail out on length mismatch first to avoid throw.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload));
    if (!data.c || !data.e) return null;
    return { client_slug: String(data.c), email: String(data.e).toLowerCase(), ts: data.ts || 0 };
  } catch (e) {
    return null;
  }
}

function confirmationPage(email, businessName) {
  const safeEmail = String(email || '').replace(/[<>&"']/g, '');
  const safeBiz = String(businessName || '').replace(/[<>&"']/g, '') || 'us';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0d;color:#eee;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{max-width:440px;padding:32px;background:#16161a;border:1px solid #2a2a30;border-radius:14px;text-align:center}
  h1{margin:0 0 12px;font-size:22px}
  p{margin:8px 0;color:#aaa;font-size:15px;line-height:1.5}
  .accent{color:#2563EB}
</style></head><body>
<div class="card">
  <h1>You're unsubscribed</h1>
  <p><span class="accent">${safeEmail}</span> won't receive any more emails from ${safeBiz}.</p>
  <p>If this was a mistake, just reply to a previous email and we'll add you back.</p>
</div></body></html>`;
}

module.exports = async function handleUnsubscribe(req, res) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('t');
  const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;

  if (!secret) {
    console.error('[unsubscribe] UNSUBSCRIBE_SIGNING_SECRET not set');
    return res.status(500).json({ ok: false, error: 'misconfigured' });
  }

  const parsed = verifyToken(token, secret);
  if (!parsed) {
    return res.status(400).json({ ok: false, error: 'invalid_token' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.warn('[unsubscribe] Supabase env missing; opt-out not persisted');
    if (method === 'POST') return res.status(204).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(confirmationPage(parsed.email, ''));
  }

  // Select-then-insert, NOT upsert. The uniqueness on (client_slug, email) comes
  // from a PARTIAL index (WHERE email IS NOT NULL), and Postgres cannot infer a
  // partial index from an ON CONFLICT column list: it raises 42P10. So every
  // unsubscribe click since this shipped returned a 500 and recorded nothing,
  // which is a CAN-SPAM problem, not a style one (audit 2026-08-10).
  try {
    const { data: existing } = await supabase
      .from('lcr_suppressions')
      .select('id')
      .eq('client_slug', parsed.client_slug)
      .ilike('email', parsed.email)
      .limit(1);
    if (!existing || existing.length === 0) {
      const { error } = await supabase
        .from('lcr_suppressions')
        .insert({
          client_slug: parsed.client_slug,
          email: parsed.email,
          source: 'email_unsubscribe',
          opted_out_at: new Date().toISOString(),
        });
      // 23505 means a concurrent click won the race: the address is suppressed
      // either way, which is the outcome we care about.
      if (error && error.code !== '23505') {
        console.error('[unsubscribe] supabase insert failed:', error.message);
        return res.status(500).json({ ok: false, error: 'persist_failed' });
      }
    }
  } catch (err) {
    console.error('[unsubscribe] unexpected:', err);
    return res.status(500).json({ ok: false, error: 'unexpected' });
  }

  // Optional: look up the client's display name for the confirmation page.
  let businessName = '';
  try {
    const { data } = await supabase
      .from('clients')
      .select('business_name')
      .eq('slug', parsed.client_slug)
      .maybeSingle();
    if (data && data.business_name) businessName = data.business_name;
  } catch (e) { /* non-fatal */ }

  if (method === 'POST') return res.status(204).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).end(confirmationPage(parsed.email, businessName));
};
