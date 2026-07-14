/**
 * GET /api/prospects/vsl-analytics
 *
 * Aggregates public.vsl_events into the VSL funnel for the admin Sales tab:
 * page views -> plays -> confirm opens -> confirms, plus email opens and the
 * per-agent breakdown. Also counts emails sent (prospecting.lead_messages).
 *
 * Auth: admin/SDR JWT.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const days = Math.min(Math.max(parseInt((req.query && req.query.days) || '60', 10), 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const totals = {};
    const byAgent = {};
    try {
        const { data } = await sb.from('vsl_events').select('event,agent').gte('created_at', since).limit(50000);
        (data || []).forEach(function (r) {
            const e = r.event || 'unknown';
            totals[e] = (totals[e] || 0) + 1;
            const a = r.agent || 'unknown';
            byAgent[a] = byAgent[a] || {};
            byAgent[a][e] = (byAgent[a][e] || 0) + 1;
        });
    } catch (_) { /* table may be empty */ }

    let emailSends = 0;
    try {
        const psb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
        const { count } = await psb.from('lead_messages').select('id', { count: 'exact', head: true }).gte('created_at', since);
        emailSends = count || 0;
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({ since: since, days: days, totals: totals, by_agent: byAgent, email_sends: emailSends });
};
