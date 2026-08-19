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
 * Public endpoint — an admin gate would block OpenPhone. Auth is a shared secret
 * token in the webhook URL (?token=, OPENPHONE_WEBHOOK_TOKEN) OR Quo's HMAC
 * signature over the raw body. One of those two must pass; everything else is
 * rejected with 401. See the comment above verifyCallExists for why the old
 * "does this call id exist?" fallback is no longer an auth path (audit 2026-08-10).
 */

const { verifySignature, readRawBody, serviceClient, publicClient, normalizePhone, openphoneFetch } = require('./_shared');
const outboundReplies = require('../prospects/_outbound_reply');
const missedCall = require('../prospects/_missed_call_alert');

// Quo ships TWO direction vocabularies depending on the event:
//   call.completed                      -> 'incoming' / 'outgoing'
//   call.summary/transcript.completed   -> 'inbound'  / 'outbound'
// Everything downstream should reason in one. Normalize on read.
//
// This mismatch was not cosmetic: deriveOutcome tested direction === 'inbound'
// while call.completed (the ONLY event that sets an outcome) always says
// 'incoming'. So 'missed_inbound' never fired once in all of July -- every one
// of the 72 incoming calls was filed as 'no_answer', and the 1-hour callback SLA
// that keys off missed_inbound never applied to a single missed call.
function normalizeDirection(d) {
    const s = String(d || '').toLowerCase();
    if (s === 'incoming' || s === 'inbound') return 'inbound';
    if (s === 'outgoing' || s === 'outbound') return 'outbound';
    return s || null;
}
function isInbound(d) { return normalizeDirection(d) === 'inbound'; }

function deriveOutcome(callPayload) {
    const status = callPayload.status || callPayload.completedReason || '';
    const direction = callPayload.direction || 'outbound';
    const answered = callPayload.answeredAt != null
        || (callPayload.duration != null && callPayload.duration > 5)
        || status === 'answered';
    // Voicemail check comes BEFORE the generic answered check because Quo
    // ships voicemail-only calls with status='completed' + voicemail=true.
    if (status === 'voicemail' || callPayload.voicemail) return 'voicemail';
    if (isInbound(direction) && !answered) return 'missed_inbound';
    if (!answered) return 'no_answer';
    return 'answered';
}

