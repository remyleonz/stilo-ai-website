/**
 * POST /api/prospects/mark-booked
 * Body: { lead_id, when_iso?, meet_link?, notes? }
 *
 * Marks a lead as a booked meeting WITHOUT touching the Google Calendar API.
 * Used by the "Mark as booked" button after the rep books the meeting on the
 * embedded Google Appointment Scheduling page (Google already created the event
 * + sent the invite/Meet link). The rep can pass the time + Meet link they see
 * on Google so the Booked tab shows them, even when the calendar sync (OAuth)
 * is not connected.
 *
 * Sets last_called_outcome='booked_meeting' so the lead lands on the Booked tab.
 * Never depends on OAuth — this is the reliable path.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

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
    const leadId = safeNumberId(body.lead_id);
    if (leadId == null) return res.status(400).json({ error: 'missing_lead_id' });

    // Optional, validated meeting time. If the rep didn't enter one (e.g. they
    // booked in the embed and will let the sync fill it), we leave it null and
    // sync-bookings can enrich it later.
    let whenIso = null;
    if (body.when_iso) {
        const d = new Date(body.when_iso);
        if (!isNaN(d.getTime())) whenIso = d.toISOString();
    }
    const meetLink = (body.meet_link && String(body.meet_link).trim()) || null;
    const notes = (body.notes && String(body.notes).trim()) || null;

    const sb = leadsClient();
    const { data: lead, error: readErr } = await sb.from('leads')
        .select('id, name, call_attempts, owner_email, email')
        .eq('id', leadId).maybeSingle();
    if (readErr) return res.status(500).json({ error: 'lead_read_failed', detail: readErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    const whenLabel = whenIso
        ? new Date(whenIso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET'
        : 'time TBD';

    const update = {
        last_called_outcome: 'booked_meeting',
        last_called_at: new Date().toISOString(),
        meeting_booked_by_sdr: gate.email || null,
        call_attempts: (Number(lead.call_attempts) || 0) + 1,
        call_notes: notes || ('Booked ' + whenLabel),
        updated_at: new Date().toISOString()
    };
    if (whenIso) update.meeting_scheduled_at = whenIso;
    if (meetLink) update.meeting_meet_link = meetLink;
    if (whenIso) update.meeting_duration_min = 15;

    const { error: updErr } = await sb.from('leads').update(update).eq('id', leadId);
    if (updErr) return res.status(500).json({ error: 'mark_booked_failed', detail: updErr.message });

    // Mirror into lead_calls so it shows in call history + counts as activity.
    try {
        await sb.from('lead_calls').insert({
            lead_id: leadId, direction: 'outbound', outcome: 'booked_meeting',
            called_at: new Date().toISOString(), logged_by: gate.email || null,
            transcript_summary: 'Meeting booked (' + whenLabel + ')'
        });
    } catch (_) { /* nice-to-have */ }

    return res.status(200).json({
        ok: true, lead_id: leadId,
        meeting_scheduled_at: whenIso, meeting_meet_link: meetLink
    });
};
