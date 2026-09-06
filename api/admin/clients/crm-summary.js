/**
 * GET /api/admin/clients/crm-summary?client_id=<uuid>
 *
 * One call = every KPI the client CRM header renders:
 *   client   — the clients row (name, contact, rate, engagement model)
 *   funnel   — lead counts (total / dialed / connected-ish / booked / upcoming)
 *   activity — dial + meeting volume
 *   money    — client_sales rollup (count, gross, commission by status)
 *
 * Counts use PostgREST head:true count queries (no row egress). The two
 * aggregations PostgREST can't do (sum of call_attempts, monthly sales
 * rollup) fetch narrow columns and add in JS — a client pool is a few
 * thousand rows of one int at most.
 */
const { assertAdmin, methodNotAllowed } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const clientId = req.query && req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });

    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const pros = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });

    const { data: client, error: cErr } = await pub.from('clients')
        .select('id,business_name,contact_name,email,phone,status,engagement_model,commission_pct,closed_at,source_lead_id')
        .eq('id', clientId).maybeSingle();
    if (cErr) return res.status(500).json({ error: 'client_read_failed', detail: cErr.message });
    if (!client) return res.status(404).json({ error: 'client_not_found' });

    // The client's own source lead (the lead that BECAME this client) carries
    // client_id but is STILO's sale to them, not their pipeline. Excluding it
    // keeps "meetings booked" from counting our meeting with the client.
    const srcLeadId = client.source_lead_id;
    const base = () => {
        let q = pros.from('leads').select('id', { count: 'exact', head: true }).eq('client_id', clientId);
        return srcLeadId ? q.neq('id', srcLeadId) : q;
    };
    const nowIso = new Date().toISOString();

    const [total, dialed, booked, upcoming] = await Promise.all([
        base(),
        base().not('last_called_at', 'is', null),
        base().not('meeting_booked_at', 'is', null),
        base().gt('meeting_scheduled_at', nowIso)
    ]);
    for (const r of [total, dialed, booked, upcoming]) {
        if (r.error) return res.status(500).json({ error: 'count_failed', detail: r.error.message });
    }

    // Total dials = sum of call_attempts across the pool.
    let dials = 0;
    {
        let dq = pros.from('leads')
            .select('call_attempts').eq('client_id', clientId).gt('call_attempts', 0).limit(10000);
        if (srcLeadId) dq = dq.neq('id', srcLeadId);
        const { data, error } = await dq;
        if (error) return res.status(500).json({ error: 'dials_read_failed', detail: error.message });
        for (const r of (data || [])) dials += Number(r.call_attempts) || 0;
    }

    // Sales ledger rollup.
    const { data: sales, error: sErr } = await pub.from('client_sales')
        .select('sale_date, sale_amount_cents, commission_cents, status')
        .eq('client_id', clientId).limit(2000);
    if (sErr) return res.status(500).json({ error: 'sales_read_failed', detail: sErr.message });

    const money = {
        sales_count: 0, gross_cents: 0, commission_cents: 0,
        commission_reported_cents: 0, commission_invoiced_cents: 0, commission_paid_cents: 0,
        by_month: {}
    };
    for (const s of (sales || [])) {
        money.sales_count++;
        money.gross_cents += Number(s.sale_amount_cents) || 0;
        money.commission_cents += Number(s.commission_cents) || 0;
        const bucket = 'commission_' + (s.status || 'reported') + '_cents';
        if (money[bucket] !== undefined) money[bucket] += Number(s.commission_cents) || 0;
        const mo = String(s.sale_date || '').slice(0, 7) || 'unknown';
        if (!money.by_month[mo]) money.by_month[mo] = { sales: 0, gross_cents: 0, commission_cents: 0 };
        money.by_month[mo].sales++;
        money.by_month[mo].gross_cents += Number(s.sale_amount_cents) || 0;
        money.by_month[mo].commission_cents += Number(s.commission_cents) || 0;
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        client: client,
        funnel: {
            leads: total.count || 0,
            dialed: dialed.count || 0,
            booked: booked.count || 0,
            upcoming: upcoming.count || 0
        },
        activity: { dials: dials },
        money: money
    });
};
