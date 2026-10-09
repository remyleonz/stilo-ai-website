#!/usr/bin/env node
/**
 * scripts/send_blason_vsl_email.js
 *
 * The Blason email in David's "pay twice" format, with the link to the VSL
 * landing page. This REPLACES send_client_sequence.js cold step 1 (and its
 * steps 2 to 3) once the page is live; the two scripts share the same
 * email_N_sent_at stamps, so a lead gets one sequence or the other, never both.
 *
 *   node scripts/send_blason_vsl_email.js --mode cold --limit 50            dry run
 *   node scripts/send_blason_vsl_email.js --mode cold --limit 50 --send
 *   node scripts/send_blason_vsl_email.js --mode warm --limit 30 --send     after a connected call
 *   node scripts/send_blason_vsl_email.js --mode followup --limit 50 --send steps 2 and 3
 *   --show   print full bodies in a dry run     --lane 1|3   cold lane (default 1)
 *
 * Refuses to run unless BLASON_VSL_URL is set (e.g. https://go.blasononline.com
 * or https://stiloaipartners.com/blason while the domain is pending). Every
 * link carries ?lid=<id>&t=<signed token> (api/public/_token.js) so the page
 * attributes views, quiz steps and the booking to the exact lead, plus
 * &lang=es for Spanish leads.
 *
 * Hard rules enforced by preSendCheck on every body before it leaves:
 *   no STILO, no price or "$", no FDA / certified, no Hialeah, no em dash,
 *   exactly ONE link and it must be the VSL host, body under 1,100 chars,
 *   a human opt-out line. Copy is Claude-authored and lives here as a template
 *   bank (no model calls in any copy path, Remy 2026-09-14).
 *
 * Audience and deliverability gates mirror send_client_sequence.js: Blason pool
 * only, verified address lanes, bounced / unsubscribed / suppressed out,
 * declines in ANY channel out, booked and closed out, one address per batch,
 * bounced domains out. Claim-before-send on lead_messages with a dedupe key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
(function loadEnv() {
    try {
        fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
            const m = line.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
        });
    } catch (_) { /* env already in process */ }
})();
const kit = require('../api/prospects/_email_kit');
const guard = require('../api/prospects/_email_guard');
const { signLead } = require('../api/public/_token');

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const MODE = arg('mode', 'cold');          // cold | warm | followup | re
//   re = RE-ENGAGE (2026-10-05, Remy's 70/day): leads the old sequence already
//        emailed and delivered (no bounce, no reply, no unsubscribe) who have not
//        had the video yet. Their email_N stamps stay untouched; the VSL step is
//        tracked off lead_messages.variant ('blason_vsl_1_*' ...).
//   lane 'auto' (cold) = fill from lane 5 (rep-typed), then 4, then 1, then 2.
const LANE = arg('lane', 'auto');          // cold only: 1 = medium confidence + MX clean, 2 = finder role inboxes (ramp slowly), 3 = site-published, 5 = rep-typed or imported address (any prefix)
const LIMIT = parseInt(arg('limit', '50'), 10);
const SEND = args.includes('--send');
const SHOW = args.includes('--show');
const GAP_MS = 2500;
const CLIENT_ID = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const VSL_URL = String(process.env.BLASON_VSL_URL || '').replace(/\/$/, '');
const LOCAL_ZIP3 = ['330', '331', '332', '333'];
// Ten touches over about nine weeks. A delivered address is never "done" after
// one video email (Remy, 2026-10-06): the sequence keeps going until they book,
// reply, or opt out. Gaps widen as it goes.
const STEP_GAP_DAYS = { 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 7, 8: 8, 9: 9, 10: 10 };
const MAX_STEP = 10;

if (!VSL_URL || !/^https:\/\//.test(VSL_URL)) { console.error('BLASON_VSL_URL is not set. Set it to the live landing page URL first.'); process.exit(1); }
const VSL_HOST = new URL(VSL_URL).host;

function sbLeads() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function sbPublic() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET; if (!secret) return null;
    const e = String(email).trim().toLowerCase();
    return b64url(e) + '.' + crypto.createHmac('sha256', secret).update(e).digest('base64url').slice(0, 24);
}
function zip3(address) { const m = String(address || '').match(/\b(3[0-4]\d)\d{2}\b/); return m ? m[1] : null; }
function tsMs(v) { const n = v ? new Date(v).getTime() : 0; return isNaN(n) ? 0 : n; }
function firstName(lead) {
    const verified = ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status);
    return verified ? (kit.firstName(lead.owner_name) || null) : null;
}
function linkFor(lead) {
    return VSL_URL + '?lid=' + lead.id + '&t=' + signLead(lead.id) + '&utm_source=email&utm_campaign=vsl' + (lead.primary_language === 'es' ? '&lang=es' : '');
}

