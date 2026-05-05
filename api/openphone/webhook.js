/**
 * POST /api/openphone/webhook
 *
 * OpenPhone (now Quo) delivers post-call events here:
 *   - call.completed                (final outcome, duration, participants)
 *   - call.recording.completed      (recording_url ready)
 *   - call.transcript.completed     (transcript text ready)
 *   - call.summary.completed        (AI summary ready)
 *
 * Each fires independently. We upsert into prospecting.lead_calls keyed on
 * openphone_call_id so the row gets enriched as each piece lands. After
 * call.completed we also stamp the parent lead's last_called_at +
 * last_called_outcome (David's column names) so the row drops out of "Cold
 * Call Ready" and into the right bucket.
 *
 * Public endpoint — admin gate would block OpenPhone. Auth is the HMAC
 * signature on the body; reject anything that doesn't verify.
 */

const { verifySignature, readRawBody, serviceClient, normalizePhone } = require('./_shared');

function deriveOutcome(callPayload) {
    const status = callPayload.status || callPayload.completedReason || '';
    const direction = callPayload.direction || 'outbound';
    const answered = callPayload.answeredAt != null
        || (callPayload.duration != null && callPayload.duration > 5)
        || status === 'completed' || status === 'answered';
    if (direction === 'inbound' && !answered) return 'missed_inbound';
    if (status === 'voicemail' || callPayload.voicemail) return 'voicemail';
    if (!answered) return 'no_answer';
    return 'answered';
}

async function findOrStubLead(sb, phone) {
    if (!phone) return null;
    const norm = normalizePhone(phone);
    // David's leads table uses both `owner_phone` and `phone` (business line).
    // Match on either.
    const { data: existing } = await sb
        .from('leads')
        .select('id')
        .or('owner_phone.eq.' + norm + ',phone.eq.' + norm)
        .maybeSingle();
    if (existing && existing.id) return existing.id;
    // Stub a minimal lead row so inbound missed calls don't get dropped.
    const { data: created, error } = await sb
        .from('leads')
        .insert({
            name: 'Unknown caller (' + norm + ')',
            owner_phone: norm,
            phone: norm,
            tier: 'cold',
            outreach_status: 'not_contacted',
            pipeline_status: 'inbound_unknown'
        })
        .select('id')
        .single();
    if (error) {
        console.error('[openphone/webhook] failed to stub lead:', error);
        return null;
    }
    return created.id;
}

