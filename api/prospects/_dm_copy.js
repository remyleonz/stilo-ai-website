/**
 * api/prospects/_dm_copy.js
 *
 * The ONE place the Instagram / Facebook DM copy lives (the importer, the
 * queue builder and the language toggle in the dashboard all call this).
 * Rules (Remy, 2026-10-08): one sentence per opener, two max on the follow-up,
 * nobody introduces themselves by name (they see the profile), Blason named
 * once in message two, no link in message one, the video link in message two.
 *
 *   arm A: "hey" / "hola" (+ verified first name), then the $80,000 line + video
 *   arm B: which laser is {Business} using, then same-factories + video
 */
const VSL = 'https://blasononline.stiloaipartners.com';

function dmCopy(row, arm, lang) {
    const es = (lang || row.lang) === 'es';
    const fn = String(row.first_name || '').trim();
    const biz = String(row.business || '').trim() || (es ? 'la clínica' : 'the clinic');
    const link = row.vsl_link || (VSL + '?utm_source=' + (row.channel === 'facebook' ? 'facebook' : 'instagram') + '&utm_campaign=vsl' + (es ? '&lang=es' : ''));
    if (arm === 'A') return {
        message_1: es ? (fn ? 'hola ' + fn : 'hola') : (fn ? 'hey ' + fn : 'hey'),
        message_2: es ? 'una rápida, la mayoría de las clínicas en Miami pagaron dos veces por su láser, una por la máquina y otra por el logo, yo le digo el error de $80,000. 4 min de cómo evitarlo: ' + link
                      : 'quick one, most clinics in Miami paid twice for their laser, once for the machine and once for the logo, I call it the $80,000 mistake. 4 min on how to skip it: ' + link,
    };
    return {
        message_1: es ? '¿qué láser están usando en ' + biz + ' para depilación?' : 'which laser is ' + biz + ' using for hair removal right now?',
        message_2: es ? 'ese sale de las mismas fábricas que los nuestros, solo que se paga dos veces, una por la máquina y otra por el logo. el error de $80,000, 4 min de cómo evitarlo: ' + link
                      : 'that one comes out of the same factories as ours, you just pay twice, once for the machine and once for the logo. the $80,000 mistake, 4 min on how to skip it: ' + link,
    };
}

/** STILO (new-client) DM copy: we sell booked meetings and sales, never "AI". */
function stiloDmCopy(row, arm, lang) {
    const es = (lang || row.lang) === 'es';
    const fn = String(row.first_name || '').trim();
    const biz = String(row.business || '').trim() || (es ? 'su empresa' : 'your company');
    if (arm === 'A') return {
        message_1: es ? (fn ? 'hola ' + fn : 'hola') : (fn ? 'hey ' + fn : 'hey'),
        message_2: es ? 'una rápida, ¿quién en ' + biz + ' se encarga de conseguir clientes nuevos, usted o alguien del equipo?' : 'quick one, who at ' + biz + ' is in charge of bringing in new accounts, you or someone on the team?',
    };
    return {
        message_1: es ? '¿cuántos clientes nuevos al mes le entran a ' + biz + ' ahora mismo?' : 'how many new accounts a month is ' + biz + ' bringing in right now?',
        message_2: es ? 'pregunto porque nosotros ponemos reuniones con compradores en la agenda de empresas como la suya, y solo cobramos cuando se cierra. ¿vale una llamada de 10 minutos?' : 'asking because we put buyer meetings on the calendar for companies like yours and only get paid when it closes. worth a 10-minute call?',
    };
}

module.exports = { dmCopy, stiloDmCopy, VSL };
