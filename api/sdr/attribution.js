/**
 * GET  /api/sdr/attribution?client_id=<uuid>
 *   Look up a client's current attribution row (admin only).
 *
 * POST /api/sdr/attribution
 *   Body: { client_id, sdr_id, upfront_fee_cents?, monthly_retainer_cents?,
 *           commission_pct?, source_lead_id?, role? }
 *   Admin-only: assign or reassign an SDR to a client. Upserts on
 *   (client_id, role) — defaults to 'primary'. Snapshots commission_pct
 *   from the SDR's current rate if not provided.
 *
 * DELETE /api/sdr/attribution?client_id=<uuid>&role=primary
 *   Admin-only: remove an attribution row.
 */
const { authSdr, methodNotAllowed, readJsonBody } = require('./_shared');

module.exports = async function handler(req, res) {
    const caller = await authSdr(req, res);
    if (!caller.ok) return;

    if (req.method === 'GET') {
        const clientId = req.query && req.query.client_id;
        if (!clientId) return res.status(400).json({ error: 'client_id_required' });
        if (!caller.isAdmin) return res.status(403).json({ error: 'admin_only' });

        const { data, error } = await caller.sb
            .from('client_attribution')
            .select(`
                *,
                sdr_users ( id, display_name, sdr_key, initials, avatar_color, email, commission_pct, commission_mrr_pct )
            `)
            .eq('client_id', clientId)
            .order('role', { ascending: true });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ attributions: data || [] });
    }

    if (req.method === 'POST') {
        if (!caller.isAdmin) return res.status(403).json({ error: 'admin_only' });
        const body = await readJsonBody(req);
        const clientId = body.client_id;
        const sdrId = body.sdr_id;
        if (!clientId || !sdrId) return res.status(400).json({ error: 'client_id_and_sdr_id_required' });

        // Snapshot commission rates from SDR if not provided
        let commissionPct = body.commission_pct;
        let commissionMrrPct = body.commission_mrr_pct;
        if (commissionPct == null || commissionMrrPct == null) {
            const { data: sdr } = await caller.sb
                .from('sdr_users')
                .select('commission_pct, commission_mrr_pct')
                .eq('id', sdrId)
                .maybeSingle();
            if (commissionPct == null) commissionPct = sdr ? Number(sdr.commission_pct) : 0.25;
            if (commissionMrrPct == null) commissionMrrPct = sdr && sdr.commission_mrr_pct != null ? Number(sdr.commission_mrr_pct) : 0.10;
        }

        const role = body.role || 'primary';
        const payload = {
            client_id: clientId,
            sdr_id: sdrId,
            role,
            source_lead_id: body.source_lead_id || null,
            upfront_fee_cents: body.upfront_fee_cents != null ? parseInt(body.upfront_fee_cents, 10) : 0,
            monthly_retainer_cents: body.monthly_retainer_cents != null ? parseInt(body.monthly_retainer_cents, 10) : 0,
            commission_pct: commissionPct,
            commission_mrr_pct: commissionMrrPct,
            payout_status: body.payout_status || 'pending',
            notes: (body.notes || '').toString().slice(0, 1000) || null,
            updated_at: new Date().toISOString()
        };

        // Upsert by (client_id, role)
        const { data: existing } = await caller.sb
            .from('client_attribution')
            .select('id')
            .eq('client_id', clientId)
            .eq('role', role)
            .maybeSingle();

        let result;
        if (existing) {
            const { data, error } = await caller.sb
                .from('client_attribution')
                .update(payload)
                .eq('id', existing.id)
                .select('*')
                .single();
            if (error) return res.status(500).json({ error: error.message });
            result = data;
        } else {
            const { data, error } = await caller.sb
                .from('client_attribution')
                .insert(payload)
                .select('*')
                .single();
            if (error) return res.status(500).json({ error: error.message });
            result = data;
        }
        return res.status(200).json({ attribution: result });
    }

    if (req.method === 'DELETE') {
        if (!caller.isAdmin) return res.status(403).json({ error: 'admin_only' });
        const clientId = req.query && req.query.client_id;
        const role = (req.query && req.query.role) || 'primary';
        if (!clientId) return res.status(400).json({ error: 'client_id_required' });
        const { error } = await caller.sb
            .from('client_attribution')
            .delete()
            .eq('client_id', clientId)
            .eq('role', role);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return methodNotAllowed(res, 'GET, POST, DELETE');
};
