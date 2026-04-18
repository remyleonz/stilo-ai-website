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
  if (ctaType !== 'purchase' && ctaType !== 'audit') {
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
    quiz_answers: body.quiz_answers && typeof body.quiz_answers === 'object' ? body.quiz_answers : {},
    tier: str(body.tier, 32),
    selected_agents: Array.isArray(body.selected_agents) ? body.selected_agents : [],
    estimated_price: str(body.estimated_price, 100),
    referrer: str(body.referrer, 500),
    page_url: str(body.page_url, 500),
    ip: str(ip, 64),
    user_agent: str(req.headers['user-agent'], 500)
  };

  try {
    const { data, error } = await supabase
      .from('leads')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[log-lead] insert error:', error.message);
      return res.status(200).json({ ok: false, error: 'insert_failed' });
    }
    return res.status(200).json({ ok: true, lead_id: data.id });
  } catch (err) {
    console.error('[log-lead] unexpected:', err);
    return res.status(200).json({ ok: false, error: 'unexpected' });
  }
};
