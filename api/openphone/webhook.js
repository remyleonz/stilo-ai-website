/**
 * POST /api/openphone/webhook
 *
 * OpenPhone delivers post-call events here:
 *   - call.completed                (final outcome, duration, participants)
 *   - call.recording.completed      (recording_url ready)
 *   - call.transcript.completed     (transcript text ready)
 *   - call.summary.completed        (AI summary ready)
 *
 * Each fires independently. We upsert into public.prospect_calls keyed on
 * `openphone_call_id` so the row gets enriched as each piece lands. After
 * call.completed we also stamp the parent prospect's status + last_called_at
 * so the row drops out of "Cold Call Ready" and into the right bucket.
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

async function findOrStubProspect(sb, phone) {
    if (!phone) return null;
    const norm = normalizePhone(phone);
    const { data: existing } = await sb
        .from('prospects')
        .select('id')
        .eq('owner_phone', norm)
        .maybeSingle();
    if (existing && existing.id) return existing.id;
    const { data: created, error } = await sb
        .from('prospects')
        .insert({
            business_name: 'Unknown caller (' + norm + ')',
            owner_phone: norm,
            status: 'callback',
            tier: 'COOL',
            callback_reason: 'inbound_unknown'
        })
        .select('id')
        .single();
    if (error) {
        console.error('[openphone/webhook] failed to stub prospect:', error);
        return null;
    }
    return created.id;
}

async function upsertCall(sb, fields) {
    const { data, error } = await sb
        .from('prospect_calls')
        .upsert(fields, { onConflict: 'openphone_call_id' })
        .select('id, prospect_id, outcome, called_at')
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
        .from('prospect_calls')
        .select('id, prospect_id')
        .eq('openphone_call_id', openphoneCallId)
        .maybeSingle();

    let prospectId = existingRow && existingRow.prospect_id;
    if (!prospectId) {
        const metaProspectId = (call.metadata && (call.metadata.prospect_id || call.metadata.prospectId)) || null;
        if (metaProspectId) {
            prospectId = Number(metaProspectId) || null;
        }
        if (!prospectId && counterparty) {
            prospectId = await findOrStubProspect(sb, counterparty);
        }
    }
    if (prospectId) baseFields.prospect_id = prospectId;

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

        if (baseFields.outcome) {
            const updates = { last_called_at: baseFields.called_at, updated_at: new Date().toISOString() };
            if (baseFields.outcome === 'missed_inbound') {
                updates.status = 'callback';
                updates.callback_reason = 'missed_inbound';
                updates.next_callback_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            } else if (baseFields.outcome === 'voicemail' || baseFields.outcome === 'no_answer') {
                updates.status = 'callback';
                updates.callback_reason = baseFields.outcome;
                updates.next_callback_at = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
            } else if (baseFields.outcome === 'answered') {
                updates.status = 'called';
            }
            if (callRow.prospect_id) {
                await sb.from('prospects').update(updates).eq('id', callRow.prospect_id);
            }
        }

        return res.status(200).json({ ok: true, call_id: openphoneCallId, prospect_id: callRow.prospect_id });
    } catch (e) {
        console.error('[openphone/webhook] processing error:', e);
        return res.status(500).json({ error: 'webhook_processing_failed', detail: String(e.message || e) });
    }
};
