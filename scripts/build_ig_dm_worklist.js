/**
 * scripts/build_ig_dm_worklist.js
 *
 * Turns ig_handles.json (from find_lead_instagram.js) into a day-by-day DM
 * worklist CSV with the message already written for each lead.
 *
 * RULES BAKED IN (do not "improve" these without reading why)
 *
 *   - Never a price, not a range, not "starting at". Agency hard rule.
 *   - Copy follows leads.primary_language. An 'es' lead gets an all-Spanish DM.
 *   - No links in the first message. Links tank IG deliverability and read as spam.
 *   - do_not_call and owner_uninterested are excluded outright.
 *   - callback_requested leads are NOT DM'd. They get a phone call. They are
 *     listed in a separate file so they don't get quietly lost.
 *
 * A/B varies exactly ONE thing, matching the SMS test so results are comparable:
 *   arm A = the treatment-gap question (the one that works on the phone)
 *   arm B = the proximity offer (showroom if zip3 is 330-333, else video call)
 * Assignment is a deterministic hash of the lead id, so it is balanced across
 * language and geography rather than confounded with either.
 *
 * Daily caps ramp because Instagram bans new accounts that blast strangers:
 * 15/day week 1, 25/day week 2, 40/day thereafter.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/build_ig_dm_worklist.js [--in ig_handles.json] [--out ig_dm_worklist.csv]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }

const ROOT = path.join(__dirname, '..', '..', '..');
const IN = arg('in', path.join(ROOT, 'ig_handles.json'));
const OUT = arg('out', path.join(ROOT, 'ig_dm_worklist.csv'));
const OUT_CALL = arg('calls', path.join(ROOT, 'ig_call_these_instead.csv'));

const REP = 'Remy';
const LOCAL_ZIP3 = ['330', '331', '332', '333', '334'];

// Matches sites/stilo-ai/assets/_names.js behaviour: first token, title-cased,
// rejected if it looks like a business word rather than a person.
const NOT_A_NAME = /^(the|dr|doctor|med|spa|clinic|center|centre|salon|studio|beauty|skin|laser|llc|inc|pa|md|do|arnp|pllc)$/i;
function firstName(owner) {
    if (!owner) return null;
    const tok = String(owner).trim().split(/[\s,]+/)[0];
    if (!tok || tok.length < 2 || NOT_A_NAME.test(tok)) return null;
    if (!/^[A-Za-zÀ-ÿ'’-]+$/.test(tok)) return null;
    return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

function zip3(address) {
    const m = String(address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
    return m ? m[1].slice(0, 3) : null;
}
// Miami-Dade, Broward and Palm Beach. These are the only leads that can
// realistically drive to the Hialeah showroom, so they go first and they are
// the only ones who get the showroom ask.
function isSouthFlorida(lead) { return LOCAL_ZIP3.includes(zip3(lead.address)); }

function hashArm(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return h % 2 === 0 ? 'A' : 'B';
}

/**
 * NO FIRST NAMES IN INSTAGRAM DMs. Two reasons, and the second is the stronger.
 *
 * 1. The data does not support it. Of 705 targets, 358 carried an owner_name and
 *    only 22 of those (6%) had that name corroborated by the handle or the
 *    business name. owner_name runs ~70% accurate, so roughly a hundred DMs
 *    would have opened with the wrong person. "Hi Louis" went to three separate
 *    4Ever Young locations off one copied corporate record.
 *
 * 2. You are messaging a BUSINESS account, not a person. Whoever opens
 *    @agelessmed is usually front desk or whoever runs the social, not the
 *    owner. Greeting a business account by the owner's first name reads as
 *    merged-from-a-list even when the name happens to be right.
 *
 * Addressing the role instead of a guessed name is both safer and more natural.
 */
/**
 * Instagram is a phone medium. Copy that opens "Hi, I'm X with Y Inc." reads as a
 * form letter and gets swiped away. So: question first, credential second, lower
 * case, short enough to read without tapping "more".
 *
 * The showroom only goes to South Florida. 97 of 742 leads are inside zip3
 * 330-334; the rest sit in Tampa (221) and Orlando (206) and cannot drive to
 * Hialeah, so asking them to "swing by" is an instant tell that the message is
 * automated.
 */
