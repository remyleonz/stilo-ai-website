/**
 * scripts/blason_value_copy.js
 *
 * The Blason "value series": 10 emails, one every 3 days, each teaching a clinic
 * or spa owner ONE useful thing and ending with ONE ask (two showroom times for
 * South Florida, a 10-minute PHONE call with Manuel for everyone else).
 * Sent by send_client_sequence.js --mode value. Written 2026-10-01.
 *
 * Copy lives here, not in the sender, so it can be read and reviewed as copy,
 * and so the validator below can render EVERY combination (step x segment x
 * language x local/remote x name/no-name) before a single send. If any rendered
 * body trips a rule, selfTest() returns the failures and the sender refuses to
 * run, dry or live.
 *
 * Hard rules this file enforces (validateValueCopy):
 *   - no price of any kind: no "$" at all, no price/cost words, no Blason
 *     numbers. The only figures are THEIR session revenue as round illustrative
 *     examples, and market APRs in the payment-plan lesson.
 *   - no FDA, no "certified/approved", no Hialeah, no em/en dash
 *   - no video / Zoom / camera: the out-of-town ask is a PHONE call
 *   - banned AI words and phrases (CLAUDE.md + humanizer)
 *   - 90 to 170 words, at most one exclamation point
 *
 * Segments: 'laser' (laser clinics and anything medical that can fire a laser),
 * 'esthetic' (spas, estheticians, wellness, schools: facial + body machines),
 * 'salon' (salons and everything else: smaller facial + body units).
 */

// Same classifier as scripts/build_blason_scripts_v2.js (that file runs main()
// on require, so it cannot be imported). Keep the two in sync.
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
/** The three copy variants. */
function valueSegment(category) {
    const s = segmentOf(category);
    if (s === 'laser' || s === 'medical') return 'laser';
    if (s === 'esthetic' || s === 'wellness' || s === 'school') return 'esthetic';
    return 'salon';
}

const MAX_VALUE_STEP = 10;
const VALUE_GAP_DAYS = 3;
const SHOWROOM = '3110 W 84th St, Unit 4, Miami, FL 33018';

// ---------------------------------------------------------------------------
// The ask
// ---------------------------------------------------------------------------
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Two concrete showroom times: the 2nd and 3rd business days after the send
 * (Eastern), 11am and 3pm. Far enough out that the owner can plan, close
 * enough that it is a real week. Manuel has to honor these, so the hours live
 * in one place: change SLOT_HOURS if his showroom hours change.
 */
const SLOT_HOURS = ['11am', '3pm'];
function showroomSlots(now, es) {
    const et = new Date(new Date(now || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const days = [];
    const d = new Date(et.getFullYear(), et.getMonth(), et.getDate());
    while (days.length < 3) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) days.push(new Date(d));
    }
    return [days[1], days[2]].map(function (day, i) {
        return es
            ? 'el ' + DAYS_ES[day.getDay()] + ' ' + day.getDate() + ' a las ' + SLOT_HOURS[i]
            : DAYS_EN[day.getDay()] + ', ' + MONTHS_EN[day.getMonth()] + ' ' + day.getDate() + ' at ' + SLOT_HOURS[i];
    });
}

function ask(c, leadIn) {
    const pre = leadIn ? leadIn + ' ' : '';
    if (c.local) {
        return c.es
            ? pre + '¿Le queda bien pasar por el showroom en Miami ' + c.slots[0] + ' o ' + c.slots[1] + '? Con 20 minutos basta.'
            : pre + 'Could you come by the showroom in Miami on ' + c.slots[0] + ' or ' + c.slots[1] + '? Twenty minutes is plenty.';
    }
    return c.es
        ? pre + '¿Tendría 10 minutos para una llamada con Manuel esta semana o la próxima? Dígame el día y yo la cuadro.'
        : pre + "Would you have 10 minutes for a phone call with Manuel this week or next? Tell me the day and I'll set it up.";
}

