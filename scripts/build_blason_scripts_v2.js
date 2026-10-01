/**
 * scripts/build_blason_scripts_v2.js
 *
 * Rebuilds the Blason cold-call script for every live lead on a rep's board,
 * one file per lead per language, and uploads them to
 * cold-call-scripts-generated/blason-v2/<lead_id>.md (and .es.md).
 * api/prospects/cold-call-script.js serves these FIRST for client-pool leads
 * when the drawer passes lead_id.
 *
 * WHY A REBUILD (2026-09-29)
 *
 * The 2026-08-27 scripts were one template with the lead's name swapped in.
 * They asked the retired "what treatment can't you do" question (50+ asks, 0
 * sales), quoted a price range, offered a video call, and ended the voicemail
 * on "nothing urgent" (40+ voicemails, 0 callbacks). Every one of those is on
 * the kill list in Sales Coaching/Blason Sales Mastery - 2026-09-24.md.
 *
 * What changes per lead, all from data we hold:
 *   - what kind of business it is, which decides what to sell and the question
 *   - where it is: South Florida closes to the showroom, everyone else to a
 *     ten-minute PHONE call with Manuel (never video, Remy 2026-09-28)
 *   - language, and whether the owner's name is verified
 *   - the lead's own history: the rep's notes, the dated next step, the last
 *     calls and anything they texted or emailed back
 *
 * No model calls. Copy is written here, reviewed in the repo, and filled in
 * deterministically, so every rep sees the same lines and the lines can be
 * tested.
 *
 * Usage:
 *   node scripts/build_blason_scripts_v2.js --dry --lead 32011     print one
 *   node scripts/build_blason_scripts_v2.js --dry                  count only
 *   node scripts/build_blason_scripts_v2.js --upload               write all
 *
 * v3 (2026-10-01): the owner script is rebuilt around WHY a spa buys (old
 * machine, demand turned away, expansion, competition), with the cost of
 * waiting multiplied out loud from the owner's own two numbers. Same file
 * name and folder so the drawer needs no change.
 *   --rep <email>   whose board (default remyleon@stiloaipartners.com)
 */
