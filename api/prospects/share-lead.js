/**
 * POST /api/prospects/share-lead
 * Body: { lead_id, to, note? }
 *
 * Shares a lead with another user (SDR or admin). The lead lands on the
 * recipient's "Shared with me" view (SDR Leads tab / admin prospects). `to`
 * accepts a full email or an sdr_key (luke/jack/alejandro/remy). One active
 * share per (lead, recipient) — re-sharing updates the note.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId, resolveAssignedTo } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.lead_id != null ? body.lead_id : body.id);
    if (leadId == null) return res.status(400).json({ error: 'missing_lead_id' });

    let toEmail = await resolveAssignedTo(body.to);
    if (!toEmail) return res.status(400).json({ error: 'unknown_recipient', detail: 'Pass a valid email or sdr_key.' });
    toEmail = toEmail.toLowerCase();
    const fromEmail = (gate.email || '').toLowerCase();
    if (toEmail === fromEmail) return res.status(400).json({ error: 'cannot_share_with_self' });

    // Pull the business name so the recipient's list reads nicely even before
    // the full lead loads.
    let businessName = null;
    try {
        const lc = leadsClient();
        const { data: lead } = await lc.from('leads').select('name').eq('id', leadId).maybeSingle();
        businessName = (lead && lead.name) || null;
    } catch (_) { /* name is cosmetic */ }

    const sb = publicClient();
    const note = (body.note && String(body.note).trim().slice(0, 500)) || null;

    // Manual upsert on the partial-unique (lead_id, recipient, active).
    const { data: existing } = await sb.from('lead_shares')
        .select('id')
        .eq('lead_id', leadId)
        .ilike('shared_to_email', toEmail)
        .eq('status', 'active')
        .maybeSingle();

    if (existing && existing.id) {
        const { error } = await sb.from('lead_shares')
            .update({ note: note, business_name: businessName, shared_by_email: fromEmail, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        if (error) return res.status(500).json({ error: 'share_update_failed', detail: error.message });
        return res.status(200).json({ ok: true, shared_to: toEmail, updated: true });
    }

    const { error } = await sb.from('lead_shares').insert({
        lead_id: leadId,
        business_name: businessName,
        shared_by_email: fromEmail,
        shared_to_email: toEmail,
        note: note,
        status: 'active'
    });
    if (error) return res.status(500).json({ error: 'share_failed', detail: error.message });
    return res.status(200).json({ ok: true, shared_to: toEmail });
};