/** What a hydro-facial / facial machine is called for the two spa variants. */
function faceMachine(c) {
    if (c.seg === 'esthetic') {
        return c.es ? 'una máquina de hidrofacial como la Hidra Acqua Skin' : 'a hydro-facial machine like the Hidra Acqua Skin';
    }
    return c.es ? 'una máquina facial multifunción (la nuestra hace 17 tratamientos en un equipo)'
        : 'a multi-function facial machine (ours runs 17 treatments in one unit)';
}

// ---------------------------------------------------------------------------
// The ten steps. Each returns { s: subject, p: [paragraphs] }. Greeting and
// opt-out are added by composeValue. The last paragraph always holds the ask.
// ---------------------------------------------------------------------------
const STEPS = {};

// 1. You pay twice: once for the machine, once for the logo
STEPS[1] = function (c) {
    const L = c.seg === 'laser';
    if (c.es) {
        return { s: L ? 'el logo de su láser' : 'el logo de su máquina', p: [
            'Algo que muchos dueños aprenden después de su primera compra grande: bastantes ' + (L ? 'láseres' : 'máquinas de estética') + ' de marca famosa salen de las mismas fábricas que otros sin ningún nombre conocido.',
            'Así que con la marca grande paga dos veces: una por la máquina y otra por el logo, el equipo de ventas y la publicidad.' + (L ? '' : ' Y algunas marcas además lo amarran a comprarles sus soluciones para siempre.'),
            'Manuel importa directo de fábrica, así que esa segunda parte no entra en el trato. Usted recibe la máquina, el entrenamiento y el servicio aquí en Miami.',
            ask(c, 'Lo mejor es verlas lado a lado.'),
        ] };
    }
    return { s: L ? 'the logo on your laser' : 'the logo on your machine', p: [
        "Here's something most owners only learn after their first big purchase. Plenty of brand-name " + (L ? 'lasers' : 'aesthetic machines') + ' are built in the same factories as ones that carry no famous name.',
        'So when you buy the big brand, you pay twice: once for the machine and once for the logo, the sales team and the ads that put that name in your head.' + (L ? '' : ' Some brands also lock you into buying their solutions for as long as you own it.'),
        "Manuel imports direct from the factory, so that second part isn't in the deal. You get the machine, training for your team and service right here in Miami.",
        ask(c, 'The easiest way to judge is side by side.'),
    ] };
};

// 2. What one room earns in a year (THEIR number is the variable)
STEPS[2] = function (c) {
    const L = c.seg === 'laser';
    // Round illustrative numbers about THEIR revenue, never Blason's.
    const n = L ? { charge: '150', per: '25', week: '3,750', year: '180,000' } : { charge: '100', per: '20', week: '2,000', year: '96,000' };
    if (c.es) {
        return { s: L ? 'lo que deja una cabina de láser' : 'lo que deja una cabina en un año', p: [
            'Una cuenta que vale la pena hacer con sus números, no con los míos.',
            'Tome lo que cobra por ' + (L ? 'una sesión de depilación láser' : 'un facial') + '. Digamos ' + n.charge + ', solo para tener un número redondo. Si una cabina hace ' + n.per + ' a la semana, son ' + n.week + ' a la semana. En 48 semanas de trabajo, unos ' + n.year + ' de una sola cabina en un año.',
            'Ahora ponga su número real y su conteo real. Casi todos los dueños se sorprenden dos veces: por lo que deja una cabina llena, y por lo que pierden cuando esa cabina está ocupada o la máquina está parada.',
            ask(c, 'Ese es el número contra el que hay que medir cualquier máquina nueva.'),
        ] };
    }
    return { s: L ? 'what one laser room makes in a year' : 'what one room makes in a year', p: [
        "Here's some math worth doing with your own numbers, not mine.",
        'Take what you charge for one ' + (L ? 'laser hair removal session' : 'facial') + ". Say it's " + n.charge + ', just to have a round number. If one room does ' + n.per + " a week, that's " + n.week + ' a week. Over 48 working weeks, about ' + n.year + ' from one room in a year.',
        'Now swap in your real number and your real weekly count. Most owners are surprised twice: once by what one busy room brings in, and again by what they lose when that room is booked or the machine is down.',
        ask(c, "That's the number to hold any new machine up against."),
    ] };
};

