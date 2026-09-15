/**
 * Phone Companion handoff.
 *
 * The SDRs dial from their PHONES (their laptops can't do calls), so the
 * laptop dialer's Space can't fire quo:// locally for them. Instead:
 *
 *   POST /api/prospects/dialer-handoff  { lead_id }
 *     Laptop, on Space: resolves the lead's phone SERVER-side (same rule as
 *     deep-link.js — the client never supplies the number) and upserts one
 *     row keyed on the rep's JWT email.
 *
 *   GET /api/prospects/dialer-handoff
 *     The rep's phone (dial/index.html) polls this and renders one big CALL
 *     button that opens the Quo app pre-dialed. Same JWT, same email, so a
 *     rep can only ever see their own handoff.
 *
 * The call itself still goes out on the rep's Quo line, so the webhook,
 * transcripts and outcome detection in the dialer are untouched.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { serviceClient, normalizePhone } = require('../openphone/_shared');

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const email = String(gate.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'no_email_on_token' });
    const sb = serviceClient(); // prospecting schema

    if (req.method === 'GET') {
        const { data, error } = await sb.from('dialer_handoff')
            .select('lead_id, e164, business, updated_at')
            .eq('rep_email', email)
            .maybeSingle();
        if (error) return res.status(500).json({ error: 'lookup_failed', detail: error.message });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(data || { lead_id: null });
    }

    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.lead_id != null ? body.lead_id : body.id);
    if (leadId == null) return res.status(400).json({ error: 'missing_lead_id' });

    const { data: lead, error: lookupErr } = await sb.from('leads')
        .select('id, name, owner_phone, phone')
        .eq('id', leadId)
        .maybeSingle();
    if (lookupErr) return res.status(500).json({ error: 'lead_lookup_failed', detail: lookupErr.message });
    const raw = lead && (lead.owner_phone || lead.phone);
    if (!lead || !raw) return res.status(404).json({ error: 'lead_not_found_or_no_phone' });

    const row = {
        rep_email: email,
        lead_id: leadId,
        e164: normalizePhone(raw),
        business: lead.name || '',
        updated_at: new Date().toISOString()
    };
    const { error } = await sb.from('dialer_handoff').upsert(row, { onConflict: 'rep_email' });
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, lead_id: leadId });
};
