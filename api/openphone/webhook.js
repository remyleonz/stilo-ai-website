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

const { verifySignature, readRawBody, serviceClient, publicClient, normalizePhone, openphoneFetch } = require('./_shared');

function deriveOutcome(callPayload) {
    const status = callPayload.status || callPayload.completedReason || '';
    const direction = callPayload.direction || 'outbound';
    const answered = callPayload.answeredAt != null
        || (callPayload.duration != null && callPayload.duration > 5)
        || status === 'answered';
    // Voicemail check comes BEFORE the generic answered check because Quo
    // ships voicemail-only calls with status='completed' + voicemail=true.
    if (status === 'voicemail' || callPayload.voicemail) return 'voicemail';
    if (direction === 'inbound' && !answered) return 'missed_inbound';
    if (!answered) return 'no_answer';
    return 'answered';
}

// Quo doesn't ship a `duration` field on the call.completed event — only
// `answeredAt` + `completedAt` (and `createdAt` for the ring window). Derive
// talk-time in seconds. For unanswered calls return 0 so the agent can
// distinguish "instant dismissal / VM" from "real conversation."
function deriveDurationSeconds(callPayload) {
    const completed = callPayload.completedAt || callPayload.endedAt;
    const answered = callPayload.answeredAt;
    if (!completed) return null;
    if (!answered) return 0;  // never picked up → no talk time
    const ms = new Date(completed).getTime() - new Date(answered).getTime();
    if (!isFinite(ms) || ms < 0) return null;
    return Math.round(ms / 1000);
}

// Lightweight Spanish-vs-English classifier for transcript text. Conservative:
// returns 'es' only when there's strong signal (3+ unique Spanish markers
// OR a Spanish-only character), otherwise 'en' for any non-trivial English
// transcript, otherwise null. The dashboard manual override always wins.
const SPANISH_WORDS = ['hola','gracias','sí','está','tiene','buenos días','buenas tardes','cómo está','cómo estás','español','claro que sí','muchas gracias','por favor','mucho gusto','perdón','disculpe','dígame','permítame','dispense','de nada','llamo','llamando','negocio','dueño','propietario','¿cómo','¿qué','¿dónde','¿cuándo','está bien','está usted','no entiendo','no problema'];
function detectLanguage(transcript) {
    if (!transcript || typeof transcript !== 'string') return null;
    const t = transcript.toLowerCase();
    if (t.length < 50) return null;
    // Distinctly Spanish characters — any single one is strong signal.
    if (/[ñ¿¡]/.test(transcript)) return 'es';
    let hits = 0;
    for (const w of SPANISH_WORDS) {
        if (t.indexOf(w) !== -1) hits++;
        if (hits >= 3) return 'es';
    }
    return 'en';
}

async function findOrStubLead(sb, phone) {
    if (!phone) return null;
    const norm = normalizePhone(phone);
    if (!norm) return null;
    // David's pipeline stores phones as (XXX) XXX-XXXX; also query E.164.
    // JSON.stringify produces the double-quoted form PostgREST needs for values
    // containing special chars like parentheses and spaces.
    const digits10 = norm.startsWith('+1') ? norm.slice(2) : null;
    const fmt = digits10 && digits10.length === 10
        ? '(' + digits10.slice(0, 3) + ') ' + digits10.slice(3, 6) + '-' + digits10.slice(6)
        : null;
    const fmtCond = fmt
        ? ',owner_phone.eq.' + JSON.stringify(fmt) + ',phone.eq.' + JSON.stringify(fmt)
        : '';
    // limit(1) (not maybeSingle) on purpose: some numbers appear on 2+ duplicate
    // lead rows, and maybeSingle throws on >1 match — which used to orphan the
    // call (lead_id=null) instead of attributing it. Take the first match.
    const { data: existingRows } = await sb
        .from('leads')
        .select('id')
        .or('owner_phone.eq.' + norm + ',phone.eq.' + norm + fmtCond)
        .order('id', { ascending: true })
        .limit(1);
    if (existingRows && existingRows[0] && existingRows[0].id) return existingRows[0].id;
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

// Reverse-merge target finder. When Quo's webhook arrives for a call but
// the SDR already logged the disposition manually (within the last hour
// for this lead, no openphone_call_id, with a human outcome), we treat
// the manual row as the merge target instead of inserting a duplicate.
//
// Bound at 1 hour because Quo's events usually land within seconds; a
// human row from yesterday is a different call event. AUTO_OUTCOMES are
// excluded because rows with those outcomes were written by some other
// webhook delivery, not a deliberate manual log.
const AUTO_OUTCOMES = new Set(['answered', 'voicemail', 'no_answer', 'missed_inbound']);
async function findRecentManualMergeTarget(sb, leadId) {
    if (!leadId) return null;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: rows } = await sb.from('lead_calls')
        .select('id, outcome, called_at')
        .eq('lead_id', leadId)
        .is('openphone_call_id', null)
        .gte('called_at', oneHourAgo)
        .order('called_at', { ascending: false })
        .limit(5);
    if (!rows || rows.length === 0) return null;
    return rows.find(r => r.outcome && !AUTO_OUTCOMES.has(r.outcome)) || null;
}

