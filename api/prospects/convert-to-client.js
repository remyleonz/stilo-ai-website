/**
 * POST /api/prospects/convert-to-client
 * Body: { id, business_name, email, deal_value? }
 *
 * Bridges a cold lead in prospecting.leads to a paying client in
 * public.clients. Steps:
 *   1. Find or create a clients row matching {business_name, email}.
 *   2. UPDATE prospecting.leads SET client_id = clients.id, stage = 'CLOSED_WON'.
 *   3. UPDATE public.clients SET source_lead_id, deal_value, closed_at.
 *
 * Idempotent on (business_name + email). The stage transition to
 * CLOSED_WON auto-writes a lead_stage_history row via the trigger from
 * Phase 3.
 */
const { assertAdmin, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }
    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.id);
    const businessName = String(body.business_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const dealValue = body.deal_value != null ? Number(body.deal_value) : null;
    if (leadId == null || !businessName || !email) {
        return res.status(400).json({ error: 'missing_fields' });
    }

    // Two clients: one against public schema (for clients table),
    // one against prospecting (for the leads/UPDATE).
    const sbPublic = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
    const sbProspecting = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    try {
        // 1. Find existing client by email; otherwise insert.
        let clientId = null;
        const { data: existing, error: existsErr } = await sbPublic
            .from('clients')
            .select('id')
            .eq('email', email)
            .maybeSingle();
        if (existsErr) throw existsErr;
        if (existing && existing.id) {
            clientId = existing.id;
            // Update the existing client with revenue + source data.
            await sbPublic.from('clients').update({
                source_lead_id: leadId,
                deal_value: dealValue,
                closed_at: new Date().toISOString()
            }).eq('id', clientId);
        } else {
            const { data: created, error: createErr } = await sbPublic
                .from('clients')
                .insert({
                    business_name: businessName,
                    email,
                    source_lead_id: leadId,
                    deal_value: dealValue,
                    closed_at: new Date().toISOString()
                })
                .select('id')
                .single();
            if (createErr) throw createErr;
            clientId = created.id;
        }

        // 2. Link the cold lead + advance stage.
        const { error: leadErr } = await sbProspecting
            .from('leads')
            .update({ client_id: clientId, stage: 'CLOSED_WON' })
            .eq('id', leadId);
        if (leadErr) throw leadErr;

        return res.status(200).json({ ok: true, client_id: clientId, lead_id: leadId });
    } catch (e) {
        console.error('[convert-to-client]', e);
        return res.status(500).json({ error: e.message || 'unknown' });
    }
};