// 3. Which machine treats which client
STEPS[3] = function (c) {
    if (c.seg === 'laser') {
        return c.es ? { s: '755, 808 o 1064', p: [
            'Una guía corta de los números de un láser de depilación, porque deciden a qué clientas puede tratar.',
            '755 nm (alejandrita): vello claro y fino, el más difícil para casi todas las máquinas.\n808 nm (diodo): el estándar, para la mayoría de pieles y vellos.\n1064 nm (Nd:YAG): llega más profundo y es la opción segura en piel oscura, Fitzpatrick IV a VI.',
            'Si su láser tiene solo uno, unas clientas tienen un resultado flojo y a otras les tiene que decir que no.',
            'El Scala Ice Galaxy tiene 755, 808, 940 y 1064 en una sola pieza de mano: a nadie en la camilla le dice que no.',
            ask(c, 'Manuel se lo enseña funcionando.'),
        ] } : { s: '755, 808 or 1064', p: [
            'A short guide to the numbers on a hair removal laser, because they decide which clients you can treat.',
            "755 nm (alexandrite): best on light and fine hair, the client most machines struggle with.\n808 nm (diode): the standard for most skin and hair types.\n1064 nm (Nd:YAG): goes deeper, and it's the safe choice on darker skin, Fitzpatrick IV to VI.",
            'If your laser only has one of these, some clients get a weak result and some get turned away.',
            'The Scala Ice Galaxy puts 755, 808, 940 and 1064 in one handpiece, so nobody in the chair gets told no.',
            ask(c, 'Manuel will show it to you running.'),
        ] };
    }
    return c.es ? { s: 'qué máquina para qué clienta', p: [
        'Una guía corta para escoger máquina: empiece por la clienta que ya tiene, no por el catálogo.',
        'La clienta de mantenimiento, con poros tapados y piel apagada: ' + faceMachine(c) + '. Es el facial que repiten cada mes.\nLa que quiere bajar medidas o tensar piel suelta: cavitación con radiofrecuencia.\nLa que quiere tonificar: estimulación muscular.\nTextura y cicatrices de acné: radiofrecuencia con microagujas, pero solo si tiene director médico.',
        'Mire su agenda del último mes y cuente cuál de esas clientas aparece más. Esa es su próxima máquina.',
        ask(c, 'Manuel le dice cuál le sirve a su cabina, y cuál no.'),
    ] } : { s: 'which machine for which client', p: [
        'A short guide to picking a machine: start with the client you already have, not the catalog.',
        'The monthly maintenance client with clogged pores and dull skin: ' + faceMachine(c) + ". It's the facial people rebook every month.\nThe client who wants inches off or loose skin tightened: cavitation with RF.\nThe one who wants toning: muscle stimulation.\nTexture and acne scars: RF microneedling, but only if you have a medical director.",
        'Look at your book for the last month and count which of those clients shows up most. That is your next machine.',
        ask(c, "Manuel will tell you which one fits your room, and which one doesn't."),
    ] };
};

// 4. What your oldest machine is really taking from you
STEPS[4] = function (c) {
    if (c.es) {
        return { s: 'lo que se lleva un día parado', p: [
            'La máquina que más le cuesta es la que está parada, y eso no aparece en ninguna factura.',
            'Cada día que está parada es un día de citas que mueve o pierde. Una reparación casi nunca es de un día: si la pieza viene de otro estado, pueden ser dos o tres semanas. Y la clienta a la que le cambia la cita dos veces, la próxima vez se va a otro lado.',
            'Apunte tres números: días que estuvo parada este año, citas que movió y clientas que no volvió a ver. Casi nadie lo ha sumado.',
            ask(c, 'Si el total le duele, Manuel le dice de frente si conviene arreglarla o cambiarla.'),
        ] };
    }
    return { s: 'what one down day takes', p: [
        "The most expensive machine in your clinic is the one that's down, and that number isn't on any invoice.",
        "Every day it's down is a day of booked sessions you move or lose. Repairs rarely take one day: if the part ships from out of state, it can be two or three weeks. And a client you rebook twice often books somewhere else next time.",
        'Write down three numbers: days it was down this year, sessions you moved, and clients you never saw again. Most owners have never added it up.',
        ask(c, 'If the total stings, Manuel will tell you straight whether to fix it or replace it.'),
    ] };
};