/* ------------------------------- the copy -------------------------------- */
// Step 1. David's structure (2026-09-30): nice speaking / same factories, pay
// twice for the logo / skip the markup, afford the best machine / before you
// buy or replace, watch this / link. Cold opener swaps "nice speaking with your
// office" for a one-line who-I-am. Two subject arms, A/B by lead id.
function step1(lead, sender) {
    const es = lead.primary_language === 'es', fn = firstName(lead), local = LOCAL_ZIP3.includes(zip3(lead.address));
    const link = linkFor(lead), arm = (Math.abs(Number(lead.id) || 0) % 2 === 0) ? 'A' : 'B';
    const warm = MODE === 'warm';
    if (es) {
        const hi = fn ? 'Hola ' + fn + ',' : 'Hola,';
        const intro = warm ? 'Un gusto hablar con su oficina el otro día.' : (MODE === 're' ? 'Soy ' + sender + ', de Blason Spa Equipment aquí en Miami, le escribí hace unas semanas. Grabamos algo corto que explica mejor lo que hacemos.' : 'Soy ' + sender + ', de Blason Spa Equipment aquí en Miami. Importamos máquinas de estética directo de fábrica.');
        const body = [hi, '', intro, '',
            'Algo que casi ningún vendedor le va a decir: las máquinas de marca y las nuestras salen de las mismas fábricas. Cuando la máquina trae un logo grande, usted paga dos veces: una por la máquina y otra por el nombre. Si se salta ese recargo, el mismo presupuesto le alcanza para la máquina que realmente quiere, en vez de conformarse con una más barata.', '',
            'Antes de comprar o cambiar cualquier equipo, vea este video corto. Muestra exactamente cómo funciona y qué significa para su cabina:', link, '',
            local ? 'Las máquinas están encendidas en nuestro showroom de Miami, así que puede probarlas antes de decidir nada.' : 'Enviamos a toda la Florida y Manuel, el dueño, le explica todo en diez minutos por teléfono.', '',
            'Y si prefiere que no le escriba, respóndame "no gracias" y no le escribo más.'].join('\n');
        const subject = arm === 'A' ? (warm ? 'después de nuestra llamada' : 'pagar dos veces por la misma máquina') : (warm ? 'lo que le mencioné en la llamada' : (MODE === 're' ? 'el error de 80 mil en su cabina' : 'antes de comprar su próxima máquina'));
        return { subject, body, arm };
    }
    const hi = fn ? 'Hi ' + fn + ',' : 'Hi,';
    const intro = warm ? 'It was nice speaking with your office the other day.' : (MODE === 're' ? "I'm " + sender + ' with Blason Spa Equipment here in Miami, I emailed you a few weeks back. We recorded something short that explains what we do better than I did.' : "I'm " + sender + ' with Blason Spa Equipment here in Miami. We import aesthetic machines direct from the factory.');
    const body = [hi, '', intro, '',
        "Something most sales reps won't tell you: the brand-name machines and ours come out of the same factories. When a machine carries a big logo you pay twice, once for the machine and once for the name. Skip that markup and the same budget buys the machine you actually wanted instead of the one you settled for.", '',
        'Before you buy or replace anything, watch this short video. It shows exactly how that works and what it means for your room:', link, '',
        local ? 'The machines are set up and running at our Miami showroom, so you can try one before deciding anything.' : 'We ship anywhere in Florida and Manuel, the owner, walks you through it in ten minutes on the phone.', '',
        "And if you'd rather I not email, just reply no thanks and I'll leave you alone."].join('\n');
    const subject = arm === 'A' ? (warm ? 'after our call' : 'paying twice for the same machine') : (warm ? 'what I mentioned on the call' : (MODE === 're' ? 'the 80,000 mistake in your treatment room' : 'before you buy your next machine'));
    return { subject, body, arm };
}
// Steps 2 and 3: a bump and a one-question close, each with the link again.
function followup(lead, step) {
    const es = lead.primary_language === 'es', fn = firstName(lead), link = linkFor(lead), local = LOCAL_ZIP3.includes(zip3(lead.address));
    const hi = es ? (fn ? 'Hola ' + fn + ',' : 'Hola,') : (fn ? 'Hi ' + fn + ',' : 'Hi,');
    if (step === 2) {
        return es
            ? { arm: 'step2', subject: 're: pagar dos veces por la misma máquina', body: [hi, '', '¿Alcanzó a ver el video? Son unos minutos y explica por qué el logo es lo que encarece la máquina, no la tecnología.', link, '', 'Si ya lo vio, dígame qué máquina tiene más vieja en cabina y Manuel le dice de frente si conviene arreglarla o cambiarla.', '', 'Si prefiere que no le escriba, respóndame "no gracias".'].join('\n') }
            : { arm: 'step2', subject: 're: paying twice for the same machine', body: [hi, '', 'Did you get a chance to watch the video? It is a few minutes and it explains why the logo is what makes the machine expensive, not the technology.', link, '', "If you already watched it, tell me the oldest machine in your room and Manuel will tell you straight whether to fix it or replace it.", '', "If you'd rather I not email, just reply no thanks."].join('\n') };
    }
    const askEs = local ? 'Venga 20 minutos al showroom de Manuel en Miami y pruebe las máquinas encendidas.' : 'Diez minutos por teléfono con Manuel y sabe si le conviene o no.';
    const askEn = local ? "Come by Manuel's Miami showroom for 20 minutes and try the machines running." : 'Ten minutes on the phone with Manuel and you know whether it makes sense or not.';
    const stopEn = "If you'd rather I stop, just reply no thanks.", stopEs = 'Si prefiere que no le escriba más, respóndame "no gracias".';
    if (step === 4) return es
        ? { arm: 'step4', subject: 'la cotización que ya tiene', body: [hi, '', 'Una pregunta rápida. Si algún vendedor ya le cotizó una máquina, mándeme la ficha técnica o el modelo. Manuel pone la nuestra al lado, línea por línea: misma longitud de onda, misma potencia, mismas piezas de mano. Así ve exactamente qué le está agregando el logo.', '', 'Sin compromiso. Si la nuestra no da la talla, se lo digo y compra la de ellos.', '', 'El video, por si quedó enterrado: ' + link, '', stopEs].join('\n') }
        : { arm: 'step4', subject: 'the quote you already have', body: [hi, '', 'Quick one. If a rep already quoted you a machine, send me the spec sheet or the model name. Manuel puts ours next to it line by line, same wavelength, same power, same handpieces, and you see exactly what the logo is adding.', '', "No pressure either way. If ours doesn't match up, I'll tell you to buy theirs.", '', 'The video, in case it got buried: ' + link, '', stopEn].join('\n') };
    if (step === 5) return es
        ? { arm: 'step5', subject: 'cuál agregaría primero', body: [hi, '', 'Si el logo no estuviera en el medio, ¿qué máquina agregaría primero a su cabina? Diodo para depilación, CO2 para resurfacing, pico para tatuajes y manchas, una máquina de hidrofacial, o una de cuerpo.', '', 'Dígame cuál y le mando un clip de dos minutos de esa máquina trabajando en nuestro showroom de Miami.', '', link, '', stopEs].join('\n') }
        : { arm: 'step5', subject: 'which one would you add first', body: [hi, '', "If the logo wasn't in the way, which machine would you add to your room first? Diode for hair removal, CO2 for resurfacing, pico for tattoos and pigment, a hydra facial machine, or a body machine.", '', "Tell me the one and I'll send you a two-minute clip of it running in our Miami showroom.", '', link, '', stopEn].join('\n') };
    if (step === 6) return es
        ? { arm: 'step6', subject: 'cuando se dañe', body: [hi, '', 'La pregunta que nadie hace antes de comprar: ¿quién contesta el teléfono cuando la máquina se cae un martes con la agenda llena?', '', 'Con nosotros contesta Manuel, el dueño, aquí en Miami. No un sistema de tickets ni un representante regional a tres estados de distancia. Eso pesa más que el logo en el costado.', '', 'El video otra vez, por si quiere el cuadro completo: ' + link, '', stopEs].join('\n') }
        : { arm: 'step6', subject: 'when it breaks', body: [hi, '', 'The question nobody asks before buying: who picks up the phone when the machine goes down on a Tuesday with clients booked?', '', "With us it's Manuel, the owner, here in Miami. Not a ticket system, not a regional rep three states away. That matters more than the logo on the side.", '', "Here's the video again if you want the full picture: " + link, '', stopEn].join('\n') };
    if (step === 7) return es
        ? { arm: 'step7', subject: 'los clientes que no puede atender', body: [hi, '', 'En toda cabina hay clientes con los que la máquina actual sufre. Piel oscura en depilación, vello fino y claro, manchas tercas, cicatrices profundas.', '', '¿Cuáles son los más difíciles de tratar con lo que tiene hoy? Dígame y Manuel le dice de frente si otra máquina lo resuelve o no.', '', 'El video: ' + link, '', stopEs].join('\n') }
        : { arm: 'step7', subject: 'the clients you turn away', body: [hi, '', 'Every room has a few clients the current machine struggles with. Darker skin on hair removal, fine light hair, stubborn pigment, deep scars.', '', 'Which ones are hardest to treat with what you have today? Tell me and Manuel will tell you straight whether a different machine fixes it or not.', '', 'The video: ' + link, '', stopEn].join('\n') };
    if (step === 8) return es
        ? { arm: 'step8', subject: 'una segunda cabina', body: [hi, '', 'La mayoría de los dueños con los que hablamos no están reemplazando nada. Están agregando: una segunda cabina, un servicio nuevo que los clientes piden, una máquina para dejar de referir gente afuera.', '', '¿Hay algo así en su lista para este año? Si es así, el presupuesto rinde mucho más sin el recargo de la marca, y el video explica por qué: ' + link, '', stopEs].join('\n') }
        : { arm: 'step8', subject: 'a second room', body: [hi, '', "Most of the owners we talk to aren't replacing anything. They're adding: a second room, a new service the clients keep asking for, a machine that lets them stop referring people out.", '', 'Is anything like that on your list for this year? If so, the budget goes a lot further without the brand markup, and the video explains why: ' + link, '', stopEn].join('\n') };
    if (step === 9) return es
        ? (local
            ? { arm: 'step9', subject: 'venga a verlas encendidas', body: [hi, '', 'La forma más simple de resolverlo: venga al showroom en Miami y ponga las manos en las máquinas. Están encendidas, Manuel le muestra las que le interesen y se va con una respuesta clara. Son unos treinta minutos.', '', 'Elija la hora al final del video: ' + link, '', stopEs].join('\n') }
            : { arm: 'step9', subject: 'diez minutos con el dueño', body: [hi, '', 'Manuel, el dueño, le dedica diez minutos por teléfono: qué tiene hoy, qué quiere agregar y qué le conviene, sin rodeos y sin recargo de marca. Enviamos a toda la Florida.', '', 'Elija la hora al final del video: ' + link, '', stopEs].join('\n') })
        : (local
            ? { arm: 'step9', subject: 'come see them running', body: [hi, '', "Simplest way to settle it: come to the showroom in Miami and put your hands on the machines. They're on and running, Manuel walks you through whichever ones you care about, and you leave with a straight answer. About thirty minutes.", '', 'Pick a time at the end of the video: ' + link, '', stopEn].join('\n') }
            : { arm: 'step9', subject: 'ten minutes with the owner', body: [hi, '', "Manuel, the owner, will give you ten minutes on the phone: what you run today, what you want to add, and what actually makes sense, no runaround and no brand markup. We ship anywhere in Florida.", '', 'Pick a time at the end of the video: ' + link, '', stopEn].join('\n') });
    if (step >= 10) return es
        ? { arm: 'step10', subject: 'el último de mi parte', body: [hi, '', 'Este es el último correo de mi parte. Le mandé el video y varias preguntas y no he sabido de usted, lo que casi siempre significa que no es el momento o que la máquina que tiene va bien. Las dos son buenas razones.', '', 'Si algo cambia, una máquina empieza a fallar o aparece un servicio nuevo, el video queda aquí: ' + link + ', y Manuel está en Miami.', '', 'No hace falta responder. Si prefiere que no le escriba nunca más, respóndame "no gracias".'].join('\n') }
        : { arm: 'step10', subject: 'last one from me', body: [hi, '', "This is the last one from me. I've sent you the video and a few questions and haven't heard back, which usually means the timing is wrong or the machine you have is doing fine. Both are good reasons.", '', 'If anything changes, a machine starts acting up or a new service comes up, the video is here: ' + link + ', and Manuel is in Miami.', '', "No need to reply. If you'd rather I never write again, just reply no thanks."].join('\n') };
    return es
        ? { arm: 'step3', subject: 'una pregunta', body: [hi, '', '¿Viene algo nuevo para ustedes este año? Un servicio nuevo, otra cabina, o una máquina que ya está cansada. Si me dice cuál, Manuel, el dueño, le dice qué le conviene sin recargo de marca.', '', 'El video por si no lo vio: ' + link, '', askEs + ' Elija la hora al final del video.', '', 'Y si no es el momento, respóndame "no gracias" y aquí termina.'].join('\n') }
        : { arm: 'step3', subject: 'one question', body: [hi, '', "Anything new coming up for you this year? A new service, another room, or a machine that is getting tired. Tell me which and Manuel, the owner, tells you what makes sense without the brand markup.", '', 'The video in case you missed it: ' + link, '', askEn + ' Pick the time at the end of the video.', '', "And if it's not the moment, just reply no thanks and that's the end of it."].join('\n') };
}

