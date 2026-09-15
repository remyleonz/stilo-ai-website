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
const repFirst = rep => rep && rep.startsWith('remyleon') ? 'remy' : rep && rep.startsWith('aleb') ? 'alejandro' : 'jorge';

// hi(name) — verified first name only, else plain "hey"/"hola".
const A_EN = [
    (hi, n) => `${hi}, ${n} here with blason spa equipment in miami, i called you the other day. quick one: what's the next machine on your wishlist?`,
    (hi, n) => `${hi}, ${n} with blason spa equipment in miami, tried you by phone the other day. curious, what's the oldest machine in your room right now?`,
    (hi, n) => `${hi}, ${n} here from blason spa equipment in miami, i called the other day. anything new coming for you guys, a new service or a second room?`,
];
const A_ES = [
    (hi, n) => `${hi}, soy ${n} de blason spa equipment en miami, los llamé hace unos días. una pregunta: ¿cuál es la próxima máquina en su lista de deseos?`,
    (hi, n) => `${hi}, soy ${n} de blason spa equipment en miami, intenté llamarlos hace poco. ¿cuál es la máquina más vieja que tienen en cabina ahora?`,
    (hi, n) => `${hi}, soy ${n} de blason spa equipment en miami, los llamé el otro día. ¿viene algo nuevo para ustedes, un servicio nuevo o una segunda cabina?`,
];
const B_EN = [
    (hi, n) => `${hi}, ${n} here with blason spa equipment in miami, i called you the other day. our machines are set up and running at the showroom in miami so you can put your hands on them before deciding anything. worth a look?`,
    (hi, n) => `${hi}, ${n} from blason spa equipment in miami, tried to reach you by phone the other day. the machines are running live at our miami showroom, you can try them before deciding anything. worth a look?`,
];
const B_ES = [
    (hi, n) => `${hi}, soy ${n} de blason spa equipment en miami, los llamé hace unos días. las máquinas están montadas y funcionando en nuestro showroom de miami, las puede probar antes de decidir nada. ¿vale la pena una visita?`,
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
            ? 'gracias por responder. version corta: equipos de estetica y contorno corporal, laser, faciales, body sculpting. manuel, el dueno de blason aqui en miami, los importa el mismo y le dice directo cual le sirve. cual es la proxima maquina en su lista de deseos?'
            : "thanks for getting back. short version: aesthetic and body contouring equipment, lasers, facials, body sculpting. manuel, the owner of blason here in miami, imports them himself, so he tells you straight which one fits. what's the next machine on your wishlist?";
        const w = await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ step2_body: body, body_generated_at: new Date().toISOString() }) });
        console.log('step2 filled for target', t.id, w.ok ? 'ok' : w.status);
    }

    // NUDGE: non-repliers who had a connected call and went quiet after step 1.
    // The tick sends step 2 (and later step 3) to 'sent' targets past the
    // cooldown; here we fill the body. Lighter than the reply pitch: a soft
    // check-in, then a final touch with an explicit out. No price, no link.
    const nudge2En = 'hey, circling back on my note. is upgrading or adding a machine on your radar at all this year? no rush, just want to point you to the right one if so.';
    const nudge2Es = 'hola, dandole seguimiento a mi mensaje. tiene pensado meter o cambiar alguna maquina este ano? sin apuro, solo para orientarlo bien.';
    const nudge3En = 'last one from me. if it is not the right time just say so and i will stop. whenever it is, we import direct and manuel will tell you straight what fits your room.';
    const nudge3Es = 'ultimo de mi parte. si no es el momento digamelo y no le escribo mas. cuando lo sea, importamos directo y manuel le dice de frente que le sirve.';
    for (const [step, bEn, bEs] of [[2, nudge2En, nudge2Es], [3, nudge3En, nudge3Es]]) {
        const col = 'step' + step + '_body';
        const rn = await fetch(`${URL_}/rest/v1/outbound_targets?campaign_id=eq.4&stage=eq.sent&step=eq.${step - 1}&first_reply_at=is.null&${col}=is.null&select=id,lead_id&order=id&limit=500`, { headers: H });
        const nr = await rn.json();
        for (const t of (Array.isArray(nr) ? nr : [])) {
            const lr = await fetch(`${URL_}/rest/v1/leads?id=eq.${t.lead_id}&select=primary_language`, { headers: H });
            const es = ((await lr.json())[0] || {}).primary_language === 'es';
            const patch = {}; patch[col] = es ? bEs : bEn;
            patch.body_generated_at = new Date().toISOString();
            const w = await fetch(`${URL_}/rest/v1/outbound_targets?id=eq.${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(patch) });
            if (!w.ok) console.log('nudge fill fail', t.id, w.status);
        }
        if (nr.length) console.log('nudge step' + step + ' filled: ' + nr.length);
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
        const hi = es ? (first ? `hola ${first}` : 'hola') : (first ? `hey ${first}` : 'hey');
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