// 5. How to read a payment plan (no lenders named, no Blason numbers)
STEPS[5] = function (c) {
    if (c.es) {
        return { s: 'cómo leer un plan de pagos', p: [
            'Casi todas las máquinas se compran con plan de pagos. Así se lee uno.',
            'No se quede con la cuota mensual. Pida la tasa anual (APR), el plazo y el total pagado al final. A un negocio nuevo o con poco crédito muchas veces le ofrecen del 24% al 35%, y en varios años eso suma casi otra máquina en intereses.',
            'Después revise: ¿el primer mes de sesiones cubre la cuota? Si unos pocos tratamientos la pagan, la máquina se paga sola desde el primer día. Si se lleva el mes entero, el plan o la máquina está mal.',
            'Pregunte por el pago anticipado. Hay planes que cobran intereses que nunca usó.',
            ask(c, ''),
        ] };
    }
    return { s: 'how to read a payment plan', p: [
        "Most machines get bought on a payment plan. Here's how to read one.",
        'Look past the monthly number. Ask for the APR, the term and the total paid at the end. A young business or thin credit often gets quoted 24% to 35%, which over a few years can add up to most of a second machine in interest.',
        'Then check: does the first month of sessions cover the payment? If a few treatments pay it, the machine pays its way from day one. If it eats the whole month, the plan or the machine is wrong.',
        'Ask about early payoff too. Some plans charge interest you never used.',
        ask(c, ''),
    ] };
};

// 6. Florida rules on who can run what (never FDA)
STEPS[6] = function (c) {
    if (c.seg === 'laser') {
        return c.es ? { s: 'quién puede usar cada máquina', p: [
            'Algo que confunde a muchas prácticas en la Florida cuando agregan una máquina: quién puede usarla.',
            'En la Florida, una esteticista no puede operar un láser ni un IPL. Esos tratamientos necesitan un profesional médico en el equipo y un director médico detrás. Contratar una gran esteticista no le pone otro operador de láser en la agenda.',
            'Así que antes de escoger máquina, mire quién está en su equipo y cuántas horas a la semana puede usarla. Un segundo láser sin nadie con licencia para usarlo es un adorno muy caro.',
            ask(c, 'Manuel pregunta esto primero, antes de recomendar nada.'),
        ] } : { s: 'who on your team can run what', p: [
            'Here is something that trips up a lot of Florida practices when they add a machine: who is allowed to run it.',
            "In Florida, an esthetician can't operate a laser or an IPL. Those treatments need a medical professional on staff and a medical director behind them. Hiring a great esthetician doesn't put another laser operator on your schedule.",
            'So before you pick a machine, look at who is actually on staff and how many hours a week they can run it. A second laser with nobody licensed to run it is a very expensive shelf.',
            ask(c, 'Manuel asks about this first, before he recommends anything.'),
        ] };
    }
    return c.es ? { s: 'lo que una esteticista sí puede usar', p: [
        'Antes de comprar su próxima máquina, vale la pena saber qué puede usar legalmente su equipo en la Florida.',
        'En la Florida, una esteticista no puede operar un láser ni un IPL. Eso necesita un director médico. Muchos spas compran uno de esos equipos y después no lo pueden usar.',
        'Lo que sí puede usar todo el día: hidrofaciales, microdermoabrasión, LED y varias máquinas de cuerpo (confirme lo que cubre su licencia). Y si tiene director médico, se abre la radiofrecuencia con microagujas, como la Morfolifting.',
        ask(c, 'Manuel le pregunta quién está en su equipo antes de recomendarle nada.'),
    ] } : { s: 'what an esthetician can legally run', p: [
        "Before you buy your next machine, it's worth knowing what your team can legally run in Florida.",
        "In Florida, an esthetician can't operate a laser or an IPL. Those need a medical director. Plenty of spas buy one of those units and then can't use it.",
        'What you can run all day: hydro-facials, microdermabrasion, LED and a number of body machines (check what your license covers). And if you do have a medical director, RF microneedling like the Morfolifting opens up.',
        ask(c, "Manuel asks who's on your team before he recommends anything."),
    ] };
};

