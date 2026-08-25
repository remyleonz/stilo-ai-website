/**
 * /api/admin/clients/sales — the client-sales ledger behind the client CRM.
 *
 * A row = one sale the CLIENT closed (e.g. Manuel sells a laser to a medspa we
 * booked him). Our revenue is the commission snapshot on the row, never a live
 * join to clients.commission_pct — a later rate change must not retro-alter
 * history (same rule as deals.commission_pct for SDRs).
 *
 *   GET    ?client_id=<uuid>            → { results: [...] } newest first
 *   POST   { client_id, sale_date?, buyer_name?, lead_id?, description,
 *            sale_amount, commission_pct?, status?, invoice_ref?, notes? }
 *            sale_amount is DOLLARS (the form's unit); stored in cents.
 *            commission_pct defaults to the client's rate.
 *   PATCH  { id, ...fields }            → partial update (status flips, edits)
 *   DELETE ?id=<uuid>                   → remove a mis-entered row
 */
const { assertAdmin, methodNotAllowed, readJsonBody } = require('../../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

function sb() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
}

module.exports = async function handler(req, res) {
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const db = sb();

    if (req.method === 'GET') {
        const clientId = req.query && req.query.client_id;
        if (!clientId) return res.status(400).json({ error: 'missing_client_id' });
        const { data, error } = await db.from('client_sales')
            .select('*').eq('client_id', clientId)
            .order('sale_date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ results: data || [] });
    }

    if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || !body.client_id) return res.status(400).json({ error: 'missing_client_id' });
        if (!body.description || !String(body.description).trim()) {
            return res.status(400).json({ error: 'missing_description', detail: 'Say what was sold.' });
        }
        const amountDollars = Number(body.sale_amount);
        if (!isFinite(amountDollars) || amountDollars <= 0) {
            return res.status(400).json({ error: 'bad_sale_amount', detail: 'sale_amount must be a positive dollar figure.' });
        }

        // Default the commission rate from the client row so the form never
        // needs to know it, but snapshot whatever we resolve.
        let pct = Number(body.commission_pct);
        if (!isFinite(pct) || pct <= 0) {
            const { data: cl, error: clErr } = await db.from('clients')
                .select('commission_pct').eq('id', body.client_id).maybeSingle();
            if (clErr) return res.status(500).json({ error: 'client_read_failed', detail: clErr.message });
            pct = Number(cl && cl.commission_pct);
            if (!isFinite(pct) || pct <= 0) {
                return res.status(400).json({ error: 'no_commission_rate', detail: 'Client has no commission_pct set and none was passed.' });
            }
        }

        const saleCents = Math.round(amountDollars * 100);
        const row = {
            client_id: body.client_id,
            lead_id: body.lead_id != null && body.lead_id !== '' ? parseInt(body.lead_id, 10) : null,
            sale_date: body.sale_date || new Date().toISOString().slice(0, 10),
            buyer_name: (body.buyer_name || '').trim() || null,
            description: String(body.description).trim(),
            items: body.items || null,
            sale_amount_cents: saleCents,
            commission_pct: pct,
            commission_cents: Math.round(saleCents * pct / 100),
            status: body.status || 'reported',
            invoice_ref: (body.invoice_ref || '').trim() || null,
            notes: (body.notes || '').trim() || null,
            created_by: gate.email || null
        };
        const { data, error } = await db.from('client_sales').insert(row).select().maybeSingle();
        if (error) return res.status(500).json({ error: 'insert_failed', detail: error.message });
        return res.status(200).json({ ok: true, sale: data });
    }

    if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (!body || !body.id) return res.status(400).json({ error: 'missing_id' });
        const patch = { updated_at: new Date().toISOString() };
        for (const k of ['sale_date', 'buyer_name', 'description', 'status', 'invoice_ref', 'notes', 'lead_id']) {
            if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
        }
        // Amount or rate edits recompute the commission from the row's own
        // snapshot values, so the two never drift from what's displayed.
        if (body.sale_amount !== undefined || body.commission_pct !== undefined) {
            const { data: cur, error: curErr } = await db.from('client_sales')
                .select('sale_amount_cents, commission_pct').eq('id', body.id).maybeSingle();
            if (curErr || !cur) return res.status(500).json({ error: 'row_read_failed', detail: curErr && curErr.message });
            const cents = body.sale_amount !== undefined ? Math.round(Number(body.sale_amount) * 100) : cur.sale_amount_cents;
            const pct = body.commission_pct !== undefined ? Number(body.commission_pct) : Number(cur.commission_pct);
            if (!isFinite(cents) || cents <= 0 || !isFinite(pct) || pct <= 0) {
                return res.status(400).json({ error: 'bad_amount_or_pct' });
            }
            patch.sale_amount_cents = cents;
            patch.commission_pct = pct;
            patch.commission_cents = Math.round(cents * pct / 100);
        }
        const { data, error } = await db.from('client_sales').update(patch).eq('id', body.id).select().maybeSingle();
        if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });
        return res.status(200).json({ ok: true, sale: data });
    }

    if (req.method === 'DELETE') {
        const id = req.query && req.query.id;
        if (!id) return res.status(400).json({ error: 'missing_id' });
        const { error } = await db.from('client_sales').delete().eq('id', id);
        if (error) return res.status(500).json({ error: 'delete_failed', detail: error.message });
        return res.status(200).json({ ok: true });
    }

    return methodNotAllowed(res, 'GET, POST, PATCH, DELETE');
};
