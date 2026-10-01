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
    p('**Campaign:** Blason Spa Equipment · Script v3 · rebuilt ' + TODAY + (es ? ' desde 388 grabaciones de llamadas.' : ' from 388 call recordings.'));
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
        // Three columns: the drawer is narrow, and on a phone a fourth column
        // scrolls off screen.
        p(es ? '| Máquina | Por qué a ellos | Precio / su 8% (nunca lo diga) |' : '| Machine | Why them | Price / your 8% (never say it) |');
        p('|---|---|---|');
        for (const m of machines) p('| ' + m[0] + ' | ' + (es ? m[4] : m[3]) + ' | ' + m[1] + ' / ' + m[2] + ' |');
        p('');
        p(es ? '*Empiece por la primera. Si mencionan algo pequeño, "le consigo la respuesta" y vuelva a la grande.*'
            : '*Lead with the first one. If they raise a small item, "I\'ll get you an answer on that," then back to the big one.*');
        p('');
    }

    // ---- 1. Front desk -----------------------------------------------------
    // The empty "front desk answers" section is a hook, not content: the
    // shared renderer (assets/cold-call-script.js) swaps it for the
    // "Front desk answered? Tap here." dropdown (name open, the hinge, the
    // screens, the three assets, the owner ask). Without it the dropdown
    // never shows. The lead-specific lines stay in the section below it.
    p('## When the front desk answers');
    p('');
    // ---- v3 (2026-10-01): one owner script, built around WHY a spa buys ----
    // Source: Clients/Blason Spa Equipment/call-scripts/Blason Cold Call Script v3.
    // The desk lines live in the shared dropdown (assets/cold-call-script.js
    // GATEKEEPER_MD); this file is everything from the owner picking up.
    const S = function (esLine, enLine) { p('> "' + (es ? esLine : enLine) + '"'); };
    const N = function (esLine, enLine) { p(es ? esLine : enLine); };
    const PAUSE = function () { p(es ? '*(pausa)*' : '*(pause)*'); };
    const nm = who.name;
    const hi = nm ? ' ' + nm : '';
    const ownerEs = nm || 'el dueño o la dueña', ownerEn = nm || 'the owner';
    const nonLaser = ['wellness', 'salon', 'school'].includes(seg);
    const kindEs = nonLaser ? 'equipos de estética' : 'láser', kindEn = nonLaser ? 'aesthetic equipment' : 'laser';
    const two = local ? ['el jueves a las 11 o el viernes a las 2', 'Thursday at 11 or Friday at 2'] : ['mañana a las 10 o el jueves a las 2', 'tomorrow at 10 or Thursday at 2'];
    const meet = local ? ['la visita', 'the visit'] : ['la llamada con él', 'the call with him'];
    // Spoken business name: a name carrying the city would say "Hialeah" out loud (copy rule: Miami, never Hialeah).
    const bizEs = /hialeah/i.test(lead.name) ? 'su clínica' : lead.name, bizEn = /hialeah/i.test(lead.name) ? 'your clinic' : lead.name;

    // ---- 1. Desk line for this lead -------------------------------------
    p(es ? '## 1. La recepción: su primera línea para este negocio' : '## 1. The front desk: your first line for this lead');
    S('Hola, le habla Remy de Blasón. B-L-A-S-O-N. Somos los importadores de ' + kindEs + ' con el showroom en Miami. ¿Está ' + ownerEs + '?',
      'Hi, it\'s Remy with Blason. B-L-A-S-O-N. We\'re the ' + kindEn + ' importer with the showroom in Miami. Is ' + ownerEn + ' in?');
    N('*¿No está? Use el recuadro de arriba: la hora, un celular y el nombre de quien contesta. Nunca le venda a la recepción.*',
      '*Not in? Use the box above: the time, a cell and the desk\'s name. Never pitch the desk.*');
    p('');

    // ---- 2. Owner opener (10 seconds) -----------------------------------
    p(es ? '## 2. Contesta el dueño o la dueña (10 segundos)' : '## 2. The owner picks up (10 seconds)');
    if (local) S('Hola' + hi + ', le habla Remy de Blasón. B-L-A-S-O-N. Somos los importadores de ' + kindEs + ' con el showroom aquí en Miami. El dueño es Manuel Junco.',
        'Hi' + hi + ', it\'s Remy with Blason. B-L-A-S-O-N. We\'re the ' + kindEn + ' importer with the showroom here in Miami. The owner\'s Manuel Junco.');
    else S('Hola' + hi + ', le habla Remy de Blasón. B-L-A-S-O-N. Somos los importadores de ' + kindEs + ' en Miami, y enviamos y entrenamos en toda la Florida. El dueño es Manuel Junco.',
        'Hi' + hi + ', it\'s Remy with Blason. B-L-A-S-O-N. We\'re the ' + kindEn + ' importer in Miami, and we ship and train all over Florida. The owner\'s Manuel Junco.');
    PAUSE();
    if (seg === 'wellness') S('Rapidito: sus pacientes de pérdida de peso, cuando ya bajaron, ¿le preguntan qué hacer con la piel suelta o con el músculo que perdieron?',
        'Quick one. Your weight-loss patients, once the weight comes off, are they asking what to do about loose skin or the muscle they lost?');
    else if (seg === 'salon') S('Rapidito: ¿tienen cabina para faciales o tratamientos, o es solo sillas?', 'Quick one. Do you have a treatment room for facials, or is it all chairs?');
    else if (seg === 'school') S('Rapidito: ¿con qué máquinas entrenan a las alumnas, y quién decide qué compra la academia?', 'Quick one. What machines do your students train on, and who decides what the academy buys?');
    else S('Rapidito: ¿ustedes hacen depilación láser ahí?', 'Quick one. Are you doing laser hair removal there today?');
    p('');
    if (hist.callCount) {
        N('**Si ya hablamos antes** (llene con "Lo que ya sabemos"):', '**If we\'ve talked before** (fill from "What we already know"):');
        S('Hola' + hi + ', es Remy de Blasón, los importadores en Miami. Hablamos el [fecha] sobre [lo que dijo]. ¿Le agarré entre clientes?',
          'Hi' + hi + ', it\'s Remy from Blason, the importer in Miami. We spoke on the [date] about [what they said]. Did I catch you between clients?');
        p('');
    }
    N('*Nada de "¿cómo está usted hoy?". Nada de lista de máquinas. Una pregunta, y deje que hable.*', '*No small talk, no list of what we sell. One question, then let them talk.*');
    p('');

    // ---- 3. The fork --------------------------------------------------------
    p(es ? '## 3. La ruta: quién puede usar qué' : '## 3. The fork: who can run what');
    if (nonLaser) {
        N('*Este negocio no puede usar láser. Venda la línea sin láser (Paso 6B), después la Puerta 3.*', '*This business can\'t run a laser. Sell the non-laser line (Step 6B), then Door 3.*');
    } else {
        N('**Si dijo que SÍ hacen láser:**', '**If they said YES, they do laser:**');
        S('Qué bueno. ¿Qué máquina tienen?', 'Good. Which machine are you running?');
        PAUSE();
        S('¿Hace cuánto la tienen?', 'How long have you had it?');
        N('*Es venta de láser. Puerta 1 (máquina vieja), después Puerta 2 (clientes que se van).*', '*Laser sale. Door 1 (old machine), then Door 2 (demand turned away).*');
        p('');
        N('**Si dijo que NO:**', '**If they said NO:**');
        S('Entiendo. ¿Quién hace los tratamientos ahí? ¿Tienen médico o enfermera practicante, o son esteticistas?',
          'Got it. Who does your treatments there? Do you have a doctor or a nurse practitioner on staff, or is it estheticians?');
        N('- **Médico, enfermera practicante o PA:** venta de láser. Puerta 2.', '- **Doctor, NP or PA on staff:** laser sale. Door 2.');
        N('- **Solo esteticistas:** nunca láser. Paso 6B, después Puerta 3.', '- **Estheticians only:** never a laser. Step 6B, then Door 3.');
        N('- **"Pensamos buscar director médico":**', '- **"We\'re thinking about a medical director":**');
        S('Muchos spas de su tamaño creen que un láser es contratar un médico a tiempo completo. No es así. Un director médico que firma los protocolos es un contrato mensual. ¿Usted conoce algún médico?',
          'Lots of spas your size think a laser means hiring a doctor full time. It doesn\'t. A medical director who signs protocols is a monthly contract. Do you know any doctors already?');
    }
    p('');

    // ---- 4. Discovery: the four motives ------------------------------------
    p(es ? '## 4. Descubrimiento: encuentre el motivo' : '## 4. Discovery: find the motive');
    N('La gente compra máquinas por cuatro razones. Encuentre cuál tiene este negocio, **con sus palabras**, y sáquele dos números: **cuántos** (clientes a la semana, días parada) y **cuánto cobra** cada uno. Una puerta; si está cerrada, una más, y la salida. **Nunca** "¿qué tratamientos no pueden hacer?" ni "¿están buscando añadir máquinas?": las dos están muertas.',
      'People buy machines for four reasons. Find which one this business has, **in their words**, and get two numbers: **how many** (clients a week, days down) and **what each one bills**. One door; if it\'s shut, one more, then the exit. **Never** "what treatments can\'t you do?" or "are you looking to add any machines?": both are dead.');
    p('');
    N('**Puerta 1. Máquina vieja, rota o lenta**', '**Door 1. Old, broken or slow machine**');
    S('¿Cuál es la máquina más vieja que tienen?', 'What\'s the oldest machine in the room?'); PAUSE();
    S('¿Cuántos años tiene? Cuando se les para, ¿qué hacen con las citas de ese día?', 'How many years on it? When it goes down, what happens to the appointments that day?'); PAUSE();
    S('¿Cuántos días estuvo parada este año, más o menos? ¿Y en un día normal, cuántos clientes pasan por ella, a cuánto la sesión?', 'How many days was it down this year, roughly? And on a normal day, how many clients go through it, and what does a session bill?');
    N('*También es Puerta 1: "lenta", "no sirve en piel oscura", "no hay piezas", "ya no la fabrican", "la alquilamos", "la de Amazon no tiene fuerza".*', '*Also Door 1: "slow", "doesn\'t work on darker skin", "can\'t get parts", "discontinued", "we rent one", "the Amazon one has no power".*');
    p('');
    N('**Puerta 2. Clientes que se les van**', '**Door 2. Demand they\'re turning away**');
    S('Cuando alguien llama para depilación láser y ustedes están llenos, o no lo ofrecen, ¿a dónde se va?', 'When someone calls for laser hair removal and you\'re booked, or you don\'t offer it, where do they go?'); PAUSE();
    S('¿Cuántos a la semana, más o menos? ¿Como dos, o como diez? ¿Y en cuánto venden un paquete de láser ahí?', 'How many a week, roughly? More like two, or more like ten? And what does a laser package go for at your place?');
    if (!nonLaser) S('¿Cómo les trabaja el láser en piel oscura? ¿Esos clientes los atienden, o los mandan a otro lado?', 'How does your laser do on darker skin? Do you treat those clients, or send them somewhere?');
    p('');
    N('**Puerta 3. Crecimiento**', '**Door 3. Expansion**');
    S('¿Cuál es la próxima máquina que van a agregar este año?', 'What\'s the next machine you\'re adding this year?'); PAUSE();
    S('¿Viene algo nuevo? ¿Otra cabina, un segundo local, más personal? ¿Cuándo abre, y cuánto tiene que facturar esa cabina al mes para pagar su renta?', 'Anything new coming? A new room, a second location, more staff? When does it open, and what does that room need to bill a month to cover its rent?');
    p('');
    N('**Puerta 4. La competencia**', '**Door 4. Competition**');
    S('¿Cuál es la clínica cerca de ustedes que más láser hace? ¿Algún cliente suyo ha terminado allá? ¿Cuántos este año, más o menos?', 'Which clinic near you does the most laser? Have any of your clients ended up there? How many this year, would you guess?');
    S('Y cuando un cliente se va allá para láser, ¿sigue viniendo con ustedes para lo demás?', 'And when a client goes there for laser, do they keep coming to you for everything else?');
    N('*Si nombran una marca (Candela, Morpheus, HydraFacial, Emsculpt, Venus): repítala y "¿cuántos años tiene, y cómo le está respondiendo?". Nunca "¿qué es eso?".*', '*If they name a brand (Candela, Morpheus8, HydraFacial, Emsculpt, Venus): name it back, then "how many years on it, and how\'s it holding up?". Never "what is that?".*');
    p('');

    // ---- 5. The cost of waiting ------------------------------------------
    p(es ? '## 5. Lo que le cuesta esperar (el corazón de la llamada)' : '## 5. The cost of waiting (the heart of the call)');
    N('Tome **sus dos números**, multiplíquelos **en voz alta**, despacio. Nunca el precio de una máquina, nunca números inventados. Si no da un número, dos opciones ("¿como dos, o como diez?").',
      'Take **their two numbers** and multiply them **out loud**, slowly. Never a machine price, never invented numbers. No number? Give two choices ("more like two, or more like ten?").');
    S('¿Me deja hacer la cuenta en voz alta un segundito? Usted me dijo [A] a la semana, y cada uno son como [B]. Eso es [A por B] a la semana. En un año, son como [A por B por 52].',
      'Can I do the math out loud for a second? You said [A] a week, and each one is about [B]. That\'s [A times B] a week. Over a year, that\'s about [A times B times 52].');
    PAUSE();
    S('¿Le suena parecido? ... O sea, cada mes que espera son como [por mes] que se van por la puerta, y se los lleva la clínica que tiene la máquina.', 'Does that sound about right? ... So every month you wait, that\'s roughly [per month] going out the door, and the clinic that has the machine is the one getting it.');
    S('Lo que dice Manuel es que la mayoría de las clínicas cubren la mensualidad con el primer mes de tratamientos. Eso es lo que quiero que vea con él.', 'Manuel\'s whole point is that most clinics cover the monthly payment with the first month of treatments. That\'s what I want you to see with him.');
    N('*Cuenta en el papel: al año = semana x 52; al mes = semana x 4.3. Si le parece mucho: "Aunque me equivoque por la mitad, son [la mitad] al año." Ejemplo: 2 a la semana x 900 = 1,800 a la semana, como 93,000 al año; la mitad, casi 4,000 al mes.*',
      '*Pad math: per year = per week x 52; per month = per week x 4.3. Too big for them? "Even if I\'m off by half, that\'s still [half] a year." Example: 2 a week x 900 = 1,800 a week, about 93,000 a year; half is close to 4,000 a month.*');
    p('');
    N('**Las otras puertas, misma forma:**', '**The other doors, same shape:**');
    S('Puerta 1: Usted me dijo que se para como [días] al mes, y pasan [clientes] clientes a [precio] la sesión. Cada día parada son [clientes por precio] que no cobra, [al mes] al mes. Y eso sin contar los que no vuelven.',
      'Door 1: You said it\'s down about [days] a month, doing [clients] clients at about [price]. Every day it\'s down is [clients x price] you don\'t bill, [per month] a month. And that\'s before the clients who don\'t rebook.');
    S('Puerta 1, alquiler: [días] días al mes a [costo] cada uno son [al mes] al mes en una máquina que nunca va a ser suya. Cada cheque de alquiler es un pago del láser de otra persona.',
      'Door 1, rental: [days] rental days a month at [cost] each is [per month] a month on a machine you\'ll never own. Every rental check is a payment on someone else\'s laser.');
    S('Puerta 3: Cada mes que la cabina nueva abre sin una máquina que venda paquetes, son [renta] de renta sin nada facturando adentro. El láser llena una cabina, porque el cliente reserva seis visitas el día que dice que sí.',
      'Door 3: Every month the new room opens without a machine that sells packages, that\'s [rent] of rent with nothing billing in it. Laser fills a room, because a client books six visits the day they say yes.');
    S('Puerta 4: [número] clientes que se fueron allá, a seis sesiones o más, son [número por paquete] en paquetes. Y allá se hacen los faciales también. No es una venta que perdió, es el cliente.',
      'Door 4: [number] clients who went there, at six sessions or more, is [number x package] in packages. And they\'re booking their facials there too. It\'s not one sale you lost, it\'s the client.');
    N('**"Esos números son muy altos":**', '**"Those numbers are high":**');
    S('Tiene razón. Son sus números, y los partí a la mitad. Manuel se los saca de verdad con usted. Para eso es ' + meet[0] + '.', 'Fair. They\'re your numbers, and I cut them in half. Manuel will run them with you for real. That\'s the point of ' + meet[1] + '.');
    p('');

    // ---- 6. The bridge ------------------------------------------------------
    p(es ? '## 6. El puente: su necesidad, una máquina' : '## 6. The bridge: their need, matched to one machine');
    N('Cuatro pasos: **repítalo** ("piel oscura"), **dígale la verdad** ("esa categoría la tenemos" / "esa marca no la trabajamos, lo más cercano es esto"), **una frase** de la máquina, y **dos horas con el nombre de Manuel**. Nunca "es igual que un Candela": "es la misma categoría, y usted la juzga".',
      'Four moves: **name it back** ("darker skin"), **match it honestly** ("we have that category" / "we don\'t carry that brand, here\'s what\'s next to it"), **one sentence** on the machine, then **two times with Manuel\'s name**. Never "same as a Candela": "same treatment category, and you judge it yourself".');
    p('');
    if (!nonLaser) {
        N('**6A. Con médico, enfermera practicante o PA: primero el láser de diodo**', '**6A. Medical, NP or MD on staff: lead with the diode laser**');
        p(es ? '| Dijo | Máquina | Diga esto |' : '| They said | Machine | Say this |');
        p('|---|---|---|');
        const rowsA = es ? [
            ['Rechaza piel oscura', 'Scala Ice Galaxy', 'El Galaxy tiene cuatro longitudes de onda en una pieza, incluida la 1064, la que se usa en piel oscura. Esos clientes dejan de irse.'],
            ['Primer láser, o cambiar uno cansado', 'Scala Ice Modena', 'El Modena es la entrada de la línea, las cuatro longitudes y la punta fría. Con ese empiezan casi todas las clínicas.'],
            ['Depilación todo el día, llenos', 'Scala Ice Planet', 'El Planet es para volumen, más potencia para clínicas que depilan todo el día.'],
            ['Una cabina, depilación y manchas', 'Scala Ice Ibiza (diodo + IPL)', 'Dos tratamientos en una caja: el diodo para el vello, el IPL para manchas y rojeces.'],
            ['Manda afuera tatuajes o carbon peel', 'Scala Ice Fashion + YAG', 'El diodo y un YAG en el mismo equipo: depilación, tatuajes y carbon peel.'],
            ['Láser de marca con lista de espera', 'Modena o Galaxy', 'Deje el [marca] en la cabina uno. Para la segunda, el diodo de Manuel es la misma categoría sin el precio de la marca.'],
            ['Se le van por Morpheus8', 'Morfolifting (RF con microagujas)', 'Esa categoría la tiene Manuel, y las puntas cuestan una fracción. (Necesita director médico.)'],
            ['Le piden Emsculpt', 'BodyPulse Pro', 'La categoría de músculo magnético, como Emsculpt, sin el precio de seis cifras.'],
        ] : [
            ['Turns away darker skin', 'Scala Ice Galaxy', 'Our Galaxy has four wavelengths in one handpiece, including the 1064, the one used on darker skin. Those clients stop going down the street.'],
            ['First laser, or replacing a tired one', 'Scala Ice Modena', 'The Modena is the entry to the line, four wavelengths and the cooled tip. It\'s the one most clinics start with.'],
            ['Hair removal all day, booked out', 'Scala Ice Planet', 'The Planet is built for volume, more power for clinics doing hair removal all day.'],
            ['One room, wants hair removal and spots', 'Scala Ice Ibiza (diode + IPL)', 'Two treatments in one box: the diode for hair, the IPL for spots and redness.'],
            ['Refers out tattoo removal or carbon peel', 'Scala Ice Fashion + YAG', 'The diode and a YAG in one cabinet: hair removal, tattoo removal and carbon peel.'],
            ['Branded laser with a waitlist', 'Modena or Galaxy', 'Keep the [brand] in room one. For the second room, Manuel\'s diode is the same treatment category without the brand price tag.'],
            ['Clients leaving for Morpheus8', 'Morfolifting (RF microneedling)', 'Manuel has that category, and the tips cost a fraction of what Morpheus charges per patient. (Medical director required.)'],
            ['Asked for Emsculpt', 'BodyPulse Pro', 'The magnetic muscle category, like Emsculpt, without the six-figure price.'],
        ];
        for (const r of rowsA) p('| ' + r[0] + ' | ' + r[1] + ' | "' + r[2] + '" |');
        p('');
        N('**Después, los tres puntos de Manuel:**', '**Then Manuel\'s three points:**');
        S('Manuel le va a enseñar tres cosas. Uno, se paga sola: la mayoría lo pone en una mensualidad, y con el primer mes de tratamientos ya cubre el pago.', 'Three things Manuel will show you. One, it pays for itself: most clinics put it at a monthly, and the first month of treatments covers the payment.');
        S('Dos, es un diodo de verdad, no una copia. Esa es la diferencia entre un láser que dura y uno que está en el taller a los seis meses.', 'Two, it\'s a real diode, not a copy. That\'s the difference between a laser that lasts and one that\'s in the shop in six months.');
        S('Tres, él mismo le entrena al equipo, le da servicio desde Miami, y le enseña cómo vender los paquetes.', 'Three, he trains your team himself, services it from Miami, and shows you how to sell the packages.');
        p('');
    }
    if (nonLaser || seg === 'esthetic' || seg === 'other') {
        N('**6B. Solo esteticistas: la línea sin láser (nunca láser)**', '**6B. Estheticians only: the non-laser line (never a laser)**');
        p(es ? '| Dijo | Máquina | Diga esto |' : '| They said | Machine | Say this |');
        p('|---|---|---|');
        const rowsB = es ? [
            ['Le piden HydraFacial', 'Hidra Acqua Skin', 'Hidrodermoabrasión, la categoría HydraFacial. Es la que los clientes repiten cada mes.'],
            ['Cabina chiquita, quiere más faciales', 'Máquina facial de 17 funciones', 'Diecisiete tratamientos en un equipo. Le sube el ticket sin poner otra silla.'],
            ['Le piden Emsculpt o moldeo', 'BodyPulse Pro', 'Músculo magnético, como Emsculpt. Nadie toca al cliente, la cabina produce sola.'],
            ['Celulitis, contorno', 'Rodillo con vacío y RF, o ShockWave', 'Esa categoría Manuel la tiene en el piso, y la de ondas de choque también.'],
            ['Le piden CoolSculpting', 'Cold Therapy', 'La misma categoría de congelar grasa, sin pagarle al fabricante por tratamiento.'],
            ['Se le quemó una cavitación barata', 'Cavitación Destroy + RF', 'Hecha más fuerte, placas separadas y cables reforzados, justo para eso.'],
        ] : [
            ['Clients ask for a HydraFacial', 'Hidra Acqua Skin', 'Hydrodermabrasion, the HydraFacial category. It\'s the one clients rebook every month.'],
            ['Small suite, wants more facials', '17-function facial machine', 'Seventeen treatments in one device. It adds a ticket without adding a chair.'],
            ['Clients ask for Emsculpt or sculpting', 'BodyPulse Pro', 'The magnetic muscle category, like Emsculpt. Nobody touches the client, so the room earns on its own.'],
            ['Cellulite, contouring', 'Roller with vacuum and RF, or ShockWave', 'Manuel has that category on the floor, and the shockwave unit too.'],
            ['Clients ask for CoolSculpting', 'Cold Therapy', 'Same fat-freezing category, with no per-treatment fee to a manufacturer.'],
            ['Burned out a cheap cavitation unit', 'Cavitación Destroy + RF', 'Built heavier, separate boards and reinforced cables, for exactly that.'],
        ];
        for (const r of rowsB) p('| ' + r[0] + ' | ' + r[1] + ' | "' + r[2] + '" |');
        N('*Las máquinas de cuerpo son zona gris en algunas licencias: "confirme lo que cubre su licencia", nunca "usted puede". Si algo es pequeño (panel LED, camilla, una pieza): "le consigo la respuesta" y de vuelta a la grande.*',
          '*Body machines are a gray area on some licenses: "check what your license covers", never "you\'re allowed". Small item (LED panel, bed, a part): "I\'ll get you an answer on that," then back to the big one.*');
        p('');
    }

    // ---- 7. The close ---------------------------------------------------------
    p(es ? '## 7. El cierre: dos horas, el nombre de Manuel, y silencio' : '## 7. The close: two times, Manuel\'s name, then silence');
    if (local) {
        S('La mejor forma de saber es probarla. Manuel se la tiene encendida. Tengo ' + two[0] + '. ¿Cuál le anoto?', 'The easiest way to know is to put your hands on it. Manuel will have it powered on for you. I\'ve got ' + two[1] + '. Which one do I put you down for?');
        N('*Cuente hasta cinco. No hable primero. Manuel está en el showroom de martes a viernes hasta las 4: ponga dos horas reales.*', '*Count to five. Don\'t talk first. Manuel is at the showroom Tuesday through Friday until 4: swap in two real slots.*');
    } else {
        S('Ustedes están' + (city ? ' en ' + city : ' lejos') + ', así que lo hacemos así: diez minutos por teléfono con Manuel. Lleva veinte años importando estas máquinas. Le dice con honestidad si le sirve, y se la manda con entrenamiento. ¿' + two[0].charAt(0).toUpperCase() + two[0].slice(1) + '?',
          'You\'re' + (city ? ' in ' + city : ' a few hours from us') + ', so here\'s how owners up there do it: ten minutes on the phone with Manuel. He\'s been importing these for twenty years. He\'ll tell you straight whether it fits, and he ships it with training. ' + two[1].charAt(0).toUpperCase() + two[1].slice(1) + '?');
        N('*Cuente hasta cinco. Manuel atiende llamadas de lunes a viernes, de 9 a 4.*', '*Count to five. Manuel takes calls Monday to Friday, 9 to 4.*');
    }
    p('');
    N('**Quiere comprar ya:**', '**They want to buy now:**');
    S('Perfecto. Manuel toma la orden él mismo para que la garantía y el entrenamiento queden bien. Lo hace por teléfono en diez minutos. ¿Puede ahora mismo, o mejor a las 3?', 'Love it. Manuel takes the order himself so the warranty and the training get set up right. He can do it by phone in ten minutes. Are you free right now, or is 3 o\'clock better?');
    N('*Si Manuel contesta, conéctelo en la llamada. Nunca mande a un comprador listo a la página web solo: nadie sabría que fue nuestra venta.*', '*If Manuel picks up, conference him in. Never send a ready buyer to the website alone: nobody will know it was our sale.*');
    if (!nonLaser && TODAY <= '2026-10-02') {
        p('');
        N('**Solo hasta el viernes 10/2:**', '**Only through Friday 10/2:**');
        S('Y Manuel tiene los láser de diodo en especial hasta el viernes, así que esta es la semana para verlo. El precio se lo da él.', 'And Manuel has his diode lasers on a special through Friday, so this week is the week to see it. He\'ll give you the number himself.');
        N('*Nunca los números. Después del viernes 10/2 esta línea es falsa.*', '*Never the numbers. After Friday 10/2 this line is false.*');
    }
    p('');

    // ---- 8. The yes lock-in -------------------------------------------------
    p(es ? '## 8. Cuando dice que sí (antes de colgar)' : '## 8. The yes lock-in (before you hang up)');
    if (local) S('Perfecto. Entonces es el [jueves a las 11], en el showroom en Miami, con Manuel. ¿Viene usted, o viene también su socio, el doctor o la gerente?', 'Perfect. So it\'s [Thursday at 11], at the showroom in Miami, with Manuel. Is it just you, or is your partner, the doctor or the manager coming too?');
    else S('Perfecto. Manuel le llama [mañana a las 10], diez minutos. ¿Quién más debe estar en la llamada?', 'Perfect. So Manuel calls you [tomorrow at 10], ten minutes. Who else should be on the line?');
    S('¿Este es su mejor celular, o hay uno que sí mira? Le mando ' + (local ? 'la dirección' : 'la confirmación') + ' por texto ahorita, y le llamo ' + (local ? 'esa mañana' : 'media hora antes') + ' para confirmar.',
      'Is this the best cell for you, or is there one you actually check? I\'m texting you ' + (local ? 'the address' : 'the confirmation') + ' right now, and I\'ll call you ' + (local ? 'that morning' : '30 minutes before') + ' to confirm.');
    N('**Texto:** ' + (local ? '"Hola [nombre], es Remy de Blasón. Quedó para el [jueves a las 11] con Manuel. 3110 W 84th St, Unit 4, Miami, FL 33018. Nos vemos."' : '"Hola [nombre], es Remy de Blasón. Manuel le llama [mañana a las 10]. Ya sabe que está buscando [la máquina]."'),
      '**Text:** ' + (local ? '"Hi [name], it\'s Remy from Blason. You\'re set for [Thursday at 11] with Manuel. 3110 W 84th St, Unit 4, Miami, FL 33018. See you then."' : '"Hi [name], it\'s Remy from Blason. Manuel will call you [tomorrow at 10]. He knows you\'re looking at [the machine]."'));
    N('**WhatsApp a Manuel, en menos de una hora:** nombre, negocio, ciudad, teléfono, idioma · TIENE: [máquina, años] · MOTIVO: [en sus palabras] · NÚMEROS: [sus dos números] · OPERA: [médico / NP / esteticista] · MOSTRARLE: [máquina].',
      '**WhatsApp Manuel within the hour (in Spanish):** name, business, city, phone, language · TIENE: [machine, years] · MOTIVO: [their words] · NÚMEROS: [their two numbers] · OPERA: [MD / NP / esthetician] · MOSTRARLE: [machine].');
    N('*Anótelo antes de la próxima llamada, con fecha. Una cita sin fecha desaparece de Hoy y Atrasados.*', '*Log it before the next dial, with the date. A booking with no date disappears from Today and Overdue.*');
    p('');

    // ---- 9. Objections --------------------------------------------------------
    p(es ? '## 9. Objeciones' : '## 9. Objections');
    N('*La regla: reconozca, una pregunta o una frase, y dos horas. Nunca vuelva a explicar todo. Nunca insista dos veces en un no.*', '*The rule: acknowledge, one question or one line, then two times. Never re-explain the offer. Never push a no twice.*');
    p('');
    const obj = [
        ['"¿Cuánto cuesta?" / "¿Un precio base?"', '"How much is it?" / "Just a ballpark"',
         'Depende de cuál unidad le sirve, y Manuel financia, la mayoría lo pone en una mensualidad. Eso es justo lo que se resuelve en ' + meet[0] + '. Y usted me acaba de decir que esperar le está costando como [su número al mes]. ¿' + two[0].charAt(0).toUpperCase() + two[0].slice(1) + '?',
         'Depends which unit fits, and Manuel does financing. Most owners put it at a monthly. That\'s exactly what ' + meet[1] + ' settles. And you just told me waiting is running about [their per-month number]. ' + two[1].charAt(0).toUpperCase() + two[1].slice(1) + '?'],
        ['"Mándeme información" / "el catálogo"', '"Send me some information" / "the catalog"',
         'Se lo mando hoy. Pero le soy honesto: el catálogo no le dice cuál le sirve a su cabina. Usted me dijo [su motivo]. Eso Manuel se lo contesta en diez minutos. Pongamos la hora y le mando la información junto.',
         'I\'ll send it today. Honest heads up, though: a catalog won\'t tell you which one fits your room. You told me [their motive]. That\'s what Manuel answers in ten minutes. Let\'s put the time down and I\'ll send the info with it.'],
        ['"Tenemos todo" / "Estamos bien"', '"We have everything" / "We\'re all set"',
         'Qué bueno, entonces usted sabe lo que produce una máquina. ¿Cuál es la más vieja?',
         'Good, then you know what a machine earns. Which one\'s the oldest?'],
        ['"No me interesa"', '"Not interested"',
         'Perfecto. Una cosa antes de colgar: ¿las máquinas ya están resueltas, o es mal momento nada más? ... Guarde mi número. Cuando quiera mirar, Manuel tiene todo encendido en Miami.',
         'All good. One thing before I let you go: is the equipment handled, or is it just a bad time? ... Save my number. When you\'re ready to look, Manuel has everything powered on in Miami.'],
        ['"Tengo que hablarlo con mi socio / el doctor"', '"I need to talk to my partner / the doctor"',
         'Claro. Pongamos a los dos con Manuel para que nadie tenga que repetirlo. ¿' + two[0].charAt(0).toUpperCase() + two[0].slice(1) + ' para los dos?',
         'Of course. Let\'s put you both with Manuel so nobody has to repeat it. ' + two[1].charAt(0).toUpperCase() + two[1].slice(1) + ' for the two of you?'],
        ['"¿No es una máquina china?" / "En Alibaba la consigo a la mitad"', '"Isn\'t it a Chinese machine?" / "Alibaba has it for half"',
         'Manuel importa directo de fábrica, por eso no tiene el sobreprecio de la marca. Es un diodo de verdad, no una copia. La diferencia es lo que pasa después: él le entrena al equipo, tiene las piezas en Miami y repara lo que vende. Cuando un láser de Alibaba se para, ¿a quién llama usted?',
         'Manuel imports direct from the factory. That\'s why there\'s no brand markup. It\'s a real diode, not a copy. The difference is what happens after it lands: he trains your team himself, keeps the parts in Miami and repairs what he sells. When an Alibaba laser goes down, who do you call?'],
        ['"No tengo el dinero" / "Mi crédito no está bien"', '"I don\'t have the money" / "My credit\'s not great"',
         'Casi nadie paga en efectivo, lo ponen en una mensualidad. Manuel trabaja con financiamiento y le dice de frente qué le conviene. Mejor saber que adivinar.',
         'Most owners don\'t pay cash, they put it at a monthly. Manuel works with financing and he\'ll tell you straight what makes sense. Better to know than to guess.'],
        ['"Llámeme más adelante"', '"Call me later" / "next month"',
         'Claro. Para llamarle cuando de verdad importe: ¿es el momento, o está esperando algo, como la cabina nueva o que pase la temporada floja? ¿Y eso cuándo es?',
         'Sure. So I call when it actually matters: is it the timing, or are you waiting on something, like the new room or the slow season? When is that?'],
        ['"Acabamos de comprar una máquina"', '"We just bought a machine"',
         'Felicidades. ¿Cuál compraron? ... O sea que eso les cubre [cara / vello / cuerpo]. ¿Y lo otro, con qué lo hacen?',
         'Congrats. Which one? ... So that covers [skin / hair / body]. What handles the other one?'],
        ['"¿Está aprobada por la FDA?"', '"Is it FDA approved?"',
         'Buena pregunta, y quiero que se la conteste Manuel con los papeles, no yo de memoria. Es lo primero que le pido que le enseñe.',
         'Fair question, and I want you to get the exact answer with the paperwork from Manuel, not my version. It\'s the first thing I\'ll have him cover.'],
        ['"¿Qué garantía tiene?"', '"What\'s the warranty?"',
         'Manuel cubre la garantía y repara lo que vende. Los términos exactos se los da él para el modelo que escoja.',
         'Manuel covers the warranty and he repairs what he sells. He\'ll give you the exact terms for the model you pick.'],
        ['"¿Tienen [algo que no trabajamos]?"', '"Do you have [something we don\'t carry]?"',
         'Eso no lo trabajamos. ¿Qué más tiene en la lista?',
         'We don\'t carry that one. What else is on the list?'],
        ['"Yo conozco a Manuel, lo llamo yo"', '"I know Manuel, I\'ll call him myself"',
         'Perfecto, se va a alegrar. Déjeme avisarle hoy que usted va, para que se lo tenga listo. ¿Qué día lo va a ver?',
         'Perfect, he\'ll be glad to hear from you. Let me tell him today you\'re coming so he has it ready. What day are you seeing him?'],
        ['"Sáquenme de la lista" / "Stop"', '"Take me off your list" / "Stop"',
         'Listo, ya está. Disculpe la molestia.', 'Done, you\'re off. Sorry for the bother.'],
    ];
    if (!local) obj.splice(4, 0, ['"Miami queda lejos"', '"Miami is too far"',
        'No tiene que venir. Diez minutos por teléfono con Manuel, y se la manda con entrenamiento. ¿' + two[0].charAt(0).toUpperCase() + two[0].slice(1) + '?',
        'You don\'t need to come down. Ten minutes on the phone with Manuel, and he ships it with training. ' + two[1].charAt(0).toUpperCase() + two[1].slice(1) + '?']);
    for (const o of obj) { p('**' + (es ? o[0] : o[1]) + '**'); S(o[2], o[3]); p(''); }
    N('*Nunca un número, un rango, "como", "desde" ni la página web. Nunca "aprobado por la FDA", "certificado", "permanente" ni "no duele". "Yo conozco a Manuel": igual mándele el resumen a Manuel y anótelo. Stop: márquelo como no llamar en el momento.*',
      '*Never a number, a range, "around", "starting at" or the website. Never "FDA approved", "certified", "permanent" or "painless". "I know Manuel": still WhatsApp Manuel the brief and log it. Stop: mark do-not-call on the spot.*');
    p('');

    // ---- 10. Voicemail ----------------------------------------------------------
    p(es ? '## 10. Buzón de voz (solo el primer intento)' : '## 10. Voicemail (first attempt only)');
    if (local) S('Hola' + hi + ', le habla Remy de Blasón. B-L-A-S-O-N. Los importadores de ' + kindEs + ' en Miami. Le llamo por ' + (nonLaser ? 'las máquinas' : 'la depilación láser') + ' en ' + bizEs + '. Me gustaría ponerle con Manuel, el dueño, en el showroom. Mi número es 786-837-6639. Otra vez, 786-837-6639.',
        'Hi' + hi + ', it\'s Remy with Blason. B-L-A-S-O-N. The ' + kindEn + ' importer in Miami. I\'m calling about ' + (nonLaser ? 'the machines' : 'laser hair removal') + ' at ' + bizEn + '. I\'d like to get you in front of Manuel, the owner, at the showroom. 786-837-6639. Again, 786-837-6639.');
    else S('Hola' + hi + ', le habla Remy de Blasón. B-L-A-S-O-N. Los importadores de ' + kindEs + ' en Miami. Le llamo por ' + (nonLaser ? 'las máquinas' : 'la depilación láser') + ' en ' + bizEs + '. Me gustaría cuadrarle diez minutos por teléfono con Manuel, el dueño. Mi número es 786-837-6639. Otra vez, 786-837-6639.',
        'Hi' + hi + ', it\'s Remy with Blason. B-L-A-S-O-N. The ' + kindEn + ' importer in Miami. I\'m calling about ' + (nonLaser ? 'the machines' : 'laser hair removal') + ' at ' + bizEn + '. I\'d like to set up ten minutes on the phone with Manuel, the owner. 786-837-6639. Again, 786-837-6639.');
    N('*El número dos veces, despacio. Nunca "no es nada urgente". Después del primer buzón, no deje más: correo directo, texto si se lo pidieron, o Instagram.*', '*Number twice, slowly. Never "it\'s nothing urgent". After the first voicemail, no more voicemails: direct email, text if they asked, or Instagram.*');
    p('');

    // ---- 11. After ------------------------------------------------------------
    p(es ? '## 11. Después de cada llamada (30 segundos)' : '## 11. After every call (30 seconds)');
    p(es ? '- Resultado, y una línea con sus palabras. Si llegó al dueño: la palabra del motivo y sus dos números.' : '- Outcome, plus one line in their words. If you reached the owner: the motive word and their two numbers.');
    p(es ? '- Próximo paso **con fecha**. Sin fecha, el lead desaparece.' : '- A **dated** next step. No date means the lead disappears.');
    p(es ? '- Solo recepción: **NO PRESENTADO**, con el nombre de quien contestó y la hora que dio.' : '- Desk-only call: **NOT PITCHED**, with the desk\'s name and the window they gave.');
    p(es ? '- Nunca diga "le mandé el email" antes de mandarlo.' : '- Never say "I sent the email" before you send it.');
    p('');
    p('*Lead ' + lead.id + ' · Script v3 · ' + TODAY + '*');
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
    /blasononline|www\.|https?:/i, /[—–]/, /equipaje/i, /\bstilo\b|\bagency\b|\bAI\b/,
    // v3 (2026-10-01): dead question, the screen-baiting line, claims we can't back, prices out loud.
    /looking to add any|buscando a(ñ|n)adir/i, /thirty seconds|treinta segundos/i, /certifi/i, /\bFDA\b/, /\$\s?\d/];

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