// 7. Local service
STEPS[7] = function (c) {
    if (c.es) {
        return { s: 'cuando una máquina se daña', p: [
            'Toda máquina se daña algún día. Lo que importa es qué pasa a la mañana siguiente.',
            'Con muchas marcas es un menú telefónico, un número de caso y una caja. La máquina se va a otro estado, espera en fila, regresa, y usted pasa semanas sin esa cabina.',
            'Antes de comprar, pregunte tres cosas. ¿Dónde está el técnico más cercano? ¿Las piezas están en la Florida o al otro lado del mundo? ¿Quién entrena a su equipo, y va incluido?',
            'Manuel importa sus máquinas él mismo y les da servicio desde Miami. Entrena a su equipo en la instalación, y cuando algo falla, usted llama a la persona que se la vendió.',
            ask(c, ''),
        ] };
    }
    return { s: 'when a machine breaks', p: [
        'Every machine breaks eventually. What matters is what happens the next morning.',
        "With a lot of brands, it's a phone tree, a ticket number and a box. The machine ships out of state, waits in a queue, ships back, and you're weeks without that room.",
        'Before you buy, ask three things. Where is the nearest technician? Are the parts in Florida or overseas? Who trains your staff, and is that included?',
        'Manuel imports his machines himself and services them from Miami. He trains your team at install, and when something breaks, you call the person who sold it to you.',
        ask(c, ''),
    ] };
};

// 8. The second-room math
STEPS[8] = function (c) {
    const L = c.seg === 'laser';
    if (c.es) {
        return { s: 'la clienta que se fue', p: [
            'Un número que casi ninguna ' + (L ? 'clínica' : 'cabina') + ' apunta: las clientas que se van porque la única máquina está ocupada.',
            'Pruébelo una semana. Cada vez que alguien pide una cita que no le puede dar, haga una rayita. Después multiplique por lo que cobra. ' + (L ? 'Y como una clienta de láser vuelve 6 a 8 veces, lo que se fue no es una sesión, es el paquete completo.' : 'Y como una clienta de facial vuelve cada mes, lo que se fue no es una cita, es un año de citas.'),
            'Una segunda cabina no necesita el doble de personal. Necesita la demanda que ya le sobra. Si su conteo da 5 o más a la semana, vale la pena mirar en serio la segunda máquina: la pagan clientas que ya la están llamando.',
            ask(c, ''),
        ] };
    }
    return { s: 'the client you turned away', p: [
        'Here is a number most ' + (L ? 'clinics' : 'spas') + ' never track: the clients you turn away because the one machine is booked.',
        "Try it for one week. Every time someone asks for a slot you can't give, make a tally mark. Then multiply by what you charge. " + (L ? "And since a laser client comes back 6 to 8 times, what walked out wasn't one session, it was the whole package." : "And since a facial client comes back every month, what walked out wasn't one visit, it was a year of them."),
        "A second room doesn't need double the staff. It needs the overflow you already have. If your tally hits 5 or more a week, a second machine deserves a serious look: it gets paid for by people already calling you.",
        ask(c, ''),
    ] };
};

