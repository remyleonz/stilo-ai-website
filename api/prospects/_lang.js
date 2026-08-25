/**
 * Outbound copy, per language, in ONE place.
 *
 * WHY THIS EXISTS
 * ---------------
 * leads.primary_language has been populated since 2026-07 (OpenPhone webhook
 * detects it off the call transcript, backfill_durations_and_language.js filled
 * the history). Until now NOTHING read it for outbound copy: it was written,
 * indexed, shown on the brief, and then ignored by every sender.
 *
 * The result shipped to a real prospect. Manuel Junco at Blason Spa Equipment is
 * primary_language='es', his entire discovery call was in Spanish, and on
 * 2026-08-11 he was sent two ENGLISH VSL emails and an ENGLISH SMS asking him to
 * go watch an English video. He never opened it. We then wondered why the VSL
 * wasn't being watched.
 *
 * A Spanish-speaking owner who cannot read the email cannot confirm the meeting,
 * cannot watch the video, and shows up cold or not at all. So every message that
 * reaches a prospect resolves its language from the lead, right here.
 *
 * HOW TO USE
 * ----------
 *   const { langForLead, t, fmtWhen, LANG_COL } = require('./_lang');
 *   // 1. add LANG_COL to your .select() so the lead actually carries the field
 *   // 2. const lang = langForLead(ld);
 *   // 3. const sms = t(lang, 'dayBeforeSms', { first, biz });
 *
 * ADDING A TEMPLATE
 * -----------------
 * Add both languages at once. A key with only an `en` entry silently sends
 * English to a Spanish speaker, which is the exact bug this module exists to
 * stop, so `t()` throws in that case rather than falling back quietly.
 */

// The column every sender must include in its select. Exported as a constant so
// a new sender greps for it and cannot forget.
const LANG_COL = 'primary_language';

const SUPPORTED = ['en', 'es'];

/**
 * Resolve a lead to 'en' or 'es'.
 *
 * Anything we do not have copy for resolves to English on purpose. Half-translated
 * output reads worse than a consistent English message, and it is the state we
 * can actually support today.
 */
function langForLead(lead) {
    const raw = String((lead && lead[LANG_COL]) || '').trim().toLowerCase();
    if (!raw) return 'en';
    const base = raw.split(/[-_]/)[0];
    return SUPPORTED.indexOf(base) !== -1 ? base : 'en';
}

function isEs(lead) { return langForLead(lead) === 'es'; }

// ---------------------------------------------------------------------------
// Dates. A Spanish email carrying "Tuesday, August 18 at 11:00 AM EDT" is still
// an English email to the person reading it.
// ---------------------------------------------------------------------------

const TZ = 'America/New_York';
const LOCALE = { en: 'en-US', es: 'es-US' };

function fmtWhen(iso, lang) {
    if (!iso) return lang === 'es' ? 'la hora que acordamos' : 'the time we set';
    return new Intl.DateTimeFormat(LOCALE[lang] || LOCALE.en, {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: TZ,
    }).format(new Date(iso));
}

function fmtDay(iso, lang) {
    if (!iso) return lang === 'es' ? 'el día acordado' : 'the day we set';
    return new Intl.DateTimeFormat(LOCALE[lang] || LOCALE.en, {
        weekday: 'long', month: 'long', day: 'numeric', timeZone: TZ,
    }).format(new Date(iso));
}

function fmtTime(iso, lang) {
    if (!iso) return lang === 'es' ? 'la hora acordada' : 'the time we set';
    return new Intl.DateTimeFormat(LOCALE[lang] || LOCALE.en, {
        hour: 'numeric', minute: '2-digit', timeZone: TZ,
    }).format(new Date(iso));
}

// ---------------------------------------------------------------------------
// Copy
//
// Every entry is a function of the template vars so the two languages can put
// the name, the business and the date wherever their own grammar needs them,
// rather than being forced through one English sentence shape.
//
// Spanish uses "usted" throughout. These are business owners, most of them older
// than the rep calling them, and several are Cuban Miami. "Tú" reads as a kid
// who wants something.
// ---------------------------------------------------------------------------