const fs = require('fs');
const path = require('path');
try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'prospecting' };
const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const CLIENT_ID = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const REP = arg('rep', null);   // null = every rep's Blason leads (v4: one script for the whole team)
const ONLY = arg('lead', null);
const UPLOAD = args.includes('--upload');
const BUCKET = 'cold-call-scripts-generated';
const FOLDER = 'blason-v2';
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const SEG = {
    laser: /laser hair removal|hair removal service|laser/i,
    medical: /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|surgeon|medical clinic|medical office|medical center|medical group|doctor|physician|nurse practitioner|obstetric|specialized clinic|family practice/i,
    wellness: /weight loss|iv therapy|wellness|hormone|holistic|alternative medicine/i,
    esthetic: /skin care|facial|spa|esthetic|beautician|lymph|permanent make-up|make-up|electrolysis/i,
    school: /school|education|academy/i,
    salon: /beauty salon|hair|wax|nail|barber|lash|brow|beauty supply|health and beauty/i,
};
function segmentOf(category) {
    const c = String(category || '');
    if (/waxing/i.test(c)) return 'salon';
    for (const k of ['laser', 'medical', 'wellness', 'school', 'esthetic', 'salon']) if (SEG[k].test(c)) return k;
    return 'other';
}
function zip3(address) {
    const m = String(address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
    return m ? m[1].slice(0, 3) : '';
}
function cityOf(address) {
    const parts = String(address || '').split(',').map(function (s) { return s.trim(); });
    return parts.length >= 3 ? parts[parts.length - 2] : '';
}
function regionOf(address) {
    const z = zip3(address);
    if (['330', '331', '332', '333', '334'].includes(z)) return 'south';
    if (['327', '328', '347', '329'].includes(z)) return 'orlando';
    if (['335', '336', '337', '338', '346'].includes(z)) return 'tampa';
    return 'other';
}
function askName(lead) {
    const verified = ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status);
    const raw = String(lead.owner_name || '').trim();
    if (!raw) return { name: null, note: null };
    let name;
    const dr = raw.match(/^dr\.?\s+(?:[a-z]\.\s*)*(?:[a-z'\-]+\s+)*?([a-z'\-]+)$/i);
    if (/^dr\b/i.test(raw) && dr) name = 'Dr. ' + dr[1];
    else name = raw.split(/\s+/)[0];
    if (!/^(dr\. )?[a-záéíóúñ'\-]{2,}$/i.test(name)) return { name: null, note: null };
    return verified ? { name: name, note: null } : { name: null, note: raw };
}
function fmtDate(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate();
}
function clean(s, max) {
    let t = String(s || '').replace(/\s+/g, ' ').replace(/[—–]/g, ',').trim();
    // Superseded wording in old notes: the far-away close is a phone call now.
    t = t.replace(/\b(?:15|fifteen)[- ]?min(?:ute)?s?(?: on)? video(?: call)?/gi, '10 min phone call')
        .replace(/\bvideo close\b/gi, 'phone-call close').replace(/\bvideo with manuel\b/gi, 'phone call with Manuel');
    return max && t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '...' : t;
}

// ---------------------------------------------------------------------------
// What to sell, per segment. Prices are for the rep's eyes only.
// ---------------------------------------------------------------------------
const M = {
    galaxy: ['Scala Ice Galaxy laser', '$15,000', '$1,200', 'Four wavelengths in one handpiece, including 1064 for darker skin', 'Cuatro longitudes de onda en una pieza, incluye 1064 para piel oscura'],
    modena: ['Scala Ice Modena laser', '$10,000', '$800', 'First laser, or replacing a tired one', 'Primer láser, o reemplazar uno cansado'],
    fashion: ['Scala Ice Fashion + YAG', '$16,500', '$1,320', 'Hair removal plus pigment and carbon peel in one box', 'Depilación más manchas y carbon peel en un solo equipo'],
    planet: ['Scala Ice Planet', '$15,000', '$1,200', '3,000W for high-volume hair removal', '3,000W para depilación de alto volumen'],
    co2: ['CO2 fractional laser', '$15,000', '$1,200', 'Scars, deep wrinkles, texture. $1,500+ a treatment', 'Cicatrices, arrugas, textura. $1,500+ por tratamiento'],
    morfo: ['Morfolifting RF microneedling', '$3,900', '$312', 'The Morpheus8 category, $800+ a session', 'La categoría Morpheus8, $800+ por sesión'],
    hifu: ['HIFU Dimension', '$3,000', '$240', 'Non-surgical lift, paid off in three treatments', 'Lifting sin cirugía, se paga en tres tratamientos'],
    bodypulse: ['BodyPulse Pro (HIFEM + RF)', '$7,500', '$600', 'The Emsculpt category. Builds muscle', 'La categoría Emsculpt. Construye músculo'],
    bella: ['Bella Corpo body and face', '$7,500', '$600', 'RF + vacuum + cavitation. Loose skin, cellulite, contouring', 'RF + vacío + cavitación. Piel suelta, celulitis, moldeo'],
    cold: ['Cold Therapy (fat freezing)', '$5,000', '$400', 'The CoolSculpting category', 'La categoría CoolSculpting'],
    hydra7: ['Hidra Acqua Skin (Ref. 1584)', '$3,500', '$280', 'The HydraFacial category. Clients rebook monthly', 'La categoría HydraFacial. Las clientas vuelven cada mes'],
    destroy: ['Cavitación Destroy + RF', '$5,000', '$400', 'Built to last, for a spa replacing a burned-out unit', 'Hecha para durar, para quien quemó una máquina barata'],
    hidra17: ['17-Functions Facial Machine (Ref. 1430)', '$2,500', '$200', '17 facials in one device', '17 faciales en un equipo'],
    ibiza: ['Scala Ice Ibiza (diode + IPL)', '$12,000', '$960', 'Hair removal plus spots and redness, two services in one room', 'Depilación más manchas y rojeces, dos servicios en una cabina'],
    lipo: ['Cavitation-RF-Lipolaser', '$3,000', '$240', 'Easiest first body machine', 'La primera máquina de cuerpo más fácil'],
};
const PLAN = {
    // HIFU 1495 and Bella Corpo 1468 showed SOLD OUT on 9/29: out until Manuel confirms stock.
    medical: ['galaxy', 'modena', 'ibiza', 'morfo'],
    surgeon: ['co2', 'morfo', 'galaxy', 'bodypulse'],
    derm: ['galaxy', 'co2', 'morfo', 'fashion'],
    laser: ['galaxy', 'fashion', 'planet', 'ibiza'],
    wellness: ['bodypulse', 'cold', 'destroy'],
    esthetic: ['hydra7', 'bodypulse', 'destroy', 'cold'],
    school: ['hidra17', 'lipo'],
    salon: ['hidra17', 'lipo'],
    other: [],
};
function planKey(lead, seg) {
    if (seg === 'medical' && /dermatolog/i.test(lead.category || '')) return 'derm';
    if (seg === 'medical' && /plastic|cosmetic surg|surgeon/i.test(lead.category || '')) return 'surgeon';
    return seg;
}

// ---------------------------------------------------------------------------
// Copy. EN and ES side by side so a change to one is a visible change to both.
// ---------------------------------------------------------------------------
const T = {
    typeLabel: {
        medical: ['Medical (can run lasers)', 'Médico (puede usar láser)'],
        laser: ['Laser clinic (runs lasers today)', 'Clínica de láser (ya usa láser)'],
        wellness: ['Weight loss / IV / wellness', 'Pérdida de peso / IV / bienestar'],
        esthetic: ['Spa or esthetics (ask about a medical director)', 'Spa o estética (pregunte por director médico)'],
        school: ['Beauty school', 'Escuela de belleza'],
        salon: ['Salon (small ticket)', 'Salón (venta pequeña)'],
        other: ['Probably not a buyer', 'Probablemente no compra'],
    },
    why: {
        medical: ['A medical practice can bill the expensive treatments, so this is a laser conversation. Open buyers get the laser, not a small add-on.',
            'Una práctica médica puede cobrar los tratamientos caros, así que esta es una conversación de láser. Al que está abierto se le ofrece el láser, no un accesorio.'],
        derm: ['A dermatologist can fire every laser in the catalog, and the independents buy for themselves. Group practices send it to corporate: if the desk says that, get the name and move on. Lead with the laser, then RF microneedling.',
            'Un dermatólogo puede usar cualquier láser del catálogo, y los independientes compran por su cuenta. Los grupos lo mandan a corporativo: si la recepción dice eso, pida el nombre y siga. Empiece por el láser, después la radiofrecuencia fraccionada.'],
        surgeon: ['The surgeon is the medical director. RF microneedling and the CO2 catch the patient who is not ready for surgery. Reach the practice manager and ask who bought the last machine.',
            'El cirujano es el director médico. La radiofrecuencia fraccionada y el CO2 atrapan al paciente que no está listo para cirugía. Busque al practice manager y pregunte quién compró la última máquina.'],
        laser: ['They already sell laser hair removal, so they know what a laser earns. The angle is the next machine, the oldest one, or darker skin they turn away.',
            'Ya venden depilación láser, saben lo que produce un láser. El ángulo es la próxima máquina, la más vieja, o la piel oscura que rechazan.'],
        wellness: ['Their patients lose weight fast, then want two things: tighter skin and the muscle back. Those are body machines. Never pitch a laser here.',
            'Sus pacientes bajan de peso rápido y después quieren dos cosas: piel firme y recuperar músculo. Eso son máquinas de cuerpo. Aquí nunca se ofrece láser.'],
        esthetic: ['Ask about a medical director in the first minute. Yes means the laser line. No means body and facial machines, never a laser.',
            'Pregunte por director médico en el primer minuto. Si dicen que sí, la línea de láser. Si no, máquinas de cuerpo y faciales, nunca láser.'],
        school: ['Schools buy training units, and the academic director decides. The angle is graduates who need machines.',
            'Las escuelas compran equipos para entrenar y decide el director académico. El ángulo son los graduados que necesitan máquinas.'],
        salon: ['Salons rarely buy. Only worth it if they have a treatment room. Confirm in 20 seconds and move on if it is all chairs.',
            'Los salones casi nunca compran. Solo vale la pena si tienen cabina. Confírmelo en 20 segundos y siga si son solo sillas.'],
        other: ['Nothing in the catalog fits this kind of business on paper. Confirm what they actually do in 20 seconds, then move on.',
            'En papel, nada del catálogo le sirve a este tipo de negocio. Confirme qué hacen en 20 segundos y siga.'],
    },
    bestTime: {
        medical: ['8:30 to 9:30am or 4 to 5pm. Surgeons operate Mon/Wed/Fri, call Tue/Thu. Never 12 to 1.', '8:30 a 9:30am o 4 a 5pm. Los cirujanos operan lunes, miércoles y viernes: llame martes o jueves. Nunca de 12 a 1.'],
        default: ['8:15 to 9:30am or 4 to 5:30pm. Never 12 to 1.', '8:15 a 9:30am o 4 a 5:30pm. Nunca de 12 a 1.'],
    },
};

function discovery(seg, es) {
    const q = {
        medical: es
            ? ['"¿Cuántos láseres tienen trabajando, y cuál es el más viejo? ¿Todavía produce igual?"', '"¿Su láser de depilación trata piel oscura, o esas clientas se van a otro lado?"']
            : ['"How many lasers are running now, and which one is the oldest? Still earning what it used to?"', '"Does your hair removal laser treat darker skin, or do those clients go somewhere else?"'],
        laser: es
            ? ['"¿Cuál es el láser más viejo que tienen? ¿Todavía produce igual?"', '"¿Tratan piel oscura con lo que tienen, o esas clientas se van?"']
            : ['"What\'s the oldest laser in the room? Still earning what it used to?"', '"Can you treat darker skin with what you have, or do those clients walk?"'],
        wellness: es
            ? ['"Sus pacientes de pérdida de peso, cuando ya bajaron, ¿le preguntan qué hacer con la piel suelta o con el músculo que perdieron?"', '"¿Tienen alguna cabina donde podrían hacer tratamientos de cuerpo?"']
            : ['"Your weight-loss patients, once the weight comes off, are they asking what to do about loose skin or the muscle they lost?"', '"Do you have a room you could run body treatments in?"'],
        esthetic: es
            ? ['"¿Las clientas le piden algo por nombre, como Emsculpt, un HydraFacial o fat freezing?"']
            : ['"Do clients ask for anything by name, like Emsculpt, a HydraFacial or fat freezing?"'],
        school: es
            ? ['"¿Con qué máquinas entrenan a las alumnas, y quién decide qué compran para la academia?"']
            : ['"What machines do your students train on, and who decides what the academy buys?"'],
        salon: es
            ? ['"¿Tienen cabina para faciales o tratamientos, o es solo sillas?"']
            : ['"Do you have a treatment room for facials, or is it all chairs?"'],
        other: es ? ['"¿Qué servicios hacen ahí, más que nada?"'] : ['"What do you mostly do there?"'],
    }[seg];
    const core = es
        ? ['"¿Cuál es la próxima máquina en su lista, aunque no sea este año?"', '"¿Viene algo nuevo? ¿Un servicio nuevo, otra cabina, un segundo local?"']
        : ['"What\'s the next machine on your list, even if it\'s not this year?"', '"Anything new coming? A new service, another room, a second location?"'];
    return q.concat(core);
}

// ---------------------------------------------------------------------------
// v4 (2026-10-01): ONE short script. Remy: "I can't master two scripts", "too
// long and salesy", "I'm not convincing them I bring value." So: value in the
// first breath, one question, their number, why Manuel, the ask. Everything a
// rep reads on a live call fits on one screen. The long v3 doc stays as
// training (Clients/Blason Spa Equipment/call-scripts/).
// ---------------------------------------------------------------------------
const REP_FIRST = { 'remyleon@stiloaipartners.com': 'Remy', 'aleb1027@gmail.com': 'Alejandro', 'davidcoira@stiloaipartners.com': 'David', 'ayesjorge911@gmail.com': 'Jorge' };

function build(rawLead, hist, es) {
    const lead = Object.assign({}, rawLead, { name: clean(rawLead.name) });
    const seg = segmentOf(lead.category);
    const pk = planKey(lead, seg);
    const region = regionOf(lead.address);
    const local = region === 'south';
    const city = cityOf(lead.address);
    const who = askName(lead);
    const L = es ? 1 : 0;
    const rep = REP_FIRST[String(lead.assigned_to || '').toLowerCase()] || 'Remy';
    const out = [];
    const p = function (s) { out.push(s == null ? '' : s); };
    const S = function (esLine, enLine) { p('> "' + (es ? esLine : enLine) + '"'); };
    const N = function (esLine, enLine) { p(es ? esLine : enLine); };
    const nm = who.name, hi = nm ? ' ' + nm : '';
    const nonLaser = ['wellness', 'salon', 'school'].includes(seg);
    const machines = PLAN[pk].map(function (k) { return M[k]; });
    const top = machines[0];
    const two = local ? ['el jueves a las 11 o el viernes a las 2', 'Thursday at 11 or Friday at 2'] : ['mañana a las 10 o el jueves a las 2', 'tomorrow at 10 or Thursday at 2'];
    const Two = [two[0].charAt(0).toUpperCase() + two[0].slice(1), two[1].charAt(0).toUpperCase() + two[1].slice(1)];
    const mins = local ? '20' : '10';

    p('# ' + (es ? 'LLAMADA BLASON: ' : 'BLASON CALL: ') + lead.name);
    p('**Script v4** · ' + (es ? 'un solo guion, corto · ' : 'one script, short · ') + TODAY);
    p('');
    p('| | |');
    p('|---|---|');
    p('| **' + (es ? 'Preguntar por' : 'Ask for') + '** | ' + (nm || (who.note ? (es ? 'el dueño (registros dicen ' + who.note + ', sin verificar)' : 'the owner (records say ' + who.note + ', unverified)') : (es ? 'el dueño, o quien compra los equipos' : 'the owner, or whoever buys the equipment'))) + ' |');
    p('| **' + (es ? 'Dónde' : 'Where') + '** | ' + (city || '') + (local ? (es ? ' · cierre: showroom' : ' · close: showroom') : (es ? ' · cierre: 10 min por teléfono con Manuel' : ' · close: 10-min phone call with Manuel')) + ' |');
    p('| **' + (es ? 'Tipo' : 'Type') + '** | ' + T.typeLabel[seg][L] + ' |');
    if (top) p('| **' + (es ? 'Empiece por' : 'Lead with') + '** | ' + top[0] + ': ' + (es ? top[4] : top[3]) + ' |');
    p('| **' + (es ? 'Mejor hora' : 'Best time') + '** | ' + (pk === 'surgeon' ? T.bestTime.medical[L] : T.bestTime.default[L]) + ' |');
    p('');

    // History: the only per-lead context a rep needs before dialing.
    const facts = [];
    if (lead.next_step) facts.push((es ? '**Próximo paso:** ' : '**Next step:** ') + clean(lead.next_step, 220));
    if (lead.rep_notes) facts.push((es ? '**Notas:** ' : '**Notes:** ') + clean(lead.rep_notes, 220));
    for (const r of hist.replies) facts.push('**' + fmtDate(r.at) + (es ? ', respondieron: ' : ', they replied: ') + '**"' + clean(r.body, 160) + '"');
    for (const c of hist.calls) {
        const sum = clean(String(c.transcript_summary || '').split(/\n\s*Next steps/i)[0].replace(/^Remy Leon (from [^.]*?)?(called|reached)[^.]*?\.\s*/i, ''), 180);
        if (sum && !/no actionable details/i.test(sum)) facts.push('**' + fmtDate(c.called_at) + (es ? ', llamada:** ' : ', call:** ') + sum);
    }
    if (facts.length) { p(es ? '## Lo que ya sabemos' : '## What we already know'); for (const f of facts.slice(0, 4)) p('- ' + f); p(''); }

    // The shared desk box is injected at this hook by assets/cold-call-script.js.
    p('## When the front desk answers');
    p('');

    // 1. Open: value in the first breath, then permission.
    p(es ? '## 1. La apertura (con el dueño)' : '## 1. The open (owner on the line)');
    if (nonLaser) S('Hola' + hi + ', le habla ' + rep + ' de Blasón, B-L-A-S-O-N, los importadores de equipos de estética aquí en Miami. Seré rápido: ayudamos a spas como el suyo a agregar un tratamiento nuevo por una fracción de lo que cuestan las máquinas de marca. ¿Le hago una pregunta para ver si le sirve?',
        'Hi' + hi + ', it\'s ' + rep + ' with Blason, B-L-A-S-O-N, the aesthetic equipment importer here in Miami. I\'ll be quick: we help spas like yours add a new treatment for a fraction of what the brand-name machines cost. Can I ask you one question to see if it\'s even relevant?');
    else S('Hola' + hi + ', le habla ' + rep + ' de Blasón, B-L-A-S-O-N, los importadores de láser aquí en Miami. Seré rápido: ayudamos a clínicas como la suya a tener depilación láser por una fracción de lo que cuestan los láser de marca. ¿Le hago una pregunta para ver si le sirve?',
        'Hi' + hi + ', it\'s ' + rep + ' with Blason, B-L-A-S-O-N, the laser importer here in Miami. I\'ll be quick: we help clinics like yours run laser hair removal for a fraction of what the brand-name lasers cost. Can I ask you one question to see if it\'s even relevant?');
    p('');

    // 2. One question that finds the reason to buy.
    p(es ? '## 2. La pregunta' : '## 2. The question');
    if (seg === 'wellness') S('Sus pacientes de pérdida de peso, cuando ya bajaron, ¿le preguntan qué hacer con la piel suelta o con el músculo que perdieron?', 'Your weight-loss patients, once the weight comes off, are they asking what to do about loose skin or the muscle they lost?');
    else if (seg === 'salon') S('¿Tienen cabina para faciales o tratamientos? ¿Cuál es el próximo servicio que quieren agregar?', 'Do you have a treatment room? What\'s the next service you want to add?');
    else if (seg === 'school') S('¿Con qué máquinas entrenan a las alumnas, y cuál les falta?', 'What machines do your students train on, and what\'s missing?');
    else {
        S('¿Ustedes hacen depilación láser hoy?', 'Are you doing laser hair removal there today?');
        N('- **Sí:** "¿Qué máquina tienen, y cómo les está respondiendo? ¿Trata bien la piel oscura? ¿Están llenos?" *(Escuche: vieja, lenta, se para, piel oscura, lista de espera.)*',
          '- **Yes:** "What are you running, and how\'s it holding up? Does it handle darker skin? Are you booked out?" *(Listen for: old, slow, down, darker skin, waitlist.)*');
        N('- **No:** "¿Y cuando una clienta lo pide, a dónde la mandan? ¿Quién hace sus tratamientos, médico o enfermera practicante, o esteticistas?" *(Esteticistas solas: nunca láser. Venda cara o cuerpo.)*',
          '- **No:** "And when a client asks for it, where do they go? Who does your treatments, a doctor or NP, or estheticians?" *(Estheticians only: never a laser. Sell face or body.)*');
    }
    p('');

    // 3. Their number: the reason to buy, in their own money.
    p(es ? '## 3. Su número' : '## 3. Their number');
    S('¿Más o menos cuántos clientes a la semana le piden eso, o lo pedirían si lo tuviera? ¿Como dos, o como diez? ¿Y en cuánto venden el paquete ahí?', 'Roughly how many clients a week ask for it, or would if you had it? More like two, or more like ten? And what does a package go for at your place?');
    S('O sea, como [clientes por paquete] a la semana. Son como [x 4] al mes que hoy se van a otra clínica. Por eso le llamé.', 'So that\'s about [clients x package] a week. That\'s roughly [x 4] a month going to another clinic today. That\'s really why I called.');
    N('*Use SUS números. Si no le da uno, salte este paso. Ejemplo: 2 a la semana x $900 = $1,800, como $7,200 al mes.*', '*Use THEIR numbers. No number? Skip this step. Example: 2 a week x $900 = $1,800, about $7,200 a month.*');
    p('');

    // 4. Why Manuel: the value, one breath.
    p(es ? '## 4. Por qué Manuel' : '## 4. Why Manuel');
    if (nonLaser) S('Manuel importa directo, así que es la misma categoría de tratamiento sin el precio de marca. Casi todos lo ponen en una mensualidad que se paga con el primer mes de tratamientos, él entrena a su equipo y le da servicio aquí en Miami, y usted la prueba antes de decidir nada.',
        'Manuel imports direct, so it\'s the same treatment category without the brand-name price. Most owners put it on a monthly that the first month of treatments pays for, he trains your team and services it here in Miami, and you try it before you decide anything.');
    else S('Los láser de marca cuestan seis cifras y le cobran por disparo. Manuel importa directo, así que es la misma categoría por una fracción. Casi todos lo ponen en una mensualidad que se paga con el primer mes de tratamientos, él entrena a su equipo y le da servicio aquí en Miami, y usted lo prueba antes de decidir nada.',
        'The brand-name lasers run six figures and charge you per shot. Manuel imports direct, so it\'s the same treatment category for a fraction of that. Most clinics put it on a monthly that the first month of treatments pays for, he trains your team and services it here in Miami, and you try it before you decide anything.');
    p('');

    // 5. The ask: two times, then silence.
    p(es ? '## 5. La pregunta final' : '## 5. The ask');
    if (local) S('¿Vale la pena 20 minutos para verlo funcionando en el showroom? Tengo ' + two[0] + '.', 'Worth 20 minutes to see it running at the showroom? I\'ve got ' + two[1] + '.');
    else S('Ustedes están' + (city ? ' en ' + city : ' lejos') + ', así que lo fácil son 10 minutos por teléfono con Manuel. Le dice derecho si le conviene, y se lo envía con entrenamiento. ¿' + Two[0] + '?',
        'Since you\'re' + (city ? ' in ' + city : ' out of town') + ', the easy version is 10 minutes on the phone with Manuel. He\'ll tell you straight if it fits, and he ships it with training. ' + Two[1] + '?');
    N('*Después de las dos horas, cállese. Cuente hasta cinco.*', '*After the two times, stop talking. Count to five.*');
    if (!nonLaser && TODAY <= '2026-10-02') S('Y esta semana Manuel tiene sus láser de diodo en especial, hasta el viernes. El precio se lo da él.', 'And this week Manuel has his diode lasers on special, through Friday. He\'ll give you the number himself.');
    p('');

    // 6. Objections: one line each, then the ask again.
    p(es ? '## 6. Si le dicen...' : '## 6. If they say...');
    const obj = [
        ['"¿Cuánto cuesta?"', '"How much is it?"', 'Depende de cuál le sirve, y casi todos lo ponen en una mensualidad. Eso se lo dice Manuel en ' + mins + ' minutos. ¿' + Two[0] + '?', 'Depends which one fits, and most owners put it on a monthly. Manuel answers that in ' + mins + ' minutes. ' + Two[1] + '?'],
        ['"Mándeme información"', '"Send me some info"', 'Se la mando hoy. Pero un catálogo no le dice cuál le sirve a su clínica. Pongamos los ' + mins + ' minutos y le mando la información junto.', 'I\'ll send it today. But a catalog won\'t tell you which one fits your clinic. Let\'s put the ' + mins + ' minutes down and I\'ll send the info with it.'],
        ['"Ya tenemos todo"', '"We\'re all set"', 'Qué bueno. ¿Cuál es la máquina más vieja que tienen?', 'Good. Which machine is the oldest one you have?'],
        ['"No me interesa"', '"Not interested"', 'Perfecto. Una sola cosa: ¿las máquinas ya están resueltas, o es mal momento?', 'All good. One thing: is the equipment handled, or is it just a bad time?'],
        ['"Lo consigo más barato en Alibaba"', '"I can get it cheaper on Alibaba"', 'Puede ser. Cuando esa se para, ¿a quién llama? Manuel tiene las piezas en Miami y entrena a su equipo.', 'You can. When that one goes down, who do you call? Manuel keeps the parts in Miami and trains your team.'],
        ['"Conozco a Manuel, lo llamo yo"', '"I know Manuel, I\'ll call him"', 'Perfecto. Le aviso hoy que usted va para que lo tenga listo. ¿Qué día lo va a ver?', 'Perfect. I\'ll let him know today you\'re coming so he has it ready. What day are you seeing him?'],
    ];
    if (!local) obj.push(['"Miami queda lejos"', '"Miami is too far"', 'No tiene que venir. 10 minutos por teléfono con Manuel y se lo envía. ¿' + Two[0] + '?', 'You don\'t have to come. 10 minutes on the phone with Manuel and he ships it. ' + Two[1] + '?']);
    for (const o of obj) { p('**' + (es ? o[0] : o[1]) + '**'); S(o[2], o[3]); p(''); }
    N('*Nunca un precio ni un rango. Nunca "certificado" ni "FDA". "Stop": márquelo no llamar.*', '*Never a price or a range. Never "certified" or "FDA". "Stop": mark do-not-call.*');
    p('');

    // 7. If yes / voicemail.
    p(es ? '## 7. Si dice que sí' : '## 7. When they say yes');
    N('- Repítale día, hora y "con Manuel". Pida el mejor celular.', '- Say back the day, time and "with Manuel". Get the best cell.');
    N('- Texto en el momento: ' + (local ? '"Quedó para el [día y hora] con Manuel. 3110 W 84th St, Unit 4, Miami, FL 33018."' : '"Manuel le llama el [día y hora]."'), '- Text right away: ' + (local ? '"You\'re set for [day and time] with Manuel. 3110 W 84th St, Unit 4, Miami, FL 33018."' : '"Manuel will call you [day and time]."'));
    N('- WhatsApp a Manuel: nombre, negocio, qué tienen, qué quieren, sus números. Anótelo con fecha.', '- WhatsApp Manuel: name, business, what they run, what they want, their numbers. Log it with the date.');
    p('');
    p(es ? '**Buzón de voz (solo el primero):**' : '**Voicemail (first one only):**');
    const biz = /hialeah/i.test(lead.name) ? (es ? 'su clínica' : 'your clinic') : lead.name;
    S('Hola' + hi + ', le habla ' + rep + ' de Blasón, B-L-A-S-O-N, en Miami. Le llamo por ' + (nonLaser ? 'un tratamiento nuevo' : 'la depilación láser') + ' en ' + biz + '. 786-837-6639. Otra vez, 786-837-6639.',
      'Hi' + hi + ', it\'s ' + rep + ' with Blason, B-L-A-S-O-N, in Miami. I\'m calling about ' + (nonLaser ? 'a new treatment' : 'laser hair removal') + ' at ' + biz + '. 786-837-6639. Again, 786-837-6639.');
    p('');
    p('*Lead ' + lead.id + ' · Script v4 · ' + TODAY + '*');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function getAll(pathQuery) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const r = await fetch(URL_ + '/rest/v1/' + pathQuery, { headers: Object.assign({ Range: from + '-' + (from + 999) }, H) });
        if (!r.ok) throw new Error(pathQuery.split('?')[0] + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
        const j = await r.json();
        rows.push.apply(rows, j);
        if (j.length < 1000) break;
    }
    return rows;
}

const BANNED = [/what (treatment|treatments)[^.?]*can'?t/i, /that you don'?t do|que hoy no hacen/i, /no pueden? hacer/i, /nothing urgent|nada urgente/i, /hialeah/i, /\bvideo\b|videollamada/i,
    /blasononline|www\.|https?:/i, /[—–]/, /equipaje/i, /\bstilo\b|\bagency\b|\bAI\b/,
    // v3 (2026-10-01): dead question, the screen-baiting line, claims we can't back, prices out loud.
    /looking to add any|buscando a(ñ|n)adir/i, /thirty seconds|treinta segundos/i, /certifi/i, /\bFDA\b/, /\$\s?\d/];

(async function main() {
    let q = 'leads?select=id,name,phone,address,category,primary_language,owner_name,owner_name_verify_status,front_desk_name,next_step,rep_notes,stage,do_not_call,assigned_to'
        + '&client_id=eq.' + CLIENT_ID + (REP ? '&assigned_to=eq.' + encodeURIComponent(REP) : '') + '&stage=in.(NEW,ENGAGED)&order=id';
    if (ONLY) q += '&id=eq.' + ONLY;
    const leads = (await getAll(q)).filter(function (l) { return !l.do_not_call; });
    const ids = leads.map(function (l) { return l.id; });
    console.log('leads on ' + (REP || 'all reps') + ': ' + leads.length);

    const calls = {}, replies = {};
    for (let i = 0; i < ids.length; i += 150) {
        const chunk = ids.slice(i, i + 150).join(',');
        const cs = await getAll('lead_calls?select=lead_id,called_at,duration_seconds,outcome,transcript_summary&direction=eq.outbound&lead_id=in.(' + chunk + ')&order=called_at.desc');
        for (const c of cs) (calls[c.lead_id] = calls[c.lead_id] || []).push(c);
        const ts = await getAll('outbound_targets?select=lead_id,first_reply_at,first_reply_body&first_reply_at=not.is.null&lead_id=in.(' + chunk + ')');
        for (const t of ts) (replies[t.lead_id] = replies[t.lead_id] || []).push({ at: t.first_reply_at, channel: 'text', body: t.first_reply_body });
        const ms = await getAll('lead_messages?select=lead_id,sent_at,channel,body,body_preview&direction=eq.inbound&lead_id=in.(' + chunk + ')&order=sent_at.desc');
        for (const m of ms) {
            const body = m.body_preview || m.body;
            if (!body || /^\s*stop\s*$/i.test(body)) continue;
            const arr = (replies[m.lead_id] = replies[m.lead_id] || []);
            if (arr.some(function (x) { return clean(x.body, 60) === clean(body, 60); })) continue;
            arr.push({ at: m.sent_at, channel: m.channel === 'sms' ? 'text' : m.channel, body: body });
        }
    }

    const stats = { built: 0, uploaded: 0, failed: 0, banned: 0, bySeg: {} };
    for (const lead of leads) {
        const cl = calls[lead.id] || [];
        const hist = {
            callCount: cl.length,
            calls: cl.filter(function (c) { return (c.duration_seconds || 0) >= 20; }).slice(0, 3),
            replies: (replies[lead.id] || []).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 2),
        };
        const seg = segmentOf(lead.category);
        stats.bySeg[seg] = (stats.bySeg[seg] || 0) + 1;
        for (const es of [false, true]) {
            const md = build(lead, hist, es);
            // The banned-copy check runs on the lines the rep SAYS (the > lines).
            // History quotes the prospect verbatim, and the stage directions
            // name the banned phrases on purpose ("never say nothing urgent").
            const spoken = md.split('\n').filter(function (l) { return /^> /.test(l); }).join('\n');
            const hit = BANNED.find(function (re) { return re.test(spoken); }) || (/[—–]/.test(md) ? /[—–]/ : null);
            if (hit) { stats.banned++; console.log('BANNED ' + lead.id + (es ? ' es ' : ' en ') + hit); continue; }
            stats.built++;
            if (ONLY && !UPLOAD) { console.log(md); console.log('\n=========================\n'); }
            if (!UPLOAD) continue;
            const file = FOLDER + '/' + lead.id + (es ? '.es.md' : '.md');
            const r = await fetch(URL_ + '/storage/v1/object/' + BUCKET + '/' + file, {
                method: 'POST',
                headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'text/markdown; charset=utf-8', 'x-upsert': 'true' },
                body: md,
            });
            if (r.ok) stats.uploaded++; else { stats.failed++; console.log('FAIL ' + file + ' ' + r.status + ' ' + (await r.text()).slice(0, 120)); }
        }
    }
    console.log(JSON.stringify(stats));
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
