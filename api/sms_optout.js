/**
 * POST /api/sms_optout
 *
 * Twilio messaging webhook. Fires for every inbound SMS to a STILO-managed
 * client number. We watch for STOP / UNSUBSCRIBE / CANCEL / END / QUIT keywords
 * and add the sender to lcr_suppressions so the next email AND SMS batch skips
 * them.
 *
 * Twilio also auto-handles STOP at the carrier level (the customer gets the
 * carrier's confirmation and is blocked from receiving anything from that
 * sender code). This endpoint is the parallel record we keep on OUR side so
 * email reactivation also stops, and so we can audit opt-outs across channels.
 *
 * Twilio sends application/x-www-form-urlencoded (NOT JSON). The site's
 * serve.js wrapper only parses JSON, so for the form body we read it ourselves
 * if req.body is missing.
 *
 * Body fields we care about (from Twilio):
 *   From         -- the customer's phone, E.164
 *   To           -- the client's Twilio number, E.164
 *   Body         -- the SMS text
 *   AccountSid   -- the client's Twilio sub-account SID
 *
 * Resolving client_slug:
 *   We look up the client by AccountSid in the public.clients table
 *   (column twilio_account_sid). If not found we still log the opt-out to a
 *   fallback row with client_slug = '_unknown_' so nothing leaks.
 *
 * ── Request authentication (audit 2026-08-10) ───────────────────────────────
 * This used to accept any POST, so anyone could suppress any phone number for
 * any client. We now validate X-Twilio-Signature: HMAC-SHA1, keyed with
 * TWILIO_AUTH_TOKEN, over the full request URL followed by every POST param
 * sorted by key and concatenated as key+value with no separator (Twilio's
 * documented scheme), base64-encoded.
 *
 * IMPORTANT: if TWILIO_AUTH_TOKEN is NOT set, the check FAILS OPEN. The
 * request is processed and a console.error is logged on every call. That is
 * deliberate: a real customer sending STOP must never be dropped because of a
 * missing env var, and legally we have to honour the opt-out. Set
 * TWILIO_AUTH_TOKEN in Vercel to close the hole; the loud log is the reminder.
 *
 * If the URL Twilio was configured with differs from what the proxy reports
 * (custom domain, extra query string), set TWILIO_WEBHOOK_URL to the exact
 * configured URL and it is tried as well.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 * Strongly recommended:
 *   TWILIO_AUTH_TOKEN        -- without it the signature check is skipped
 *   TWILIO_WEBHOOK_URL       -- only if URL reconstruction is wrong
 */

const crypto = require('crypto');
const querystring = require('querystring');
const { createClient } = require('@supabase/supabase-js');

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

/**
 * Twilio's signature: base64(HMAC-SHA1(authToken, url + sorted(k+v)...)).
 * Pure function, exported for tests.
 */
function computeTwilioSignature(authToken, url, params) {
  let data = String(url);
  Object.keys(params || {}).sort().forEach((k) => {
    const v = params[k];
    data += k + (Array.isArray(v) ? v.join('') : (v == null ? '' : String(v)));
  });
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function candidateUrls(req) {
  const out = [];
  if (process.env.TWILIO_WEBHOOK_URL) out.push(process.env.TWILIO_WEBHOOK_URL);
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    const proto = req.headers['x-forwarded-proto']
      || ((req.connection && req.connection.encrypted) ? 'https' : 'http');
    out.push(proto + '://' + host + (req.url || '/api/sms_optout'));
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

/**
 * @returns {{ok: boolean, reason: string}} ok=true means "process this request".
 * reason 'unverified_no_token' is the fail-open path.
 */
function verifyTwilioRequest(req, params) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[sms_optout] TWILIO_AUTH_TOKEN is not set. Accepting this webhook WITHOUT signature verification. Anyone can forge opt-outs until this env var is added.');
    return { ok: true, reason: 'unverified_no_token' };
  }
  const sig = req.headers['x-twilio-signature'] || req.headers['X-Twilio-Signature'];
  if (!sig) return { ok: false, reason: 'missing_signature' };
  const match = candidateUrls(req).some((u) => safeEqual(sig, computeTwilioSignature(authToken, u, params)));
  return match ? { ok: true, reason: 'verified' } : { ok: false, reason: 'bad_signature' };
}

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function readForm(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(querystring.parse(raw)); }
      catch (e) { resolve({}); }
    });
  });
}

// Twilio expects a TwiML response. Empty <Response/> means: don't auto-reply
// from us. The carrier handles the standard STOP confirmation.
function twimlOk(res, replyText) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  if (replyText) {
    const safe = String(replyText).replace(/[<>&]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]
    );
    return res.status(200).end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`);
  }
  return res.status(200).end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

module.exports = async function handleSmsOptout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const body = await readForm(req);

  const auth = verifyTwilioRequest(req, body);
  if (!auth.ok) {
    console.warn('[sms_optout] rejected unsigned/forged webhook:', auth.reason);
    return res.status(403).end();
  }

  const from = String(body.From || '').trim();
  const accountSid = String(body.AccountSid || '').trim();
  const text = String(body.Body || '').trim().toUpperCase();

  if (!from || !text) return twimlOk(res);

  const firstWord = text.split(/\s+/)[0];
  const isStop = STOP_KEYWORDS.indexOf(firstWord) !== -1;
  if (!isStop) return twimlOk(res);

  const supabase = getSupabase();
  if (!supabase) {
    console.warn('[sms_optout] Supabase env missing; opt-out not persisted', { from });
    return twimlOk(res);
  }

  // Resolve client_slug from the AccountSid (the per-client Twilio sub-account).
  let clientSlug = '_unknown_';
  if (accountSid) {
    try {
      const { data } = await supabase
        .from('clients')
        .select('slug')
        .eq('twilio_account_sid', accountSid)
        .maybeSingle();
      if (data && data.slug) clientSlug = data.slug;
    } catch (e) { /* fall through with _unknown_ */ }
  }

  // Select-then-insert, NOT upsert: uniqueness on (client_slug, phone) is a
  // PARTIAL index (WHERE phone IS NOT NULL) and Postgres cannot infer one from
  // an ON CONFLICT column list, so every STOP write here raised 42P10 and
  // recorded nothing (audit 2026-08-10). An unrecorded STOP is the whole ballgame.
  try {
    const { data: existing } = await supabase
      .from('lcr_suppressions')
      .select('id')
      .eq('client_slug', clientSlug)
      .eq('phone', from)
      .limit(1);
    if (!existing || existing.length === 0) {
      const { error } = await supabase
        .from('lcr_suppressions')
        .insert({
          client_slug: clientSlug,
          phone: from,
          source: 'sms_stop',
          opted_out_at: new Date().toISOString(),
        });
      if (error && error.code !== '23505') {
        console.error('[sms_optout] insert failed:', error.message);
      }
    }
  } catch (err) {
    console.error('[sms_optout] unexpected:', err);
  }

  // Empty TwiML — let the carrier send the standard STOP confirmation.
  return twimlOk(res);
};

// Exported for unit tests.
module.exports.computeTwilioSignature = computeTwilioSignature;
module.exports.verifyTwilioRequest = verifyTwilioRequest;
