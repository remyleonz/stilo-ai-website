/**
 * POST /api/prospects/meeting-transcript
 * Body: { lead_id, title?, occurred_at?, duration_seconds?, attendees?,
 *         summary?, action_items?, transcript?, meet_url?, source?,
 *         tactiq_meeting_id?, raw? }
 *
 * Stores a sales-meeting record (Tactiq summary/artifacts and/or a pasted full
 * transcript) on a lead, the meeting analog of cold-call logging. Re-ingesting
 * the same Tactiq meeting (same lead_id + tactiq_meeting_id) UPDATES the row so
 * a late-generated summary fills in without duplicating.
 *
 * This is the single sink both the manual "Add meeting transcript" form and the
 * Tactiq ingestion (assistant/cron pulling from the Tactiq MCP) write to.
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

    // Need at least one piece of content to be worth storing.
    const summary = (body.summary && String(body.summary).trim()) || null;
    const transcript = (body.transcript && String(body.transcript).trim()) || null;
    const actionItems = (body.action_items && String(body.action_items).trim()) || null;
    if (!summary && !transcript && !actionItems) {
        return res.status(400).json({ error: 'empty_meeting', detail: 'Provide a summary, action_items, or transcript.' });
    }

    let occurredAt = null;
    if (body.occurred_at) { const d = new Date(body.occurred_at); if (!isNaN(d.getTime())) occurredAt = d.toISOString(); }

    const row = {
        lead_id: leadId,
        source: (body.source === 'manual' ? 'manual' : 'tactiq'),
        tactiq_meeting_id: (body.tactiq_meeting_id && String(body.tactiq_meeting_id)) || null,
        title: (body.title && String(body.title).slice(0, 500)) || 'Sales meeting',
        occurred_at: occurredAt,
        duration_seconds: Number.isFinite(Number(body.duration_seconds)) ? Number(body.duration_seconds) : null,
        attendees: Array.isArray(body.attendees) ? body.attendees : null,
        summary: summary,
        action_items: actionItems,
        transcript: transcript,
        meet_url: (body.meet_url && String(body.meet_url)) || null,
        raw: (body.raw && typeof body.raw === 'object') ? body.raw : null,
        created_by: gate.email || null,
        updated_at: new Date().toISOString()
    };

    const sb = leadsClient();

    // Confirm the lead exists (and to attach a friendly title fallback).
    const { data: lead } = await sb.from('leads').select('id, name').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // Dedupe on (lead_id, tactiq_meeting_id): update an existing Tactiq meeting.
    if (row.tactiq_meeting_id) {
        const { data: existing } = await sb.from('lead_meetings')
            .select('id').eq('lead_id', leadId).eq('tactiq_meeting_id', row.tactiq_meeting_id).maybeSingle();
        if (existing) {
            const { data: upd, error: uErr } = await sb.from('lead_meetings')
                .update(row).eq('id', existing.id).select('id').maybeSingle();
            if (uErr) return res.status(500).json({ error: 'update_failed', detail: uErr.message });
            return res.status(200).json({ ok: true, id: upd.id, updated: true });
        }
    }

    const { data: ins, error: iErr } = await sb.from('lead_meetings').insert(row).select('id').maybeSingle();
    if (iErr) return res.status(500).json({ error: 'insert_failed', detail: iErr.message });
    return res.status(200).json({ ok: true, id: ins.id, updated: false });
};
