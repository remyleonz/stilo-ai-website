/**
 * api/prospects/_missed_call_alert.js
 *
 * Emails when a prospect calls US and nobody picks up. Called from
 * openphone/webhook.js on the call path.
 *
 * This did not exist before 2026-08-17. Reply-to-a-text raised an email; a
 * prospect actually dialing our number raised nothing at all. Neville Walters
 * (lead 17339) called at 7:59pm on 2026-08-16 after re-opening the VSL six
 * times, and the only record was a lead_calls row nobody looked at until the
 * next morning. An inbound call is a stronger buying signal than any text we
 * send, so it is the one event that should always reach a phone.
 *
 * Fires on any inbound call we did not answer: missed_inbound, voicemail, or
 * no_answer. Voicemail matters because deriveOutcome() in the webhook checks
 * the voicemail flag BEFORE the missed-inbound branch, so an inbound call that
 * rolls to voicemail is classified 'voicemail' and would never match a
 * missed_inbound-only gate. That ordering is exactly how Neville's call would
 * have slipped through a narrower version of this.
 *
 * Idempotent on prospecting.lead_calls.alert_sent_at. One call produces several
 * webhook events (call.completed, then transcript, then summary), and each one
 * re-runs this path.
 *
 * 2026-08-28: the email now carries the two things a rep needed anyway and was
 * opening the dashboard to get.
 *
 *   1. PRIOR CONTACT. A callback is a different conversation depending on
 *      whether we spoke to them yesterday or have never reached them at all,
 *      and the rep has no way to know which from a phone notification. Three
 *      of the first Blason missed calls (Goldfingers, Aloha, Skinne) were all
 *      returning a dial from the day before, and the alert said nothing about
 *      it. History is merged from lead_calls, lead_messages AND
 *      outbound_targets, because outbound-tick does not write lead_messages
 *      rows for its own campaign steps: those bodies live on
 *      outbound_targets.stepN_body. A thread built from lead_messages alone is
 *      missing every text we sent from a campaign.
 *
 *   2. A CALLBACK SCRIPT. Not the cold-call brief: they dialed US, so the open
 *      is different and re-explaining the offer is the fastest way to lose the
 *      call. Acknowledge, one question, close the next step. The script branches
 *      on the client account (a lead in a client's pool must never hear STILO
 *      copy) and on primary_language.
 *
 * The price answer in every branch is the two questions, never a number. See
 * Jim at Brandon Lift Service on 2026-08-17: he asked twice, got a vibe, filled
 * the blank in himself with "another monthly agency retainer" and killed it.
 */


// Inbound outcomes that mean a human tried to reach us and did not get through.
const UNANSWERED_INBOUND = new Set(['missed_inbound', 'voicemail', 'no_answer']);

// Miami-Dade + Broward. A lead inside this range gets asked to the Hialeah
// showroom; everyone else gets the phone call with Manuel. Same rule the
// cold-call scripts and draft-email.js use, including the 5-digit match: an
// inline \b after four digits never matches a 5-digit zip, which is how every
// local lead spent a week getting the weaker video-call ask.
const SHOWROOM_ZIP3 = ['330', '331', '332', '333'];
const SHOWROOM_ADDR = '3110 W 84th St Unit 4, Miami, FL 33018';

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', weekday: 'short', hour: 'numeric',
            minute: '2-digit', timeZoneName: 'short',
        }).format(new Date(iso));
    } catch (_) { return String(iso || ''); }
}

// Short stamp for the history rows: "Aug 27, 3:33pm". No timezone suffix,
// because every row in the block is ET and repeating it eight times is noise.
function fmtShort(iso) {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(new Date(iso)).replace(' AM', 'am').replace(' PM', 'pm');
    } catch (_) { return String(iso || ''); }
}

// lead_calls.called_at is timestamptz, but leads.last_called_at and the older
// message stamps are naive UTC. Anything already carrying a zone is left alone;
// a bare timestamp is read as UTC rather than as the server's local time.
function asDate(v) {
    if (!v) return null;
    const s = String(v);
    const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.replace(' ', 'T') + 'Z');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

