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
 *
 * VALUE SERIES (2026-10-01): --mode value sends the 10-step teaching series in
 * scripts/blason_value_copy.js to leads already emailed (email 1), one every
 * 3 days measured from the most recent email of ANY kind. Claimed on the lead
 * (value_step, guarded update) and on lead_messages (dedupe_key per lead+step)
 * before the send. Every template is rendered and validated at startup; one
 * failing template stops the run, dry or live.
 *   node scripts/send_client_sequence.js --mode value --limit 40 [--show] [--send]
 *
 * LANE 4 (2026-10-01): email_verify_status='deliverable' at ANY confidence,
 * never emailed. A 10/day test pool; the 8% breaker stays in force for it.
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
const valueCopy = require(path.join(__dirname, 'blason_value_copy.js'));

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const CLIENT_ID = arg('client', '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
const LIMIT = parseInt(arg('limit', '20'), 10);
const SEND = args.includes('--send');
const LANE = arg('lane', '1');   // 1 = medium+deliverable (proven 3.4%), 2 = role inboxes on live domains,
                                 // 3 = site_published (address the business prints on its own site; the
                                 //     2026-09-13 contact-page crawl stamps these)
                                 // 4 = deliverable at ANY confidence (test pool, 10/day, breaker on)
                                 // 5 = REP addresses (2026-10-03, Remy): an address a human typed into the
                                 //     lead or emailed from the drawer, or one that came with the original
                                 //     import and the finder never produced. Role prefix allowed: Remy said
                                 //     "if I was the one to type in the info@, it goes out". Bounced 3 of 456
                                 //     lifetime (0.7%), so it is the cleanest pool we have. Finder-found role
                                 //     inboxes stay in lane 2, ramped slowly with bounce tracked per lane.
// cold     = never-emailed leads picked by LANE (the original behaviour)
// followup = the next due step (2 to 5) for leads already emailed, with no reply, no bounce, no unsubscribe
// warm     = leads a rep actually reached on the phone (20s+ connected call) whose
//            address passed DNS verification and who have never been emailed
// value    = the 10-step teaching series (blason_value_copy.js), one every 3 days
//            after the most recent email of any kind, to leads who got email 1
const MODE = arg('mode', 'cold');
if (!['cold', 'followup', 'warm', 'value'].includes(MODE)) { console.error('bad --mode'); process.exit(1); }
if (MODE === 'cold' && !['1', '2', '3', '4', '5'].includes(LANE)) { console.error('bad --lane'); process.exit(1); }
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
 * email_1..4_sent_at are `timestamp without time zone` holding naive UTC, and
 * `new Date('2026-09-28T14:00:00')` parses that as LOCAL time (4h off on this
 * Mac). Treat a stamp with no zone as UTC.
 */
function tsMs(v) {
    if (!v) return 0;
    const s = String(v);
    const t = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime();
    return isNaN(t) ? 0 : t;
}
function etDay(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

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
 * Steps 2 to 5 of the sequence (2026-09-28). Step 1 is compose() below.
 *
 * Until now the sequence was one email and one bump. Each step here makes a
 * DIFFERENT case for the same small ask (a showroom visit for South Florida, a
 * 10 minute phone call with Manuel for everyone else), so a lead who ignored
 * one angle meets a new one instead of the same note again:
 *
 *   2  the bump         did the first one get buried
 *   3  the risk         buying the wrong machine, or being orphaned on parts
 *   4  the invitation   a concrete visit or call, their pick of day
 *   5  the close-out    last note, door left open
 *
 * Personalised from fields we actually hold: corroborated first name, the
 * business name, what kind of practice it is, language, and distance from the
 * showroom. Nothing here is invented per lead. Never a price, never a link.
 */
const LASER_LEGAL_RE = /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|laser|medical clinic/i;
const STEP_GAP_DAYS = { 2: 3, 3: 4, 4: 5, 5: 7 };   // days since the previous step
const MAX_STEP = 5;

function shortBusinessName(name) {
    // "Hello Sugar | Orlando Sodo - Brazilian Wax" -> "Hello Sugar"
    const n = String(name || '').split(/\s[|\-:]\s|\s*\|\s*/)[0].replace(/[®™]/g, '').trim();
    return (n.length >= 3 && n.length <= 40) ? n : null;
}

/**
 * Manuel's laser special (flyer from Remy, 2026-09-29): diode and YAG lasers,
 * through Friday 10/2/2026. A real deadline is the one urgency lever the call
 * transcripts show working, so it rides the emails while it is TRUE, and only
 * to practices that can legally run a laser. Never the numbers, never the
 * flyer (it lists prices and an unverified "FDA approved"). It switches itself
 * off after the last day, Eastern time.
 */
const SPECIAL_LAST_DAY_ET = '2026-10-02';
function specialLine(lead, es) {
    const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (todayEt > SPECIAL_LAST_DAY_ET) return null;
    if (!LASER_LEGAL_RE.test(String(lead.category || ''))) return null;
    return es
        ? 'Un dato: Manuel tiene sus láseres en especial hasta este viernes, 2 de octubre, así que conviene hablar antes.'
        : 'One thing worth knowing: Manuel has his lasers on a special through this Friday, October 2, so it is worth talking before then.';
}
/** Put the special line just above the closing paragraph of a composed email. */
function addSpecial(r, lead, es) {
    const sp = specialLine(lead, es);
    if (!sp || !r || !r.body) return r;
    const i = r.body.lastIndexOf('\n\n');
    r.body = i > 0 ? r.body.slice(0, i) + '\n\n' + sp + r.body.slice(i) : r.body + '\n\n' + sp;
    return r;
}

function composeFollowup(lead, c) {
    return addSpecial(composeFollowupBase(lead, c), lead, c.es);
}
function composeFollowupBase(lead, c) {
    const step = lead.__step || 2;
    const es = c.es, fn = c.fn, local = c.local;
    const hi = es ? (fn ? 'Hola ' + fn + ',' : 'Hola,') : (fn ? 'Hi ' + fn + ',' : 'Hi,');
    const opt = es ? c.optEs : c.optEn;
    const biz = shortBusinessName(lead.name);
    const medical = LASER_LEGAL_RE.test(String(lead.category || ''));
    const join = function (lines) { return lines.join('\n'); };

    if (step === 2) {
        return es
            ? { arm: 'step2', subject: 're: sus máquinas', body: join([hi, '',
                'Le escribí la semana pasada y no quería que se perdiera en su bandeja.', '',
                '¿Hay alguna máquina que ha estado pensando agregar este año? Aunque sea una idea, yo le digo cuál le conviene.' + c.showEs, '', opt]) }
            : { arm: 'step2', subject: 're: your machines', body: join([hi, '',
                "I emailed you last week and didn't want it to get buried.", '',
                "Is there a machine you've been thinking about adding this year? Even a rough idea, and I'll tell you which one makes sense." + c.showEn, '', opt]) };
    }

    if (step === 3) {
        const whatEn = medical ? 'a laser or an RF unit' : 'a new machine';
        const whatEs = medical ? 'un láser o un equipo de radiofrecuencia' : 'una máquina nueva';
        return es
            ? { arm: 'step3', subject: 'lo que pasa después de comprar', body: join([hi, '',
                'Casi nadie se arrepiente de comprar ' + whatEs + '. Se arrepienten de lo que pasa después: la pieza que tarda semanas, el representante que ya no contesta, el equipo que nadie le enseñó a usar bien.', '',
                'Manuel importa los equipos él mismo y los atiende desde Miami. Las piezas están aquí, el entrenamiento lo da él y le deja su certificado.', '',
                (biz ? 'En ' + biz + ', ' : '') + '¿qué equipo le ha dado más dolores de cabeza hasta ahora?', '', opt]) }
            : { arm: 'step3', subject: 'what happens after you buy', body: join([hi, '',
                'Almost nobody regrets buying ' + whatEn + '. They regret what comes after: the part that takes weeks, the rep who stops answering, the machine nobody trained the staff on.', '',
                'Manuel imports the equipment himself and services it from Miami. Parts are here, he does the training, and you leave with a certificate.', '',
                (biz ? 'At ' + biz + ', which' : 'Which') + ' machine has given you the most headaches so far?', '', opt]) };
    }

    if (step === 4) {
        if (local) {
            return es
                ? { arm: 'step4', subject: 'venga a probarlas', body: join([hi, '',
                    'Le propongo algo sencillo. Venga 20 minutos al showroom de Manuel aquí en Miami' + (biz ? ' con alguien de ' + biz : '') + ', pruebe los equipos encendidos y haga todas las preguntas que quiera. Si nada le sirve, se va sin compromiso.', '',
                    '¿Qué le queda mejor, un día de esta semana o de la próxima? Dígame el día y yo lo cuadro con Manuel.', '', opt]) }
                : { arm: 'step4', subject: 'come try them', body: join([hi, '',
                    "Here's a simple idea. Come by Manuel's showroom here in Miami for 20 minutes" + (biz ? ' with whoever runs treatments at ' + biz : '') + ', try the machines while they are running, and ask anything you want. If nothing fits, you walk out and that is the end of it.', '',
                    'Which works better, a day this week or next? Give me the day and I will set it up with Manuel.', '', opt]) };
        }
        return es
            ? { arm: 'step4', subject: '10 minutos con Manuel', body: join([hi, '',
                'Como no están en Miami, le propongo diez minutos por teléfono con Manuel, el dueño. Él le pregunta qué tratamientos hacen y le dice de frente qué equipo le conviene' + (biz ? ' a ' + biz : '') + ' o no.', '',
                'Enviamos a toda la Florida y el entrenamiento va incluido.', '',
                '¿Qué le queda mejor, un día de esta semana o de la próxima?', '', opt]) }
            : { arm: 'step4', subject: '10 minutes with Manuel', body: join([hi, '',
                "Since you're not in Miami, here's the easy version: ten minutes on the phone with Manuel, the owner. He asks what treatments you run and tells you straight which machine makes sense" + (biz ? ' for ' + biz : '') + ' or not.', '',
                'We ship anywhere in Florida and training comes with it.', '',
                'Which works better, a day this week or next?', '', opt]) };
    }

    // step 5
    const askEn = local ? "Manuel's showroom is here in Miami" : 'Manuel is ten minutes away by phone and ships anywhere in Florida';
    const askEs = local ? 'el showroom de Manuel está aquí en Miami' : 'Manuel está a diez minutos por teléfono y envía a toda la Florida';
    return es
        ? { arm: 'step5', subject: 'cierro el tema', body: join([hi, '',
            'Este es mi último correo, no quiero llenarle la bandeja.', '',
            'Si más adelante piensa agregar un equipo, abrir otra cabina o cambiar uno que ya está viejo, ' + askEs + '. Me responde a este correo y lo cuadramos el mismo día.', '',
            'Y si ya tiene algo en mente ahora, dígame cuál y se lo paso a Manuel hoy.', '',
            'Que le vaya muy bien' + (biz ? ' en ' + biz : '') + '.']) }
        : { arm: 'step5', subject: 'closing the loop', body: join([hi, '',
            "This is my last note, I don't want to crowd your inbox.", '',
            "If down the road you're adding a machine, opening another room, or replacing one that's getting old, " + askEn + '. Reply to this email and we will set it up the same day.', '',
            "And if something is already on your mind, tell me which machine and I'll put it in front of Manuel today.", '',
            'Wishing you a great rest of the year' + (biz ? ' at ' + biz : '') + '.']) };
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
    if (MODE === 'value') return addSpecial(composeValueFor(lead), lead, lead.primary_language === 'es');
    const r = composeBase(lead, clientName);
    return MODE === 'followup' ? r : addSpecial(r, lead, lead.primary_language === 'es');
}

/**
 * Value series step for one lead. The name only goes in when the owner name is
 * verified (or rep-confirmed) AND the address corroborates it; otherwise the
 * neutral "Hi,". Local = the same LOCAL_ZIP3 rule the showroom copy uses.
 */
function composeValueFor(lead) {
    const es = lead.primary_language === 'es';
    const verified = ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status);
    return valueCopy.composeValue(lead.__vstep, {
        es: es,
        seg: valueCopy.valueSegment(lead.category),
        local: LOCAL_ZIP3.includes(zip3(lead.address)),
        fn: verified ? corroboratedFirstName(lead) : null,
        slots: valueCopy.showroomSlots(Date.now(), es),
    });
}
function composeBase(lead, clientName) {
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

    // 2026-09-25 rewrite (Remy): read like a note from a person, not a pitch.
    // Short, one question, the opt-out said like a human at the bottom.
    // (List-Unsubscribe header still ships on every send.)
    const optEn = "And if you'd rather I not email, just reply no thanks and I'll leave you alone.";
    const optEs = 'Y si prefiere que no le escriba, respóndame "no gracias" y no le escribo más.';
    const showEn = local ? " Manuel's showroom is here in Miami, so you can try a machine before deciding anything." : " We import everything direct and ship anywhere in Florida.";
    const showEs = local ? ' El showroom de Manuel está aquí en Miami, así que puede probar una máquina antes de decidir nada.' : ' Importamos todo directo y enviamos a cualquier parte de Florida.';

    if (MODE === 'followup') {
        return composeFollowup(lead, { es: es, fn: fn, local: local, optEn: optEn, optEs: optEs, showEn: showEn, showEs: showEs });
    }

    const calledLine = (MODE === 'warm');
    const openEn = fn ? 'Hi ' + fn + ',' : 'Hi,';
    const openEs = fn ? 'Hola ' + fn + ',' : 'Hola,';

    if (es) {
        const intro = calledLine ? 'Gracias por atender mi llamada el otro día.'
            : 'Soy ' + sender + ', de ' + clientName + ' aquí en Miami. Importamos máquinas de estética directo de fábrica.';
        if (arm === 'A') {
            return { arm: 'A', subject: (calledLine ? 'después de nuestra llamada' : 'algo nuevo este año'), body: [
                openEs, '', intro, '',
                '¿Viene algo nuevo para ustedes este año? ¿Un servicio nuevo, otra cabina, o una máquina que ya está vieja? Si me dice cuál, le pido a Manuel, el dueño, que le diga de frente cuál le conviene.' + showEs, '',
                optEs,
            ].join('\n') };
        }
        return { arm: 'B', subject: (calledLine ? 'una pregunta después de la llamada' : 'las clientas más difíciles'), body: [
            openEs, '', intro, '',
            'Con el equipo que tienen hoy, ¿qué clientas se les complican más? Si me dice cuáles, Manuel, el dueño, le dice de frente si tiene algo que lo resuelva.' + showEs, '',
            optEs,
        ].join('\n') };
    }

    const intro = calledLine ? 'Thanks for taking my call the other day.'
        : "I'm " + sender + ' with ' + clientName + ' here in Miami. We import aesthetic machines direct from the factory.';
    if (arm === 'A') {
        return { arm: 'A', subject: (calledLine ? 'after our call' : 'anything new this year'), body: [
            openEn, '', intro, '',
            "Anything new coming up for you this year? A new service, another room, or a machine that's getting old? Tell me which and I'll have Manuel, the owner, tell you straight what makes sense." + showEn, '',
            optEn,
        ].join('\n') };
    }
    return { arm: 'B', subject: (calledLine ? 'one question after our call' : 'your hardest clients'), body: [
        openEn, '', intro, '',
        "With the equipment you have today, which clients are the hardest to treat? Tell me which and Manuel, the owner, will tell you straight whether he has something that fixes it." + showEn, '',
        optEn,
    ].join('\n') };
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

/** The step this lead is due for right now, or null. */
function nextStepFor(lead) {
    for (let n = 2; n <= MAX_STEP; n++) {
        if (lead['email_' + n + '_sent_at']) continue;
        const prev = lead['email_' + (n - 1) + '_sent_at'];
        if (!prev) return null;
        const ageDays = (Date.now() - new Date(prev).getTime()) / 86400000;
        return ageDays >= STEP_GAP_DAYS[n] ? n : null;
    }
    return null;
}

async function main() {
    const sb = sbLeads();
    const pub = sbPublic();

    // Value series: render and validate EVERY template combination (with the
    // live special-line gate applied) before touching a lead. One bad template
    // stops the run, dry or live.
    if (MODE === 'value') {
        const bad = valueCopy.selfTest(addSpecial);
        if (bad.length) {
            console.error('VALUE COPY FAILED VALIDATION (' + bad.length + '):\n  ' + bad.join('\n  '));
            process.exit(3);
        }
        console.log('value copy: all templates pass validation');
    }

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
    // value mode is exempt for the same reason: it only re-mails addresses
    // that already took email 1 without bouncing (2026-10-01).
    if (SEND && MODE !== 'followup' && MODE !== 'value' && rSent >= 10 && rRate >= 0.08) {
        console.error('REFUSING to send: trailing bounce rate is at or above 8%. Fix the list before feeding the domain more of it.');
        process.exit(2);
    }
    if ((MODE === 'followup' || MODE === 'value') && rRate >= 0.08) {
        console.log('note: trailing bounce is ' + (rRate * 100).toFixed(1) + '% but ' + MODE + ' only re-mails non-bounced addresses, so it proceeds.');
    }

    // Lane 1 is the proven pool: a real person's address, verified domain,
    // medium confidence. Lane 2 is role inboxes (info@, contact@) whose domain
    // is alive: the local part is not a guessed person, so the 13% guess-miss
    // bounce rate of low-confidence PERSONAL addresses does not apply, but the
    // pool is unproven, which is exactly what the breaker above is for.
    const SELECT_COLS = 'id,name,owner_name,owner_email,email,email_verify_address,address,primary_language,'
        + 'email_verify_status,email_confidence,bounced_at,unsubscribed_at,email_1_sent_at,email_2_sent_at,'
        + 'reply_received_at,last_called_outcome,stage,do_not_call,next_step,pinned_at,category,'
        + 'email_3_sent_at,email_4_sent_at,email_5_sent_at,value_step,value_last_sent_at,owner_name_verify_status,'
        + 'all_emails_json,email_search_status';
    let q = sb.from('leads').select(SELECT_COLS)
        .eq('client_id', CLIENT_ID)
        .is('bounced_at', null)
        .is('unsubscribed_at', null);
    if (MODE === 'followup') {
        // Steps 2 to 5. Anyone who got email 1, has not finished the sequence,
        // and has neither replied nor bounced nor unsubscribed. WHICH step is
        // due, and whether enough days have passed, is decided per lead below
        // (nextStepFor). email_N_sent_at is the idempotency stamp for step N.
        q = q.not('email_1_sent_at', 'is', null)
            .is('email_5_sent_at', null).is('reply_received_at', null);
    } else if (MODE === 'value') {
        // Value series: got email 1, has not finished the 10 steps, no reply.
        // Cadence and the any-channel reply check are decided per lead below.
        q = q.not('email_1_sent_at', 'is', null).is('reply_received_at', null)
            .or('value_step.is.null,value_step.lt.' + valueCopy.MAX_VALUE_STEP);
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
    } else if (LANE === '5') {
        // Rep lane: never emailed, domain alive. Whether the address is a
        // rep/import address (vs finder-found) is decided per lead below.
        q = q.is('email_1_sent_at', null).neq('email_verify_status', 'dead_domain');
    } else {
        // Lane 4 is lane 1 without the confidence gate: 'deliverable' at any
        // confidence. Unproven, so it runs at 10/day under the 8% breaker.
        const laneStatus = LANE === '2' ? 'role_inbox' : (LANE === '3' ? 'site_published' : 'deliverable');
        q = q.is('email_1_sent_at', null).eq('email_verify_status', laneStatus);
        if (LANE === '1') q = q.eq('email_confidence', 'medium');
    }
    // Every mode reads the whole pool: which leads are DUE is decided in code
    // below, so a small fetch would hide due leads behind ones that are not.
    const { data: leads, error } = await q.limit(2000);
    if (error) { console.error(error); process.exit(1); }

    // Cold sends spend the daily cap on the best leads first, not on whatever
    // order the database returns. The 9/24 transcript read: Orlando 145 called
    // / 0 booked, South FL 4 of 5 bookings, and only laser-legal practices
    // (med spas, derms, surgeons) buy the big units. Lower rank sends first.
    // This is wider than LOCAL_ZIP3 on purpose: that one gates showroom copy.
    if (MODE === 'cold') {
        const SOUTH_FL_ZIP3 = ['330', '331', '332', '333', '334'];
        const rank = function (l) {
            const south = SOUTH_FL_ZIP3.includes(zip3(l.address)) ? 0 : 2;
            const cat = String(l.category || '');
            const seg = /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|laser|medical clinic/i.test(cat) ? 0
                : /beauty salon|hair salon|nail|barber|massage|wellness/i.test(cat) ? 3 : 1;
            return south + seg;
        };
        leads.sort(function (a, b) {
            return (rank(a) - rank(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
    }

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
    const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'me.com']);
    {
        let from = 0;
        while (true) {
            const { data: rows } = await sb.from('lead_messages')
                .select('to_address').eq('channel', 'email').not('bounced_at', 'is', null)
                .range(from, from + 999);
            if (!rows || !rows.length) break;
            for (const r of rows) {
                const d = String(r.to_address || '').split('@')[1];
                // Free-mail domains never go on the domain blacklist: one bad gmail
                // address says nothing about every other gmail inbox.
                if (d && !FREE_MAIL_DOMAINS.has(d.toLowerCase())) bounceDomains.add(d.toLowerCase());
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

    // Value series reads each candidate's message history: ANY inbound message
    // (an SMS reply never stamps reply_received_at) or a captured reply on any
    // outbound row is a reply, and the newest outbound email of any kind (a
    // manual one from the dashboard included) anchors the 3-day cadence.
    const repliedIds = new Set();
    const lastEmailMs = {};
    if (MODE === 'value') {
        const ids = leads.map(function (l) { return l.id; });
        for (let i = 0; i < ids.length; i += 150) {
            const { data: msgs, error: mErr } = await sb.from('lead_messages')
                .select('lead_id, direction, channel, sent_at, replied_at, status')
                .in('lead_id', ids.slice(i, i + 150)).limit(5000);
            if (mErr) { console.error(mErr); process.exit(1); }
            for (const m of (msgs || [])) {
                if (m.direction === 'inbound' || m.replied_at) repliedIds.add(m.lead_id);
                if (m.direction === 'outbound' && m.channel === 'email') {
                    lastEmailMs[m.lead_id] = Math.max(lastEmailMs[m.lead_id] || 0, tsMs(m.sent_at));
                }
            }
        }
    }
    // Lane 5 origin test. "Rep address" = a human emailed this lead from the
    // drawer (variants ask/ctx/desk/manual*), OR the address has no finder
    // trace (email_search_status is not 'found' and it is not among the
    // finder's candidates in all_emails_json). Everything the finder produced
    // stays in lanes 1/2/4 with their own bounce history.
    let humanEmailedIds = null;
    if (MODE === 'cold' && LANE === '5') {
        humanEmailedIds = new Set();
        const { data: hm } = await sb.from('lead_messages').select('lead_id')
            .eq('channel', 'email').eq('direction', 'outbound')
            .in('variant', ['ask', 'ctx', 'desk', 'manual_followup', 'manual']).limit(5000);
        (hm || []).forEach(function (m) { humanEmailedIds.add(m.lead_id); });
    }
    const isRepAddress = function (l) {
        if (humanEmailedIds && humanEmailedIds.has(l.id)) return true;
        const addr = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!addr) return false;
        if (l.email_search_status === 'found') return false;
        const cands = JSON.stringify(l.all_emails_json || '').toLowerCase();
        return cands.indexOf(addr) === -1;
    };

    const skipWhy = {};
    const skipped = function (why) { skipWhy[why] = (skipWhy[why] || 0) + 1; return false; };

    const consented = leads.filter(function (l) {
        if (humanEmailedIds && !isRepAddress(l)) return skipped('finder address, not lane 5');
        if (MODE === 'value') {
            if (l.do_not_call) return skipped('do_not_call');
            if (declined.has(l.last_called_outcome)) return skipped('declined on a call');
            if (CLOSED.includes(l.stage)) return skipped('stage ' + l.stage);
            if (killedIds.has(l.id)) return skipped('dead/opted out on SMS');
            if (l.pinned_at || String(l.next_step || '').trim()) return skipped('human-owned (pinned or next step)');
            if (repliedIds.has(l.id)) return skipped('replied in some channel');
            return true;
        }
        if (connectedIds && !connectedIds.has(l.id)) return false;
        if (MODE === 'warm' && queuedIds.has(l.id)) return false;
        if (l.do_not_call) return false;
        if (declined.has(l.last_called_outcome)) return false;
        if (CLOSED.includes(l.stage)) return false;
        if (killedIds.has(l.id)) return false;
        // A lead a human is working (dated next step or pinned to Hottest) never gets a
        // generic intro email on top of the real conversation (Natasha, 9/28).
        if (l.pinned_at || String(l.next_step || '').trim()) return false;
        return true;
    });
    const removed = leads.length - consented.length;
    if (MODE === 'value') {
        // Due = 3+ days since the newest email of any kind (steps 1 to 5, the
        // last value step, or any outbound email row). Oldest waiting first.
        const now = Date.now();
        const due = [];
        for (const l of consented) {
            const last = Math.max(tsMs(l.email_1_sent_at), tsMs(l.email_2_sent_at), tsMs(l.email_3_sent_at),
                tsMs(l.email_4_sent_at), tsMs(l.email_5_sent_at), tsMs(l.value_last_sent_at), lastEmailMs[l.id] || 0);
            if (etDay(last) === etDay(now)) { skipped('emailed today'); continue; }
            if (now - last < valueCopy.VALUE_GAP_DAYS * 86400000) { skipped('under 3 days since last email'); continue; }
            l.__vstep = (l.value_step || 0) + 1;
            l.__vlast = last;
            due.push(l);
        }
        due.sort(function (a, b) { return a.__vlast - b.__vlast; });
        consented.length = 0;
        Array.prototype.push.apply(consented, due);
    }
    if (MODE === 'followup') {
        // Oldest waiting first, so nobody sits between steps while newer leads
        // take the cap. Never a second email the same ET day as a value email.
        const today = etDay(Date.now());
        for (const l of consented) l.__step = (tsMs(l.value_last_sent_at) && Date.now() - tsMs(l.value_last_sent_at) < 3 * 86400e3) ? null : nextStepFor(l);  // 3-day gap after a value email
        const due = consented.filter(function (l) { return l.__step; });
        due.sort(function (a, b) {
            return String(a['email_' + (a.__step - 1) + '_sent_at']).localeCompare(String(b['email_' + (b.__step - 1) + '_sent_at']));
        });
        consented.length = 0;
        Array.prototype.push.apply(consented, due);
    }
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
    if (removed && MODE !== 'value') console.log('consent filter removed ' + removed + ' lead(s) who already said no');
    if (MODE === 'value') {
        console.log('value pool: ' + leads.length + ' leads got email 1, not finished, no reply_received_at, not bounced/unsubscribed');
        Object.keys(skipWhy).forEach(function (k) { console.log('  skip ' + String(skipWhy[k]).padStart(4) + '  ' + k); });
        const bySteps = {};
        eligible.forEach(function (l) { bySteps[l.__vstep] = (bySteps[l.__vstep] || 0) + 1; });
        console.log('  due by step: ' + JSON.stringify(bySteps) + (shielded.length > eligible.length ? '  (' + (shielded.length - eligible.length) + ' more due, held by --limit)' : ''));
    }

    console.log('client:   ' + clientName);
    const modeDesc = MODE === 'followup' ? 'next step of 2 to 5 is due, no reply, no bounce, no unsubscribe'
        : MODE === 'value' ? 'value step due, 3+ days since any email, no reply in any channel'
        : MODE === 'warm' ? '20s+ connected call, DNS-verified address, never emailed'
        : (LANE === '2' ? 'role inbox on a live domain'
            : LANE === '3' ? 'address published on their own site'
            : LANE === '4' ? 'deliverable at any confidence (test pool)'
            : LANE === '5' ? 'rep-typed or imported address, any prefix, domain alive'
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
        const fails = preSendCheck(subject, body).concat(MODE === 'value' ? valueCopy.validateValueCopy(subject, body) : []);
        if (fails.length) { console.log('SKIP  ' + tag + '  copy: ' + fails.join('; ')); stats.skipped++; continue; }

        if (!SEND) {
            console.log('DRY   ' + tag + '  -> ' + to + (ok.role ? '  [role inbox]' : ''));
            console.log('      ' + (lead.__step ? 'step ' + lead.__step + ' | ' : '') + (lead.__vstep ? 'value ' + lead.__vstep + ' ' + arm + ' | ' : '') + subject + ' | ' + body.split('\n')[0] + ' ...');
            if (args.includes('--show')) console.log(body.replace(/^/gm, '        ') + '\n');
            stats.sent++; continue;
        }

        // VALUE: claim the step on the lead FIRST, guarded on the step we read.
        // A second runner (or a re-run) finds value_step already moved and
        // backs off. Released below if the send fails.
        let vClaimed = false;
        const vPrev = { value_step: lead.value_step == null ? null : lead.value_step, value_last_sent_at: lead.value_last_sent_at || null };
        if (MODE === 'value') {
            let cq = sb.from('leads').update({ value_step: lead.__vstep, value_last_sent_at: new Date().toISOString() })
                .eq('id', lead.id);
            cq = (lead.__vstep === 1) ? cq.is('value_step', null) : cq.eq('value_step', lead.__vstep - 1);
            const { data: vc, error: vcErr } = await cq.select('id');
            if (vcErr) { console.log('FAIL  ' + tag + '  value claim: ' + vcErr.message); stats.failed++; continue; }
            if (!vc || !vc.length) { console.log('DUP   ' + tag + '  value step ' + lead.__vstep + ' already claimed'); stats.dup++; continue; }
            vClaimed = true;
        }
        const releaseValue = async function () {
            if (!vClaimed) return;
            await sb.from('leads').update(vPrev).eq('id', lead.id).eq('value_step', lead.__vstep);
        };

        // CLAIM before sending. A read-then-check loses the race; see send-email.js.
        // Value steps key on lead + step (not time), so one step can never go
        // to one lead twice, whatever happens to the lead row.
        const dedupeKey = crypto.createHash('sha1')
            .update(MODE === 'value' ? ['blason_value', lead.id, lead.__vstep].join('|')
                : [lead.id, 'email', to, subject, Math.floor(Date.now() / 300000)].join('|')).digest('hex');
        const claim = await sb.from('lead_messages').insert({
            lead_id: lead.id, direction: 'outbound', channel: 'email', subject: subject,
            sent_at: new Date().toISOString(), sent_by: process.env.STILO_SENDER_EMAIL || null,
            to_address: to, provider: 'resend', status: 'sending', dedupe_key: dedupeKey,
            variant: (MODE === 'cold' ? 'blason_lane' + LANE : 'blason_' + MODE) + '_' + (arm || 'x'),
        }).select('id').single();
        if (claim.error) {
            // Value: a 23505 means this lead+step already has a message row, so
            // it WAS sent; keep the lead stamp. Any other claim error releases it.
            if (String(claim.error.code) === '23505') { console.log('DUP   ' + tag); stats.dup++; continue; }
            await releaseValue();
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
                await releaseValue();
                console.log('FAIL  ' + tag + '  resend: ' + (j.message || ('http_' + r.status)));
                stats.failed++; continue;
            }
            await sb.from('lead_messages').update({
                body: plain, body_preview: plain.slice(0, 280), from_address: fromEmail,
                provider_message_id: j.id || null, status: 'sent',
            }).eq('id', claim.data.id);
            if (MODE !== 'value') {   // value steps were stamped by the claim
                const stepNo = MODE === 'followup' ? (lead.__step || 2) : 1;
                const stamp = {};
                stamp['email_' + stepNo + '_sent_at'] = new Date().toISOString();
                stamp['email_' + stepNo + '_status'] = 'sent';
                await sb.from('leads').update(stamp).eq('id', lead.id);
            }
            console.log('SENT  ' + tag + '  -> ' + to);
            stats.sent++;
        } catch (e) {
            await sb.from('lead_messages').delete().eq('id', claim.data.id);
            await releaseValue();
            console.log('FAIL  ' + tag + '  ' + String(e.message || e));
            stats.failed++; continue;
        }
        await new Promise(function (r) { setTimeout(r, GAP_MS); });
    }

    console.log('\n' + JSON.stringify(stats));
    if (!SEND) console.log('Dry run. Nothing was sent. Re-run with --send.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