function message(lead, arm) {
    const es = lead.lang === 'es';
    const local = isSouthFlorida(lead);

    if (arm === 'A') {
        if (es) return `hola! una pregunta rápida, ¿hay algún tratamiento que sus clientas le piden y que ahorita no pueden hacer? soy ${REP}, de Blasón Spa Equipment aquí en Miami, nosotros vendemos los equipos`;
        return `hey! quick question, is there a treatment your clients keep asking for that you can't do yet? i'm ${REP} with Blasón Spa Equipment in Miami, we supply the machines`;
    }
    // arm B: the offer. Showroom if they can actually drive to it, a call if not.
    if (local) {
        if (es) return `hola! tenemos un showroom aquí en Miami con las máquinas montadas y funcionando, contorno corporal, láser, ese tipo de cosas. ¿vale la pena pasar a probarlas? soy ${REP}, de Blasón Spa Equipment`;
        return `hey! we keep a showroom in Miami with the machines set up and running, body contouring, lasers, that kind of thing. worth swinging by to try a few? i'm ${REP} with Blasón Spa Equipment`;
    }
    if (es) return `hola! soy ${REP}, de Blasón Spa Equipment en Miami. le vendemos equipos a spas por toda la Florida. ¿vale la pena una llamada corta para enseñarle lo que tenemos?`;
    return `hey! i'm ${REP} with Blasón Spa Equipment in Miami, we supply machines to spas all over Florida. worth a quick call to run through what we carry?`;
}

function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function main() {
    const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
    const all = Object.values(raw).filter(r => r.handle);

    const EXCLUDE = new Set(['do_not_call', 'owner_uninterested']);
    const callInstead = all.filter(r => r.outcome === 'callback_requested' || r.stage === 'ENGAGED');
    const pool = all.filter(r =>
        !EXCLUDE.has(r.outcome) &&
        r.outcome !== 'callback_requested' &&
        r.stage !== 'ENGAGED' &&
        r.stage !== 'CLOSED_LOST'
    );

    // South Florida first, always. They can drive to the showroom, which is the
    // strongest thing Blason has, and it is the only cohort the showroom ask is
    // honest for. Within each region: never-dialed first (safe warm-up volume),
    // then the ones where the phone already failed, which is the whole reason
    // this channel exists.
    const rank = r => {
        if (!r.outcome) return 0;                                   // never dialed
        if (['voicemail', 'no_answer', 'missed_inbound'].includes(r.outcome)) return 1;
        if (r.outcome === 'answered') return 2;
        return 3;
    };
    pool.sort((a, b) =>
        (isSouthFlorida(b) - isSouthFlorida(a))
        || rank(a) - rank(b)
        || String(a.name).localeCompare(String(b.name)));

    // Ramp: 15/day week 1, 25/day week 2, 40/day after.
    function capForDay(d) { return d <= 5 ? 15 : d <= 10 ? 25 : 40; }
    let day = 1, usedToday = 0;

    const header = ['day', 'region', 'priority', 'instagram_url', 'handle', 'business',
        'city_zip', 'lang', 'arm', 'message', 'phone_result', 'rating', 'reviews',
        'status', 'sent_on', 'reply', 'notes'];
    const lines = [header.join(',')];

    pool.forEach(r => {
        if (usedToday >= capForDay(day)) { day++; usedToday = 0; }
        usedToday++;
        const arm = hashArm(r.id);
        const z = zip3(r.address);
        lines.push([
            day,
            isSouthFlorida(r) ? 'South Florida' : 'rest of FL',
            ['never dialed', 'phone failed', 'answered, not logged', 'other'][rank(r)],
            'https://instagram.com/' + r.handle,
            '@' + r.handle,
            r.name,
            (String(r.address || '').split(',').slice(-2).join(',').trim()) + (z ? '' : ''),
            r.lang || 'en',
            arm,
            message(r, arm),
            r.outcome || 'never dialed',
            r.rating || '',
            r.reviews || '',
            'to send', '', '', '',
        ].map(csvCell).join(','));
    });

    fs.writeFileSync(OUT, lines.join('\n'));

    const ch = ['instagram_url', 'business', 'owner_first', 'phone_result', 'stage', 'why'];
    const clines = [ch.join(',')];
    callInstead.forEach(r => clines.push([
        'https://instagram.com/' + r.handle, r.name, firstName(r.owner_name) || '',
        r.outcome || '', r.stage || '',
        'Already warm on the phone. Call, do not DM.',
    ].map(csvCell).join(',')));
    fs.writeFileSync(OUT_CALL, clines.join('\n'));

    const armCount = pool.reduce((a, r) => (a[hashArm(r.id)] = (a[hashArm(r.id)] || 0) + 1, a), {});
    console.log('DM worklist: ' + pool.length + ' leads over ' + day + ' days');
    console.log('  arms: A=' + armCount.A + '  B=' + armCount.B);
    console.log('  spanish: ' + pool.filter(r => r.lang === 'es').length);
    console.log('  named:   ' + pool.filter(r => firstName(r.owner_name)).length);
    console.log('  excluded (dnc / uninterested): ' + all.filter(r => EXCLUDE.has(r.outcome)).length);
    console.log('  call instead of DM: ' + callInstead.length + ' -> ' + OUT_CALL);
    console.log('written to ' + OUT);
}

main();