/** Correctness checks that must hold for every body. */
function preSendCheck(subject, body) {
    const t = subject + '\n' + body, fails = [];
    if (/stilo/i.test(t.replace(/https?:\/\/\S+/g, ''))) fails.push('mentions STILO');   // the link host contains 'stilo'
    if (/\$|\bprice\b|\bprecio\b|\bcost\b|\bcosto\b|starting at|desde \$/i.test(t)) fails.push('mentions price');
    if (/[—–]/.test(t)) fails.push('em or en dash');
    if (/hialeah/i.test(t)) fails.push('Hialeah');
    if (/\bfda\b|certif/i.test(t)) fails.push('FDA or certified claim');
    if (/\bundefined\b|\bnull\b|Hi ,|Hola ,/.test(t)) fails.push('broken merge');
    const links = t.match(/https?:\/\/[^\s)]+/g) || [];
    if (links.length !== 1) fails.push('expected exactly one link, found ' + links.length);
    if (links.length && new URL(links[0]).host !== VSL_HOST) fails.push('link is not the VSL host');
    if (links.length && !/[?&]t=[A-Za-z0-9_-]{10,}/.test(links[0])) fails.push('link has no signed token');
    if (!/no thanks|no gracias/i.test(body)) fails.push('no human opt-out line');
    if (body.length > 1100) fails.push('body too long (' + body.length + ')');
    return fails;
}
function nextStepFor(lead) {
    for (let n = 2; n <= MAX_STEP; n++) {
        if (lead['email_' + n + '_sent_at']) continue;
        const prev = lead['email_' + (n - 1) + '_sent_at']; if (!prev) return null;
        return ((Date.now() - new Date(prev).getTime()) / 86400000 >= STEP_GAP_DAYS[n]) ? n : null;
    }
    return null;
}

