/**
 * scripts/send_client_sequence.js
 *
 * Sends a client-pool cold email sequence from the command line, reusing the
 * SAME guards the dashboard's "Email this lead" button uses. This is not a
 * second sending implementation: it imports _email_guard.js and _email_kit.js
 * rather than reimplementing them, so a fix there applies here too.
 *
 * WHY THIS EXISTS
 *
 * Every sender in this repo is an HTTP handler behind a user JWT, so there was
 * no way to run a batch without either clicking 34 times or calling Resend
 * directly. Calling Resend directly skips four things that matter:
 *
 *   1. _email_guard.canSend()  - dead domains, malformed, disposable
 *   2. the dedupe_key claim    - see the race described in send-email.js
 *   3. lead_messages logging   - the conversation view reads from it
 *   4. List-Unsubscribe        - Gmail and Yahoo require it at volume
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM send-email.js
 *
 * No open-tracking pixel. send-email.js injects one for the Sales tab, which is
 * right for a warm one-off but wrong for cold volume: a 1x1 beacon is a spam
 * signal and this whole script exists to protect a fresh subdomain's
 * reputation. Opens are not measurable here and that is the intended trade.
 *
 * THE LANE GATE
 *
 * Only `email_confidence='medium'` AND `email_verify_status='deliverable'`
 * addresses are eligible. Measured 2026-08-30 over 890 sends:
 *
 *     medium  293 sent  10 bounced   3.4%
 *     null    423 sent  51 bounced  12.1%
 *     low     123 sent  16 bounced  13.0%
 *     none     38 sent   5 bounced  13.2%
 *
 * The MX check alone is NOT enough: it validates the domain, while the email
 * finder guesses the local part. Three of Blason's five bounces were stamped
 * 'deliverable' and still bounced because the person did not exist.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/send_client_sequence.js --client <uuid> --dry
 *   node sites/stilo-ai/scripts/send_client_sequence.js --client <uuid> --limit 20
 *   node sites/stilo-ai/scripts/send_client_sequence.js --client <uuid> --limit 20 --send
 *
 * --send is required to actually send. Without it the script always dry-runs,
 * because the failure mode of a mistaken batch is unrecoverable.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
try {
    fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { createClient } = require('@supabase/supabase-js');
const guard = require(path.join(ROOT, 'api/prospects/_email_guard.js'));
const kit = require(path.join(ROOT, 'api/prospects/_email_kit.js'));

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const CLIENT_ID = arg('client', '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
const LIMIT = parseInt(arg('limit', '20'), 10);
const SEND = args.includes('--send');
const LANE = arg('lane', '1');   // 1 = medium+deliverable (proven 3.4%), 2 = role inboxes on live domains,
                                 // 3 = site_published (address the business prints on its own site; the
                                 //     2026-09-13 contact-page crawl stamps these)
// cold     = never-emailed leads picked by LANE (the original behaviour)
// followup = one bump to leads emailed 3+ days ago with no reply, no bounce, no unsubscribe
// warm     = leads a rep actually reached on the phone (20s+ connected call) whose
//            address passed DNS verification and who have never been emailed
const MODE = arg('mode', 'cold');
if (!['cold', 'followup', 'warm'].includes(MODE)) { console.error('bad --mode'); process.exit(1); }
const GAP_MS = parseInt(arg('gap', '4000'), 10);   // pace so a fresh subdomain does not spike
const LOCAL_ZIP3 = ['330', '331', '332', '333'];

function sbLeads() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}
function sbPublic() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = b64url(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }));
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}

function zip3(address) {
    const m = String(address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
    return m ? m[1].slice(0, 3) : null;
}

/**
 * Only greet by name when the address CORROBORATES the name.
 *
 * owner_name and owner_email come from different sources and disagree more than
 * you would expect: `rick@cascadesmedspa.com` carries owner_name "Arty", and
 * `theteam@alohaaestheticsfl.com` carries "Phi". Greeting Arty at rick@ is worse
 * than not greeting anyone, because it announces the mail was merged from a list.
 *
 * So: if the local part opens with a name-like token that is NOT the first name
 * we hold, drop to the generic greeting. A role-ish local part (staff@, theteam@)
 * fails the same test and also falls back, which is the behaviour we want.
 */
