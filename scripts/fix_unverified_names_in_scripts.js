/**
 * Stop the cold-call scripts from asserting an unverified owner name.
 *
 * Every Blason lead came from google_maps and NONE has
 * owner_direct_confirmed. The generated scripts hedged the name in the
 * "Ask for" metadata row ("from records, unverified") but then used it flatly
 * in the three lines the rep actually SAYS:
 *
 *     "Hi, is Marela available?"
 *     "Hey, Marela? This is [YOUR NAME]..."
 *     "Hi, Marela, this is [YOUR NAME]..."
 *
 * So the hedge never reached the call. A scraped Google name is often a
 * practitioner, a former owner, or an institution fragment — "Dermatology of
 * Miami" yields "Phillip" from "Phillip Frost Department", and "Advanced Eye
 * Center: Rodrigo Belalcazar, MD" tells the rep to ask for "Kourosh". Opening
 * with the wrong name is worse than opening with none.
 *
 * Per Remy 2026-08-27: ask for the owner rather than say a wrong name. The
 * scraped name is kept in the Ask-for row as a secondary hint the rep may use
 * only if the desk offers it first.
 *
 * Usage: node scripts/fix_unverified_names_in_scripts.js [--apply] [--limit N]
 * Dry run by default. Idempotent: an already-patched script is skipped.
 */
const fs = require('fs');
const path = require('path');
fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (l) {
    const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
});
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

const BUCKET = 'cold-call-scripts-generated';
const CLIENT_ID = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';   // Blason Spa Equipment
const APPLY = process.argv.indexOf('--apply') !== -1;
const LIMIT = (function () {
    const i = process.argv.indexOf('--limit');
    return i === -1 ? Infinity : Number(process.argv[i + 1]) || Infinity;
})();
const MARKER = 'the owner or decision-maker';   // idempotency marker

function slugify(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Rewrite every place the script SPEAKS the name. Returns {text, hits}. */
function depersonalize(md, first) {
    const F = esc(first);
    let hits = 0;
    const sub = function (re, to) {
        const before = md;
        md = md.replace(re, to);
        if (md !== before) hits++;
    };
    // 1. The metadata row: keep the name, but demote it to a hint.
    sub(new RegExp('(\\|\\s*\\*\\*Ask for\\*\\*\\s*\\|\\s*)' + F + '[^|\\n]*', 'i'),
        '$1' + MARKER + ' (records say ' + first + ', unverified — only use it if the desk says it first)');
    // 2. Gatekeeper line.
    sub(new RegExp('"Hi, is ' + F + ' available\\?', 'gi'), '"Hi, is the owner available?');
    // 3. Opener, greeting form. Lowercase what follows, or removing the name
    //    leaves "Hey, This is [YOUR NAME]" with a capital mid-sentence.
    sub(new RegExp('"Hey, ' + F + '\\?\\s*This is', 'gi'), '"Hey, this is');
    sub(new RegExp('"Hey, ' + F + '\\?\\s*', 'gi'), '"Hey, ');
    // 4. Voicemail / alt opener, comma form.
    sub(new RegExp('"Hi, ' + F + ', this is', 'gi'), '"Hi, this is');
    // 5. The "Log:" line. Left alone, a rep copies the scraped name straight
    //    into the CRM as the confirmed contact and the bad data outlives the
    //    call that could have corrected it.
    sub(new RegExp('(\\n\\s*1\\. Log:[^\\n]*?)·\\s*' + F + '\\s*·', 'i'),
        '$1· owner name (confirm on the call) ·');
    return { text: md, hits: hits };
}

(async function () {
    const { data: leads, error } = await pro.from('leads')
        .select('id,name,owner_name,owner_direct_confirmed')
        .eq('client_id', CLIENT_ID).not('owner_name', 'is', null);
    if (error) { console.error('lead read failed:', error.message); process.exit(1); }

    // A human-confirmed owner is safe to say out loud; leave those alone.
    const targets = leads.filter(function (l) { return !l.owner_direct_confirmed; });
    console.log('Blason leads with an unverified owner name:', targets.length,
        '(of ' + leads.length + ' with any name)');
    console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: dry run\n');

    let patched = 0, already = 0, missing = 0, noname = 0, leftover = 0;
    let n = 0;
    for (const l of targets) {
        if (n++ >= LIMIT) break;
        const first = String(l.owner_name).trim().split(/\s+/)[0];
        if (!first || first.length < 2) { noname++; continue; }
        const file = slugify(l.name) + '.md';
        const dl = await sb.storage.from(BUCKET).download(file);
        if (dl.error) { missing++; continue; }
        const md = await dl.data.text();
        if (md.includes(MARKER)) { already++; continue; }

        const out = depersonalize(md, first);
        if (!out.hits) { continue; }

        // Anything still speaking the name after the rewrite is a phrasing we
        // did not anticipate. Report it rather than assuming it is handled.
        const spoken = out.text.split('\n').filter(function (x) {
            return x.trim().startsWith('>') && new RegExp('\\b' + esc(first) + '\\b').test(x);
        });
        if (spoken.length) {
            leftover++;
            if (leftover <= 5) console.log('  LEFTOVER in ' + file + ': ' + spoken[0].trim().slice(0, 90));
        }

        if (patched < 3) {
            console.log('  ' + file + '  (' + l.owner_name + ')');
            out.text.split('\n').filter(function (x) { return /Ask for|is the owner available|"Hey, |"Hi, this is/.test(x); })
                .slice(0, 3).forEach(function (x) { console.log('     ' + x.trim().slice(0, 110)); });
        }
        if (APPLY) {
            const up = await sb.storage.from(BUCKET).upload(file, Buffer.from(out.text, 'utf8'), {
                contentType: 'text/markdown', upsert: true
            });
            if (up.error) { console.error('  upload failed ' + file + ': ' + up.error.message); continue; }
        }
        patched++;
    }
    console.log('\npatched: ' + patched + ' | already done: ' + already +
        ' | script missing: ' + missing + ' | unusable name: ' + noname +
        ' | with leftover mentions: ' + leftover);
    if (!APPLY) console.log('Re-run with --apply to write.');
})();