// Merge Quo's enrichment onto an existing manual row. Human outcome +
// notes are preserved (the SDR's judgment beats Quo's auto-derivation);
// everything else (transcript, summary, recording, duration, timestamps,
// openphone_call_id, raw_payload) gets stamped in.
async function mergeQuoIntoManualRow(sb, rowId, baseFields) {
    const enrich = Object.assign({}, baseFields);
    delete enrich.outcome;
    delete enrich.notes;
    const { data, error } = await sb.from('lead_calls')
        .update(enrich)
        .eq('id', rowId)
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

    // Primary auth: a secret token in the webhook URL (?token=...). Quo's HMAC
    // signature scheme proved impossible to reproduce reliably (their docs are
    // vague and a byte-exact body still wouldn't verify), so we authenticate
    // the webhook by a shared secret in the URL that only we and Quo know. HMAC
    // still works as a fallback if it ever verifies. The token is rotatable via
    // OPENPHONE_WEBHOOK_TOKEN + re-pointing the webhooks.
    function getUrlToken() {
        if (req.query && req.query.token) return String(req.query.token);
        try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; }
        catch (_) { return ''; }
    }
    const expectedToken = process.env.OPENPHONE_WEBHOOK_TOKEN || '';
    const urlToken = getUrlToken();
    const tokenOk = !!expectedToken && urlToken.length === expectedToken.length
        && (function () { try { return require('crypto').timingSafeEqual(Buffer.from(urlToken), Buffer.from(expectedToken)); } catch (_) { return false; } })();

    if (!tokenOk && !verifySignature(sigHeader, raw)) {
        // SIGFAIL diagnostic (2026-06-03): real call.completed events 401 while
        // transcript/summary pass, even though all 3 keys are in the secret and
        // a manually-forged K1 event verifies. Log, per key, whether our
        // canonical HMAC matches the received signature so we can see if this is
        // a key, scheme, or raw-body-bytes problem. Remove once root-caused.
        try {
            const crypto = require('crypto');
            const bodyStr = raw.toString('utf8');
            let pTs = null, pSig = null;
            if (sigHeader.indexOf(';') !== -1) { const p = sigHeader.split(';'); pTs = p[2]; pSig = (p[3] || '').trim(); }
            const secrets = (process.env.OPENPHONE_WEBHOOK_SIGNING_SECRET || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
            const diag = secrets.map(function (k, i) {
                const withTs = crypto.createHmac('sha256', Buffer.from(k, 'base64')).update((pTs ? pTs + '.' : '') + bodyStr).digest('base64');
                const noTs = crypto.createHmac('sha256', Buffer.from(k, 'base64')).update(bodyStr).digest('base64');
                const rawKey = crypto.createHmac('sha256', k).update((pTs ? pTs + '.' : '') + bodyStr).digest('base64');
                return { i: i, key_head: k.slice(0, 6), match_withTs: withTs === pSig, match_noTs: noTs === pSig, match_rawKey: rawKey === pSig, computed_head: withTs.slice(0, 8) };
            });
            const detail = {
                evt_type: (function () { try { var b = JSON.parse(bodyStr); return b.type || (b.object && b.object.type) || '?'; } catch (_) { return '?'; } })(),
                sig_header: sigHeader,
                content_type: req.headers['content-type'] || null,
                body_len: raw.length,
                recv_sig_head: (pSig || '').slice(0, 8),
                body_b64: raw.toString('base64'),
                diag: diag
            };
            console.warn('[openphone/webhook] SIGFAIL ' + JSON.stringify(detail));
            // Persist so we can read the full diagnostic (Vercel log viewer
            // truncates). MUST await: serverless freezes after the response, so
            // a fire-and-forget insert never lands. Temporary; remove after fix.
            try { await publicClient().from('webhook_debug').insert({ detail: detail }); } catch (_) {}
        } catch (e) { console.warn('[openphone/webhook] SIGFAIL diag error', e && e.message); }
        return res.status(401).json({ error: 'invalid_signature' });
    }

    let evt;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    const type = evt.type || evt.event || '';
    const data = evt.data || evt.payload || evt.object || evt;
    const sb = serviceClient();

    // Message events (SMS/MMS) flow into prospecting.lead_messages, NOT
    // lead_calls. Quo sends message.received + message.delivered.
    if (type && type.indexOf('message.') === 0) {
        const msg = data.object || data.message || data;
        const direction = type === 'message.received' ? 'inbound' : 'outbound';
        const fromN = msg.from || (msg.participants && msg.participants[0]) || null;
        const toN   = msg.to   || (msg.participants && msg.participants[1]) || null;
        const counterparty = direction === 'inbound' ? fromN : toN;
        let mLeadId = null;
        if (counterparty) {
            const normCounterparty = normalizePhone(counterparty);
            if (normCounterparty) {
                const { data: lead } = await sb
                    .from('leads')
                    .select('id, assigned_to')
                    .or('owner_phone.eq.' + normCounterparty + ',phone.eq.' + normCounterparty)
                    .maybeSingle();
                if (lead) mLeadId = lead.id;
            }
        }
        const body = msg.body || msg.text || msg.content || '';
        const messageRow = {
            lead_id: mLeadId,
            direction,
            channel: 'sms',
            body,
            body_preview: body.slice(0, 280),
            sent_at: msg.createdAt || msg.sentAt || msg.deliveredAt || new Date().toISOString(),
            to_address: toN ? normalizePhone(toN) : null,
            from_address: fromN ? normalizePhone(fromN) : null,
            provider: 'openphone',
            provider_message_id: msg.id || msg.messageId || null,
            status: type === 'message.delivered' ? 'delivered' : 'received',
            raw_payload: evt
        };
        try {
            const { error: msgErr } = await sb.from('lead_messages').insert(messageRow);
            if (msgErr && msgErr.code !== '23505') throw msgErr; // ignore dup-on-key collisions
            return res.status(200).json({ ok: true, channel: 'sms', lead_id: mLeadId });
        } catch (e) {
            console.error('[openphone/webhook] message insert failed', e);
            return res.status(202).json({ ok: true, error: e.message });
        }
    }

    const call = data.object || data.call || data;
    const openphoneCallId = call.callId || call.call_id || call.id;

    if (!openphoneCallId) {
        console.warn('[openphone/webhook] no call id in event:', type);
        return res.status(202).json({ ok: true, ignored: 'no_call_id' });
    }
    const direction = call.direction || 'outbound';
    const fromNumber = call.from || (call.participants && call.participants[0]) || null;
    const toNumber = call.to || (call.participants && call.participants[1]) || null;
    let counterparty = direction === 'inbound' ? fromNumber : toNumber;
    // Transcript events have no from/to — fall back to dialogue identifier
    if (!counterparty && Array.isArray(call.dialogue)) {
        const ext = call.dialogue.find(function(t) { return t.userId == null && t.identifier; });
        if (ext) counterparty = ext.identifier;
    }

    const baseFields = {
        openphone_call_id: openphoneCallId,
        direction: direction,
        from_number: fromNumber ? normalizePhone(fromNumber) : null,
        to_number: toNumber ? normalizePhone(toNumber) : null,
        called_at: call.createdAt || call.startedAt || new Date().toISOString(),
        raw_payload: evt
    };

    // logged_by attribution. Four sources, in order of preference:
    //   1. call.metadata.logged_by — admin's log-call route originated the
    //      OpenPhone call and pushed metadata through (exact, never null).
    //   2. Quo userId → SDR email mapping. Quo's webhook never carries an
    //      email, just their internal user id (e.g. "UShj8EpsSW"). We map it.
    //   3. leads.assigned_to fallback (applied after lead resolution below).
    // We intentionally never set logged_by to null here — upsert would wipe
    // out a value already on the row from a prior manual log.
    // Secondary signal — used only when a call isn't on a dedicated SDR line.
    // Luke has no Quo user seat, so he never appears here; he's covered by the
    // phone-line map below. Keep this in sync with `list-users` in Quo.
    const QUO_USER_ID_TO_EMAIL = {
        'UShj8EpsSW': 'remyleon@stiloaipartners.com',         // Remy Leon (owner)
        'USCFfV4w6g': 'jackmaguire@stiloaipartners.com',      // Jack Maguire
        'USHJZZYPss': 'alejandrobarrios@stiloaipartners.com', // Alejandro Barrios
        'USsSwYdBtK': 'davidcoira@stiloaipartners.com'        // David Coira (legacy id)
    };
    const metadataLoggedBy = (call.metadata && call.metadata.logged_by) || null;
    if (metadataLoggedBy) {
        baseFields.logged_by = metadataLoggedBy;
    } else if (call.userId && QUO_USER_ID_TO_EMAIL[call.userId]) {
        baseFields.logged_by = QUO_USER_ID_TO_EMAIL[call.userId];
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
        // Last-resort: Quo summary events don't ship from/to numbers, so when
        // a summary lands first (or is the only event we get) we previously
        // dropped the row at lead_id=null and orphaned the transcript. Pull
        // the call detail from Quo's REST API to recover from/to + a
        // contact.externalId tag, then re-run resolution.
        if (!leadId && openphoneCallId && (type === 'call.summary.completed' || type === 'call.transcript.completed')) {
            try {
                const fetched = await openphoneFetch({ path: '/calls/' + openphoneCallId });
                if (fetched.status === 200 && fetched.json) {
                    const fc = fetched.json.data || fetched.json;
                    const fcCounterparty = (fc.direction === 'inbound' ? fc.from : fc.to)
                        || (fc.participants && (fc.direction === 'inbound' ? fc.participants[0] : fc.participants[1]));
                    if (fc.from && !baseFields.from_number) baseFields.from_number = normalizePhone(fc.from);
                    if (fc.to && !baseFields.to_number) baseFields.to_number = normalizePhone(fc.to);
                    // Pull duration from the API response too — summary/transcript
                    // events don't carry timestamps, so without this duration_seconds
                    // would stay NULL on rows that only ever fire summary.
                    const apiDur = deriveDurationSeconds(fc);
                    if (apiDur != null) baseFields.duration_seconds = apiDur;
                    if (fcCounterparty) {
                        leadId = await findOrStubLead(sb, fcCounterparty);
                    }
                    if (leadId) {
                        console.log('[openphone/webhook] recovered orphan lead via Quo API lookup', { call_id: openphoneCallId, lead_id: leadId, duration: apiDur });
                    }
                } else {
                    console.warn('[openphone/webhook] Quo API lookup failed for orphan', { call_id: openphoneCallId, status: fetched.status });
                }
            } catch (e) {
                console.warn('[openphone/webhook] Quo API lookup threw', e.message || e);
            }
        }
    }
    if (leadId) baseFields.lead_id = leadId;

    // ── SDR attribution by dedicated Quo line (primary signal) ───────────────
    // Each rep dials from their own Quo number, so the STILO-owned side of the
    // call identifies the rep regardless of which Quo user (or no user, in
    // Luke's case) placed it. Data-driven off public.sdr_users.openphone_number
    // so onboarding a rep is just: insert the row + set their number. An
    // explicit metadata.logged_by from the admin call tool still wins (set
    // above), so this only fills or overrides the userId-map guess for SDR lines.
    if (!metadataLoggedBy && (baseFields.from_number || baseFields.to_number)) {
        try {
            const pub = publicClient();
            const { data: sdrLines } = await pub
                .from('sdr_users')
                .select('email, openphone_number')
                .eq('active', true)
                .not('openphone_number', 'is', null);
            if (Array.isArray(sdrLines) && sdrLines.length) {
                const lineToEmail = {};
                for (const s of sdrLines) {
                    const n = normalizePhone(s.openphone_number);
                    if (n) lineToEmail[n] = s.email;
                }
                const ourLine = [baseFields.from_number, baseFields.to_number]
                    .find(function (n) { return n && lineToEmail[n]; });
                if (ourLine) baseFields.logged_by = lineToEmail[ourLine];
            }
        } catch (e) {
            console.warn('[openphone/webhook] sdr line attribution failed', e.message || e);
        }
    }

    // Fallback attribution: if we resolved a lead but no explicit logged_by
    // came through, attribute the call to whoever owns the lead. Without
    // this every Quo/OpenPhone webhook lands with logged_by=null and the
    // lead never appears in that SDR's My Call History.
    if (leadId && !baseFields.logged_by) {
        const { data: ownerRow } = await sb
            .from('leads')
            .select('assigned_to')
            .eq('id', leadId)
            .maybeSingle();
        if (ownerRow && ownerRow.assigned_to) {
            baseFields.logged_by = ownerRow.assigned_to;
        }
    }

    // Try every shape Quo / OpenPhone has shipped a recording URL in. If
    // they ever change the schema or finally start sending recordings (which
    // requires enabling recordings on each number + subscribing to the
    // call.recording.completed event in Quo settings), we'll catch it.
    function extractRecordingUrl() {
        return (data.recording && (data.recording.url || data.recording.signedUrl))
            || (call.recording && (call.recording.url || call.recording.signedUrl))
            || call.recordingUrl
            || call.recording_url
            || (Array.isArray(call.media) && call.media[0] && (call.media[0].url || call.media[0].signedUrl))
            || data.url
            || null;
    }

    try {
        if (type === 'call.completed' || type === 'call.ended' || type === 'call.summary.completed') {
            // Quo never sends a duration field — derive from completedAt / answeredAt.
            // For unanswered calls deriveDurationSeconds returns 0, which is
            // signal (not noise) for the sales script agent.
            const derived = deriveDurationSeconds(call);
            if (derived != null) baseFields.duration_seconds = derived;
            else if (call.duration || call.durationSeconds) baseFields.duration_seconds = call.duration || call.durationSeconds;
            baseFields.outcome = deriveOutcome(call);
            // summary may be a string, .text, or an array (Quo v3 sends array)
            const rawSummary = data.summary || call.summary || null;
            if (rawSummary) {
                if (typeof rawSummary === 'string') baseFields.transcript_summary = rawSummary;
                else if (rawSummary.text) baseFields.transcript_summary = rawSummary.text;
                else if (Array.isArray(rawSummary)) baseFields.transcript_summary = rawSummary.join('\n');
            }
            // Quo v3 call.summary.completed also includes nextSteps array
            const rawNextSteps = call.nextSteps || data.nextSteps || null;
            if (Array.isArray(rawNextSteps) && rawNextSteps.length) {
                const nextStr = 'Next steps:\n' + rawNextSteps.map(function(s) { return '- ' + s; }).join('\n');
                baseFields.transcript_summary = baseFields.transcript_summary
                    ? baseFields.transcript_summary + '\n\n' + nextStr
                    : nextStr;
            }
            // Some Quo deployments ship the recording url on call.completed
            // itself rather than firing a separate call.recording.completed —
            // grab it here too.
            const recUrl = extractRecordingUrl();
            if (recUrl) baseFields.recording_url = recUrl;
        } else if (type === 'call.recording.completed') {
            const recUrl = extractRecordingUrl();
            if (recUrl) baseFields.recording_url = recUrl;
        } else if (type === 'call.transcript.completed' || data.transcript) {
            const transcript = data.transcript || (call.transcript && call.transcript.text) || null;
            if (typeof transcript === 'string') baseFields.transcript = transcript;
            else if (Array.isArray(transcript)) {
                baseFields.transcript = transcript.map(function (seg) {
                    return (seg.speaker || seg.user || '?') + ': ' + (seg.text || seg.content || '');
                }).join('\n');
            }
            // Quo v3: transcript lives in call.dialogue as [{userId, identifier, content}]
            if (!baseFields.transcript && Array.isArray(call.dialogue)) {
                baseFields.transcript = call.dialogue.map(function(t) {
                    return (t.identifier || t.userId || '?') + ': ' + (t.content || '');
                }).join('\n');
            }
        }

        // Reverse-merge path: if the SDR logged this call manually faster
        // than Quo's webhook landed (the 10-second race), there's a recent
        // manual row for this lead with no openphone_call_id. Merge our
        // enrichment onto that row instead of inserting a duplicate.
        let callRow;
        if (leadId && !existingRow) {
            const manualTarget = await findRecentManualMergeTarget(sb, leadId);
            if (manualTarget) {
                callRow = await mergeQuoIntoManualRow(sb, manualTarget.id, baseFields);
                console.log('[openphone/webhook] merged Quo enrichment into recent manual log', {
                    call_id: openphoneCallId,
                    lead_calls_id: callRow.id,
                    preserved_outcome: manualTarget.outcome
                });
            }
        }
        if (!callRow) {
            callRow = await upsertCall(sb, baseFields);
        }

        // Auto-detect Spanish on the transcript and stamp the lead's
        // primary_language ONLY if currently null. Never overrides a
        // manual choice from the dashboard.
        if (baseFields.transcript && callRow.lead_id) {
            const lang = detectLanguage(baseFields.transcript);
            if (lang) {
                try {
                    await sb.from('leads')
                        .update({ primary_language: lang })
                        .eq('id', callRow.lead_id)
                        .is('primary_language', null);
                } catch (e) {
                    console.warn('[openphone/webhook] language stamp failed', e.message || e);
                }
            }
        }

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

// CRITICAL for signature verification: disable Vercel's automatic body parser
// so the raw request stream reaches readRawBody() intact. With the parser on,
// @vercel/node races to consume/parse the body before our handler reads it,
// intermittently leaving readRawBody empty -> HMAC over an empty body -> 401
// invalid_signature (the flip-flop where some deliveries land and others fail).
// The Stripe webhook in this repo uses the same export for the same reason.
module.exports.config = {
    api: { bodyParser: false }
};