async function main() {
    const sb = sbLeads(), pub = sbPublic();
    const { data: clientRow } = await pub.from('clients').select('business_name,website').eq('id', CLIENT_ID).single();
    const clientName = (clientRow && clientRow.business_name) || 'Blason Spa Equipment';
    const clientSite = (clientRow && clientRow.website) || 'blasononline.com';

    let q = sb.from('leads').select('id,name,owner_name,owner_name_verify_status,owner_email,email,email_verify_address,email_verify_status,email_confidence,'
        + 'primary_language,address,category,stage,last_called_outcome,bounced_at,unsubscribed_at,reply_received_at,'
        + 'email_1_sent_at,email_2_sent_at,email_3_sent_at,last_called_at,all_emails_json,email_search_status,pinned_at,next_step,do_not_call,assigned_to')
        .eq('client_id', CLIENT_ID).is('bounced_at', null).is('unsubscribed_at', null);
    if (MODE === 'followup') q = q.is('reply_received_at', null);
    else if (MODE === 're') q = q.not('email_1_sent_at', 'is', null).is('reply_received_at', null);
    else if (MODE === 'warm') q = q.is('email_1_sent_at', null).not('last_called_at', 'is', null);
    else if (LANE === 'auto') q = q.is('email_1_sent_at', null).neq('email_verify_status', 'dead_domain');
    else if (LANE === '5') q = q.is('email_1_sent_at', null).neq('email_verify_status', 'dead_domain');
    else if (LANE === '2') q = q.is('email_1_sent_at', null).eq('email_verify_status', 'role_inbox');
    else q = q.is('email_1_sent_at', null).eq('email_verify_status', LANE === '3' ? 'site_published' : 'deliverable');
    if (MODE === 'cold' && LANE === '1') q = q.eq('email_confidence', 'medium');
    if (MODE === 're') q = q.is('unsubscribed_at', null).is('bounced_at', null);
    // PostgREST caps a single response at 1,000 rows no matter what .limit()
    // asks for. With 2,787 Blason leads the pool was silently truncated to the
    // first 1,000 (every run printed "pool 1000"). Page through it.
    let leads = [], error = null;
    for (let from = 0; ; from += 1000) {
        const r = await q.range(from, from + 999);
        if (r.error) { error = r.error; break; }
        leads = leads.concat(r.data || []);
        if (!r.data || r.data.length < 1000) break;
    }
    if (error) { console.error(error); process.exit(1); }

    // VSL step state lives in lead_messages.variant ('blason_vsl_<n>_<arm>'), not
    // in email_N_sent_at: re-engaged leads already used those stamps on the old
    // sequence. vslState[lead] = { step: highest sent, last: sent_at of it }.
    const vslState = {};
    {
        const { data: msgs } = await sb.from('lead_messages').select('lead_id,variant,sent_at').like('variant', 'blason_vsl_%').limit(10000);
        (msgs || []).forEach(function (m) {
            const n = parseInt(String(m.variant).split('_')[2], 10) || 1;
            const cur = vslState[m.lead_id] || { step: 0, last: null };
            if (n > cur.step) { cur.step = n; cur.last = m.sent_at; }
            vslState[m.lead_id] = cur;
        });
    }
    const vslIds = new Set(Object.keys(vslState).map(Number));
    const vslNextStep = function (lead) {
        const st = vslState[lead.id]; if (!st || st.step >= MAX_STEP) return null;
        const n = st.step + 1;
        // Half-day tolerance: the 10:31 leg must catch a step that was sent at
        // 12:30 three days ago, not push it to tomorrow (10/08: 129 due, 0 sent).
        return ((Date.now() - new Date(st.last).getTime()) / 86400000 >= STEP_GAP_DAYS[n] - 0.5) ? n : null;
    };

    // Bounced domains, declines in any channel, closed stages, SMS queue.
    const bounceDomains = new Set();
    {
        const { data: rows } = await sb.from('lead_messages').select('to_address').eq('channel', 'email').not('bounced_at', 'is', null).limit(5000);
        (rows || []).forEach(function (r) { const d = String(r.to_address || '').split('@')[1]; if (d) bounceDomains.add(d.toLowerCase()); });
    }
    const declined = new Set(['owner_uninterested', 'do_not_call']);
    const CLOSED = ['CLOSED_LOST', 'CLOSED_WON', 'MEETING_BOOKED'];
    const { data: targets } = await sb.from('outbound_targets').select('lead_id,stage').in('stage', ['dead', 'opted_out', 'queued']);
    const killedIds = new Set((targets || []).filter(function (t) { return t.stage !== 'queued'; }).map(function (t) { return t.lead_id; }));
    const queuedIds = new Set((targets || []).filter(function (t) { return t.stage === 'queued'; }).map(function (t) { return t.lead_id; }));

    // Connected 20s+ call on record for warm mode
    let connectedIds = null;
    if (MODE === 'warm') {
        connectedIds = new Set();
        const { data: calls } = await sb.from('lead_calls').select('lead_id,duration_seconds,leads!inner(client_id)').eq('leads.client_id', CLIENT_ID).gte('duration_seconds', 20).limit(5000);
        (calls || []).forEach(function (c) { connectedIds.add(c.lead_id); });
    }

    // Lane 5: a human emailed the lead from the drawer, or the address has no
    // finder trace (typed by a rep or came with the import). Same rule as
    // send_client_sequence.js lane 5.
    let humanEmailedIds = null;
    if (MODE === 'cold' && (LANE === '5' || LANE === 'auto')) {
        humanEmailedIds = new Set();
        const { data: hm } = await sb.from('lead_messages').select('lead_id').eq('channel', 'email').eq('direction', 'outbound')
            .in('variant', ['ask', 'ctx', 'desk', 'manual_followup', 'manual']).limit(5000);
        (hm || []).forEach(function (m) { humanEmailedIds.add(m.lead_id); });
    }
    const isRepAddress = function (l) {
        if (humanEmailedIds && humanEmailedIds.has(l.id)) return true;
        const addr = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!addr || l.email_search_status === 'found') return false;
        return JSON.stringify(l.all_emails_json || '').toLowerCase().indexOf(addr) === -1;
    };
    // lane 'auto' (cold): the order Remy set on 10/03. Rep-typed or imported
    // addresses first (0.7% bounce), then verified personal (lane 4/1), then
    // the finder's role inboxes (lane 2) only to fill, capped per run below.
    const autoLane = function (l) {
        if (isRepAddress(l)) return '5';
        if (l.email_verify_status === 'deliverable') return l.email_confidence === 'medium' ? '1' : '4';
        if (l.email_verify_status === 'role_inbox') return '2';
        return null;
    };
    // Finder role inboxes crawl at 10/run on the main domain. From the test domain