async function upsertCall(sb, fields) {
    const { data, error } = await sb
        .from('lead_calls')
        .upsert(fields, { onConflict: 'openphone_call_id' })
        .select('id, lead_id, outcome, called_at')
        .single();
    if (error) throw error;
    return data;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'method_not_allowed' });
    }

    const raw = await readRawBody(req);
    const sigHeader = req.headers['openphone-signature']
        || req.headers['x-openphone-signature']
        || req.headers['openphone-webhook-signature']
        || '';

    if (!verifySignature(sigHeader, raw)) {
        console.warn('[openphone/webhook] signature verification failed');
        return res.status(401).json({ error: 'invalid_signature' });
    }

    let evt;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    const type = evt.type || evt.event || '';
    const data = evt.data || evt.payload || evt.object || evt;
    const call = data.object || data.call || data;
    const openphoneCallId = call.id || call.callId || call.call_id;

    if (!openphoneCallId) {
        console.warn('[openphone/webhook] no call id in event:', type);
        return res.status(202).json({ ok: true, ignored: 'no_call_id' });
    }

    const sb = serviceClient();
    const direction = call.direction || 'outbound';
    const fromNumber = call.from || (call.participants && call.participants[0]) || null;
    const toNumber = call.to || (call.participants && call.participants[1]) || null;
    const counterparty = direction === 'inbound' ? fromNumber : toNumber;

    const baseFields = {
        openphone_call_id: openphoneCallId,
        direction: direction,
        from_number: fromNumber ? normalizePhone(fromNumber) : null,
        to_number: toNumber ? normalizePhone(toNumber) : null,
        called_at: call.createdAt || call.startedAt || new Date().toISOString(),
        raw_payload: evt
    };

    if (call.userId || call.metadata) {
        baseFields.logged_by = (call.metadata && call.metadata.logged_by) || null;
    }

    const { data: existingRow } = await sb
        .from('lead_calls')
        .select('id, lead_id')
        .eq('openphone_call_id', openphoneCallId)
        .maybeSingle();

    let leadId = existingRow && existingRow.lead_id;
    if (!leadId) {
        // Resolution order:
        //  1. metadata.lead_id / prospect_id (when an admin-side flow eventually triggers a call)
        //  2. contact.externalId tag "stilo_lead_<id>" (set by the autosync trigger when pushing
        //     HOT leads to Quo as contacts — reliable across Mac/iPhone/web clients)
        //  3. phone-number match against owner_phone or business phone
        const metaLeadId = (call.metadata && (call.metadata.lead_id || call.metadata.leadId
            || call.metadata.prospect_id || call.metadata.prospectId)) || null;
        if (metaLeadId) {
            leadId = Number(metaLeadId) || null;
        }
        if (!leadId) {
            const contact = call.contact || (data && data.contact) || null;
            const externalId = contact && (contact.externalId || (contact.externalIds && contact.externalIds[0])) || '';
            const m = String(externalId).match(/^stilo_(?:lead|prospect)_(\d+)$/);
            if (m) leadId = Number(m[1]) || null;
        }
        if (!leadId && counterparty) {
            leadId = await findOrStubLead(sb, counterparty);
        }
    }
    if (leadId) baseFields.lead_id = leadId;

    try {
        if (type === 'call.completed' || type === 'call.ended' || type === 'call.summary.completed') {
            baseFields.duration_seconds = call.duration || call.durationSeconds || null;
            baseFields.outcome = deriveOutcome(call);
            if (data.summary || (call.summary && call.summary.text)) {
                baseFields.transcript_summary = data.summary || call.summary.text;
            }
        } else if (type === 'call.recording.completed' || (call.recording && call.recording.url)) {
            baseFields.recording_url = (data.recording && data.recording.url)
                || (call.recording && call.recording.url)
                || data.url || null;
        } else if (type === 'call.transcript.completed' || data.transcript) {
            const transcript = data.transcript || (call.transcript && call.transcript.text) || null;
            if (typeof transcript === 'string') baseFields.transcript = transcript;
            else if (Array.isArray(transcript)) {
                baseFields.transcript = transcript.map(function (seg) {
                    return (seg.speaker || seg.user || '?') + ': ' + (seg.text || seg.content || '');
                }).join('\n');
            }
        }

        const callRow = await upsertCall(sb, baseFields);

        if (baseFields.outcome && callRow.lead_id) {
            // David's leads table tracks last_called_at + last_called_outcome
            // + call_attempts + next_action_due_at directly on the row.
            const updates = {
                last_called_at: baseFields.called_at,
                last_called_outcome: baseFields.outcome,
                call_attempts: 1, // backend will increment via its own logic; use 1 as a floor
                updated_at: new Date().toISOString()
            };
            if (baseFields.outcome === 'missed_inbound') {
                updates.next_action_type = 'callback';
                updates.next_action_due_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            } else if (baseFields.outcome === 'voicemail' || baseFields.outcome === 'no_answer') {
                updates.next_action_type = 'callback';
                updates.next_action_due_at = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
            }
            await sb.from('leads').update(updates).eq('id', callRow.lead_id);
        }

        return res.status(200).json({ ok: true, call_id: openphoneCallId, lead_id: callRow.lead_id });
    } catch (e) {
        console.error('[openphone/webhook] processing error:', e);
        return res.status(500).json({ error: 'webhook_processing_failed', detail: String(e.message || e) });
    }
};
