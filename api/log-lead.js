/**
 * POST /api/log-lead
 *
 * Captures lead data the moment someone clicks "Get Started Now" (purchase
 * intent) or "Book a Free 15-min Audit" (audit intent) at the end of the
 * homepage quiz. Writes to public.leads in Supabase so we have full context
 * (contact info + quiz answers + selected agents + tier + price) BEFORE
 * they complete Stripe or confirm Calendly. Used for retargeting drop-offs.
 *
 * Body (all fields optional except cta_type):
 *   {
 *     cta_type:        "purchase" | "audit",
 *     contact_name:    "Jane Doe",
 *     email:           "jane@example.com",
 *     phone:           "+15551234567",
 *     business_name:   "Planet Fitness Miami",
 *     quiz_answers:    { q1: "...", q2: "...", ... },
 *     tier:            "starter" | "growth" | "partner",
 *     selected_agents: ["echo", "ignite", "forge"],
 *     estimated_price: "$7,485 setup + $1,340/mo",
 *     referrer:        document.referrer,
 *     page_url:        window.location.href
 *   }
 *
 * Response: 200 { ok: true, lead_id } or 2xx { ok: false } on soft fail.
 * Never blocks the user flow — the client fires-and-forgets this request.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return null;
  }
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

function str(v, max) {
  if (v == null) return null;
  var s = String(v);
  return max ? s.slice(0, max) : s;
}

// HTML-escape every user-supplied value before interpolating into email HTML.
// Same helper as api/public/book-meeting.js. Without this the quiz form was an
// unauthenticated way to send arbitrary HTML from our domain (audit 2026-08-10).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function firstName(full) {
  if (!full) return 'there';
  return String(full).trim().split(/\s+/)[0] || 'there';
}

// ── Anti-abuse gates (audit 2026-08-10) ─────────────────────────────────────
// The endpoint stays publicly callable (real quiz submissions come from the
// marketing site with no auth), but the auto-reply email is capped:
//   - max 3 sends per recipient email per day
//   - max 30 sends per day total from this endpoint
// Checked twice: a cheap in-memory counter (per warm lambda) plus a DB count of
// today's quiz_submissions rows as the cross-instance backstop. On breach the
// row is still inserted; only the email is skipped.
// Additionally, requests that carry an Origin/Referer from a host that is NOT
// ours are rejected outright. Absent origin is allowed (the site's own form
// posts and curl both work).
var ALLOWED_ORIGIN_HOSTS = ['stiloaipartners.com', 'www.stiloaipartners.com', 'localhost', '127.0.0.1'];
function originAllowed(req) {
  var src = req.headers.origin || req.headers.referer || '';
  if (!src) return true;
  try {
    var h = new URL(src).hostname.toLowerCase();
    return ALLOWED_ORIGIN_HOSTS.indexOf(h) !== -1;
  } catch (_) { return false; }
}

var MAX_SENDS_PER_EMAIL_PER_DAY = 3;
var MAX_SENDS_PER_DAY = 30;
var _sendLog = { day: null, total: 0, byEmail: {} };
function _todayUtc() { return new Date().toISOString().slice(0, 10); }
function _rollDay() {
  var d = _todayUtc();
  if (_sendLog.day !== d) _sendLog = { day: d, total: 0, byEmail: {} };
}
function memAllowsSend(email) {
  _rollDay();
  if (_sendLog.total >= MAX_SENDS_PER_DAY) return false;
  if ((_sendLog.byEmail[email] || 0) >= MAX_SENDS_PER_EMAIL_PER_DAY) return false;
  return true;
}
function memRecordSend(email) {
  _rollDay();
  _sendLog.total++;
  _sendLog.byEmail[email] = (_sendLog.byEmail[email] || 0) + 1;
}

// DB backstop. Called AFTER the row insert, so counts include the current
// submission: recipient count of 1..3 and total of 1..30 still allow the send.
async function dbAllowsSend(supabase, email) {
  var since = _todayUtc() + 'T00:00:00Z';
  try {
    var perEmail = await supabase
      .from('quiz_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('email', email)
      .gte('created_at', since);
    if (perEmail.count != null && perEmail.count > MAX_SENDS_PER_EMAIL_PER_DAY) return false;
    var total = await supabase
      .from('quiz_submissions')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since);
    if (total.count != null && total.count > MAX_SENDS_PER_DAY) return false;
    return true;
  } catch (e) {
    // Count failing shouldn't block a legit lead's first-touch; the in-memory
    // limit still applies.
    console.warn('[log-lead] rate-limit count failed:', e && e.message);
    return true;
  }
}

// Build a deep-link URL that lands the recipient directly on the booking modal
// of the marketing site with their name/email/business pre-filled. The page's
// ?book=1 handler reads these params and opens openBookingModal() on load.
function buildBookingUrl(row) {
  var params = new URLSearchParams();
  params.set('book', '1');
  if (row.contact_name)  params.set('name', row.contact_name);
  if (row.email)         params.set('email', row.email);
  if (row.business_name) params.set('business', row.business_name);
  return 'https://stiloaipartners.com/?' + params.toString();
}

// Personalised off the five quiz answers: their industry, what a customer is
// worth, where work comes from today, and who is actually doing the selling.
// No product list, no agent names, no "AI plan" language.
var PAIN = {
  'Referrals and word of mouth': 'everything is coming from referrals, which means the good months and the quiet months are decided for you',
  'Inbound / our website': 'you are waiting on inbound, which caps you at however many people happen to find you',
  'We buy leads': 'you are buying leads, which usually means paying for the same names your competitors are calling',
  'An agency or SDR we hired': 'you have already paid someone to do this and it did not stick',
  'Mostly nothing right now': 'there is no real outbound happening, so growth is whatever walks in'
};
var OWNER = {
  'Me, the owner': 'you are the one doing it, on top of running the business',
  'One salesperson': 'it sits on one person, so the pipeline moves at exactly one person\u2019s pace',
  'A small sales team': 'the team is closing, not prospecting, which is the right way round but leaves the top of the funnel thin',
  'Nobody owns it': 'nobody actually owns it, so it happens when someone remembers'
};

function buildQuizReplyHtml(row) {
  // Every value that originates in the request body goes through esc().
  // PAIN/OWNER lookups are safe (values come from our own fixed maps, the
  // user's answer is only used as a lookup key).
  var name = esc(firstName(row.contact_name));
  var biz = esc(row.business_name || 'your business');
  var a = row.quiz_answers || {};
  var industry = a.industry && a.industry !== 'Something else' ? esc(String(a.industry).toLowerCase()) : null;
  var pain = PAIN[a.current_source] || null;
  var owner = OWNER[a.who_owns_sales] || null;
  var worth = a.customer_value ? esc(String(a.customer_value)) : null;
  var soon = a.timeline && /now|30/i.test(a.timeline);

  var lines = [];
  lines.push('<p>Hey ' + name + ',</p>');

  var opener = 'Thanks for going through the questions for ' + biz + '.';
  if (industry) opener += ' We work with ' + industry + ' companies, so this is familiar ground.';
  lines.push('<p>' + opener + '</p>');

  if (pain || owner) {
    var read = 'From your answers, the picture is that ' + (pain || '') +
      (pain && owner ? ', and ' : '') + (owner || '') + '.';
    lines.push('<p>' + read + '</p>');
  }

  var fix = 'What we do is the front half. We build the list of every company in your area that fits, research each one, and work them on email, phone and text with a rep assigned to your account. You get the meeting, plus a page on who you are about to sit with and why they are in the market.';
  lines.push('<p>' + fix + '</p>');

  if (worth) {
    lines.push('<p>You said a customer is worth ' + worth + ' to you. That number is the whole conversation, because it decides whether this is obviously worth doing or not worth starting. I would rather work that out with you on a call than guess at it here.</p>');
  }

  lines.push('<p style="margin:22px 0;"><a href="' + esc(buildBookingUrl(row)) + '" style="display:inline-block;padding:13px 24px;background:#0A2E85;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">Pick a time on my calendar</a></p>');
  lines.push('<p>Fifteen minutes' + (soon ? ', and given you said you want to move soon I would take the earliest slot that works' : '') + '. If a call is overkill, reply here with your one question and I will answer it.</p>');
  lines.push('<p style="margin-top:26px;">Remy Leon<br/>'
    + '<span style="color:#6c6a66;font-size:13.5px;">Co-founder, STILO AI PARTNERS</span><br/>'
    + '<span style="color:#6c6a66;font-size:13.5px;">(786) 837-6639 &nbsp;&middot;&nbsp; '
    + '<a href="https://stiloaipartners.com" style="color:#6c6a66;">stiloaipartners.com</a></span></p>');

  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#0a0a0f;max-width:560px;margin:0 auto;line-height:1.6;font-size:15.5px;">'
    + lines.join('') + '</div>';
}

async function sendQuizLeadReplyEmail(row, leadId) {
  var html = buildQuizReplyHtml(row);
  // Strip line breaks so a crafted business_name can't smuggle extra headers.
  var subject = String(row.business_name || 'Your business').replace(/[\r\n]+/g, ' ').slice(0, 150) + ': what we would do first';
  // Sender: the real Workspace mailbox, so Gmail recipients
  // see a profile picture (hello@ has no Workspace mailbox, no pfp).
  // Standardised on remyleon@ 2026-07-20: every other sender falls back to it,
  // and a From address that is not a real deliverable mailbox is a reputation hit.
  var from = 'Remy Leon <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>';
  var to = row.email;
  if (!to) return { ok: false, reason: 'no_email' };

  var resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: from,
      to: to,
      reply_to: 'remyleon11@gmail.com',
      subject: subject,
      html: html,
      tags: [
        { name: 'source', value: 'quiz_complete' },
        { name: 'lead_id', value: String(leadId).slice(0, 40) }
      ]
    })
  });
  var json = await resp.json().catch(function(){ return {}; });
  if (!resp.ok) {
    console.warn('[log-lead] resend non-2xx:', resp.status, json && json.message);
    return { ok: false, error: json && json.message };
  }
  console.log('[log-lead] first-touch email sent', { lead_id: leadId, resend_id: json.id });
  return { ok: true, id: json.id };
}

module.exports = async function handleLogLead(req, res) {
  // CORS not needed — same-origin. Keep method strict.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Cross-site posts (an Origin/Referer that is not ours) are rejected. Absent
  // origin stays allowed so the site's own forms and curl keep working.
  if (!originAllowed(req)) {
    return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  var ctaType = body.cta_type;
  // 2026-05-27: added 'quiz_complete' so we capture finishers even if they
  // never click a CTA button. The Outbound Lead Reply Agent watches for these.
  var validCtas = { purchase: 1, audit: 1, quiz_complete: 1 };
  if (!validCtas[ctaType]) {
    return res.status(400).json({ ok: false, error: 'invalid_cta_type' });
  }

  var supabase = getSupabase();
  if (!supabase) {
    // Don't fail the user flow. Log server-side so we notice in Vercel logs.
    console.warn('[log-lead] Supabase env missing; lead not persisted');
    return res.status(200).json({ ok: false, error: 'storage_unavailable' });
  }

  var ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket && req.socket.remoteAddress ||
    null;

  var row = {
    cta_type: ctaType,
    contact_name: str(body.contact_name, 200),
    email: str(body.email, 320),
    phone: str(body.phone, 50),
    business_name: str(body.business_name, 200),
    website: str(body.website, 500),
    quiz_answers: body.quiz_answers && typeof body.quiz_answers === 'object' ? body.quiz_answers : {},
    tier: str(body.tier, 32),
    selected_agents: Array.isArray(body.selected_agents) ? body.selected_agents : [],
    agent_scores: body.agent_scores && typeof body.agent_scores === 'object' ? body.agent_scores : null,
    estimated_price: str(body.estimated_price, 100),
    referrer: str(body.referrer, 500),
    page_url: str(body.page_url, 500),
    ip: str(ip, 64),
    user_agent: str(req.headers['user-agent'], 500)
  };

  try {
    const { data, error } = await supabase
      .from('quiz_submissions')
      .insert(row)
      .select('id,email')
      .single();

    if (error) {
      console.error('[log-lead] insert error:', error.message, error.details, error.hint, error.code);
      return res.status(200).json({
        ok: false,
        error: 'insert_failed',
        detail: error.message,
        code: error.code,
        hint: error.hint
      });
    }

    // Outbound Lead Reply — LIVE
    // 2026-05-27 (V2): await the send so it actually completes before the
    // serverless function exits. Previous fire-and-forget was being killed
    // by Vercel after the response. Resend takes ~500ms — negligible UX hit.
    // Send on quiz_complete, audit, and purchase so every meaningful intent
    // triggers a first-touch.
    // The auto-reply only ever goes to row.email — the address in the row we
    // just inserted — and only within the daily caps (audit 2026-08-10).
    // The recipient is read back OFF THE INSERTED ROW, not off the request body,
    // so there is no path where this endpoint mails an address it did not just
    // persist. Everything else in the template still comes from `row`.
    var emailResult = null;
    var storedEmail = data && data.email;
    if (storedEmail && process.env.RESEND_API_KEY) {
      var recipient = String(storedEmail).toLowerCase();
      if (!memAllowsSend(recipient)) {
        console.warn('[log-lead] rate limit (memory): skipping email to', recipient);
        emailResult = { ok: false, reason: 'rate_limited' };
      } else if (!(await dbAllowsSend(supabase, storedEmail))) {
        console.warn('[log-lead] rate limit (db): skipping email to', recipient);
        emailResult = { ok: false, reason: 'rate_limited' };
      } else {
        memRecordSend(recipient);
        try {
          emailResult = await sendQuizLeadReplyEmail(
            Object.assign({}, row, { email: storedEmail }), data.id);
        } catch (e) {
          console.warn('[log-lead] lead-reply email failed:', e && e.message);
          emailResult = { ok: false, error: e && e.message };
        }
      }
    }

    return res.status(200).json({ ok: true, lead_id: data.id, email: emailResult });
  } catch (err) {
    console.error('[log-lead] unexpected:', err);
    return res.status(200).json({ ok: false, error: 'unexpected' });
  }
};
