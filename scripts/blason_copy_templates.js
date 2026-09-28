/**
 * scripts/blason_copy_templates.js
 *
 * Claude-authored template bank for Blason campaign 4 step-1 SMS. Replaces the
 * Gemini call in the daily autopilot (Gemini prepay ran dry 2026-09-14 and its
 * deterministic fallback still asked the RETIRED question).
 *
 * The copy itself was written by Claude once, reviewed here in the repo, and is
 * personalized per lead deterministically: verified first name when we have one,
 * the lead's language, and the rep's own first name from the assigned line. No
 * per-send model call, so the copy is STABLE and the A/B stays interpretable.
 *
 * TEST PLAN (Remy, 2026-09-14): hold this copy for at least 200 sends, then read
 * reply rate by variant:
 *   select variant, count(*) sends, count(first_reply_at) replies
 *   from prospecting.outbound_targets
 *   where campaign_id=4 and step1_sent_at >= '2026-09-14' group by variant;
 *
 * Arm A rotates the three buyer-motive questions (wishlist / oldest machine /
 * expansion). Arm B is the showroom. Never price, never Hialeah, never the
 * retired "what can't your equipment do" question.
 *
 * Usage: node scripts/blason_copy_templates.js          (fill bodyless targets)
 *        node scripts/blason_copy_templates.js --dry    (print, write nothing)
 */
const fs = require('fs');
const path = require('path');
try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'prospecting', 'Content-Profile': 'prospecting', 'Content-Type': 'application/json' };
const DRY = process.argv.includes('--dry');
const repFirst = rep => rep && rep.startsWith('remyleon') ? 'Remy' : rep && rep.startsWith('aleb') ? 'Alejandro' : 'Jorge';

// hi(name): verified first name only, else plain "Hey"/"Hola". Kept identical
// to curatedSms in api/prospects/_outbound.js (2026-09-25 human-voice rewrite:
// rep's real name, why we're texting, one easy question, opt-out said like a
// person on the first text).
const A_EN = [
    (hi, n) => hi + ", it's " + n + " from Blason Spa Equipment, I called you the other day. Is there a machine you've been thinking about adding? Oh and if you'd rather not get texts from me, just reply stop.",
    (hi, n) => hi + ', ' + n + " from Blason Spa Equipment here, I called the other day. Anything new coming up for you guys, a new service or another room? And if texts aren't your thing, just reply stop.",
];
const A_ES = [
    (hi, n) => hi + ', es ' + n + ' de Blason Spa Equipment, le llamé el otro día. ¿Hay alguna máquina que ha estado pensando agregar? Y si prefiere que no le escriba por aquí, nada más responda stop.',
    (hi, n) => hi + ', ' + n + ' de Blason Spa Equipment, le llamé hace poco. ¿Viene algo nuevo para ustedes, un servicio nuevo u otra cabina? Si prefiere no recibir textos, responda stop y listo.',
];
const B_EN = [
    (hi, n) => hi + ", it's " + n + " from Blason Spa Equipment. Random question since I called the other day, what's the oldest machine you've got running right now? If you'd rather I not text, just reply stop.",
    (hi, n) => hi + ', ' + n + " from Blason Spa Equipment here. Is there a treatment your clients keep asking about that you'd like to offer? Oh and if you'd rather not get texts, just reply stop.",
];
const B_ES = [
    (hi, n) => hi + ', es ' + n + ' de Blason Spa Equipment. Una pregunta rápida desde que le llamé, ¿cuál es la máquina más vieja que tiene trabajando ahora? Si prefiere que no le escriba, responda stop.',
];
const BANNED = /hialeah|price|precio|\$|cost|financing|cannot do|can.t do|no pueden hacer|asking for that/i;

