/**
 * POST /api/list-invoices
 *
 * Body: { access_token: "<Supabase JWT>" }
 *
 * Uses the user's Supabase JWT to identify the authed client, looks up their
 * Stripe customer by email, and returns the customer's invoice history.
 *
 * Returns:
 *   { invoices: [{ id, amount_cents, status, created_at (ISO), pdf_url, hosted_url, number }] }
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async function listInvoices(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const accessToken = body.access_token;
  if (!accessToken) {
    return res.status(401).json({ error: 'Missing access_token' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Server is missing Supabase or Stripe env vars' });
  }

  // Verify the JWT by calling auth.getUser. Using the anon key + Authorization
  // header is the recommended pattern for identifying the caller.
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: 'Bearer ' + accessToken } } }
  );

  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  const email = userData.user.email;
  if (!email) {
    return res.status(400).json({ error: 'User has no email on file' });
  }

  try {
    // Find Stripe customer(s) by email. Users who purchased multiple bundles
    // may have multiple customer records — grab all, then list invoices across.
    const customers = await stripe.customers.list({ email: email, limit: 10 });
    if (!customers || customers.data.length === 0) {
      return res.status(200).json({ invoices: [] });
    }

    const allInvoices = [];
    for (const c of customers.data) {
      const list = await stripe.invoices.list({ customer: c.id, limit: 30 });
      for (const inv of list.data) {
        allInvoices.push({
          id: inv.id,
          number: inv.number || null,
          amount_cents: inv.amount_paid || inv.amount_due || 0,
          currency: inv.currency,
          status: inv.status,
          created_at: new Date((inv.created || 0) * 1000).toISOString(),
          pdf_url: inv.invoice_pdf || null,
          hosted_url: inv.hosted_invoice_url || null,
        });
      }
    }

    allInvoices.sort(function(a, b) {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return res.status(200).json({ invoices: allInvoices });
  } catch (err) {
    console.error('[list-invoices] Stripe error:', err && err.message);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};