// 9. Try before you buy
STEPS[9] = function (c) {
    const L = c.seg === 'laser';
    if (c.es) {
        const first = L
            ? 'La mejor forma que conozco de juzgar un láser antes de comprarlo: póngase la pieza de mano en su propio brazo. Va a sentir el enfriamiento, oír qué tan ruidoso es, ver qué tan rápido cubre un área y cómo queda la piel después. Un folleto no le dice nada de eso.'
            : 'La mejor forma que conozco de juzgar una máquina antes de comprarla: pruébela en su propia piel. Va a sentir la succión, el calor, qué tan cómoda es para la clienta y cómo queda la piel después. Un folleto no le dice nada de eso.';
        return { s: L ? 'pruébelo en su propio brazo' : 'pruébela en su propia piel', p: [first,
            c.local
                ? 'Las máquinas están montadas y funcionando en el showroom de Manuel: ' + SHOWROOM + '. Traiga a quien la va a usar para que la pruebe también. Sale con respuestas claras.'
                : 'Si alguna vez viene a Miami, las máquinas están funcionando en el showroom de Manuel: ' + SHOWROOM + '. Mientras tanto, lo más parecido es hablar con Manuel: le dice exactamente qué revisar cuando pruebe cualquier máquina, la suya o la de otro.',
            ask(c, ''),
        ] };
    }
    const first = L
        ? "Here is the best way I know to judge a laser before you buy it: put the handpiece on your own arm. You feel the cooling, hear how loud it runs, see how fast it covers an area and how your skin looks after. A brochure can't tell you any of that."
        : "Here is the best way I know to judge a machine before you buy it: try it on your own skin. You feel the suction, the heat, how comfortable it is for a client and how your skin looks after. A brochure can't tell you any of that.";
    return { s: L ? 'try it on your own arm' : 'try it on your own skin', p: [first,
        c.local
            ? "The machines are set up and running at Manuel's showroom: " + SHOWROOM + '. Bring whoever will run it, so they can try it too. You walk out with straight answers.'
            : "If you're ever in Miami, the machines are running at Manuel's showroom: " + SHOWROOM + ". Until then, the next best thing is a call with Manuel. He'll tell you exactly what to check when you test any machine, his or anyone else's.",
        ask(c, ''),
    ] };
};

// 10. Close-out. The ask here IS the yes/no, and "close" doubles as the opt-out.
STEPS[10] = function (c) {
    const L = c.seg === 'laser';
    if (c.es) {
        return { s: '¿cierro su expediente?', noOpt: true, p: [
            'Le he mandado varias notas sobre ' + (L ? 'láseres' : 'máquinas de cara y cuerpo') + ' en estas últimas semanas y no quiero seguir llenándole la bandeja de entrada.',
            'Así que se lo pregunto directo: ¿cierro su expediente?',
            'Si es que sí, responda "cerrar" y no le escribo más.\nSi una máquina nueva está en la lista para más adelante, responda "después" y le escribo una sola vez, cuando usted me diga.\nY si quiere ' + (c.local ? 'ver una funcionando en el showroom de Miami' : 'hablar 10 minutos por teléfono con Manuel') + ', responda "sí" y lo cuadro.',
            'De cualquier forma, gracias por leer estas notas. Sé que su tiempo vale, y no lo quiero gastar.',
        ] };
    }
    return { s: 'should I close your file?', noOpt: true, p: [
        "I've sent you a few notes about " + (L ? 'lasers' : 'facial and body machines') + " over the last few weeks, and I don't want to keep filling your inbox.",
        'So, a straight question: should I close your file?',
        "If yes, just reply \"close\" and you won't hear from me again.\nIf a new machine is on the list for later, reply \"later\" and I'll check back once, when you say.\nAnd if you'd like to " + (c.local ? 'see one running at the showroom in Miami' : 'talk to Manuel for 10 minutes by phone') + ', reply "yes" and I\'ll set it up.',
        'Either way, thanks for reading these. I know your time is worth something.',
    ] };
};

const OPT_EN = "If you'd rather not get these, just reply stop.";
const OPT_ES = 'Si prefiere no recibir más, solo responda "no".';

/** c = { es, seg, local, fn, slots }  ->  { subject, body, arm } */
function composeValue(step, c) {
    if (!STEPS[step]) throw new Error('no value step ' + step);
    const t = STEPS[step](c);
    const hi = c.es ? (c.fn ? 'Hola ' + c.fn + ',' : 'Hola,') : (c.fn ? 'Hi ' + c.fn + ',' : 'Hi,');
    const paras = [hi].concat(t.p.map(function (x) { return String(x).trim(); }).filter(Boolean));
    if (!t.noOpt) paras.push(c.es ? OPT_ES : OPT_EN);
    return { subject: t.s, body: paras.join('\n\n'), arm: 'v' + step + '_' + c.seg };
}

// ---------------------------------------------------------------------------
// Validation. Runs on every rendered body before send, and on every template
// combination at startup (selfTest).
// ---------------------------------------------------------------------------
const BANNED_WORDS = ['delve', 'leverage', 'utilize', 'streamline', 'optimize', 'facilitate', 'foster', 'robust',
    'comprehensive', 'seamless', 'cutting-edge', 'innovative', 'transformative', 'holistic', 'pivotal', 'nuanced',
    'multifaceted', 'game-changer', 'unlock', 'elevate'];