function corroboratedFirstName(lead) {
    const fn = kit.firstName(lead.owner_name, lead.name, lead.address);
    if (!fn) return null;
    const localPart = String(lead.owner_email || '').split('@')[0].toLowerCase();
    const token = (localPart.match(/^[a-z]+/) || [''])[0];
    // Nothing name-like to compare against (j.smith@, 1234@) -> trust owner_name.
    if (token.length < 3) return fn;
    const first = fn.toLowerCase();
    // Match on either direction of prefix: rmartinez@ for Remy, or remy@ for Remy.
    if (token === first || token.startsWith(first) || first.startsWith(token)) return fn;
    return null;
}

/**
 * Copy. Same question the phone script and the SMS campaign use, so results
 * stay comparable across channels. No price of any kind, no link to a page
 * carrying prices, no STILO branding, no booking link.
 *
 * 2026-09-13 rewrite: the old diagnostic ("what treatment can't you do") is
 * RETIRED everywhere. 40 asks across the call corpus got ~90% "we're covered"
 * and zero sales; these buyers buy on expansion and upgrades, not confessed
 * weakness. The question is now the WISHLIST question, and for Miami-metro
 * leads the showroom leads the email, because that is the line local owners
 * respond to on the phone.
 */
function compose(lead, clientName) {
    const es = lead.primary_language === 'es';
    const fn = corroboratedFirstName(lead);
    const local = LOCAL_ZIP3.includes(zip3(lead.address));
    const sender = process.env.STILO_SENDER_NAME || 'Remy';
    // A/B by lead id so a lead always sees ONE arm and the two stay comparable.
    // 2026-09-17 rewrite from call intel. High-ticket aesthetic gear (laser, RF
    // microneedling, body contouring) sells on two levers, one per arm:
    //   Arm A = DE-RISK the big purchase (fear). On a $15k+ machine the risk is
    //     not what you pay, it is buying the wrong one or getting orphaned on
    //     service. Manuel imports direct, says which earns its keep, parts from
    //     Miami not a rep who retired (real: Pareen's Candela rep did exactly that).
    //   Arm B = REVENUE CAPTURE (greed). The treatment clients ask for and get
    //     referred out for is one machine away from being the owner's revenue.
    // Both name laser + body contouring up front so the copy pulls toward the
    // big deals, not an $800 unit. Never the words price/cost (preSendCheck).
    const arm = (Math.abs(Number(lead.id) || 0) % 2 === 0) ? 'A' : 'B';
    const showroomEn = 'The machines are set up and running at our Miami showroom, so you can put your hands on one before deciding anything.';
    const showroomEs = 'Las maquinas estan montadas y funcionando en nuestro showroom de Miami, asi que puede probar una antes de decidir nada.';
    const tailEn = local ? [showroomEn, ''] : [];
    const tailEs = local ? [showroomEs, ''] : [];

    if (MODE === 'followup') {
        if (es) {
            return { arm: 'bump', subject: 're: sobre sus equipos', body: [
                (fn ? 'Hola ' + fn + ',' : 'Hola,'), '',
                'Le escribi la semana pasada y queria intentarlo una vez mas.', '',
                'La pregunta sigue en pie: cual es el tratamiento que sus clientes piden y que hoy tiene que mandar a otro lado? Casi siempre esta a una maquina de ser su ingreso.', '',
            ].concat(local ? [showroomEs, ''] : ['Manuel importa directo, laser, radiofrecuencia, contorno corporal, y le dice de frente cual le conviene.', '']).concat([
                'Y si no le interesa, digamelo y no le vuelvo a escribir.',
            ]).join('\n') };
        }
        return { arm: 'bump', subject: 're: your equipment', body: [
            (fn ? 'Hi ' + fn + ',' : 'Hi,'), '',
            'I emailed you last week and figured it was worth one more try.', '',
            'The question still stands: what is the treatment your clients keep asking for that you have to send them elsewhere for? That is usually one machine away from being your revenue.', '',
        ].concat(local ? [showroomEn, ''] : ['Manuel imports direct, laser, RF microneedling, body contouring, and tells you straight which one is worth it.', '']).concat([
            'And if it is a no, just say so and I will not email you again.',
        ]).join('\n') };
    }

    const calledLine = (MODE === 'warm');
    const openEn = fn ? 'Hi ' + fn + ',' : 'Hi,';
    const openEs = fn ? 'Hola ' + fn + ',' : 'Hola,';

    if (es) {
        const lead1 = calledLine ? 'Gracias por atender mi llamada.'
            : 'Soy ' + sender + ', de ' + clientName + ' en Miami. Importamos equipos de estetica directo de fabrica.';
        if (arm === 'A') {
            return { arm: 'A', subject: (calledLine ? 'despues de nuestra llamada' : 'sobre sus equipos de estetica'), body: [
                openEs, '',
                lead1 + ' En las maquinas grandes, un laser, radiofrecuencia con microagujas, contorno corporal, el riesgo nunca fue lo que paga. Es comprar la equivocada, o quedarse sin servicio cuando falla.', '',
                'Manuel las importa directo de fabrica, asi que le dice de frente cual le rinde y cual no vale la pena, y las piezas y el servicio salen de Miami, no de un representante que ya se retiro.', '',
            ].concat(tailEs).concat(['Cual maquina esta mas cerca de agregar? Yo le digo exactamente que hace falta.']).join('\n') };
        }
        return { arm: 'B', subject: (calledLine ? 'una pregunta despues de la llamada' : 'el tratamiento que le piden'), body: [
            openEs, '',
            lead1 + ' Una pregunta: cual es el tratamiento que sus clientes siempre piden y que usted tiene que mandar a otro lado?', '',
            'Casi siempre esta a una maquina de ser su ingreso en vez de una referencia que se va por la puerta, y las de alto valor, laser y contorno corporal, se pagan solas mas rapido de lo que uno cree. Manuel las importa directo, asi que le muestra la maquina exacta y que hace falta para traerla a su spa.', '',
        ].concat(tailEs).concat(['Digame cual tratamiento es y yo me encargo del resto.']).join('\n') };
    }

    const lead1 = calledLine ? 'Thanks for taking my call.'
        : "I'm " + sender + ' with ' + clientName + ' in Miami. We import aesthetic machines direct from the factory.';
    if (arm === 'A') {
        return { arm: 'A', subject: (calledLine ? 'after our call' : 'about your aesthetic equipment'), body: [
            openEn, '',
            lead1 + ' On the big machines, a laser, RF microneedling, body contouring, the risk was never what you pay. It is buying the wrong one, or getting stuck with no service when it fails.', '',
            'Manuel imports them direct from the factory, so he tells you straight which one earns its keep and which is not worth it, and parts and service come out of Miami, not a rep who retired on you.', '',
        ].concat(tailEn).concat(['What machine are you closest to adding? I will have Manuel tell you exactly what it takes.']).join('\n') };
    }
    return { arm: 'B', subject: (calledLine ? 'one question after our call' : 'the treatment your clients keep asking for'), body: [
        openEn, '',
        lead1 + ' One question: what is the one treatment your clients keep asking for that you have to send them somewhere else for?', '',
        'That is usually one machine away from being your revenue instead of a referral out the door, and the high-ticket ones, laser and body contouring, pay for themselves faster than most owners expect. Manuel imports them direct, so he will show you the exact machine and what it takes to bring it in-house.', '',
    ].concat(tailEn).concat(['Tell me which treatment it is and I will take it from there.']).join('\n') };
}