// Voicemail greeting patterns (EN + ES). A transcript that OPENS with one of
// these means a machine picked up, not a person, even when the call "completed"
// with a 20-40s duration because the rep left a message. This is the fallback
// for when the provider doesn't flag voicemail itself. Checked against the start
// of the transcript only, so a caller saying "leave me a message" mid-convo
// doesn't trip it.
const VM_PATTERNS = [
    /you'?ve reached/i,
    /please leave (a|your)( detailed)? message/i,
    /leave (a|your) (message|name and number) (after|at)/i,
    /(unable|can'?t|cannot|not able) to (take|answer) your call/i,
    /the person you (are|'?re) trying to reach/i,
    /(mailbox|voice ?mail)( box)? is full/i,
    /not available to take your call/i,
    /at the (tone|beep)/i,
    /record your message/i,
    /buz[oó]n de voz|deje (su|un) mensaje|no (est[aá]|se encuentra) disponible|despu[eé]s (del|de la) (tono|se[nñ]al)/i
];
function looksLikeVoicemail(text) {
    if (!text || typeof text !== 'string') return false;
    const head = text.slice(0, 400);
    return VM_PATTERNS.some(function (re) { return re.test(head); });
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

// Match a phone number to an existing lead (owner_phone or business phone), in
// both E.164 and David's (XXX) XXX-XXXX format. No stub.
async function matchLeadByPhone(sb, phone) {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    const digits10 = norm.startsWith('+1') ? norm.slice(2) : null;
    const fmt = digits10 && digits10.length === 10
        ? '(' + digits10.slice(0, 3) + ') ' + digits10.slice(3, 6) + '-' + digits10.slice(6)
        : null;
    // JSON.stringify → the double-quoted form PostgREST needs for values with
    // parentheses/spaces.
    const fmtCond = fmt
        ? ',owner_phone.eq.' + JSON.stringify(fmt) + ',phone.eq.' + JSON.stringify(fmt)
        : '';
    // limit(1) (not maybeSingle): a number can appear on 2+ duplicate rows and
    // maybeSingle throws on >1, which used to orphan the call. Take the first.
    const { data } = await sb
        .from('leads')
        .select('id')
        .or('owner_phone.eq.' + norm + ',phone.eq.' + norm + fmtCond)
        .order('id', { ascending: true })
        .limit(1);
    return (data && data[0] && data[0].id) || null;
}

async function findOrStubLead(sb, phone) {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    const matched = await matchLeadByPhone(sb, norm);
    if (matched) return matched;
    // Stub a minimal lead so a call from an unknown number isn't dropped.
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

// Recover a callback from a number we do not have on file, WITHOUT guessing.
//
// The prospect calls back from a mobile that is not on the lead record. The only
// honest signal is that WE previously spoke to that same counterparty number, so
// look the number itself up in call history. Keyed on the CALLER, never on our
// own line.
//
// What this replaced: a "most recent real lead this LINE touched in the last
// hour" fallback. That pinned every stranger who rang a rep's Quo line onto
// whatever lead the rep happened to be dialling. It put 16 unrelated inbound
// calls onto 11 leads between 2026-07-02 and 07-21 — six of them onto Dale's
// Tires, whose real outcome it then overwrote with missed_inbound plus a phantom
// 1-hour callback SLA. It also self-perpetuated: each bogus inbound refreshed
// the window, re-electing the same seed lead indefinitely.
async function leadForCounterpartyHistory(sb, counter) {
    if (!counter) return null;
    try {
        const { data: rows } = await sb
            .from('lead_calls')
            .select('lead_id, called_at')
            .or('from_number.eq.' + counter + ',to_number.eq.' + counter)
            .not('lead_id', 'is', null)
            .order('called_at', { ascending: false })
            .limit(10);
        const ids = Array.from(new Set((rows || []).map(function (r) { return r.lead_id; })));
        if (!ids.length) return null;
        const { data: leads } = await sb.from('leads').select('id, name').in('id', ids);
        const nameById = new Map((leads || []).map(function (l) { return [l.id, l.name]; }));
        // Prefer a real lead over one of our own "Unknown caller" stubs so a
        // callback never chains onto another junk lead.
        for (const r of (rows || [])) {
            const nm = nameById.get(r.lead_id) || '';
            if (nm && !/^Unknown caller/i.test(nm)) return r.lead_id;
        }
        return rows[0].lead_id;
    } catch (e) {
        console.warn('[openphone/webhook] counterparty history lookup failed', e.message || e);
    }
    return null;
}

// Resolve a call to a lead, robust to direction mislabeling. The counterparty is
// the number that ISN'T one of OUR lines.
//
// Returns { leadId, resolvedBy } where resolvedBy is 'phone' | 'history' |
// 'stub' | null. Callers need that: a lead resolved by anything other than an
// actual phone match must NOT have its sales outcome overwritten by a stranger's
// inbound ring.
async function resolveCounterpartyLead(sb, ourLines, counterparty, fromN, toN) {
    let counter = counterparty ? normalizePhone(counterparty) : null;
    if (!counter || ourLines.has(counter)) {
        counter = [fromN, toN].find(function (n) { return n && !ourLines.has(n); }) || counter;
    }
    if (counter && !ourLines.has(counter)) {
        const id = await matchLeadByPhone(sb, counter);
        if (id) return { leadId: id, resolvedBy: 'phone' };
        const hist = await leadForCounterpartyHistory(sb, counter);
        if (hist) return { leadId: hist, resolvedBy: 'history' };
        return { leadId: await findOrStubLead(sb, counter), resolvedBy: 'stub' };
    }
    return { leadId: null, resolvedBy: null };
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

// Secondary SANITY CHECK ONLY, never an authentication path (audit 2026-08-10).
//
// This used to be auth fallback #3: if token and HMAC both failed, a request
// whose call id resolved against the OpenPhone API was accepted. That is not
// authentication. A call id is not a secret, it appears in every transcript
// payload, every webhook we've ever received, and anyone who once saw one could
// replay it to forge call.transcript.completed / call.summary.completed events
// and write arbitrary transcripts and summaries onto our leads.
//
// The cold-start race it was added for is already covered by getUrlToken(),
// which falls back to parsing req.url directly when req.query is missing, so
// nothing is lost by demoting it. It now only runs as an optional forensic
// check (OPENPHONE_SANITY_CHECK_CALLS=1) and only logs.
async function verifyCallExists(evt) {
    try {
        const data = (evt && (evt.data || evt.payload || evt.object || evt)) || {};
        const call = data.object || data.call || data;
        const callId = call && (call.callId || call.call_id || call.id);
        if (!callId || !/^AC[A-Za-z0-9]+$/.test(String(callId))) return false;
        const r = await openphoneFetch({ path: '/calls/' + encodeURIComponent(callId) });
        if (r.status !== 200) return false;
        const c = (r.json && (r.json.data || r.json)) || {};
        return String(c.id || '') === String(callId);
    } catch (_) {
        return false;
    }
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
    //
    // The second branch is what covers the Vercel cold-start race: on a cold
    // invocation req.query can be undefined, but req.url ALWAYS carries the raw
    // path + query string, so parsing it directly still finds the token. This is
    // the reason verifyCallExists no longer needs to be an auth path.
    function getUrlToken() {
        if (req.query && req.query.token) return String(req.query.token);
        try { return new URL(req.url, 'http://x').searchParams.get('token') || ''; }
        catch (_) { return ''; }
    }
    const expectedToken = process.env.OPENPHONE_WEBHOOK_TOKEN || '';
    const urlToken = getUrlToken();
    const tokenOk = !!expectedToken && urlToken.length === expectedToken.length
        && (function () { try { return require('crypto').timingSafeEqual(Buffer.from(urlToken), Buffer.from(expectedToken)); } catch (_) { return false; } })();

    // Parse the body now so the API-confirmation fallback can read the call id.
    let evt;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    // Authenticate. Exactly two things can grant access (audit 2026-08-10):
    //   1. the shared secret token in the URL (?token=), the working path
    //   2. Quo's HMAC signature over the raw body, kept for when their scheme
    //      becomes reproducible; harmless while it never verifies
    // Nothing else. The old third fallback (verifyCallExists) let anyone holding
    // a known call id forge transcript/summary events, because it treated the
    // request's own contents as its credential. The cold-start race that fallback
    // was written for is handled inside getUrlToken() above, which reads the raw
    // req.url when req.query is missing, so removing it costs no deliveries.
    const sigOk = verifySignature(sigHeader, raw);
    const authed = tokenOk || sigOk;
    if (!authed) {
        console.warn('[openphone/webhook] unauthenticated event rejected', {
            type: (evt && (evt.type || (evt.object && evt.object.type))) || '?',
            token_seen: !!urlToken,
            token_configured: !!expectedToken
        });
        return res.status(401).json({ error: 'invalid_signature' });
    }
    // Optional forensic check, off by default: confirms the event's call id is
    // real in our Quo account. Logs only, it can never accept or reject.
    if (process.env.OPENPHONE_SANITY_CHECK_CALLS === '1' && !(await verifyCallExists(evt))) {
        console.warn('[openphone/webhook] sanity check: authenticated event whose call id did not resolve in our Quo account', {
            type: (evt && evt.type) || '?'
        });
    }

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
            // 23505 here means the unique index on provider_message_id rejected a
            // redelivery, so we have already processed this exact message. That
            // is now the ONE place redelivery is filtered, which is what lets the
            // reply alert fire on every genuinely new message instead of once per
            // target. Quo retries any non-2xx, so without this a retry storm
            // would re-alert on the same text.
            const isRedelivery = !!msgErr;

            // Outbound campaign reply handling runs INLINE, not on a cron. The
            // campaign promises a callback inside ~4 minutes, and a 5-minute
            // poller would spend most of that budget just noticing. This moves
            // the target to 'replied', starts the callback clock, and emails the
            // assigned rep. Opt-outs are handled here too and are terminal.
            //
            // Wrapped so a failure can never 500 the webhook: Quo retries any
            // non-2xx, and a retry loop would re-insert messages and re-alert.
            let outboundReply = null;
            if (direction === 'inbound' && !isRedelivery) {
                try {
                    outboundReply = await outboundReplies.handleInboundSms(
                        messageRow.from_address, messageRow.to_address, body
                    );
                } catch (e) {
                    console.error('[openphone/webhook] outbound reply handling failed', e);
                }
            }
            return res.status(200).json({ ok: true, channel: 'sms', lead_id: mLeadId, outbound: outboundReply });
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
    // Normalize on WRITE so the stored value is stable regardless of which event
    // wrote it last. Before this, an answered outbound call was stored as
    // 'outgoing' by call.completed and then flipped to 'outbound' when the
    // summary landed -- which is the entire reason three direction values exist
    // in the table, and why every downstream filter has to say
    // .in('direction', ['outbound','outgoing']).
    const direction = normalizeDirection(call.direction) || 'outbound';
    const fromNumber = call.from || (call.participants && call.participants[0]) || null;
    const toNumber = call.to || (call.participants && call.participants[1]) || null;
    let counterparty = isInbound(direction) ? fromNumber : toNumber;
    // Transcript events have no from/to — fall back to dialogue identifier
    if (!counterparty && Array.isArray(call.dialogue)) {
        const ext = call.dialogue.find(function(t) { return t.userId == null && t.identifier; });
        if (ext) counterparty = ext.identifier;
    }

    const baseFields = {
        openphone_call_id: openphoneCallId,
        direction: direction,
        called_at: call.createdAt || call.startedAt || new Date().toISOString(),
        raw_payload: evt
    };
    // Only set from/to when THIS event carries them. The later transcript /
    // summary events have no numbers; writing null here would wipe the from/to
    // that call.completed already stored (upsert overwrites every column it's
    // given). Preserving them keeps the call row complete + lead matching intact.
    if (fromNumber) baseFields.from_number = normalizePhone(fromNumber);
    if (toNumber) baseFields.to_number = normalizePhone(toNumber);

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
        // Luke Huron resigned 2026-08-06. KEPT deliberately: a webhook that
        // arrives late for one of his 904 calls must still attribute to him, and
        // dropping the id would silently re-credit it to whoever holds the line
        // next. His sdr_users row is inactive, so nothing routes TO him.
        'USxSahMbat': 'huronfire5@gmail.com',                 // Luke Huron (departed)
        // Jack Maguire removed (terminated). His old line +17869819302 is now
        // Jorge's; Jorge has his own Quo seat below.
        'UScVtcqU89': 'ayesjorge911@gmail.com',              // Jorge Ayes
        // NOTE: must be the rep's sdr_users.email (their dashboard identity), not
        // a company alias — logged_by is matched against sdr_users downstream.
        // Ale's Quo seat + login are both aleb1027@gmail.com.
        'USHJZZYPss': 'aleb1027@gmail.com',                  // Alejandro Barrios
        'USPZ6AB3Lg': 'georgegutierrez446@gmail.com',        // George Gutierrez (hired 2026-07-24)
        'USsSwYdBtK': 'davidcoira@stiloaipartners.com'        // David Coira (legacy id)
    };

    // ── Agency-owner cold-call lines (2026-06-08) ────────────────────────────
    // The two owners cold-call from their own Quo numbers, but BOTH lines sit
    // under Remy's Quo user seat (UShj8EpsSW). So the userId map above would
    // stamp every owner call as Remy, misattributing David's. We map the lines
    // themselves and let the phone-line block below override the userId guess.
    // Attribution-only on purpose: owners are NOT in sdr_users, so this keeps
    // them out of round-robin lead assignment and the commission leaderboard.
    // THIS MAP IS HISTORICAL, NOT CURRENT STATE. Entries are keyed by the line a
    // call actually came from, so a retired number must stay here forever: a
    // resync (openphone/resync-all.js) replays old calls through this exact code
    // path, and dropping a retired line would re-attribute every historical call
    // made from it to nobody. Only ever ADD here; never delete.
    //
    // Current lines live in public.sdr_users.openphone_number and are layered on
    // top of this map below, so a rep who changes numbers is handled by the DB
    // update alone. Both owners now have sdr_users rows, so their CURRENT lines
    // resolve from the DB too.
    const OWNER_LINE_TO_EMAIL = {
        '+17868376639': 'remyleon@stiloaipartners.com',  // (786) 837-6639 — Remy Leon, current
        // (786) 574-2922 — David's original owner line. RETIRED from the Quo
        // account 2026-07-28 when he moved to (754) 707-5311. Kept so his ~2
        // months of calls from it stay attributed on any resync. Safe to keep
        // permanently precisely because a retired number can never be reassigned
        // to another rep.
        '+17865742922': 'davidcoira@stiloaipartners.com'
        // (754) 707-5311 and (305) 614-7430 are deliberately absent. They have
        // changed hands once already (754 went David -> George 2026-07-25 ->
        // David 2026-07-28), so hardcoding either would guarantee a wrong answer
        // after the next swap. Both resolve from sdr_users, which is the one
        // place a reassignment gets recorded.
    };
    const metadataLoggedBy = (call.metadata && call.metadata.logged_by) || null;
    if (metadataLoggedBy) {
        baseFields.logged_by = metadataLoggedBy;
    } else if (call.userId && QUO_USER_ID_TO_EMAIL[call.userId]) {
        baseFields.logged_by = QUO_USER_ID_TO_EMAIL[call.userId];
    }

    const { data: existingRow } = await sb
        .from('lead_calls')
        .select('id, lead_id, logged_by')
        .eq('openphone_call_id', openphoneCallId)
        .maybeSingle();

    let leadId = existingRow && existingRow.lead_id;
    // HOW the lead was resolved, at handler scope because the leads-table write
    // near the end of this function gates on it. Declaring it inside the
    // resolution block below leaves it out of scope there and every webhook 500s.
    let resolvedBy = leadId ? 'existing_row' : null;
    if (!leadId) {
        // Resolution order:
        //  1. metadata.lead_id / prospect_id (when an admin-side flow eventually triggers a call)
        //  2. contact.externalId tag "stilo_lead_<id>" (set by the autosync trigger when pushing
        //     HOT leads to Quo as contacts — reliable across Mac/iPhone/web clients)
        //  3. phone-number match against owner_phone or business phone
        // OUR OpenPhone line numbers (owner + SDR lines). Used to find the real
        // counterparty and recover callbacks (see resolveCounterpartyLead).
        const ourLines = new Set(Object.keys(OWNER_LINE_TO_EMAIL).map(normalizePhone).filter(Boolean));
        try {
            const pubLines = publicClient();
            // NOT filtered on active. This set answers "is this number ours?",
            // which is a different question from "which rep owns it?" (see the
            // attribution block below, which does still require active). A
            // departed rep's line keeps receiving replies to texts they already
            // sent: when Marcus was offboarded 2026-08-18 his line still held a
            // live thread with a lead who had replied three times. Dropping the
            // line here made resolveCounterpartyLead read OUR number as the
            // prospect and stub a junk "Unknown caller" lead on every reply.
            const { data: _lns, error: _lnsErr } = await pubLines.from('sdr_users').select('openphone_number').not('openphone_number', 'is', null);
            // Log it. Falling back to owner lines alone silently means every SDR
            // line stops being recognised as ours, so resolveCounterpartyLead
            // starts treating OUR number as the prospect and stubs junk leads.
            // Degrading is right; degrading invisibly is not.
            if (_lnsErr) console.error('[openphone/webhook] sdr_users line fetch failed, falling back to owner lines only:', _lnsErr.message);
            (_lns || []).forEach(function (r) { const n = normalizePhone(r.openphone_number); if (n) ourLines.add(n); });
        } catch (e) {
            console.error('[openphone/webhook] sdr_users line fetch threw, falling back to owner lines only:', (e && e.message) || e);
        }
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
        if (leadId) resolvedBy = 'explicit';   // metadata / externalId tag
        if (!leadId) {
            const r = await resolveCounterpartyLead(sb, ourLines, counterparty, baseFields.from_number, baseFields.to_number);
            leadId = r.leadId; resolvedBy = r.resolvedBy;
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
                    if (fcCounterparty || baseFields.from_number || baseFields.to_number) {
                        const r2 = await resolveCounterpartyLead(sb, ourLines, fcCounterparty, baseFields.from_number, baseFields.to_number);
                        leadId = r2.leadId; resolvedBy = r2.resolvedBy;
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

    // ── Rep attribution by dedicated Quo line (primary signal) ───────────────
    // Each rep dials from their own Quo number, so the STILO-owned side of the
    // call identifies the rep regardless of which Quo user (or no user, in
    // Luke's case) placed it. SDR lines are data-driven off
    // public.sdr_users.openphone_number; the two owner lines are layered in from
    // OWNER_LINE_TO_EMAIL (owners aren't in sdr_users). An explicit
    // metadata.logged_by from the admin call tool still wins (set above), so
    // this only fills or overrides the userId-map guess for known lines.
    if (!metadataLoggedBy && (baseFields.from_number || baseFields.to_number)) {
        try {
            // Owner lines first; SDR rows can't collide with them (different
            // numbers), and seeding here means an owner line always resolves
            // even before any DB read.
            const lineToEmail = Object.assign({}, OWNER_LINE_TO_EMAIL);
            const pub = publicClient();
            const { data: sdrLines } = await pub
                .from('sdr_users')
                .select('email, openphone_number')
                .eq('active', true)
                .not('openphone_number', 'is', null);
            if (Array.isArray(sdrLines) && sdrLines.length) {
                for (const s of sdrLines) {
                    const n = normalizePhone(s.openphone_number);
                    if (n) lineToEmail[n] = s.email;
                }
            }
            const ourLine = [baseFields.from_number, baseFields.to_number]
                .find(function (n) { return n && lineToEmail[n]; });
            if (ourLine) baseFields.logged_by = lineToEmail[ourLine];
        } catch (e) {
            console.warn('[openphone/webhook] line attribution failed', e.message || e);
        }
    }

    // Fallback attribution: if we resolved a lead but no explicit logged_by
    // came through, attribute the call to whoever owns the lead. Without
    // this every Quo/OpenPhone webhook lands with logged_by=null and the
    // lead never appears in that SDR's My Call History.
    //
    // BUT never let this overwrite an attribution already on the row. Quo fires
    // call.completed (carries from/to → line attribution = the real caller)
    // THEN transcript/summary (no numbers → line block skipped). Without the
    // existingRow.logged_by guard, the later events fell through to this
    // assigned_to fallback and the upsert clobbered the caller with the lead's
    // owner — which is why both owner test calls (to a lead assigned to Luke)
    // were mis-stamped huronfire5 instead of remy/david.
    if (leadId && !baseFields.logged_by && !(existingRow && existingRow.logged_by)) {
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
            // Only call.completed/ended carry the call's answer status. The
            // summary payload has no answeredAt, so deriveOutcome would wrongly
            // return 'no_answer' and clobber the 'answered' that call.completed
            // already set. So don't derive an outcome from summary events.
            if (type === 'call.completed' || type === 'call.ended') {
                baseFields.outcome = deriveOutcome(call);
            }
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

        // Voicemail fallback: if the transcript/summary opens with a voicemail
        // greeting, a machine answered, not a person. Reclassify so voicemails
        // never count as connects. Only overrides an auto outcome, never a manual
        // human outcome (booked, not interested, callback, etc.).
        const vmText = baseFields.transcript || baseFields.transcript_summary || '';
        if (vmText && looksLikeVoicemail(vmText)) {
            const curOutcome = baseFields.outcome || (existingRow && existingRow.outcome) || null;
            const autoOutcomes = ['answered', 'voicemail', 'no_answer', 'missed_inbound'];
            if (!curOutcome || autoOutcomes.indexOf(curOutcome) !== -1) baseFields.outcome = 'voicemail';
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

        // DO NOT let a stranger's inbound ring overwrite a lead's sales outcome.
        //
        // Between 2026-07-02 and 07-21 unknown inbound callers were pinned to
        // whatever lead the rep's line touched last, and this block then stamped
        // that lead with missed_inbound plus a phantom 1-hour callback SLA. Six
        // landed on Dale's Tires alone, masking its real outcome.
        //
        // An inbound call may only stamp the lead when the CALLER's number
        // actually matched that lead ('phone'), or the lead came from an explicit
        // metadata/externalId tag. A 'history' or 'stub' resolution still files
        // the CALL against the lead (useful context) but must not rewrite the
        // pipeline state. Outbound is always safe: the rep chose who to dial.
        const inboundCall = isInbound(baseFields.direction);
        const mayStampLead = !inboundCall || resolvedBy === 'phone' || resolvedBy === 'explicit';
        if (baseFields.outcome && callRow.lead_id && !mayStampLead) {
            console.log('[openphone/webhook] inbound from an unmatched number; filing the call but NOT stamping the lead', {
                call_id: openphoneCallId, lead_id: callRow.lead_id, resolved_by: resolvedBy, from: baseFields.from_number
            });
        }
        if (baseFields.outcome && callRow.lead_id && mayStampLead) {
            // David's leads table tracks last_called_at + last_called_outcome
            // + call_attempts + next_action_due_at directly on the row.
            const updates = {
                last_called_at: baseFields.called_at,
                last_called_outcome: baseFields.outcome,
                call_attempts: 1, // backend will increment via its own logic; use 1 as a floor
                updated_at: new Date().toISOString()
            };
            // No auto-scheduled callbacks. This block used to stamp
            // next_action_type='callback' (+1h for missed_inbound, +4h for
            // voicemail/no_answer), which dumped every unanswered dial into the
            // Callbacks tab as due-today. The tab is human-scheduled only: a
            // lead enters it when the rep logs callback_requested /
            // interested_followup with a time, or uses "Add to callback list".
            await sb.from('leads').update(updates).eq('id', callRow.lead_id);
        }

        // A prospect dialing our number and not getting through is the strongest
        // buying signal in the system and until 2026-08-17 it raised nothing at
        // all. Runs after the lead stamp so the email carries the current stage,
        // and wrapped so a Resend outage can never 500 the webhook: Quo retries
        // any non-2xx, and a retry loop here would re-alert on the same call.
        let missedAlert = null;
        if (inboundCall) {
            try {
                missedAlert = await missedCall.alertMissedInbound(sb, {
                    callId: openphoneCallId,
                    leadId: mayStampLead ? callRow.lead_id : null,
                    phone: baseFields.from_number || callRow.from_number,
                    outcome: baseFields.outcome || callRow.outcome,
                    calledAt: baseFields.called_at,
                    repEmail: baseFields.logged_by || callRow.logged_by,
                    transcript: baseFields.transcript || callRow.transcript,
                    summary: baseFields.transcript_summary || callRow.transcript_summary,
                });
            } catch (e) {
                console.error('[openphone/webhook] missed-call alert failed', e && e.message);
            }
        }

        return res.status(200).json({ ok: true, call_id: openphoneCallId, lead_id: callRow.lead_id, missed_alert: missedAlert });
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