const BANNED_PHRASES = ['quick question', 'pregunta rápida', 'pregunta rapida', 'just checking in',
    'i hope this email finds you well', "in today's", 'in today’s', "it's worth noting", 'it’s worth noting',
    'furthermore', 'moreover', 'in conclusion', 'thirty seconds', 'certifi', 'certific', 'fda', 'hialeah',
    'approved', 'aprobad', 'guarantee', 'garantiza', 'clinical-grade', 'video', 'zoom', 'camera', 'cámara', 'camara',
    'stilo', 'testimonial'];
function wordCount(s) { return String(s).split(/\s+/).filter(function (w) { return /[\p{L}\p{N}]/u.test(w); }).length; }

function validateValueCopy(subject, body) {
    const t = (subject + '\n' + body);
    const low = t.toLowerCase();
    const fails = [];
    for (const w of BANNED_WORDS) if (new RegExp('\\b' + w.replace(/-/g, '[- ]'), 'i').test(t)) fails.push('banned word: ' + w);
    for (const p of BANNED_PHRASES) if (low.includes(p)) fails.push('banned phrase: ' + p);
    if (/\$\s*\d/.test(t)) fails.push('dollar figure');
    else if (/\$/.test(t)) fails.push('dollar sign');
    if (/\b(price|prices|pricing|costs?|precios?|costos?)\b/i.test(t)) fails.push('price word');
    if (/starting at|a partir de/i.test(t)) fails.push('starting-at');
    if (/[—–]/.test(t)) fails.push('em or en dash');
    if (/\s-\s/.test(t)) fails.push('spaced hyphen used as a dash');
    if (/https?:\/\/|www\./i.test(t)) fails.push('link');
    if (/\bundefined\b|\bnull\b|NaN|Hi ,|Hola ,/.test(t)) fails.push('broken merge');
    if ((t.match(/!/g) || []).length > 1) fails.push('more than one exclamation point');
    const wc = wordCount(body);
    if (wc < 90 || wc > 170) fails.push('word count ' + wc + ' (90 to 170)');
    if (subject.length > 45) fails.push('subject too long');
    return fails;
}

/**
 * Render every combination and return the failures. `finish` lets the sender
 * pass its addSpecial() so the date-gated special line is part of what is
 * checked on the days it is live.
 */
function selfTest(finish) {
    const out = [];
    const now = Date.now();
    const subjects = { en: new Set(), es: new Set() };
    for (let step = 1; step <= MAX_VALUE_STEP; step++) {
        for (const seg of ['laser', 'esthetic', 'salon']) {
            for (const es of [false, true]) {
                for (const local of [true, false]) {
                    for (const fn of [null, 'Maria']) {
                        const c = { es: es, seg: seg, local: local, fn: fn, slots: showroomSlots(now, es) };
                        let r = composeValue(step, c);
                        const cat = seg === 'laser' ? 'Medical spa' : seg === 'esthetic' ? 'Day spa' : 'Beauty salon';
                        if (finish) r = finish(r, { category: cat, primary_language: es ? 'es' : 'en' }, es);
                        const f = validateValueCopy(r.subject, r.body);
                        if (f.length) out.push('step ' + step + ' ' + seg + ' ' + (es ? 'es' : 'en') + ' ' + (local ? 'local' : 'remote') + (fn ? ' named' : '') + ': ' + f.join('; '));
                        if (seg === 'laser' && local && !fn) subjects[es ? 'es' : 'en'].add(r.subject);
                    }
                }
            }
        }
    }
    for (const k of ['en', 'es']) if (subjects[k].size !== MAX_VALUE_STEP) out.push('subjects not unique per step (' + k + ')');
    return out;
}

module.exports = {
    MAX_VALUE_STEP, VALUE_GAP_DAYS, SHOWROOM,
    segmentOf, valueSegment, showroomSlots, composeValue, validateValueCopy, selfTest, wordCount,
};