// (BLASON_TEST_SENDER_EMAIL) the 25% breaker is the guard, so let them flow.
const LANE2_MAX_PER_RUN = process.env.BLASON_TEST_SENDER_EMAIL ? 60 : 10;
    const skipWhy = {};
    const skip = function (w) { skipWhy[w] = (skipWhy[w] || 0) + 1; return false; };
    const seenAddr = new Set();
    const eligible = (leads || []).filter(function (l) {
        const to = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!to) return skip('no address');
        if (humanEmailedIds && LANE === '5' && !isRepAddress(l)) return skip('finder address, not lane 5');
        if (l.do_not_call) return skip('do_not_call');
        if (declined.has(l.last_called_outcome)) return skip('declined on a call');
        if (CLOSED.includes(l.stage)) return skip('closed or booked');
        if (killedIds.has(l.id)) return skip('dead or opted out by SMS');
        if (queuedIds.has(l.id) && MODE !== 'followup') return skip('in the SMS queue today');
        if (bounceDomains.has(to.split('@')[1])) return skip('bounced domain');
        if (seenAddr.has(to)) return skip('duplicate address in batch');
        if (MODE === 'warm' && !connectedIds.has(l.id)) return skip('no connected call');
        if (MODE === 'followup') { if (!vslIds.has(l.id)) return skip('not on the VSL sequence'); l.__step = vslNextStep(l); if (!l.__step) return skip('next step not due'); }
        if ((MODE === 'cold' || MODE === 're' || MODE === 'warm') && vslIds.has(l.id)) return skip('already got the video email');
        if (l.pinned_at || String(l.next_step || '').trim()) return skip('human-owned (pinned or next step)');
        if (MODE === 'cold' && LANE === 'auto') { l.__lane = autoLane(l); if (!l.__lane) return skip('no lane (unverified or finder role inbox beyond ramp)'); }
        seenAddr.add(to); l.__to = to; return true;
    });
    if (MODE === 'cold') {
        const SOUTH = ['330', '331', '332', '333', '334'];
        const rank = function (l) {
            const south = SOUTH.includes(zip3(l.address)) ? 0 : 2;
            const seg = /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|laser|medical clinic/i.test(String(l.category || '')) ? 0 : /beauty salon|hair salon|nail|barber|massage/i.test(String(l.category || '')) ? 3 : 1;
            return south + seg;
        };
        const laneRank = { '5': 0, '1': 1, '4': 2, '2': 3 };
        eligible.sort(function (a, b) { return ((laneRank[a.__lane] || 0) - (laneRank[b.__lane] || 0)) || (rank(a) - rank(b)) || (a.id - b.id); });
    }
    let lane2Taken = 0;
    const batch = (MODE === 'cold' && LANE === 'auto')
        ? eligible.filter(function (l) { if (l.__lane === '2') { if (lane2Taken >= LANE2_MAX_PER_RUN) return false; lane2Taken++; } return true; }).slice(0, LIMIT)
        : eligible.slice(0, LIMIT);

    console.log('Blason VSL email · mode ' + MODE + (MODE === 'cold' ? ' lane ' + LANE : '') + ' · link host ' + VSL_HOST);
    console.log('pool ' + (leads || []).length + ' · eligible ' + eligible.length + ' · this run ' + batch.length + ' · ' + (SEND ? 'SENDING' : 'DRY RUN'));
    Object.keys(skipWhy).forEach(function (k) { console.log('  skip ' + String(skipWhy[k]).padStart(5) + '  ' + k); });
    console.log('');

    // The email signs as the rep who OWNS the lead (Remy, 2026-10-08): the
    // footer and the "I'm <name>" line carry leads.assigned_to, so a reply or
    // a video watch lands on that rep's board and the rep's name is the one
    // the clinic already heard on the phone. Unassigned leads sign as Remy.
    // Reply-To stays the shared inbox: the reps have no mailbox.
    const masterSender = await kit.getSenderIdentity(process.env.STILO_SENDER_EMAIL);
    const senderCache = {};
    async function senderFor(lead) {
        const key = String(lead.assigned_to || '').toLowerCase();
        if (!key || key === String(process.env.STILO_SENDER_EMAIL || '').toLowerCase()) return masterSender;
        if (!senderCache[key]) senderCache[key] = await kit.getSenderIdentity(key);
        return senderCache[key] && senderCache[key].name ? senderCache[key] : masterSender;
    }
    const sender = masterSender;
    // Two sending domains (Remy, 2026-10-06): never-emailed addresses go out
    // from the TEST domain (BLASON_TEST_SENDER_EMAIL) so their bounces land on
    // that domain's reputation; confirmed-delivered addresses (followup, re)
    // keep the main Blason sender. One bad list no longer drags the good one.
    const fromEmail = (MODE === 'cold' && process.env.BLASON_TEST_SENDER_EMAIL) ? process.env.BLASON_TEST_SENDER_EMAIL : (process.env.BLASON_SENDER_EMAIL || sender.fromEmail);
    console.log('from ' + fromEmail + ' · signed by the lead\'s rep (assigned_to), Remy when unassigned');

    // Bounce breaker per sending domain, trailing 72h. The old sequence refused
    // at 8%; this sender had none and pushed the main domain to 11.4% on 10/06.
    // Remy's call for the video week: let it run unless it gets brutal, 25%.
    if (SEND && MODE !== 'followup') {
        const since = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
        const dom = fromEmail.split('@')[1];
        const { data: recent } = await sb.from('lead_messages').select('bounced_at').eq('channel', 'email').eq('direction', 'outbound')
            .ilike('from_address', '%@' + dom).gte('sent_at', since).limit(5000);
        const n = (recent || []).length, b = (recent || []).filter(function (r) { return r.bounced_at; }).length, rate = n ? b / n : 0;
        const ceiling = Number(process.env.BLASON_BOUNCE_BREAKER || 0.25);
        console.log('breaker: ' + b + '/' + n + ' bounced in the last 72h from ' + dom + ' (' + (rate * 100).toFixed(1) + '%), refuses at ' + Math.round(ceiling * 100) + '%');
        if (n >= 20 && rate >= ceiling) { console.error('REFUSING to send from ' + dom + ': trailing bounce rate is at or above ' + Math.round(ceiling * 100) + '%. Verify the list before feeding this domain more of it.'); process.exit(2); }
    }
    const stats = { sent: 0, skipped: 0, failed: 0, dup: 0 };

    for (const lead of batch) {
        const to = lead.__to, tag = '#' + lead.id + ' ' + String(lead.name).slice(0, 40);
        const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', to).limit(1);
        if (sup && sup.length) { console.log('SKIP  ' + tag + '  suppressed'); stats.skipped++; continue; }
        const ok = await guard.canSend({ email: to });
        if (!ok.ok) { console.log('SKIP  ' + tag + '  guard: ' + ok.reason); stats.skipped++; continue; }

        const stepNo = MODE === 'followup' ? lead.__step : 1;
        const leadSender = await senderFor(lead);
        const fromName = '"' + leadSender.name.replace(/"/g, '') + ' · ' + clientName + '"';
        const senderFirst = (leadSender.name || 'Remy').split(/\s+/)[0];
        const c = stepNo === 1 ? step1(lead, senderFirst) : followup(lead, stepNo);
        const fails = preSendCheck(c.subject, c.body);
        if (fails.length) { console.log('SKIP  ' + tag + '  copy: ' + fails.join('; ')); stats.skipped++; continue; }

        if (!SEND) {
            console.log('DRY   ' + tag + '  -> ' + to + '  step ' + stepNo + ' ' + c.arm + (lead.__lane ? ' lane' + lead.__lane : '') + ' | ' + c.subject);
            if (SHOW) console.log(c.body.replace(/^/gm, '        ') + '\n');
            stats.sent++; continue;
        }
        const dedupeKey = crypto.createHash('sha1').update(['blason_vsl', lead.id, stepNo].join('|')).digest('hex');
        const claim = await sb.from('lead_messages').insert({
            lead_id: lead.id, direction: 'outbound', channel: 'email', subject: c.subject, sent_at: new Date().toISOString(),
            sent_by: (lead.assigned_to || process.env.STILO_SENDER_EMAIL || null), to_address: to, provider: 'resend', status: 'sending',
            dedupe_key: dedupeKey, variant: 'blason_vsl_' + stepNo + '_' + c.arm + (MODE === 'cold' ? '_lane' + (lead.__lane || LANE) : MODE === 're' ? '_re' : ''),
        }).select('id').single();
        if (claim.error) { if (String(claim.error.code) === '23505') { console.log('DUP   ' + tag); stats.dup++; } else { console.log('FAIL  ' + tag + ' claim: ' + claim.error.message); stats.failed++; } continue; }

        const html = kit.buildClientEmailHtml({ bodyText: c.body, sender: leadSender, clientName: clientName, es: lead.primary_language === 'es', website: clientSite });
        const plain = kit.sanitizeCopy(c.body) + '\n\n' + kit.clientFooterText(leadSender, clientName, lead.primary_language === 'es', clientSite);
        const ut = unsubToken(to);
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: fromName + ' <' + fromEmail + '>', to: [to], reply_to: process.env.STILO_REPLY_TO || fromEmail,
                    subject: c.subject, html: html, text: plain,
                    headers: ut ? { 'List-Unsubscribe': '<https://stiloaipartners.com/api/unsubscribe?t=' + ut + '>, <mailto:' + (process.env.STILO_REPLY_TO || fromEmail) + '?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
                }),
            });
            const j = await r.json().catch(function () { return {}; });
            if (!r.ok) { await sb.from('lead_messages').delete().eq('id', claim.data.id); console.log('FAIL  ' + tag + '  resend: ' + (j.message || 'http_' + r.status)); stats.failed++; continue; }
            await sb.from('lead_messages').update({ body: plain, body_preview: plain.slice(0, 280), from_address: fromEmail, provider_message_id: j.id || null, status: 'sent' }).eq('id', claim.data.id);
            // Cold/warm step 1 claims email_1_sent_at so the OLD sequence never
            // also picks the lead up. Re-engage and VSL follow-ups leave the
            // email_N stamps alone (vslState is the source of truth for those).
            if (stepNo === 1 && MODE !== 're') {
                await sb.from('leads').update({ email_1_sent_at: new Date().toISOString(), email_1_status: 'sent' }).eq('id', lead.id);
            }
            console.log('SENT  ' + tag + '  -> ' + to + '  step ' + stepNo);
            stats.sent++;
        } catch (e) {
            await sb.from('lead_messages').delete().eq('id', claim.data.id);
            console.log('FAIL  ' + tag + '  ' + String(e.message || e)); stats.failed++; continue;
        }
        await new Promise(function (r) { setTimeout(r, GAP_MS); });
    }
    console.log('\n' + JSON.stringify(stats));
    if (!SEND) console.log('Dry run. Nothing was sent. Re-run with --send.');
}
main().catch(function (e) { console.error(e); process.exit(1); });
