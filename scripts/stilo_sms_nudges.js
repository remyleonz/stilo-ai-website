/**
 * scripts/stilo_sms_nudges.js
 *
 * Fills the follow-up texts (steps 2 to 5) for STILO's own warm SMS campaign
 * (campaign 2, "Warm follow-up, already called"). The Blason campaign has had
 * this since 9/15 (scripts/blason_copy_templates.js); STILO never did, so 385
 * people who got a first text and went quiet never heard from us again.
 *
 * Who gets one: targets in stage 'sent' (a first text went out, no reply).
 * outbound-tick sends each step once the gap has passed (3, 3, 7, 14 days,
 * see _outbound.js nudgeGapDays) and caps volume per line and per day.
 *
 * Which line: the target's ORIGINAL line, always. Remy owns every Quo line
 * (Remy, 2026-09-29: "none of the numbers are inactive, I just don't have a
 * hired rep for them, but I am still on them"), so the thread stays on the
 * number that sent the first text and volume spreads across all of them.
 *
 * Copy: no name (the first text already introduced the rep, and the line may
 * no longer have that rep), no company name (on STILO's book the opener works
 * by sounding like a person), no price, no AI language, no link. Two wordings
 * per step picked by target id so a group of businesses does not get identical
 * texts. Language follows leads.primary_language.
 *
 * The promise guard: any target that already received a text saying it was the
 * last one is never filled again. No body means the tick cannot send.
 *
 * Usage: node scripts/stilo_sms_nudges.js         (fill)
 *        node scripts/stilo_sms_nudges.js --dry   (print, write nothing)
 */
const fs = require('fs');
const path = require('path');
try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { copyGate } = require(path.join(__dirname, '..', 'api/prospects/_shared.js'));
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'prospecting', 'Content-Profile': 'prospecting', 'Content-Type': 'application/json' };
const DRY = process.argv.includes('--dry');
const CAMPAIGN = 2;

const PROMISED = /last (one|text|note|message) from me|last one, promise|último (mensaje|texto)/i;
const NUDGES = {
    2: {
        en: [
            "Hey, me again. Quick one: are you taking on more work right now, or is the calendar pretty full?",
            "Hey, following up on my text. Are you looking for more customers this season, or are you booked up?",
        ],
        es: [
            'Hola, soy yo otra vez. Una pregunta rápida: ¿están buscando más trabajo ahora, o tienen el calendario lleno?',
            'Hola, dándole seguimiento a mi mensaje. ¿Buscan más clientes esta temporada, o están bien llenos?',
        ],
    },
    3: {
        en: [
            "Hey, one more thought. We find local companies that need what you do and put them on your calendar. You just show up and close. Worth a quick call this week?",
            "Hey, the short version of what we do: we line up meetings with businesses that need your service, and you close them. Is that something you'd use right now?",
        ],
        es: [
            'Hola, una idea más. Encontramos empresas locales que necesitan lo que usted hace y se las ponemos en su calendario. Usted solo llega y cierra. ¿Vale la pena una llamada corta esta semana?',
            'Hola, en corto lo que hacemos: le conseguimos reuniones con negocios que necesitan su servicio, y usted las cierra. ¿Le serviría ahora?',
        ],
    },
    4: {
        en: [
            "Hey, curious: what kind of customer do you wish you had more of? Even a rough answer tells me if we can help.",
            "Hey, quick question. If you could add one steady account this quarter, what kind of business would it be?",
        ],
        es: [
            'Hola, por curiosidad: ¿de qué tipo de cliente le gustaría tener más? Aunque sea una idea, me dice si le podemos ayudar.',
            'Hola, una pregunta. Si pudiera sumar una cuenta fija este trimestre, ¿qué tipo de negocio sería?',
        ],
    },
    5: {
        en: [
            "Hey, last text from me so I don't bug you. If more booked meetings ever sounds good, just text me back here. And if you'd rather not hear from me, reply stop.",
        ],
        es: [
            'Hola, este es mi último mensaje para no molestarle. Si algún día le interesa tener más reuniones agendadas, me escribe por aquí. Y si prefiere que no le escriba, responda stop.',
        ],
    },
};

(async function main() {
    let filled = 0, promised = 0, bad = 0;
    for (const step of [2, 3, 4, 5]) {
        const col = 'step' + step + '_body';
        const r = await fetch(URL_ + '/rest/v1/outbound_targets?campaign_id=eq.' + CAMPAIGN + '&stage=eq.sent&step=eq.' + (step - 1)
            + '&first_reply_at=is.null&' + col + '=is.null&select=id,lead_id,step1_body,step2_body,step3_body,step4_body&order=id&limit=1000', { headers: H });
        const rows = await r.json();
        if (!Array.isArray(rows)) { console.log('read failed step ' + step, rows); continue; }
        let n = 0;
        for (const t of rows) {
            if ([t.step1_body, t.step2_body, t.step3_body, t.step4_body].some(function (b) { return PROMISED.test(b || ''); })) { promised++; continue; }
            const lr = await fetch(URL_ + '/rest/v1/leads?id=eq.' + t.lead_id + '&select=primary_language', { headers: H });
            const es = ((await lr.json())[0] || {}).primary_language === 'es';
            const bank = NUDGES[step][es ? 'es' : 'en'];
            const body = bank[t.id % bank.length];
            if (copyGate(body) || /[—–]/.test(body) || /stilo/i.test(body) || body.length > 320) { bad++; console.log('SKIP invalid', t.id, step); continue; }
            if (DRY) { if (n < 2) console.log('step' + step, t.id, body); n++; filled++; continue; }
            const patch = {}; patch[col] = body; patch.body_generated_at = new Date().toISOString();
            const w = await fetch(URL_ + '/rest/v1/outbound_targets?id=eq.' + t.id + '&' + col + '=is.null', { method: 'PATCH', headers: H, body: JSON.stringify(patch) });
            if (w.ok) { filled++; n++; } else console.log('write fail', t.id, w.status);
        }
        if (n) console.log('step' + step + (DRY ? ' would fill: ' : ' filled: ') + n);
    }
    console.log(JSON.stringify({ filled: filled, held_back_by_promise: promised, invalid: bad, dry: DRY }));
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
