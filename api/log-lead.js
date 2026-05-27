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

// Map quiz agent id -> friendly name used in the first-touch email
var AGENT_NAME = {
  'receptionist': 'AI Receptionist',
  'lead-response': 'Outbound Lead Reply Agent',
  'reactivation': 'Lost Customer Reactivation Agent',
  'lead-gen': 'Lead Generator',
  'website': 'Website Builder',
  'seo': 'AI SEO',
  'growth-intel': 'Growth Intelligence',
  'sales-coach': 'AI Sales Manager',
  'custom': 'Custom Automations'
};

function firstName(full) {
  if (!full) return 'there';
  return String(full).trim().split(/\s+/)[0] || 'there';
}

function buildQuizReplyHtml(row) {
  var name = firstName(row.contact_name);
  var biz = row.business_name || 'your business';
  var agents = (row.selected_agents || []).map(function(id){ return AGENT_NAME[id] || id; });
  var agentList = agents.length
    ? '<ul style="margin:14px 0 14px 18px;padding:0;color:#0a0a0f;">' +
        agents.map(function(a){ return '<li style="margin:6px 0;font-size:15px;">' + a + '</li>'; }).join('') +
      '</ul>'
    : '';
  var calendly = 'https://calendly.com/remyleon11/30min';
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#0a0a0f;max-width:560px;margin:0 auto;line-height:1.6;font-size:15px;">',
    '<p>Hey ' + name + ',</p>',
    '<p>Remy here, founder of STILO AI Partners. Saw you just ran our quiz for ' + biz + ' — appreciate you taking the time.</p>',
    '<p>Based on what you shared, the three agents that would move the needle fastest for you:</p>',
    agentList,
    '<p>I wrote those out for you because they\'re the same three I would actually recommend in an audit call. Most owners think they need all nine. They don\'t. We get faster ROI starting with the right three.</p>',
    '<p>I\'d love to walk you through what we\'d build, plus the realistic numbers for your business. Fifteen minutes, no slide deck, no pressure.</p>',
    '<p style="margin:22px 0;"><a href="' + calendly + '" style="display:inline-block;padding:13px 24px;background:#1E3A8A;color:white;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Book a 15-minute call with Remy</a></p>',
    '<p>If a call is overkill, just reply to this email with your top question. I read every one.</p>',
    '<p>— Remy<br/><span style="color:#6c6a66;font-size:14px;">Founder, STILO AI Partners</span><br/><a href="https://stiloaipartners.com" style="color:#1E3A8A;font-size:14px;">stiloaipartners.com</a></p>',
    '</div>'
  ].join('');
}

async function sendQuizLeadReplyEmail(row, leadId) {
  var html = buildQuizReplyHtml(row);
  var subject = 'Quick note about ' + (row.business_name || 'your business');
  var from = 'Remy from STILO <hello@stiloaipartners.com>';
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
      .select('id')
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
    // 2026-05-27: on every quiz_complete, send a personalized first-touch
    // email via Resend within seconds. Fire-and-forget so the recommendation
    // screen doesn't wait on Resend's API.
    if (ctaType === 'quiz_complete' && row.email && process.env.RESEND_API_KEY) {
      // Run async without await — user gets their result page instantly
      sendQuizLeadReplyEmail(row, data.id).catch(function(e){
        console.warn('[log-lead] lead-reply email failed:', e && e.message);
      });
    }

    return res.status(200).json({ ok: true, lead_id: data.id });
  } catch (err) {
    console.error('[log-lead] unexpected:', err);
    return res.status(200).json({ ok: false, error: 'unexpected' });
  }
};