(async () => {
    // STEP 2: a lead who replied gets the pitch turn. Generic by design; a reply
    // that needs a real conversational answer is what the reply alert is for,
    // and the rep can overwrite step2_body before the tick sends it.
    const r2 = await fetch(`${URL_}/rest/v1/outbound_targets?campaign_id=eq.4&stage=eq.replied&step2_sent_at=is.null&step2_body=is.null&select=id,lead_id&order=id`, { headers: H });
    const replied = await r2.json();
    for (const t of (Array.isArray(replied) ? replied : [])) {
        const lr = await fetch(`${URL_}/rest/v1/leads?id=eq.${t.lead_id}&select=primary_language`, { headers: H });
        const es = ((await lr.json())[0] || {}).primary_language === 'es';
        const body = es
            ? 'Gracias por contestar. Manuel, el dueño, importa todo él mismo, así que le dice de frente cuál le sirve para su espacio. ¿Qué agregaría primero?'
            : "Thanks for getting back to me. Manuel, the owner, imports everything himself, so he'll tell you straight which one fits your space. What would you add first?";
        if (DRY) { console.log('step2 reply', t.id, body); continue; }
        const w = await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ step2_body: body, body_generated_at: new Date().toISOString() }) });
        console.log('step2 filled for target', t.id, w.ok ? 'ok' : w.status);
    }

    // NUDGES, steps 2 to 5 (2026-09-28, was 2 to 3). Non-repliers who had a
    // connected call and went quiet. The tick sends each one once the gap for
    // that step has passed (3, 3, 7, 14 days); here we fill the body.
    //
    // Each step makes a different case for the same small ask, so nobody gets
    // the same text twice:
    //   2  the easy question     is a machine on the radar
    //   3  the reason to trust   Manuel imports it, parts and training in Miami
    //   4  the invitation        showroom (South Florida) or 15 min video call
    //   5  the close-out         last text, door open, opt-out said like a person
    //
    // Personalised from what we hold: verified first name, language, distance
    // from the showroom, and whether the practice can run a laser. Two wordings
    // per slot, picked by target id, so a franchise with three locations does
    // not get three identical texts. No price, no link, never Hialeah.
    //
    // THE PROMISE GUARD. Until today step 3 said "Last one from me, promise."
    // Anyone who received that text was made a promise, and steps 4 and 5 are
    // never filled for them. No body means the tick cannot send.
    const PROMISED = /last one from me|último mensaje/i;
    const LASER_LEGAL = /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|laser|medical clinic/i;
    const SOUTH_FL = ['330', '331', '332', '333'];
    const NUDGES = {
        2: {
            en: [
                (c) => `${c.hey}, me again from Blason. No rush at all, just curious if a new machine is on the radar this year?`,
                (c) => `${c.hey}, it's ${c.rep} from Blason again. Quick one: anything in the room you'd replace if you could?`,
            ],
            es: [
                (c) => `${c.hey}, soy yo otra vez de Blason. Sin apuro, solo curiosidad, ¿tiene pensado agregar alguna máquina este año?`,
                (c) => `${c.hey}, ${c.rep} de Blason otra vez. Una pregunta corta: ¿hay algún equipo que cambiaría si pudiera?`,
            ],
        },
        3: {
            en: [
                (c) => `${c.hey}, one thing I didn't say on the phone. Manuel imports ${c.medical ? 'the lasers and RF units' : 'every machine'} himself, so parts and training are here in Miami, not overseas. Worth a look?`,
                (c) => `${c.hey}, ${c.rep} from Blason. Most owners tell me the hard part isn't buying a machine, it's getting it serviced after. Manuel handles that himself from Miami. Has that been a headache for you?`,
            ],
            es: [
                (c) => `${c.hey}, algo que no le dije por teléfono. Manuel importa ${c.medical ? 'los láseres y equipos de radiofrecuencia' : 'todas las máquinas'} él mismo, así que las piezas y el entrenamiento están aquí en Miami. ¿Le interesa verlo?`,
                (c) => `${c.hey}, ${c.rep} de Blason. Muchos dueños me dicen que lo difícil no es comprar la máquina, es el servicio después. Manuel lo atiende él mismo desde Miami. ¿Le ha pasado?`,
            ],
        },
        4: {
            en: [
                (c) => c.local
                    ? `${c.hey}, easy idea: come by Manuel's showroom in Miami for 20 minutes and try the machines while they're running. Would this week or next be better?`
                    : `${c.hey}, easy idea since you're not in Miami: 15 minutes on video with Manuel, he shows you the machine running. Would this week or next be better?`,
                (c) => c.local
                    ? `${c.hey}, ${c.rep} from Blason. The machines are set up and running at the Miami showroom. Want me to hold 20 minutes for you with Manuel? Tell me a day.`
                    : `${c.hey}, ${c.rep} from Blason. Manuel does a 15 minute video walk-through and ships anywhere in Florida. Want me to hold a slot? Tell me a day.`,
            ],
            es: [
                (c) => c.local
                    ? `${c.hey}, una idea fácil: pase 20 minutos por el showroom de Manuel en Miami y pruebe las máquinas encendidas. ¿Le queda mejor esta semana o la próxima?`
                    : `${c.hey}, una idea fácil ya que no están en Miami: 15 minutos por video con Manuel, él le muestra la máquina funcionando. ¿Esta semana o la próxima?`,
                (c) => c.local
                    ? `${c.hey}, ${c.rep} de Blason. Las máquinas están montadas y encendidas en el showroom de Miami. ¿Le aparto 20 minutos con Manuel? Dígame el día.`
                    : `${c.hey}, ${c.rep} de Blason. Manuel hace una videollamada de 15 minutos y envía a toda la Florida. ¿Le aparto un espacio? Dígame el día.`,
            ],
        },
        5: {
            en: [
                (c) => `${c.hey}, this is my last text so I don't bug you. If a machine ever comes up, ${c.local ? "Manuel's showroom is here in Miami" : 'Manuel ships anywhere in Florida'}, just text me back here. And if you'd rather not hear from me, reply stop.`,
            ],
            es: [
                (c) => `${c.hey}, este es mi último mensaje para no molestarle. Si algún día piensa en un equipo, ${c.local ? 'el showroom de Manuel está aquí en Miami' : 'Manuel envía a toda la Florida'}, me escribe por aquí. Y si prefiere que no le escriba, responda stop.`,
            ],
        },
    };
    // An UNSENT step 3 still holding the old "last one" wording is rewritten,
    // otherwise it would go out, make the promise, and end the sequence at 3.
    {
        const ro = await fetch(`${URL_}/rest/v1/outbound_targets?campaign_id=eq.4&stage=eq.sent&step=lt.3&step3_sent_at=is.null&step3_body=not.is.null&select=id,step3_body&limit=500`, { headers: H });
        const stale = (await ro.json() || []).filter(t => PROMISED.test(t.step3_body || ''));
        if (!DRY) for (const t of stale) {
            await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}&step3_sent_at=is.null`, { method: 'PATCH', headers: H, body: JSON.stringify({ step3_body: null }) });
        }
        if (stale.length) console.log('unsent old step 3 bodies ' + (DRY ? 'to rewrite: ' : 'cleared for rewrite: ') + stale.length);
    }
    for (const step of [2, 3, 4, 5]) {
        const col = 'step' + step + '_body';
        const rn = await fetch(`${URL_}/rest/v1/outbound_targets?campaign_id=eq.4&stage=eq.sent&step=eq.${step - 1}&first_reply_at=is.null&${col}=is.null&select=id,lead_id,assigned_to,step3_body&order=id&limit=500`, { headers: H });
        const nr = await rn.json();
        let filled = 0, promised = 0;
        for (const t of (Array.isArray(nr) ? nr : [])) {
            if (step >= 4 && PROMISED.test(t.step3_body || '')) { promised++; continue; }
            const lr = await fetch(`${URL_}/rest/v1/leads?id=eq.${t.lead_id}&select=owner_name,owner_name_verify_status,primary_language,address,category`, { headers: H });
            const l = (await lr.json())[0] || {};
            const es = l.primary_language === 'es';
            const verified = ['verified', 'rep_confirmed'].includes(l.owner_name_verify_status);
            const f = verified && l.owner_name ? String(l.owner_name).trim().split(/\s+/)[0].toLowerCase() : null;
            const F = f && /^[a-záéíóúñ]{2,}$/.test(f) && f !== 'dr' ? f.charAt(0).toUpperCase() + f.slice(1) : null;
            const zip = (String(l.address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || '';
            const ctx = {
                hey: es ? (F ? 'Hola ' + F : 'Hola') : (F ? 'Hey ' + F : 'Hey'),
                rep: repFirst(t.assigned_to),
                local: SOUTH_FL.includes(zip.slice(0, 3)),
                medical: LASER_LEGAL.test(String(l.category || '')),
            };
            const bank = NUDGES[step][es ? 'es' : 'en'];
            const body = bank[t.id % bank.length](ctx);
            if (BANNED.test(body) || /[—–]/.test(body) || body.length > 320) { console.log('SKIP invalid nudge', t.id, step); continue; }
            if (DRY) { console.log('step' + step, t.id, body); filled++; continue; }
            const patch = {}; patch[col] = body;
            patch.body_generated_at = new Date().toISOString();
            const w = await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(patch) });
            if (w.ok) filled++; else console.log('nudge fill fail', t.id, w.status);
        }
        if (filled || promised) console.log('nudge step' + step + (DRY ? ' would fill: ' : ' filled: ') + filled + (promised ? ', held back by the step 3 promise: ' + promised : ''));
    }

    const r = await fetch(`${URL_}/rest/v1/outbound_targets?campaign_id=eq.4&step1_sent_at=is.null&step1_body=is.null&stage=eq.queued&select=id,lead_id,variant,assigned_to&order=id`, { headers: H });
    const targets = await r.json();
    if (!Array.isArray(targets) || !targets.length) { console.log('nothing to fill'); return; }
    let ai = 0, bi = 0, written = 0;
    for (const t of targets) {
        const lr = await fetch(`${URL_}/rest/v1/leads?id=eq.${t.lead_id}&select=owner_name,owner_name_verify_status,primary_language`, { headers: H });
        const l = (await lr.json())[0] || {};
        const es = l.primary_language === 'es';
        const verified = ['verified', 'rep_confirmed'].includes(l.owner_name_verify_status);
        const first = verified && l.owner_name ? String(l.owner_name).trim().split(/\s+/)[0].toLowerCase() : null;
        const F = first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
        const hi = es ? (F ? `Hola ${F}` : 'Hola') : (F ? `Hey ${F}` : 'Hey');
        const n = repFirst(t.assigned_to);
        let body;
        if (t.variant === 'A') { const p = es ? A_ES : A_EN; body = p[ai % p.length](hi, n); ai++; }
        else { const p = es ? B_ES : B_EN; body = p[bi % p.length](hi, n); bi++; }
        if (BANNED.test(body) || body.length > 320) { console.log('SKIP invalid', t.id); continue; }
        if (DRY) { console.log(t.id, body); continue; }
        const w = await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ step1_body: body, body_generated_at: new Date().toISOString() }) });
        if (w.ok) written++; else console.log('write fail', t.id, w.status);
    }
    console.log((DRY ? 'dry, would write ' : 'wrote ') + (DRY ? targets.length : written) + ' bodies');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