function firstLine(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const OUTCOME_LABEL = {
    answered: 'We reached someone',
    voicemail: 'We left a voicemail',
    no_answer: 'No answer',
    missed_inbound: 'They called us, we missed it',
    callback_requested: 'They asked us to call back',
    owner_uninterested: 'Owner said not interested',
    do_not_call: 'Asked not to be called',
    wrong_number: 'Wrong number',
    disconnected: 'Number disconnected',
    booked_meeting: 'Meeting booked',
};

/**
 * Everything we have said to this lead, and they to us, newest first.
 *
 * Three sources, because no single table holds the thread:
 *   lead_calls       every dial and every inbound ring
 *   lead_messages    hand-sent email and SMS, plus captured inbound SMS
 *   outbound_targets campaign SMS steps, whose bodies live on stepN_body and
 *                    are never written to lead_messages by outbound-tick
 *
 * Returns at most `limit` normalized events. Never throws: a history read that
 * fails must not stop the alert, since the alert is the part that matters.
 */
async function fetchHistory(sb, leadId, excludeCallId, limit) {
    const cap = limit || 8;
    const events = [];
    try {
        const [calls, msgs, targets] = await Promise.all([
            sb.from('lead_calls')
                .select('openphone_call_id, direction, outcome, called_at, duration_seconds, transcript_summary, notes, logged_by')
                .eq('lead_id', leadId).order('called_at', { ascending: false }).limit(25),
            sb.from('lead_messages')
                .select('direction, channel, subject, body, body_preview, sent_at, sent_by, status')
                .eq('lead_id', leadId).order('sent_at', { ascending: false }).limit(25),
            sb.from('outbound_targets')
                .select('step1_body, step1_sent_at, step2_body, step2_sent_at, step3_body, step3_sent_at, first_reply_at, first_reply_body')
                .eq('lead_id', leadId).limit(5),
        ]);

        for (const c of (calls.data || [])) {
            // The call that triggered this email is the subject line, not history.
            if (excludeCallId && c.openphone_call_id === excludeCallId) continue;
            const mins = Math.round((c.duration_seconds || 0));
            const who = c.direction === 'inbound' ? 'They called' : 'We called';
            const label = OUTCOME_LABEL[c.outcome] || (who + ' (' + (c.outcome || 'logged') + ')');
            const detail = firstLine(c.transcript_summary || c.notes, 190)
                || (mins ? ('Talked for ' + mins + 's') : '');
            events.push({
                at: asDate(c.called_at), kind: 'call', inbound: c.direction === 'inbound',
                label: label, detail: detail, by: c.logged_by || '',
            });
        }

        for (const m of (msgs.data || [])) {
            const ch = m.channel === 'sms' ? 'Text' : (m.channel === 'email' ? 'Email' : (m.channel || 'Message'));
            const inbound = m.direction === 'inbound';
            let label = inbound ? (ch + ' from them') : (ch + ' we sent');
            if (!inbound && m.status === 'bounced') label = ch + ' we sent (bounced)';
            events.push({
                at: asDate(m.sent_at), kind: 'message', inbound: inbound,
                label: label,
                detail: firstLine(m.subject ? (m.subject + ': ' + (m.body || m.body_preview || '')) : (m.body || m.body_preview), 190),
                by: m.sent_by || '',
            });
        }

        for (const t of (targets.data || [])) {
            for (const n of [1, 2, 3]) {
                const at = t['step' + n + '_sent_at'];
                if (!at) continue;
                events.push({
                    at: asDate(at), kind: 'message', inbound: false,
                    label: 'Campaign text, step ' + n,
                    detail: firstLine(t['step' + n + '_body'], 190), by: '',
                });
            }
            if (t.first_reply_at) {
                events.push({
                    at: asDate(t.first_reply_at), kind: 'message', inbound: true,
                    label: 'Text from them', detail: firstLine(t.first_reply_body, 190), by: '',
                });
            }
        }
    } catch (e) {
        console.error('[missed-call] history read failed: ' + (e && e.message));
        return [];
    }

    // A campaign step and a lead_messages row can describe the same text. Same
    // minute plus the same opening 40 characters is the same message.
    const seen = new Set();
    const deduped = [];
    for (const ev of events) {
        if (!ev.at) continue;
        const key = Math.floor(ev.at.getTime() / 60000) + '|' + ev.detail.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(ev);
    }
    deduped.sort(function (a, b) { return b.at - a.at; });
    return deduped.slice(0, cap);
}

function renderHistory(events, totalKnown) {
    if (!events.length) {
        return '<div style="border:1px solid #E5E7EB;border-radius:6px;padding:14px 16px;margin:0 0 20px">'
            + '<p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6B7280">History</p>'
            + '<p style="margin:0;font-size:14px;color:#374151">Nothing on record. This is the first contact either way, '
            + 'so treat it as a cold call they happened to start.</p></div>';
    }
    const rows = events.map(function (ev) {
        const accent = ev.inbound ? '#2563EB' : '#9CA3AF';
        return '<tr>'
            + '<td style="padding:8px 10px 8px 0;vertical-align:top;white-space:nowrap;color:#6B7280;font-size:13px;width:96px">'
            + esc(fmtShort(ev.at.toISOString())) + '</td>'
            + '<td style="padding:8px 0;vertical-align:top;border-left:3px solid ' + accent + ';padding-left:12px">'
            + '<span style="font-size:14px;font-weight:600;color:#111">' + esc(ev.label) + '</span>'
            + (ev.detail ? '<br><span style="font-size:13px;color:#4B5563;line-height:1.45">' + esc(ev.detail) + '</span>' : '')
            + '</td></tr>';
    }).join('');
    const more = totalKnown > events.length
        ? '<p style="margin:10px 0 0;font-size:12px;color:#6B7280">Showing the last ' + events.length + '. Open the lead for the rest.</p>'
        : '';
    return '<div style="margin:0 0 22px">'
        + '<p style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6B7280">History with this lead</p>'
        + '<table style="width:100%;border-collapse:collapse">' + rows + '</table>' + more + '</div>';
}

/**
 * The callback script.
 *
 * This is deliberately NOT the cold-call brief. On a cold call you earn the
 * right to ask a question; on a callback they have already given it to you, and
 * the fastest way to lose the call is to spend it re-explaining the offer they
 * just called about. So: acknowledge, one question, close the next step.
 *
 * Two rules are load-bearing and neither is a style choice.
 *   - No price. Ever. The answer to "how much" is the two questions, because a
 *     number quoted before they have said what a customer is worth is just a
 *     cost and the rest of the call is haggling over it.
 *   - One offer. A second product on the same call kills the first one.
 *
 * Branches on the client account first (a lead in a client's pool must never
 * hear STILO copy) and then on language.
 */
function buildScript(ctx) {
    const es = ctx.spanish;
    const local = ctx.local;

    if (ctx.clientAccount === 'Blason Spa Equipment') {
        if (es) {
            return {
                title: 'Guion para devolver la llamada',
                note: 'Le llamamos de parte de Blason. Usted no vende STILO en esta llamada.',
                steps: [
                    { t: 'Abra así', say: 'Hola, le habla [su nombre], de Blason Spa Equipment en Miami. Usted me acaba de devolver la llamada, se lo agradezco.' },
                    { t: 'Por qué llamó (una línea, y pare)', say: 'Le llamé por el equipo que ustedes tienen trabajando ahora mismo. Nada más.' },
                    { t: 'La pregunta (hágala y quédese callado)', say: '¿Qué tratamiento le están pidiendo sus clientas que hoy usted no pueda hacer?' },
                    { t: 'Conteste lo que le digan', say: 'Manuel importa las máquinas él mismo. Él le dice de frente si tiene la que le sirve para eso, o si no le conviene.' },
                    {
                        t: 'Cierre el siguiente paso',
                        say: local
                            ? ('El showroom está en ' + SHOWROOM_ADDR + ', de lunes a sábado de 9 a 4. Están puestas y funcionando. ¿Qué día le sirve esta semana? Se lo aparto.')
                            : 'Quince minutos con Manuel por teléfono. ¿Qué le sirve mejor, mañana temprano o por la tarde?',
                    },
                    { t: 'Antes de colgar', say: '¿Cuál es el mejor correo suyo? Le mando la confirmación ahí mismo.' },
                ],
                objections: [
                    { q: '"¿De qué se trata?"', say: 'Una llamada perdida mía. Blason Spa Equipment, en Miami. Nosotros surtimos los láser y las máquinas de contorno corporal. Tenía una sola pregunta sobre lo que ustedes tienen ahora.' },
                    { q: '"¿Cuánto cuesta?"', say: 'Depende de cuál máquina, y cuál máquina depende de lo que usted quiera ofrecer. Eso lo pone Manuel cuando sepa qué necesita. ¿Qué tratamiento le están pidiendo?' },
                    { q: '"Mándeme información"', say: 'Se la mando hoy. Pero una máquina no se compra por una hoja de papel. En Miami están puestas y funcionando. ¿Qué día le sirve?' },
                    { q: '"No estamos buscando nada"', say: 'Está bien. Una última cosa: ¿cuál fue la última máquina que compraron, y a quién se la compraron?' },
                ],
            };
        }
        return {
            title: 'Callback script',
            note: 'You are calling for Blason. STILO does not come up on this call.',
            steps: [
                { t: 'Open with this', say: 'Hi, this is [your name] with Blason Spa Equipment in Miami. You just called me back, I appreciate that.' },
                { t: 'Why you called (one line, then stop)', say: 'I called about the equipment you have running right now. That is it.' },
                { t: 'The question (ask it, then be quiet)', say: 'What treatment are your clients asking for that you cannot do today?' },
                { t: 'Whatever they name', say: 'Manuel imports the machines himself. He will tell you straight whether he has the one for that, or whether it is not worth it for you.' },
                {
                    t: 'Close the next step',
                    say: local
                        ? ('The showroom is at ' + SHOWROOM_ADDR + ', Monday to Saturday, 9 to 4. They are set up and running. What day works this week? I will hold it for you.')
                        : 'Fifteen minutes with Manuel on the phone. What is better, tomorrow morning or tomorrow afternoon?',
                },
                { t: 'Before you hang up', say: 'What is the best email for you? I will send the confirmation there.' },
            ],
            objections: [
                { q: '"What is this about?"', say: 'A missed call from me. Blason Spa Equipment, in Miami. We supply the lasers and the body contouring machines. I had one question about what you are running now.' },
                { q: '"How much is it?"', say: 'Depends which machine, and which machine depends on what you want to offer. Manuel prices it once he knows what you need. What treatment are clients asking you for?' },
                { q: '"Just email me something"', say: 'I will send it today. But nobody buys one of these off a spec sheet. They are set up and running in Miami. What day works?' },
                { q: '"We are not looking"', say: 'Fair enough. Last thing before I go: what machine did you buy most recently, and who did you buy it from?' },
            ],
        };
    }

    if (es) {
        return {
            title: 'Guion para devolver la llamada',
            note: 'Una sola oferta en esta llamada. No mencione precio.',
            steps: [
                { t: 'Abra así', say: 'Hola, le habla [su nombre], de STILO. Usted me acaba de devolver la llamada.' },
                { t: 'Por qué llamó (una línea, y pare)', say: 'Le llamé por el tema de llenarle el calendario de citas de venta. Esa es toda la razón.' },
                { t: 'La pregunta (hágala y quédese callado)', say: '¿Cómo están consiguiendo clientes nuevos ahora mismo?' },
                { t: 'Conteste lo que le digan', say: 'Nosotros le conseguimos las citas. Usted solo se sienta con gente que ya dijo que sí a la reunión.' },
                { t: 'Cierre el siguiente paso', say: 'Quince minutos esta semana. ¿Mañana temprano o mañana por la tarde?' },
                { t: 'Antes de colgar', say: '¿Cuál es el mejor correo suyo? Le mando la confirmación ahí mismo.' },
            ],
            objections: [
                { q: '"¿Cuánto cuesta?"', say: 'Depende de dos cosas: cuántas reuniones al mes quiere, y cuánto vale realmente un cliente nuevo para usted. Así que déjeme preguntarle, ¿cuánto vale una cuenta nueva para usted en un año?' },
                { q: '"No estamos interesados"', say: 'Está bien. ¿Qué le está funcionando ahora para conseguir clientes nuevos?' },
                { q: '"Mándeme información"', say: 'Se la mando. Pero lo que le sirve depende de su número, no del mío. ¿Cuántas reuniones al mes le harían falta para que valga la pena?' },
            ],
        };
    }

    return {
        title: 'Callback script',
        note: 'One offer on this call. No price, no range, no ballpark.',
        steps: [
            { t: 'Open with this', say: 'Hi, this is [your name] with STILO. You just called me back.' },
            { t: 'Why you called (one line, then stop)', say: 'I called about getting more sales meetings onto your calendar. That is the whole reason.' },
            { t: 'The question (ask it, then be quiet)', say: 'How are you getting new customers right now?' },
            { t: 'Whatever they say', say: 'We book the meetings for you. You only sit down with people who already agreed to the call.' },
            { t: 'Close the next step', say: 'Fifteen minutes this week. Tomorrow morning or tomorrow afternoon?' },
            { t: 'Before you hang up', say: 'What is the best email for you? I will send the confirmation there.' },
        ],
        objections: [
            { q: '"How much is it?"', say: 'It depends on two things: how many meetings a month you want, and what a new client is actually worth to you. So let me ask, what is one new account worth to you in a year?' },
            { q: '"Not interested"', say: 'Fair. What is working for you right now for new business?' },
            { q: '"Just send me info"', say: 'I will. But what fits depends on your number, not mine. How many meetings a month would make this worth doing?' },
        ],
    };
}

function renderScript(script) {
    const steps = script.steps.map(function (s, i) {
        return '<tr>'
            + '<td style="padding:9px 10px 9px 0;vertical-align:top;width:22px;color:#2563EB;font-weight:700;font-size:14px">' + (i + 1) + '</td>'
            + '<td style="padding:9px 0;vertical-align:top">'
            + '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6B7280;margin:0 0 3px">' + esc(s.t) + '</div>'
            + '<div style="font-size:15px;line-height:1.5;color:#111">&ldquo;' + esc(s.say) + '&rdquo;</div>'
            + '</td></tr>';
    }).join('');

    const objections = script.objections.map(function (o) {
        return '<tr>'
            + '<td style="padding:8px 12px 8px 0;vertical-align:top;width:34%;font-size:13px;font-weight:600;color:#111">' + esc(o.q) + '</td>'
            + '<td style="padding:8px 0;vertical-align:top;font-size:13px;line-height:1.5;color:#374151">' + esc(o.say) + '</td>'
            + '</tr>';
    }).join('');

    return '<div style="border:1px solid #DBEAFE;background:#F8FAFF;border-radius:6px;padding:16px 18px;margin:0 0 20px">'
        + '<p style="margin:0 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#2563EB;font-weight:700">' + esc(script.title) + '</p>'
        + '<p style="margin:0 0 12px;font-size:13px;color:#6B7280">' + esc(script.note) + '</p>'
        + '<table style="width:100%;border-collapse:collapse">' + steps + '</table>'
        + '<p style="margin:16px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6B7280">If they push back</p>'
        + '<table style="width:100%;border-collapse:collapse">' + objections + '</table>'
        + '</div>';
}

/**
 * @param {object} sb    supabase client already bound to the `prospecting` schema
 * @param {object} opts  { callId, leadId, phone, outcome, calledAt, repEmail,
 *                         transcript, summary }
 * @returns {object|null} null when this is not an unanswered inbound call
 */
async function alertMissedInbound(sb, opts) {
    if (!opts || !UNANSWERED_INBOUND.has(opts.outcome)) return null;
    if (!opts.callId) return null;

    // Idempotency read first: cheaper than composing an email we then discard,
    // and this path runs on every event for the same call. client_account rides
    // along because the stamp_client_account trigger has already set it on this
    // row, which saves a second lookup to decide whose script to print.
    const { data: existing, error: readErr } = await sb.from('lead_calls')
        .select('id, alert_sent_at, client_account').eq('openphone_call_id', opts.callId).maybeSingle();
    if (readErr) {
        console.error('[missed-call] idempotency read failed: ' + readErr.message);
        return { skipped: 'read_failed' };
    }
    if (existing && existing.alert_sent_at) return { skipped: 'already_alerted' };

    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };

    let lead = null;
    if (opts.leadId) {
        const { data } = await sb.from('leads')
            .select('id,name,owner_name,niche,category,stage,assigned_to,address,primary_language,call_attempts,do_not_call,next_action_type,next_action_due_at')
            .eq('id', opts.leadId).maybeSingle();
        lead = data || null;
    }

    // History is only meaningful once we know which lead this is. An unmatched
    // inbound number still gets the alert, just without the thread.
    const history = opts.leadId ? await fetchHistory(sb, opts.leadId, opts.callId, 8) : [];

    const owner = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';
    const alertInbox = process.env.HEALTH_ALERT_TO || 'remyleon11@gmail.com';
    const to = Array.from(new Set(
        [opts.repEmail || (lead && lead.assigned_to), owner, alertInbox]
            .map(function (e) { return String(e || '').toLowerCase().trim(); })
            .filter(function (e) { return e && /.+@.+\..+/.test(e); })
    ));

    const business = (lead && lead.name) || 'Unknown number';
    const telLink = 'tel:' + String(opts.phone || '').replace(/[^\d+]/g, '');
    const adminUrl = lead
        ? 'https://stiloaipartners.com/admin/?lead=' + lead.id
        : 'https://stiloaipartners.com/admin/';

    const zipM = String((lead && lead.address) || '').match(/\b(\d{5})(?:-\d{4})?\b/);
    const script = buildScript({
        clientAccount: (existing && existing.client_account) || null,
        spanish: !!lead && lead.primary_language === 'es',
        local: !!zipM && SHOWROOM_ZIP3.indexOf(zipM[1].slice(0, 3)) !== -1,
    });

    // A voicemail transcript is the single most useful thing in this email, so
    // it goes above the fold rather than behind a click into the dashboard.
    const vm = String(opts.transcript || opts.summary || '').trim().slice(0, 900);

    const rows = [
        ['Phone', '<a href="' + telLink + '" style="color:#2563EB;text-decoration:none;font-weight:600">' + esc(opts.phone) + '</a>'],
        ['Owner', esc((lead && lead.owner_name) || 'unknown')],
        ['Industry', esc((lead && (lead.niche || lead.category)) || '')],
        ['Stage', esc((lead && lead.stage) || '')],
        ['Came in', esc(fmtTime(opts.calledAt))],
    ];
    if (existing && existing.client_account) rows.splice(3, 0, ['Account', esc(existing.client_account)]);
    const rowsHtml = rows.map(function (r) {
        return '<tr><td style="padding:5px 0;color:#6B7280;width:120px">' + r[0]
            + '</td><td style="padding:5px 0">' + r[1] + '</td></tr>';
    }).join('');

    const label = opts.outcome === 'voicemail' ? 'Left a voicemail' : 'Missed call';

    // A lead who has already told us no, or who is on a scheduled callback, is a
    // different call. The rep is about to dial from a phone notification, so the
    // warning has to be in the email or it is not seen at all.
    const flags = [];
    if (lead && lead.do_not_call) flags.push('This lead is marked do not call. Do not dial. Find out why they rang first.');
    if (lead && lead.next_action_type === 'callback' && lead.next_action_due_at) {
        flags.push('There is already a scheduled callback on this lead for ' + fmtShort(lead.next_action_due_at) + '. They beat you to it.');
    }
    if (history.some(function (e) { return /not interested|do not|Wrong number/i.test(e.label); })) {
        flags.push('They have turned us down before. Do not re-pitch. Ask why they called.');
    }
    const flagsHtml = flags.length
        ? '<div style="background:#FEF3C7;border-left:3px solid #D97706;padding:12px 14px;margin:0 0 20px;border-radius:4px">'
        + flags.map(function (f) { return '<p style="margin:0 0 4px;font-size:14px;color:#78350F;line-height:1.45">' + esc(f) + '</p>'; }).join('')
        + '</div>'
        : '';

    const html = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">',
        '<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;font-weight:700">' + label + '</p>',
        '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">' + esc(business) + ' called you</h1>',
        vm ? '<div style="background:#F3F4F6;border-left:3px solid #2563EB;padding:14px 16px;margin:0 0 20px;border-radius:4px">'
            + '<p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6B7280">What they said</p>'
            + '<p style="margin:0;font-size:15px;line-height:1.5;white-space:pre-wrap">' + esc(vm) + '</p></div>' : '',
        '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">' + rowsHtml + '</table>',
        flagsHtml,
        '<p style="margin:0 0 14px;font-size:15px;font-weight:600">They dialed you. Call them back today.</p>',
        // Buttons sit above the script, not under it. The script is long on a
        // phone and the whole point of this email is that the call happens now.
        '<p style="margin:0 0 24px">',
        '<a href="' + telLink + '" style="display:inline-block;background:#2563EB;color:#fff;padding:11px 20px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px;margin-right:8px">Call back</a>',
        '<a href="' + adminUrl + '" style="display:inline-block;background:#fff;color:#2563EB;border:1px solid #2563EB;padding:10px 19px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px">Open the lead</a>',
        '</p>',
        renderHistory(history, history.length),
        renderScript(script),
        '</div>',
    ].join('');

    let sent = null;
    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: (process.env.STILO_SENDER_NAME || 'STILO Outbound')
                    + ' <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>',
                to: to,
                reply_to: owner,
                subject: (opts.outcome === 'voicemail' ? 'Voicemail: ' : 'Missed call: ') + business,
                html: html,
            }),
        });
        const j = await r.json().catch(function () { return {}; });
        sent = { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
    } catch (e) {
        console.error('[missed-call] send threw: ' + (e && e.message));
        return { skipped: 'send_threw' };
    }

    if (sent && !sent.error && sent.status < 300) {
        // Stamp only on a confirmed send. A failed send that stamps anyway is a
        // silently swallowed inbound call, which is the whole bug being fixed.
        await sb.from('lead_calls')
            .update({ alert_sent_at: new Date().toISOString() })
            .eq('openphone_call_id', opts.callId);
    }
    return sent;
}

module.exports = { alertMissedInbound, UNANSWERED_INBOUND, buildScript, fetchHistory };
