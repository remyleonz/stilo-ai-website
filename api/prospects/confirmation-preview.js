/**
 * GET /api/prospects/confirmation-preview?lead_id=123&agent=reactivation&when_iso=...
 *
 * The exact confirmation email that will be sent, so the rep can read it and
 * edit it in the booking modal BEFORE the meeting is booked.
 *
 * Built by _confirmation_email.js, the same module send-confirmations.js uses.
 * That is the whole point: a preview generated from its own copy of the wording
 * would let a rep approve one email while the prospect receives another.
 *
 * `agent` is the rep's live dropdown selection, which has not been saved yet, so
 * it overrides the lead's stored pitch_agent. Changing the dropdown re-fetches
 * and the copy changes with it (the VSL link is agent-specific).
 *
 * If the rep has already edited this lead's email, their saved version comes
 * back instead of the template, flagged with edited:true.
 *
 * Auth: admin/SDR JWT.
 */
const { assertAdminOrSdr, methodNotAllowed, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { buildConfirmation } = require('./_confirmation_email');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const leadId = safeNumberId(q.lead_id || q.id);
    if (!leadId) return res.status(400).json({ error: 'bad_lead_id' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const { data: lead, error } = await sb.from('leads')
        .select('id,name,address,owner_name,owner_email,email,niche,category,pitch_agent,matched_product_name,meeting_scheduled_at,meeting_booked_by_sdr,confirmation_email_subject,confirmation_email_body')
        .eq('id', leadId).maybeSingle();
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // Sign the email off with the rep who is actually booking it, which is
    // whoever is looking at this modal.
    let repName = 'Remy';
    try {
        const who = (gate.email || lead.meeting_booked_by_sdr || '').toLowerCase();
        if (who) {
            const { data: sdr } = await pub.from('sdr_users').select('display_name').eq('email', who).maybeSingle();
            if (sdr && sdr.display_name) repName = sdr.display_name.split(/\s+/)[0];
        }
    } catch (_) { /* fall back to Remy */ }

    // when_iso lets the modal preview the slot the rep just picked, before it is
    // written to the lead. Without it the date line would show the OLD meeting
    // time (or none at all on a first booking).
    const built = buildConfirmation({
        lead: lead,
        agent: q.agent || null,
        whenIso: q.when_iso || lead.meeting_scheduled_at || null,
        repName: repName,
    });

    const edited = !!(lead.confirmation_email_subject || lead.confirmation_email_body);

    return res.status(200).json({
        lead_id: lead.id,
        to: built.to,
        slug: built.slug,
        // What will actually go out: the rep's edit if there is one, else the template.
        subject: lead.confirmation_email_subject || built.subject,
        body: lead.confirmation_email_body || built.body,
        // The clean generated version, so the UI can offer "reset to default".
        default_subject: built.subject,
        default_body: built.body,
        edited: edited,
    });
};