const COPY = {

    // -- confirmation email (_confirmation_email.js) --------------------------
    confirmSubject: {
        en: function (v) {
            if (!v.whenIso) return 'You are booked, quick confirm';
            return 'You are booked, quick confirm for ' + fmtDay(v.whenIso, 'en');
        },
        es: function (v) {
            if (!v.whenIso) return 'Quedó agendado, confirme por favor';
            return 'Quedó agendado para el ' + fmtDay(v.whenIso, 'es') + ', confirme por favor';
        },
    },

    confirmBody: {
        en: function (v) {
            return [
                'Hi ' + v.first + ',',
                '',
                'You are on the calendar for ' + fmtWhen(v.whenIso, 'en') + '.',
                '',
                'Confirm you are still good here. Same page has a short walkthrough of exactly how we '
                    + 'fill a calendar for a business like ' + v.biz + ', so you can see what '
                    + 'we will actually be talking about:',
                v.link,
                '',
                'Cannot make it? Just reply and we will find a better time.',
                '',
                'See you then,',
                v.rep,
                'STILO AI Partners',
            ].join('\n');
        },
        es: function (v) {
            return [
                'Hola ' + v.first + ',',
                '',
                'Lo tengo agendado para el ' + fmtWhen(v.whenIso, 'es') + ', hora de Miami.',
                '',
                'Confírmeme aquí que sigue en pie. En esa misma página hay un video corto donde le '
                    + 'explico exactamente cómo le llenamos el calendario de reuniones a un negocio '
                    + 'como ' + v.biz + ', para que sepa de qué vamos a hablar:',
                v.link,
                '',
                'Si ya no puede, respóndame a este correo y buscamos otra hora.',
                '',
                'Nos vemos,',
                v.rep,
                'STILO AI Partners',
            ].join('\n');
        },
    },

    // -- VSL confirm email (_vsl.js) -----------------------------------------
    vslConfirmSubject: {
        en: function (v) { return 'Quick confirm for our call, ' + v.first; },
        es: function (v) { return 'Confírmeme la reunión, ' + v.first; },
    },

    vslConfirmBody: {
        en: function (v) {
            return [
                'Hi ' + v.first + ',',
                '',
                'Good talking with you. I have us down for ' + fmtWhen(v.whenIso, 'en') + '.',
                '',
                'One quick thing so I know you are still good for it. Confirm here, and the same page has a '
                    + 'short video of me running through exactly what happens on the call, how we charge, and '
                    + 'who you are actually dealing with:',
                v.confirmUrl,
                '',
                'Worth three minutes before we talk. It means we can skip the background and spend our time on '
                    + v.biz + '.',
                '',
                'Cannot make it anymore? Just reply and we will find a better time.',
                '',
                'Talk soon,',
                v.sender,
                'STILO AI Partners',
            ].join('\n');
        },
        es: function (v) {
            return [
                'Hola ' + v.first + ',',
                '',
                'Un gusto hablar con usted. Quedamos para el ' + fmtWhen(v.whenIso, 'es') + ', hora de Miami.',
                '',
                'Una cosa rápida para saber que sigue en pie. Confírmeme aquí. En esa misma página hay un '
                    + 'video corto donde le explico qué pasa exactamente en la reunión, cómo cobramos, y con '
                    + 'quién está tratando:',
                v.confirmUrl,
                '',
                'Son tres minutos y valen la pena. Así no perdemos la reunión en explicarle lo básico y la '
                    + 'usamos completa en ' + v.biz + '.',
                '',
                'Si ya no puede, respóndame y buscamos otra hora.',
                '',
                'Hablamos,',
                v.sender,
                'STILO AI Partners',
            ].join('\n');
        },
    },

    // -- SMS after they watch the VSL (send-vsl-followup.js) ------------------
    vslFollowupSms: {
        en: function (v) {
            return 'Glad you got a chance to watch the video. I hope it gave you an idea of how we can help your business. '
                + 'I\'ve got you down for ' + v.day + ' at ' + v.time + '. '
                + 'The meeting will explain exactly how we can make you money and answer any questions you may have. Talk soon.';
        },
        es: function (v) {
            return 'Qué bueno que pudo ver el video. Espero que le haya dado una idea de cómo le podemos ayudar. '
                + 'Lo tengo agendado para el ' + v.day + ' a las ' + v.time + '. '
                + 'En la reunión le explico exactamente cómo le vamos a traer más ventas y le contesto lo que tenga. Hablamos.';
        },
    },

    // -- SMS the day before (send-day-before.js) -----------------------------
    dayBeforeSms: {
        en: function (v) {
            return v.greet + 'looking forward to the meeting tomorrow. '
                + 'I had a deep look at ' + v.biz + ' with my team, and we have a plan set that you will find valuable. '
                + 'Anything in particular you want me and my team to look at before the meeting?';
        },
        es: function (v) {
            return v.greet + 'con ganas de la reunión de mañana. '
                + 'Estuve revisando ' + v.biz + ' con mi equipo y le tenemos un plan que le va a servir. '
                + '¿Hay algo en particular que quiere que revisemos antes de la reunión?';
        },
    },

    // -- T-15 reminder, SMS + email (send-meeting-reminders.js) --------------
    // v.company: whose name the rep is calling under. 'STILO' for our own
    // pipeline; the CLIENT's business name for client-account leads (a rep
    // dialing for Blason says Blason, never STILO — the prospect has never
    // heard of STILO and the meeting is with the client's owner).
    reminderSms: {
        en: function (v) {
            var co = v.company || 'STILO';
            return v.meet
                ? 'Hi ' + v.first + ', ' + v.rep + ' from ' + co + '. Our meeting is at ' + v.time + ', about 15 min out. Join here: ' + v.meet
                : 'Hi ' + v.first + ', ' + v.rep + ' from ' + co + '. Our meeting is at ' + v.time + ', about 15 min out. I\'ll call you then.';
        },
        es: function (v) {
            var co = v.company || 'STILO';
            return v.meet
                ? 'Hola ' + v.first + ', habla ' + v.rep + ' de ' + co + '. Nuestra reunión es a las ' + v.time + ', como en 15 minutos. Entre por aquí: ' + v.meet
                : 'Hola ' + v.first + ', habla ' + v.rep + ' de ' + co + '. Nuestra reunión es a las ' + v.time + ', como en 15 minutos. Lo llamo a esa hora.';
        },
    },

    reminderEmailSubject: {
        en: function (v) { return 'Your ' + ((v && v.company) || 'STILO') + ' meeting starts in ~15 minutes'; },
        es: function (v) { return 'Su reunión con ' + ((v && v.company) || 'STILO') + ' empieza en ~15 minutos'; },
    },

    // The join line is built by the caller (it differs when there is no Meet
    // link) and spliced in as its own paragraph, so the URL sits alone on a line
    // and survives every mail client.
    reminderEmailJoin: {
        en: function (v) {
            return v.meet ? ['Join here:', v.meet] : [v.rep + ' will call you at the number on file.'];
        },
        es: function (v) {
            return v.meet ? ['Entre por aquí:', v.meet] : [v.rep + ' lo va a llamar al número que tenemos.'];
        },
    },

    reminderEmailBody: {
        en: function (v) {
            var co = v.company || 'STILO';
            var sig = v.companyFull || (v.company ? v.company : 'STILO AI Partners');
            return [
                'Hi ' + v.first + ',',
                '',
                'Quick reminder, your meeting with ' + co + ' is at ' + v.time + ', about 15 minutes from now.',
                '',
            ].concat(v.joinLines).concat([
                '',
                'Running late or need to move it? Just reply here.',
                '',
                'See you shortly,',
                v.rep,
                sig,
            ]).join('\n');
        },
        es: function (v) {
            var co = v.company || 'STILO';
            var sig = v.companyFull || (v.company ? v.company : 'STILO AI Partners');
            return [
                'Hola ' + v.first + ',',
                '',
                'Un recordatorio rápido, su reunión con ' + co + ' es a las ' + v.time + ', como en 15 minutos.',
                '',
            ].concat(v.joinLines).concat([
                '',
                '¿Se le hizo tarde o necesita moverla? Respóndame aquí mismo.',
                '',
                'Nos vemos ahorita,',
                v.rep,
                sig,
            ]).join('\n');
        },
    },

    // -- no-show follow-up (noshow-email.js) ---------------------------------
    noshowSubject: {
        en: function () { return 'Did we miss each other?'; },
        es: function () { return '¿No nos pudimos conectar?'; },
    },

    noshowBody: {
        en: function (v) {
            const whenStr = v.whenIso ? new Intl.DateTimeFormat('en-US', {
                weekday: 'long', month: 'long', day: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZone: TZ,
            }).format(new Date(v.whenIso)) : null;
            return [
                'Hi ' + v.first + ',',
                '',
                'We had a call on the calendar' + (whenStr ? ' for ' + whenStr : '') + ' but I do not think we connected. No problem at all, things come up.',
                '',
                'Did something get in the way, or is the timing just off right now? If you are still up for it, you can grab a new time that works better here:',
                '',
                v.link,
                '',
                'It is fifteen minutes on where the next customers for ' + v.biz + ' are going to come from, and what it would take to put more of them on your calendar. If now is not the moment, just reply and tell me, no pressure either way.',
                '',
                'Talk soon,',
                v.sender,
                'STILO AI Partners',
                'stiloaipartners.com',
            ].join('\n');
        },
        es: function (v) {
            const whenStr = v.whenIso ? new Intl.DateTimeFormat('es-US', {
                weekday: 'long', month: 'long', day: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZone: TZ,
            }).format(new Date(v.whenIso)) : null;
            return [
                'Hola ' + v.first + ',',
                '',
                'Teníamos una llamada' + (whenStr ? ' el ' + whenStr : '') + ' y creo que no nos pudimos conectar. No hay ningún problema, esas cosas pasan.',
                '',
                '¿Se le atravesó algo, o simplemente no es el momento? Si todavía le interesa, aquí puede agarrar la hora que mejor le sirva:',
                '',
                v.link,
                '',
                'Son quince minutos sobre de dónde van a salir los próximos clientes de ' + v.biz + ', y qué haría falta para ponerle más de ellos en el calendario. Si ahora no es el momento, respóndame y dígamelo, sin compromiso.',
                '',
                'Hablamos,',
                v.sender,
                'STILO AI Partners',
                'stiloaipartners.com',
            ].join('\n');
        },
    },

    // -- nurture value fallbacks (_nurture_value.js) -------------------------
    // Only the wrappers. The substance (facts.how / facts.proof) is generated
    // or comes from AGENT_FACTS, and is handled by the prompt instruction below.
    nurtureQuickThought: {
        en: function (v) {
            return 'Hey' + (v.who ? ' ' + v.who : '') + ', ' + v.sender + ' from STILO. One thought before we talk: '
                + v.proof.toLowerCase() + ' Does that match how you\'d judge it?';
        },
        es: function (v) {
            return 'Hola' + (v.who ? ' ' + v.who : '') + ', habla ' + v.sender + ' de STILO. Una idea antes de que hablemos: '
                + v.proof.toLowerCase() + ' ¿Así es como usted lo mediría?';
        },
    },

    nurtureWhatToExpect: {
        en: function (v) {
            return 'Morning' + (v.who ? ' ' + v.who : '') + '. Quick note on today: about 20 minutes, I\'ll show you the '
                + v.label + ' running live, and we\'ll work out what it\'s worth for ' + v.biz
                + ' using your numbers. You\'ll leave with a straight answer either way.';
        },
        es: function (v) {
            return 'Buenos días' + (v.who ? ' ' + v.who : '') + '. Una nota rápida sobre hoy: son unos 20 minutos, le muestro '
                + v.label + ' funcionando en vivo, y sacamos juntos cuánto vale para ' + v.biz
                + ' con los números suyos. Sale de ahí con una respuesta clara de todas maneras.';
        },
    },

    // Subject lines for the four long-form nurture emails. The bodies come out of
    // Gemini, but the subject is picked in code, so it needs its own translation
    // or a Spanish email arrives under an English subject.
    nurtureSubject: {
        en: function (v) {
            const s = {
                how_it_works: 'How the ' + v.label + ' actually works',
                the_numbers: 'What the numbers usually look like',
                use_case: v.biz ? 'What this looks like for ' + v.biz : 'What this looks like for your business',
                objection_prehandle: 'The part people usually push back on',
            };
            return s[v.stepKey] || 'Before our call';
        },
        es: function (v) {
            const s = {
                how_it_works: 'Cómo funciona ' + v.label + ' en la práctica',
                the_numbers: 'Cómo suelen ser los números',
                use_case: v.biz ? 'Cómo se ve esto para ' + v.biz : 'Cómo se ve esto para su negocio',
                objection_prehandle: 'La parte que casi siempre cuestionan',
            };
            return s[v.stepKey] || 'Antes de nuestra reunión';
        },
    },

    // Appended to the Gemini prompt. The model writes the whole touch, so the
    // cheapest correct fix is to tell it which language to write in. Explicit
    // about register because "write in Spanish" alone produced neutral textbook
    // Spanish that reads translated.
    nurturePromptLang: {
        en: function () { return ''; },
        es: function () {
            return [
                '',
                'LANGUAGE: Write this entire message in Spanish. The recipient is a business owner in Miami '
                    + 'who does business in Spanish.',
                '- Use "usted", never "tu". These are owners, often older than the sender.',
                '- Write Latin American / Miami business Spanish, not Castilian. No "vosotros", no "os".',
                '- It must read as though it were written in Spanish, not translated out of English. '
                    + 'If a phrase only makes sense as a translation of an English idiom, replace it.',
                '- Keep proper nouns as-is: the business name, STILO AI Partners, and any product names.',
                '- Accents and punctuation must be correct, including the opening signs on questions.',
            ].join('\n');
        },
    },
};

/**
 * t(lang, key, vars) -> string
 *
 * Throws on a missing key or a missing language. That is deliberate. The failure
 * mode this module exists to prevent is a Spanish speaker silently receiving
 * English, so a template that forgot its `es` entry must break in staging rather
 * than quietly ship the thing we are trying to fix.
 */
function t(lang, key, vars) {
    const entry = COPY[key];
    if (!entry) throw new Error('[_lang] unknown copy key: ' + key);
    const l = SUPPORTED.indexOf(lang) !== -1 ? lang : 'en';
    const fn = entry[l];
    if (typeof fn !== 'function') {
        throw new Error('[_lang] copy key "' + key + '" has no "' + l + '" variant');
    }
    return fn(vars || {});
}

module.exports = {
    LANG_COL, SUPPORTED, langForLead, isEs, t, COPY,
    fmtWhen, fmtDay, fmtTime,
};