/** Correctness checks that must hold for every generated body. */
function preSendCheck(subject, body) {
    const t = (subject + '\n' + body);
    const fails = [];
    if (/stilo/i.test(t)) fails.push('mentions STILO in client copy');
    if (/\$|\bprice\b|\bprecio\b|\bcost\b|\bcosto\b|starting at|desde \$/i.test(t)) fails.push('mentions price');
    if (/[—–]/.test(t)) fails.push('contains an em or en dash');
    if (/hialeah/i.test(t)) fails.push('mentions Hialeah (say Miami; standing rule 2026-09-03)');
    if (/https?:\/\/|www\./i.test(t)) fails.push('contains a link');
    if (/\bundefined\b|\bnull\b|Hi ,|Hola ,/.test(t)) fails.push('broken name merge');
    if (body.length > 1200) fails.push('body too long');
    return fails;
}

async function main() {
    const sb = sbLeads();
    const pub = sbPublic();

    const { data: client } = await pub.from('clients')
        .select('business_name, website').eq('id', CLIENT_ID).maybeSingle();
    const clientName = (client && client.business_name) || 'Blason Spa Equipment';
    const clientSite = (client && client.website) || '';

    // ---- BOUNCE BREAKER -------------------------------------------------
    // The domain is young and lane 2's pool is unproven. Before any send run,
    // look at the trailing 72h of this client's outbound email: 10+ sends with
    // an 8%+ bounce rate means the list is hurting the domain faster than the
    // volume is helping it, and the run refuses to start. Lane 1 measured 3.4%,
    // so a healthy run never trips this.
    const since = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const { data: recent } = await sb.from('lead_messages')
        .select('bounced_at, leads!inner(client_id)')
        .eq('direction', 'outbound').eq('channel', 'email')
        .gte('sent_at', since).eq('leads.client_id', CLIENT_ID);
    const rSent = (recent || []).length;
    const rBounced = (recent || []).filter(function (m) { return m.bounced_at; }).length;
    const rRate = rSent ? (rBounced / rSent) : 0;
    console.log('breaker:  ' + rBounced + '/' + rSent + ' bounced in the last 72h (' + (rRate * 100).toFixed(1) + '%)');
    // followup mode ONLY re-mails addresses that received email 1 and did NOT
    // bounce, so it cannot be the source of the trailing bounce and is exempt
    // from the aggregate breaker. The breaker exists to stop NEW bad lists
    // (cold/warm lanes), not proven-deliverable follow-ups. 2026-09-17.
    if (SEND && MODE !== 'followup' && rSent >= 10 && rRate >= 0.08) {
        console.error('REFUSING to send: trailing bounce rate is at or above 8%. Fix the list before feeding the domain more of it.');
        process.exit(2);
    }
    if (MODE === 'followup' && rRate >= 0.08) {
        console.log('note: trailing bounce is ' + (rRate * 100).toFixed(1) + '% but followup only re-mails non-bounced addresses, so it proceeds.');
    }

    // Lane 1 is the proven pool: a real person's address, verified domain,
    // medium confidence. Lane 2 is role inboxes (info@, contact@) whose domain
    // is alive: the local part is not a guessed person, so the 13% guess-miss
    // bounce rate of low-confidence PERSONAL addresses does not apply, but the
    // pool is unproven, which is exactly what the breaker above is for.
    const SELECT_COLS = 'id,name,owner_name,owner_email,email,email_verify_address,address,primary_language,'
        + 'email_verify_status,email_confidence,bounced_at,unsubscribed_at,email_1_sent_at,email_2_sent_at,'
        + 'reply_received_at,last_called_outcome,stage,do_not_call';
    let q = sb.from('leads').select(SELECT_COLS)
        .eq('client_id', CLIENT_ID)
        .is('bounced_at', null)
        .is('unsubscribed_at', null);
    if (MODE === 'followup') {
        // One bump per lead, 3+ days after email 1, only while they have
        // neither replied nor bounced nor unsubscribed. email_2_sent_at is the
        // idempotency stamp, so re-running tops up instead of re-bumping.
        const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
        q = q.not('email_1_sent_at', 'is', null).lt('email_1_sent_at', cutoff)
            .is('email_2_sent_at', null).is('reply_received_at', null);
    } else if (MODE === 'warm') {
        // Reached on the phone (connected filter below), address passed DNS
        // verification, never emailed. DELIVERABLE ONLY. The 2026-09-04 warm
        // batch allowed role inboxes on the theory that a prior call made it
        // follow-up, not list mail; deliverability does not care about the
        // relationship: 21 of 36 role-inbox sends bounced (58%) vs 0 of 3
        // personal addresses. An info@ that does not exist bounces no matter
        // how warm the lead is.
        q = q.is('email_1_sent_at', null)
            .eq('email_verify_status', 'deliverable')
            .not('last_called_at', 'is', null);
    } else {
        const laneStatus = LANE === '2' ? 'role_inbox' : (LANE === '3' ? 'site_published' : 'deliverable');
        q = q.is('email_1_sent_at', null).eq('email_verify_status', laneStatus);
        if (LANE === '1') q = q.eq('email_confidence', 'medium');
    }
    const { data: leads, error } = await q.limit(MODE === 'warm' ? 2000 : LIMIT * 3);   // over-fetch, the filters below remove some
    if (error) { console.error(error); process.exit(1); }

    // ---- CONSENT FILTER -------------------------------------------------
    // Bounced / unsubscribed / suppressed are DELIVERABILITY gates. They say
    // nothing about whether the person already told us no, and on 2026-08-31
    // this script emailed The Salt Room Orlando two days after they texted
    // "Hi, we are not interested. Thanks though!" and were correctly marked
    // dead on the SMS campaign. The Instagram worklist had these exclusions
    // from the start; the email lane did not. A decline in ANY channel is a
    // decline in every channel.
    // ---- BOUNCE SHIELDS (2026-09-14, before opening lane 2 at volume) ----
    // (a) Domain blacklist: any domain that has EVER bounced one of our sends
    //     is dead to us; the sending domain pays for every retry.
    // (b) Address dedupe: several leads share one inbox (franchises). Lowest
    //     lead id in the batch owns the address; the rest wait.
    const bounceDomains = new Set();
    {
        let from = 0;
        while (true) {
            const { data: rows } = await sb.from('lead_messages')
                .select('to_address').eq('channel', 'email').not('bounced_at', 'is', null)
                .range(from, from + 999);
            if (!rows || !rows.length) break;
            for (const r of rows) {
                const d = String(r.to_address || '').split('@')[1];
                if (d) bounceDomains.add(d.toLowerCase());
            }
            if (rows.length < 1000) break; from += 1000;
        }
        console.log('bounce-domain blacklist: ' + bounceDomains.size + ' domains');
    }
    const declined = new Set(['owner_uninterested', 'do_not_call']);
    // MEETING_BOOKED counts as closed for outbound purposes: a lead mid-visit
    // or mid-reschedule is in a live human conversation, and a templated
    // "i called you recently" email into that thread reads like a bot (Oya
    // Wellness got one on 2026-09-08 while actively texting about that day's
    // showroom visit).
    const CLOSED = ['CLOSED_LOST', 'CLOSED_WON', 'MEETING_BOOKED'];
    const { data: killed } = await sb.from('outbound_targets')
        .select('lead_id, stage').in('stage', ['dead', 'opted_out', 'queued']);
    const killedIds = new Set((killed || []).filter(function (t) { return t.stage !== 'queued'; }).map(function (t) { return t.lead_id; }));
    // Warm email skips anyone sitting in an SMS queue: a text and an email on
    // the same day, both opening with "i called you", reads like a blitz. The
    // SMS goes first; the email stays available for a later batch.
    const queuedIds = new Set((killed || []).filter(function (t) { return t.stage === 'queued'; }).map(function (t) { return t.lead_id; }));

    // Warm mode requires an actual conversation on record: a connected outbound
    // call of 20 seconds or more, same bar the SMS campaign uses at enqueue.
    let connectedIds = null;
    if (MODE === 'warm') {
        connectedIds = new Set();
        let from = 0;
        for (;;) {
            const { data: calls, error: cErr } = await sb.from('lead_calls')
                .select('lead_id, duration_seconds, leads!inner(client_id)')
                .eq('leads.client_id', CLIENT_ID)
                .gte('duration_seconds', 20)
                .range(from, from + 999);
            if (cErr) { console.error(cErr); process.exit(1); }
            if (!calls || !calls.length) break;
            for (const c of calls) if (c.lead_id) connectedIds.add(c.lead_id);
            if (calls.length < 1000) break;
            from += 1000;
        }
    }

    const consented = leads.filter(function (l) {
        if (connectedIds && !connectedIds.has(l.id)) return false;
        if (MODE === 'warm' && queuedIds.has(l.id)) return false;
        if (l.do_not_call) return false;
        if (declined.has(l.last_called_outcome)) return false;
        if (CLOSED.includes(l.stage)) return false;
        if (killedIds.has(l.id)) return false;
        return true;
    });
    const removed = leads.length - consented.length;
    const _seenAddr = new Set();
    const shielded = consented.filter(function (l) {
        const addr = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!addr) return false;
        const dom = addr.split('@')[1];
        if (dom && bounceDomains.has(dom)) return false;
        if (_seenAddr.has(addr)) return false;
        _seenAddr.add(addr);
        return true;
    });
    if (shielded.length !== consented.length) {
        console.log('bounce shields removed ' + (consented.length - shielded.length) + ' (blacklisted domain or duplicate inbox)');
    }
    const eligible = shielded.slice(0, LIMIT);
    if (removed) console.log('consent filter removed ' + removed + ' lead(s) who already said no');

    console.log('client:   ' + clientName);
    const modeDesc = MODE === 'followup' ? 'emailed 3+ days ago, no reply, no bounce, no unsubscribe'
        : MODE === 'warm' ? '20s+ connected call, DNS-verified address, never emailed'
        : (LANE === '2' ? 'role inbox on a live domain'
            : LANE === '3' ? 'address published on their own site'
            : 'medium confidence + MX clean') + ', never emailed';
    console.log('mode ' + MODE + (MODE === 'cold' ? ' lane ' + LANE : '') + ':   '
        + eligible.length + ' eligible (' + modeDesc + ')');
    console.log('mode:     ' + (SEND ? 'SENDING' : 'DRY RUN (pass --send to actually send)'));
    console.log('');

    const sender = await kit.getSenderIdentity(process.env.STILO_SENDER_EMAIL);
    const fromEmail = process.env.BLASON_SENDER_EMAIL || sender.fromEmail;
    const fromName = '"' + sender.name.replace(/"/g, '') + ' · ' + clientName + '"';
    const stats = { sent: 0, skipped: 0, failed: 0, dup: 0 };

    for (const lead of eligible) {
        // Prefer the address the verifier actually checked, then owner_email,
        // then the plain email column (rep-collected addresses land there).
        const to = String(lead.email_verify_address || lead.owner_email || lead.email || '').trim().toLowerCase();
        const tag = '#' + lead.id + ' ' + String(lead.name).slice(0, 40);

        const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', to).limit(1);
        if (sup && sup.length) { console.log('SKIP  ' + tag + '  suppressed'); stats.skipped++; continue; }

        const ok = await guard.canSend({ email: to });
        if (!ok.ok) { console.log('SKIP  ' + tag + '  guard: ' + ok.reason); stats.skipped++; continue; }

        const { subject, body, arm } = compose(lead, clientName);
        const fails = preSendCheck(subject, body);
        if (fails.length) { console.log('SKIP  ' + tag + '  copy: ' + fails.join('; ')); stats.skipped++; continue; }

        if (!SEND) {
            console.log('DRY   ' + tag + '  -> ' + to + (ok.role ? '  [role inbox]' : ''));
            console.log('      ' + subject + ' | ' + body.split('\n')[0] + ' ...');
            stats.sent++; continue;
        }

        // CLAIM before sending. A read-then-check loses the race; see send-email.js.
        const dedupeKey = crypto.createHash('sha1')
            .update([lead.id, 'email', to, subject, Math.floor(Date.now() / 300000)].join('|')).digest('hex');
        const claim = await sb.from('lead_messages').insert({
            lead_id: lead.id, direction: 'outbound', channel: 'email', subject: subject,
            sent_at: new Date().toISOString(), sent_by: process.env.STILO_SENDER_EMAIL || null,
            to_address: to, provider: 'resend', status: 'sending', dedupe_key: dedupeKey,
            variant: (MODE === 'cold' ? 'blason_lane' + LANE : 'blason_' + MODE) + '_' + (arm || 'x'),
        }).select('id').single();
        if (claim.error) {
            if (String(claim.error.code) === '23505') { console.log('DUP   ' + tag); stats.dup++; continue; }
            console.log('FAIL  ' + tag + '  claim: ' + claim.error.message); stats.failed++; continue;
        }

        const html = kit.buildClientEmailHtml({
            bodyText: body, sender: sender, clientName: clientName,
            es: lead.primary_language === 'es', website: clientSite,
        });
        const plain = kit.sanitizeCopy(body) + '\n\n' +
            kit.clientFooterText(sender, clientName, lead.primary_language === 'es', clientSite);
        const t = unsubToken(to);

        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: fromName + ' <' + fromEmail + '>',
                    to: [to],
                    reply_to: process.env.STILO_REPLY_TO || fromEmail,
                    subject: subject,
                    html: html,          // no tracking pixel: this is cold volume
                    text: plain,
                    headers: t ? {
                        'List-Unsubscribe': '<https://stiloaipartners.com/api/unsubscribe?t=' + t + '>, <mailto:' + (process.env.STILO_REPLY_TO || fromEmail) + '?subject=unsubscribe>',
                        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                    } : undefined,
                }),
            });
            const j = await r.json().catch(function () { return {}; });
            if (!r.ok) {
                await sb.from('lead_messages').delete().eq('id', claim.data.id);   // release the claim
                console.log('FAIL  ' + tag + '  resend: ' + (j.message || ('http_' + r.status)));
                stats.failed++; continue;
            }
            await sb.from('lead_messages').update({
                body: plain, body_preview: plain.slice(0, 280), from_address: fromEmail,
                provider_message_id: j.id || null, status: 'sent',
            }).eq('id', claim.data.id);
            const stamp = MODE === 'followup'
                ? { email_2_sent_at: new Date().toISOString(), email_2_status: 'sent' }
                : { email_1_sent_at: new Date().toISOString(), email_1_status: 'sent' };
            await sb.from('leads').update(stamp).eq('id', lead.id);
            console.log('SENT  ' + tag + '  -> ' + to);
            stats.sent++;
        } catch (e) {
            await sb.from('lead_messages').delete().eq('id', claim.data.id);
            console.log('FAIL  ' + tag + '  ' + String(e.message || e));
            stats.failed++; continue;
        }
        await new Promise(function (r) { setTimeout(r, GAP_MS); });
    }

    console.log('\n' + JSON.stringify(stats));
    if (!SEND) console.log('Dry run. Nothing was sent. Re-run with --send.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
