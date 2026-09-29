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
const REP = arg('rep', 'remyleon@stiloaipartners.com');
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
    hydra7: ['Hydra Acqua Skin, 7 handles', '$3,900', '$312', 'The HydraFacial category. Clients rebook monthly', 'La categoría HydraFacial. Las clientas vuelven cada mes'],
    destroy: ['Cavitación Destroy + RF', '$5,000', '$400', 'Built to last, for a spa replacing a burned-out unit', 'Hecha para durar, para quien quemó una máquina barata'],
    hidra17: ['Hidra Acqua Skin, 17 functions', '$3,500', '$280', '17 facials in one device', '17 faciales en un equipo'],
    lipo: ['Cavitation-RF-Lipolaser', '$3,000', '$240', 'Easiest first body machine', 'La primera máquina de cuerpo más fácil'],
};
const PLAN = {
    medical: ['galaxy', 'modena', 'morfo', 'hifu'],
    surgeon: ['co2', 'morfo', 'hifu', 'galaxy'],
    laser: ['galaxy', 'fashion', 'planet', 'morfo'],
    wellness: ['bodypulse', 'bella', 'hifu', 'cold'],
    esthetic: ['bodypulse', 'bella', 'hydra7', 'destroy'],
    school: ['hidra17', 'lipo', 'bella'],
    salon: ['hidra17', 'lipo'],
    other: [],
};
function planKey(lead, seg) {
    if (seg === 'medical' && /dermatolog|plastic|cosmetic surg|surgeon/i.test(lead.category || '')) return 'surgeon';
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
        surgeon: ['The surgeon is the medical director. HIFU and RF microneedling catch the patient who is not ready for surgery. Reach the practice manager and ask who bought the last machine.',
            'El cirujano es el director médico. HIFU y radiofrecuencia fraccionada atrapan al paciente que no está listo para cirugía. Busque al practice manager y pregunte quién compró la última máquina.'],
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

function build(rawLead, hist, es) {
    const lead = Object.assign({}, rawLead, { name: clean(rawLead.name) });
    const seg = segmentOf(lead.category);
    const pk = planKey(lead, seg);
    const region = regionOf(lead.address);
    const local = region === 'south';
    const city = cityOf(lead.address);
    const who = askName(lead);
    const L = es ? 1 : 0;
    const out = [];
    const p = function (s) { out.push(s == null ? '' : s); };
    const machines = PLAN[pk].map(function (k) { return M[k]; });
    const top = machines[0];
    const nameOrOwner = who.name || (es ? 'el dueño o la dueña' : 'the owner');
    // Never assume a gender: the owner is "them", or their name when we have it.
    const them = who.name ? (es ? 'a ' + who.name : who.name) : (es ? 'al dueño o a la dueña' : 'them');
    const their = who.name ? who.name + (es ? '' : "'s") : (es ? '' : 'their');
    const blason = es
        ? 'Blasón, B-L-A-S-O-N, Spa Equipment, los importadores con el showroom aquí en Miami'
        : 'Blason, B-L-A-S-O-N, Spa Equipment, the importer with the showroom here in Miami';

    p('# ' + (es ? 'LLAMADA BLASON: ' : 'BLASON CALL: ') + lead.name);
    p('**Campaign:** Blason Spa Equipment · Script v2 · rebuilt ' + TODAY + (es ? ' desde 388 grabaciones de llamadas.' : ' from 388 call recordings.'));
    p('');
    p(es ? '## Antes de marcar' : '## Before you dial');
    p('| | |');
    p('|---|---|');
    p('| **' + (es ? 'Negocio' : 'Business') + '** | ' + lead.name + ' |');
    p('| **' + (es ? 'Teléfono' : 'Phone') + '** | ' + (lead.phone || '') + ' |');
    p('| **' + (es ? 'Dónde' : 'Where') + '** | ' + (city || lead.address || '') + ' |');
    const nameCell = who.name ? who.name
        : (who.note ? (es ? 'la dueña/el dueño. Registros dicen ' + who.note + ' (sin verificar, úselo solo si la recepción lo dice primero)' : 'the owner. Records say ' + who.note + ' (unverified, only use it if the desk says it first)')
            : (es ? 'la dueña/el dueño, o quien compra los equipos' : 'the owner, or whoever buys the equipment'));
    p('| **' + (es ? 'Preguntar por' : 'Who to reach') + '** | ' + nameCell + ' |');
    if (lead.front_desk_name) p('| **' + (es ? 'Recepción' : 'Front desk') + '** | ' + clean(lead.front_desk_name, 60) + ' |');
    p('| **' + (es ? 'Tipo' : 'Type') + '** | ' + T.typeLabel[seg][L] + ' |');
    p('| **' + (es ? 'Idioma' : 'Language') + '** | ' + (lead.primary_language === 'es' ? (es ? 'Español' : 'Spanish: run the call in Spanish') : (es ? 'Inglés: haga la llamada en inglés' : 'English')) + ' |');
    p('| **' + (es ? 'Mejor hora' : 'Best time') + '** | ' + (pk === 'surgeon' ? T.bestTime.medical[L] : T.bestTime.default[L]) + ' |');
    p('| **' + (es ? 'Meta' : 'Goal') + '** | ' + (local
        ? (es ? 'Un día y hora para visitar el showroom en Miami' : 'A day and a time for a showroom visit in Miami')
        : (es ? 'Un día y hora para 10 minutos por teléfono con Manuel' : 'A day and a time for a 10-minute phone call with Manuel')) + ' |');
    p('');

    // ---- History ---------------------------------------------------------
    p(es ? '## Lo que ya sabemos' : '## What we already know');
    const facts = [];
    if (lead.next_step) facts.push((es ? '**Próximo paso:** ' : '**Next step:** ') + clean(lead.next_step, 260));
    if (lead.rep_notes) facts.push((es ? '**Sus notas:** ' : '**Your notes:** ') + clean(lead.rep_notes, 260));
    for (const r of hist.replies) facts.push('**' + fmtDate(r.at) + (es ? ', respondieron por ' : ', they replied by ') + r.channel + ':** "' + clean(r.body, 200) + '"');
    for (const c of hist.calls) {
        const sum = clean(String(c.transcript_summary || '').split(/\n\s*Next steps/i)[0].replace(/^Remy Leon (from [^.]*?)?(called|reached)[^.]*?\.\s*/i, ''), 220)
            || clean(String(c.transcript_summary || '').split('\n')[0], 220);
        if (!sum || /no actionable details/i.test(sum)) continue;
        facts.push('**' + fmtDate(c.called_at) + (es ? ', llamada ' : ', call ') + (c.duration_seconds || 0) + 's:** ' + sum);
    }
    if (hist.callCount) facts.push((es ? 'Llamadas en total: ' : 'Calls so far: ') + hist.callCount + (hist.callCount >= 5 ? (es ? '. Si la recepción sigue bloqueando, pida el celular o WhatsApp del dueño.' : '. If the desk keeps blocking, ask for the owner\'s cell or WhatsApp.') : '.'));
    if (!facts.length) facts.push(es ? 'Nada todavía. Primera llamada.' : 'Nothing yet. First call.');
    for (const f of facts.slice(0, 8)) p('- ' + f);
    p('');

    // ---- What to sell ----------------------------------------------------
    p(es ? '## Qué venderles' : '## What to sell them');
    p(T.why[pk] ? T.why[pk][L] : T.why[seg][L]);
    p('');
    if (machines.length) {
        p(es ? '| Máquina | Por qué a ellos | Precio (nunca lo diga) | Su 8% |' : '| Machine | Why them | Price (never say it) | Your 8% |');
        p('|---|---|---|---|');
        for (const m of machines) p('| ' + m[0] + ' | ' + (es ? m[4] : m[3]) + ' | ' + m[1] + ' | ' + m[2] + ' |');
        p('');
        p(es ? '*Empiece por la primera. Si mencionan algo pequeño, "le consigo la respuesta" y vuelva a la grande.*'
            : '*Lead with the first one. If they raise a small item, "I\'ll get you an answer on that," then back to the big one.*');
        p('');
    }

    // ---- 1. Front desk -----------------------------------------------------
    p(es ? '## 1. La recepción' : '## 1. The front desk');
    p(es ? '**Siempre la compañía, deletreada, y una razón:**' : '**Always the company, spelled, plus one reason:**');
    p('> ' + (es ? '"Hola, le habla Remy de ' + blason + '. Es sobre las máquinas, ¿está ' + nameOrOwner + '?"'
        : '"Hi, it\'s Remy with ' + blason + '. It\'s about the machines. Is ' + nameOrOwner + ' in?"'));
    p('');
    p(es ? '**Si no está (lo más común). Pida una hora, nunca que lo transfieran:**' : '**If not in (most of the time). Get a time, never ask for a transfer:**');
    p('> ' + (es ? '"Es una decisión del dueño, así que no le quito tiempo. Usted conoce el horario mejor que yo, ¿a qué hora consigo ' + them + ', en la mañana o al final del día? ¿Y hay un celular o WhatsApp para proveedores? La línea de aquí siempre está sonando."'
        : '"It\'s an owner decision, so I won\'t eat your time with it. You know the schedule better than me, when would I actually catch ' + them + ', mornings or end of day? And is there a cell or WhatsApp for vendors? This line is always slammed."'));
    p('');
    p(es ? '**"¿De parte de quién? / ¿Es paciente?"**' : '**"What is this regarding?" / "Are you a patient?"**');
    p('> ' + (es ? '"No soy paciente. Soy Remy de Blasón, B-L-A-S-O-N. Vendemos máquinas, de láser, de cara y de cuerpo. Es para el dueño."'
        : '"I\'m not a patient. It\'s Remy from Blason, B-L-A-S-O-N. We sell machines: laser, face and body. It\'s for the owner."'));
    p('');
    p(es ? '**"Mándelo por email a info@" / "si le interesa, le llaman":**' : '**"Send it to info@" / "if they\'re interested they\'ll call you":**');
    p('> ' + (es ? '"Con gusto. Déjele una pregunta de mi parte: ¿cuál es la próxima máquina en su lista? Si la respuesta es ninguna, me dice y no llamo más. ¿Cuál es el correo directo, no el de info?"'
        : '"Happy to. Leave ' + them + ' one question from me: what\'s the next machine on the list? If the answer is nothing, tell me and I\'ll stop calling, promise. What\'s the direct email, not the info one?"'));
    p('');
    p(es ? '*Menú de opciones: marque la opción de proveedores, ventas, gerente o operador. Nunca cuelgue sin marcar nada. Anote el nombre de quien contestó y llame a la hora exacta: "Hola María, soy Remy, me esperan a las 9."*'
        : '*Phone menu: press the vendor, sales, manager or operator option. Never hang up without pressing anything. Write down the desk\'s name and call back on the dot: "Hi Maria, it\'s Remy, they\'re expecting me at 9."*');
    p('');

    // ---- 2. Voicemail ------------------------------------------------------
    const hook = {
        medical: es ? 'es sobre sus láseres y lo que costaría uno nuevo directo de fábrica' : 'it\'s about your lasers and what a new one looks like factory-direct',
        laser: es ? 'es sobre sus láseres y lo que costaría uno nuevo directo de fábrica' : 'it\'s about your lasers and what a new one looks like factory-direct',
        wellness: es ? 'es sobre máquinas de cuerpo para sus pacientes de pérdida de peso, piel suelta y músculo' : 'it\'s about body machines for your weight-loss patients, loose skin and muscle',
        esthetic: es ? 'es sobre máquinas de cuerpo y faciales, la categoría Emsculpt y HydraFacial sin el precio de marca' : 'it\'s about body and facial machines, the Emsculpt and HydraFacial category without the brand markup',
        school: es ? 'es sobre las máquinas con que entrenan a sus alumnas' : 'it\'s about the machines your students train on',
        salon: es ? 'es sobre máquinas de faciales para su cabina' : 'it\'s about facial machines for your treatment room',
        other: es ? 'es sobre máquinas de estética' : 'it\'s about aesthetic machines',
    }[seg];
    p(es ? '## 2. Buzón de voz (solo el primer intento)' : '## 2. Voicemail (first attempt only)');
    p('> ' + (es ? '"Hola' + (who.name ? ' ' + who.name : '') + ', le habla Remy de Blasón, B-L-A-S-O-N, los importadores en Miami. ' + hook.charAt(0).toUpperCase() + hook.slice(1) + '. Mi número es 786-837-6639. Otra vez, 786-837-6639."'
        : '"Hey' + (who.name ? ' ' + who.name : '') + ', it\'s Remy with Blason, B-L-A-S-O-N, the equipment importer in Miami. ' + hook.charAt(0).toUpperCase() + hook.slice(1) + '. My number is 786-837-6639. Again, 786-837-6639."'));
    p('');
    p(es ? '*Nunca "no es nada urgente". Número dos veces, despacio. Después del primer buzón: email a su correo directo o mensaje por Instagram, no más buzones.*'
        : '*Never "nothing urgent." Number twice, slowly. After the first voicemail: email the owner\'s direct address or DM on Instagram, no more voicemails.*');
    p('');

    // ---- 3. The owner ------------------------------------------------------
    p(es ? '## 3. Cuando contesta la dueña o el dueño' : '## 3. When you reach the owner');
    p(es ? '**Apertura:**' : '**Open:**');
    p('> ' + (es ? '"Hola' + (who.name ? ' ' + who.name : '') + ', le habla Remy de ' + blason + '. ¿Lo agarré entre ' + (seg === 'medical' || seg === 'wellness' ? 'pacientes' : 'clientas') + '?"'
        : '"Hi' + (who.name ? ' ' + who.name : '') + ', it\'s Remy with ' + blason + '. Did I catch you in between ' + (seg === 'medical' || seg === 'wellness' ? 'patients' : 'clients') + '?"'));
    p('');
    if (hist.callCount) {
        p(es ? '**Continuidad (ya hemos llamado):**' : '**Continuity (we have called before):**');
        p('> ' + (es ? '"Llamé hace unos días y hablé con la recepción. Le prometí que sería rápido."' : '"I called a few days ago and spoke with your front desk. I promised them I\'d keep it quick."'));
        p('');
    }
    if (seg === 'esthetic' || seg === 'other') {
        p(es ? '**La pregunta que decide la mitad del catálogo (primer minuto):**' : '**The question that picks the half of the catalog (first minute):**');
        p('> ' + (es ? '"Una pregunta rápida para mostrarle lo correcto: ¿ustedes tienen director médico, o son esteticistas?"'
            : '"Quick one so I show you the right half of the catalog: do you have a medical director on staff, or is it estheticians running the floor?"'));
        p('');
        p(es ? '- **Sí:** la línea de láser (Modena o Galaxy). Es la venta grande.' : '- **Yes:** the laser line (Modena or Galaxy). This is the big sale.');
        p(es ? '- **No:** cuerpo y faciales. Nunca un láser.' : '- **No:** body and facial machines. Never a laser.');
        p('');
    }
    p(es ? '**Descubrimiento. Haga dos, y cállese:**' : '**Discovery. Ask two, then stop talking:**');
    for (const q of discovery(seg, es)) p('> ' + q);
    p('');
    p(es ? '*Si nombran una marca (Candela, Venus, Morpheus8, Emsculpt, HydraFacial), busque la traducción en la referencia abajo. Nunca "¿qué es eso?". Si no la conoce: "Le pregunto a Manuel por esa unidad exacta y le devuelvo la llamada en una hora. Mientras tanto, ¿qué más tiene en la lista?"*'
        : '*If they name a brand (Candela, Venus, Morpheus8, Emsculpt, HydraFacial), use the translation in the reference below. Never "what is that?" If you don\'t know it: "Let me check with Manuel on that exact unit and call you back in an hour. Meanwhile, what else is on the list?"*');
    p('');
    p(es ? '**El valor (solo después de que dijeron algo real):**' : '**The value (only after they\'ve said something real):**');
    p('> ' + (es ? '"Por eso los dueños vienen con nosotros: Manuel importa directo de fábrica, la misma máquina sin el sobreprecio de la marca. ' + (local ? 'Usted la prueba encendida en el showroom antes de comprar, en vez de encargar a ciegas por Internet. ' : 'Se la envía gratis con entrenamiento, y él mismo le da servicio. ') + 'Garantía de un año y él la repara de por vida."'
        : '"Here\'s why owners come to us: Manuel imports factory-direct, same machines without the brand markup. ' + (local ? 'You fire them in the showroom before you buy, instead of ordering blind online. ' : 'He ships free with training, and he services them himself. ') + 'One-year warranty, and he repairs them for life."'));
    p('');
    p(es ? '**El cierre:**' : '**The close:**');
    if (local) {
        p('> ' + (es ? '"Manuel está en el showroom de martes a viernes hasta las 4. Tengo el jueves a las 11 o el viernes a las 2. ¿Cuál le anoto? ... Listo. Le mando la dirección por texto ahorita, Manuel va a estar ahí esperándole, y le llamo esa mañana para confirmar."'
            : '"Manuel\'s at the showroom in Miami Tuesday through Friday till 4. I\'ve got Thursday at 11 or Friday at 2. Which one do I put you down for? ... Done. I\'ll text you the address right now, Manuel will be waiting for you, and I\'ll call you the morning of to confirm."'));
    } else {
        p('> ' + (es ? '"Como están' + (city ? ' en ' + city : ' lejos') + ', hacemos esto: diez minutos por teléfono con Manuel, el dueño. Él le dice de frente cuál máquina le conviene, y se la envía con entrenamiento y garantía. ¿Mañana a las 10 o el jueves a las 2?"'
            : '"Since you\'re' + (city ? ' in ' + city : ' out of town') + ', here\'s the easy version: ten minutes on the phone with Manuel, the owner. He\'ll tell you straight which machine fits, and he ships it with training and the warranty. Tomorrow at 10 or Thursday at 2?"'));
    }
    p('');
    p(es ? '*Cambie los días por dos horas reales. Manuel atiende llamadas de lunes a viernes, de 9 a 4.*'
        : '*Swap in two real slots. Manuel takes calls Monday to Friday, 9 to 4.*');
    p('');
    p(es ? '**Si es un no:**' : '**If it\'s a no:**');
    p('> ' + (es ? '"Perfecto. Una cosa antes de colgar: ¿las máquinas ya están resueltas, o es mal momento nada más?"'
        : '"All good. One thing before I let you go: is the equipment handled, or is it just a bad time?"'));
    p('');
    p(es ? '*Una sola vez. Anote la respuesta, pida el número directo, y ponga fecha para llamar en 60 días.*'
        : '*Once. Log the answer, get the direct line, set a 60-day callback.*');
    p('');

    // ---- 4. Objections -----------------------------------------------------
    p(es ? '## 4. Objeciones que va a escuchar' : '## 4. Objections you will hear');
    const obj = [];
    obj.push([es ? '"¿Cuánto cuesta?" / "¿Tiene un precio base?"' : '"How much is it?" / "Do you have a base price?"',
        es ? '"Depende de cuál unidad le sirve, y Manuel financia, la mayoría lo pone en una mensualidad. Eso es justo lo que se resuelve ' + (local ? 'en la visita' : 'en los diez minutos con él') + '. ¿Cuánto le vale a usted un tratamiento así en un año?" *Nunca un número, un rango, ni la página web. Después, silencio.*'
            : '"Depends which unit fits what your clients want, and Manuel does financing, so most owners put it on a monthly. That\'s exactly what ' + (local ? 'the visit' : 'the ten minutes with him') + ' settles. What\'s a treatment like that worth to you over a year?" *Never a number, a range or the website. Then silence.*']);
    obj.push([es ? '"¿Me pueden dar un descuento?" / "Si es buen precio, voy"' : '"Can y\'all get a discounted rate?" / "If it\'s a good deal I\'ll come by"',
        es ? '"Manuel importa directo de fábrica, así que no tiene el sobreprecio de la marca. El descuento es cómo compramos, no un cupón. ' + (local ? 'Venga a probarla el jueves a las 2 y que Manuel le arme el paquete.' : 'Diez minutos con él y le arma el paquete. ¿Mañana a las 10?') + '" *No diga que hay una "promoción" a menos que Manuel la haya confirmado esta semana.*'
            : '"Manuel imports factory-direct, so there\'s no brand markup. The deal is how we buy, not a coupon. ' + (local ? 'Come fire it Thursday at 2 and have Manuel price the package.' : 'Ten minutes with him and he prices the package. Tomorrow at 10?') + '" *Don\'t say "we\'re running a special" unless Manuel confirmed one this week.*']);
    obj.push([es ? '"Ya tenemos todo" / "estamos cubiertos"' : '"We\'re covered" / "we have everything"',
        es ? '"Entonces ya pasó lo difícil. ¿Cuál es la máquina más vieja que tiene, y cuánto le costó tenerla parada este año?" Si nada: "¿Viene algo nuevo, otra cabina o un segundo local?"'
            : '"Then you\'re past the hard part. What\'s the oldest machine in the room, and what did downtime cost you this year?" If nothing: "Anything new coming, a room or a second location?"']);
    obj.push([es ? '"Acabamos de comprar"' : '"We just bought"',
        es ? '"Felicidades. ¿Cuáles? ... ¿Quién le entrena al personal, y de dónde viene la pieza cuando se dañe? ¿Y cuál sigue, cuerpo o cara?" Anote la marca y llame en 60 a 90 días. Una clínica que acaba de gastar es una clínica que gasta.'
            : '"Congrats. Which ones? ... Who\'s training your staff on it, and where\'s the part coming from when it\'s down? And what\'s next, body or face?" Log the brand, call back in 60 to 90 days. A clinic that just spent is a clinic that spends.']);
    if (seg === 'esthetic' || seg === 'salon' || seg === 'school') {
        obj.push([es ? '"No tenemos licencia para eso" / "no somos med spa"' : '"We\'re not licensed for that" / "we\'re not a med spa"',
            es ? '"Bueno saberlo, eso cambia lo que le enseñaría. La mitad de lo que tenemos no necesita director médico: cavitación, radiofrecuencia, hidrodermoabrasión, HIFEM. Y cuando quiera un láser, un director médico que firme protocolos cuesta unos cientos al mes. ¿Conoce algún médico?"'
                : '"Good to know, that changes what I\'d show you. Half of what we carry needs no medical director at all: cavitation, RF, hydro-dermabrasion, HIFEM. And when you\'re ready for a laser, a director who signs protocols runs a few hundred a month. Do you know any doctors?"']);
    }
    if (!local) {
        obj.push([es ? '"Miami queda lejos"' : '"Miami is too far"',
            es ? '"No tiene que venir. Diez minutos por teléfono con Manuel, y le envía la máquina gratis con entrenamiento. ¿Mañana a las 10 o el jueves a las 2?"'
                : '"You don\'t have to come down. Ten minutes on the phone with Manuel, and he ships it free with training. Tomorrow at 10 or Thursday at 2?"']);
    }
    obj.push([es ? '"Lo compro en Alibaba o Amazon por la mitad"' : '"I can get it on Alibaba for half"',
        es ? '"Se puede, y algunos de los mejores clientes de Manuel lo intentaron primero. Llega la máquina, ¿y después? Sin instalación, sin entrenamiento, sin certificado, y cuando se daña no hay técnico en Miami. Manuel tiene las piezas aquí y entrena gratis. Compare después."'
            : '"You can, and some of Manuel\'s best customers tried that first. The machine shows up, then what? No install, no training, no certificate, and when it breaks there\'s no tech in Miami. He stocks the parts here and trains your staff free. Compare after."']);
    obj.push([es ? '"Nos estamos mudando / remodelando / abrimos después"' : '"We\'re moving / remodeling / opening later"',
        es ? '"Felicidades. Un espacio más grande es un menú nuevo. ¿Qué piensan agregar en el local nuevo? ... Entonces véalas antes de firmar nada. Pongamos la fecha ahora, no en noviembre."'
            : '"Congrats. A bigger space means a new menu. What are you planning to add in the new place? ... Then see the machines before you sign for anything. Let\'s put the date down now, not in November."']);
    obj.push([es ? '"Tengo que hablar con mi socia / el doctor"' : '"I have to talk to my partner / the doctor"',
        es ? '"Claro. Pongamos a los dos con Manuel para que nadie tenga que repetirlo. ¿' + (local ? 'Jueves a las 11 o viernes a las 2' : 'Mañana a las 10 o jueves a las 2') + ' para los dos?"'
            : '"Of course. Let\'s put you both with Manuel so nobody has to relay it. ' + (local ? 'Thursday at 11 or Friday at 2' : 'Tomorrow at 10 or Thursday at 2') + ' for both of you?"']);
    obj.push([es ? '"¿Qué es lo que vende?" / "¿Es publicidad?"' : '"What is it you sell?" / "Is this marketing?"',
        es ? '"Máquinas. Vendemos máquinas de láser, de cara y de piel." Y después la pregunta de la lista.' : '"Machines. We sell laser, face and body machines." Then the wishlist question.']);
    obj.push([es ? '"No me interesa"' : '"Not interested"',
        es ? '"Perfecto. ¿Las máquinas ya están resueltas, o es mal momento?" Una sola pregunta. Nunca insista dos veces.'
            : '"All good. Is the equipment handled, or is it just a bad time?" One question. Never push twice.']);
    obj.push([es ? '"Sáquenme de la lista" / "Stop"' : '"Take us off the list" / "Stop"',
        es ? '"Listo, ya está. Disculpe la molestia." Márquelo como no llamar en el momento.' : '"Done, you\'re off. Sorry for the bother." Mark do not call on the spot.']);
    for (const o of obj) { p('**' + o[0] + '**'); p('> ' + o[1]); p(''); }

    // ---- 5. After ----------------------------------------------------------
    p(es ? '## 5. Después de la llamada, el mismo día' : '## 5. After the call, same day');
    p(es ? '- Anote el resultado y una línea antes de la próxima llamada. Si hay próximo paso, póngale fecha.' : '- Log the outcome and one line before the next dial. If there\'s a next step, give it a date.');
    p(es ? '- Si agendó: texto con la dirección (' + (local ? '3110 W 84th St Unit 4, Miami, FL 33018' : 'o la hora de la llamada con Manuel') + '), y WhatsApp a Manuel con nombre, negocio, idioma, si tienen director médico, las máquinas que dijeron en sus palabras, y la marca con que compararon.'
        : '- If booked: text the ' + (local ? 'address (3110 W 84th St Unit 4, Miami, FL 33018)' : 'call time') + ', and WhatsApp Manuel the name, business, language, medical director yes or no, the machines they named in their words, and any brand they compared to.');
    p(es ? '- Si hubo conversación de 20 segundos o más: el texto de seguimiento sale solo al día siguiente.' : '- A connected call of 20 seconds or more feeds the next day\'s follow-up text automatically.');
    p(es ? '- Nunca diga "le mandé el email" antes de mandarlo.' : '- Never say "I sent the email" before you send it.');
    p('');
    p('*Lead ' + lead.id + ' · Script v2 · ' + TODAY + '*');
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

const BANNED = [/what (treatment|treatments)[^.?]*can'?t/i, /no pueden? hacer/i, /nothing urgent|nada urgente/i, /hialeah/i, /\bvideo\b|videollamada/i,
    /blasononline|www\.|https?:/i, /[—–]/, /equipaje/i, /\bstilo\b|\bagency\b|\bAI\b/];

(async function main() {
    let q = 'leads?select=id,name,phone,address,category,primary_language,owner_name,owner_name_verify_status,front_desk_name,next_step,rep_notes,stage,do_not_call'
        + '&client_id=eq.' + CLIENT_ID + '&assigned_to=eq.' + encodeURIComponent(REP) + '&stage=in.(NEW,ENGAGED)&order=id';
    if (ONLY) q += '&id=eq.' + ONLY;
    const leads = (await getAll(q)).filter(function (l) { return !l.do_not_call; });
    const ids = leads.map(function (l) { return l.id; });
    console.log('leads on ' + REP + ': ' + leads.length);

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
