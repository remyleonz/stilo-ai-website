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
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const querystring = require('querystring');
const { createClient } = require('@supabase/supabase-js');

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];

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

  try {
    const { error } = await supabase
      .from('lcr_suppressions')
      .upsert(
        {
          client_slug: clientSlug,
          phone: from,
          source: 'sms_stop',
          opted_out_at: new Date().toISOString(),
        },
        { onConflict: 'client_slug,phone' }
      );
    if (error) console.error('[sms_optout] upsert failed:', error.message);
  } catch (err) {
    console.error('[sms_optout] unexpected:', err);
  }

  // Empty TwiML — let the carrier send the standard STOP confirmation.
  return twimlOk(res);
};
