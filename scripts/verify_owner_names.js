/**
 * scripts/verify_owner_names.js
 *
 * Proves or disproves leads.owner_name against the business's OWN website.
 *
 * WHY THIS EXISTS
 *
 * owner_name is roughly 70% right and nothing in the pipeline ever checked it.
 * Measured on the 705-lead Instagram list: 358 carried a name and only 22 (6%)
 * had that name corroborated anywhere else in the record. On a 40-lead sample
 * this script caught Modern Dermatology carrying owner_name "John B Adams"
 * while their own site names Dr. Alexandra Grob as founder.
 *
 * A wrong first name is worse than no first name. It is the single clearest
 * signal that a message was merged from a purchased list, and it is the reason
 * the Instagram copy now opens with no name at all. This script is how names
 * earn their way back into outbound copy.
 *
 * THE RULE
 *
 *   verified     a name matching owner_name sits next to an owner/founder/CEO
 *                label on their own site. Safe to merge into copy.
 *   contradicted the site names a DIFFERENT person. owner_name_found holds
 *                theirs. Never merge owner_name; consider replacing it.
 *   unverified   we looked and found no owner attribution. Do not merge.
 *   null         never checked.
 *
 * Only 'verified' may be used in outbound copy. Everything else gets the
 * no-name opener.
 *
 * WHAT THIS DOES NOT DO
 *
 * No Sunbiz. search.sunbiz.org is behind Cloudflare (403 + JS challenge) so it
 * cannot be scraped directly. Florida DOES publish bulk officer data over SFTP
 * at sftp.floridados.gov, which is the authoritative source and a much better
 * input than any website; it needs an account, so it is a separate job.
 *
 * No LinkedIn. Bot-blocked at any useful volume.
 *
 * A team page is evidence, not proof. Some sites publish stock or stale staff
 * names. That is why the source URL is stored: every claim stays auditable.
 *
 * Usage:
 *   node scripts/verify_owner_names.js --client <uuid> [--limit 200] [--dry]
 *   node scripts/verify_owner_names.js --all --limit 500
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try {
    fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const CLIENT_ID = arg('client', null);
const ALL = args.includes('--all');
const LIMIT = parseInt(arg('limit', '200'), 10);
const DRY = args.includes('--dry');
const CONCURRENCY = 12;
const TIMEOUT_MS = 12000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Where owners get named. Ordered by how likely the page is to exist.
const PAGES = ['', '/about', '/about-us', '/our-team', '/team', '/meet-the-team',
    '/staff', '/our-story', '/contact', '/about-me'];

// The words that mark somebody as the principal, in both languages.
const ROLE = /\b(owner|founder|co-?founder|president|ceo|proprietor|medical director|nurse practitioner and owner|due[ñn][ao]|propietari[ao]|fundador[ae]?s?|president[ae])\b/i;

// A plausible human name: one to three capitalised tokens, allowing accents.
const NAME_TOKEN = "[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü'’-]{1,20}";
const NAME_RE = new RegExp('(?:Dr\\.?\\s+|Dra\\.?\\s+)?(' + NAME_TOKEN + '(?:\\s+' + NAME_TOKEN + '){0,2})', 'g');

// Words that look like names but are not people. Anything appearing here
// disqualifies the whole candidate, because a real name will not contain them.
const NOT_NAME = new Set(['The', 'Our', 'Meet', 'About', 'Book', 'Now', 'Home', 'Contact', 'Services',
    'Med', 'Spa', 'Medical', 'Center', 'Centre', 'Clinic', 'Beauty', 'Skin', 'Laser', 'Wellness',
    'Aesthetics', 'Aesthetic', 'Board', 'Certified', 'Read', 'More', 'Learn', 'View', 'Call',
    'Schedule', 'Appointment', 'Treatments', 'Team', 'Staff', 'Founder', 'Owner', 'President',
    'Florida', 'Miami', 'Tampa', 'Orlando', 'Sobre', 'Nuestro', 'Nuestra',
    // added after the first live run surfaced these as "names"
    'Care', 'Director', 'Forms', 'What', 'Welcome', 'Consultation', 'National', 'Injectable',
    'Trainer', 'With', 'Dr', 'Dra', 'Hi', 'Hello', 'We', 'You', 'Your', 'Us', 'Is', 'And',
    'Toradol', 'Botox', 'Filler', 'Fillers', 'Facial', 'Facials', 'Body', 'Face', 'Hair',
    'New', 'Best', 'Top', 'Free', 'Get', 'See', 'Why', 'How', 'When', 'Where', 'Book',
    'Practice', 'Office', 'Suite', 'Located', 'Serving', '专', 'Nurse', 'Practitioner',
    'Physician', 'Assistant', 'Registered', 'Licensed', 'Master', 'Expert', 'Specialist']);

/**
 * Do two names refer to the same person?
 *
 * Any shared token counts, not just the first. The first run flagged
 * "Ekaterina Vasileva" against a site saying "Kate Vasileva" as a contradiction,
 * when Kate is simply what Ekaterina goes by; the surname is the tell. Same
 * story for "Zdenka Orbegozo" appearing as "Zee". Matching on the first token
 * alone manufactures false contradictions, and a false contradiction is exactly
 * as damaging as a false verification.
 */
function sameName(a, b) {
    const norm = function (s) {
        return String(s || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/^(dr|dra|mr|mrs|ms)\.?\s+/, '')
            .split(/[\s,]+/).filter(function (t) { return t.length > 1; });
    };
    const A = norm(a), B = norm(b);
    if (!A.length || !B.length) return false;
    if (A.some(function (x) { return B.includes(x); })) return true;
    // Diminutives: Kate/Ekaterina, Zee/Zdenka, Alex/Alexandra. A short token
    // that prefixes a longer one, or shares its first 3 letters, is the same
    // person often enough that treating it as a contradiction is the worse error.
    return A.some(function (x) {
        return B.some(function (y) {
            const s = x.length <= y.length ? x : y, l = x.length <= y.length ? y : x;
            return s.length >= 3 && (l.startsWith(s) || l.slice(0, 3) === s.slice(0, 3));
        });
    });
}

// Device, treatment and vendor brands. These are capitalised, sit right next to
// the word "director" or "owner" on a med spa page, and are not people.
const NOT_NAME_BRAND = /\b(morpheus|coolsculpt\w*|emsculpt\w*|hydrafacial|sculptra|kybella|juvederm|restylane|dysport|xeomin|botox|yocale|vagaro|booksy|mangomint|zenoti|glossgenius|squarespace|wordpress|surgery|surgical|medicin\w*|aging|therapy|therapies|plastic|dermatology|injectables?)\b/i;

/**
 * A candidate is usable as evidence only if it looks like an actual person.
 * `business` is passed so we reject the practice's own name, which shows up
 * constantly next to role words ("Purple Rain ... Owner").
 */
function looksLikeFullName(cand, business) {
    const parts = String(cand || '').trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 3) return false;
    if (!parts.every(function (p) { return !NOT_NAME.has(p) && p.length >= 2; })) return false;
    if (NOT_NAME_BRAND.test(cand)) return false;
    // Every token already present in the business name means we matched the
    // business, not a human.
    const biz = String(business || '').toLowerCase();
    if (biz && parts.every(function (p) { return biz.includes(p.toLowerCase()); })) return false;
    return true;
}

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1);
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}

function normUrl(raw) {
    if (!raw) return null;
    let u = String(raw).trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { return new URL(u); } catch (e) { return null; }
}

function firstToken(name) {
    const t = String(name || '').trim().replace(/^(Dr|Dra|Mr|Mrs|Ms)\.?\s+/i, '').split(/[\s,]+/)[0];
    return t ? t.toLowerCase() : null;
}

async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal, redirect: 'follow',
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!/text|html/i.test(ct)) return null;
        const body = (await res.text()).slice(0, 700000);
        const stripped = body.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(d); })
            .replace(/\s+/g, ' ');
        return stripped;
    } catch (e) { return null; }
    finally { clearTimeout(t); }
}

/** Pull candidate owner names out of the text near a role word. */
function candidates(text) {
    const out = [];
    let m;
    ROLE.lastIndex = 0;
    const roleRe = new RegExp(ROLE.source, 'gi');
    while ((m = roleRe.exec(text)) !== null) {
        // A name usually sits within ~70 chars either side of the role word.
        const win = text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70);
        NAME_RE.lastIndex = 0;
        let n;
        while ((n = NAME_RE.exec(win)) !== null) {
            const cand = n[1].trim();
            const parts = cand.split(/\s+/);
            if (parts.some(function (p) { return NOT_NAME.has(p); })) continue;
            if (parts.length < 1) continue;
            out.push({ name: cand, context: win.trim().slice(0, 180) });
        }
    }
    return out;
}

async function verifyLead(lead) {
    const u = normUrl(lead.website);
    if (!u) return { status: 'unverified', reason: 'no_website' };

    for (const p of PAGES) {
        const url = u.origin + (p || u.pathname || '/');
        const text = await fetchText(url);
        if (!text) continue;
        const cands = candidates(text);
        if (!cands.length) continue;

        // A match can come from any candidate on the page, including one-token
        // ones ("Zee"), because a nickname is still confirmation.
        if (lead.owner_name) {
            const hit = cands.find(function (c) { return sameName(lead.owner_name, c.name); });
            if (hit) return { status: 'verified', source: url, found: hit.name, context: hit.context };
        }

        // Nothing matched. Only treat that as evidence if the page actually
        // produced a credible full name; a stray "Forms" or "Di" is scraper
        // noise and must not become a contradiction or a proposal.
        const solid = cands.filter(function (c) { return looksLikeFullName(c.name, lead.name); });
        if (!solid.length) continue;

        if (!lead.owner_name) {
            return { status: 'unverified', source: url, found: solid[0].name, context: solid[0].context, proposed: true };
        }
        return { status: 'contradicted', source: url, found: solid[0].name, context: solid[0].context };
    }
    return { status: 'unverified', reason: 'no_owner_attribution_found' };
}

async function main() {
    const db = sb();
    let q = db.from('leads')
        .select('id,name,owner_name,website,owner_name_verify_status')
        .not('website', 'is', null)
        .is('owner_name_verify_status', null)
        .limit(LIMIT);
    if (CLIENT_ID) q = q.eq('client_id', CLIENT_ID);
    else if (!ALL) { console.error('pass --client <uuid> or --all'); process.exit(1); }

    const { data: leads, error } = await q;
    if (error) { console.error(error); process.exit(1); }
    console.log(leads.length + ' leads to check' + (DRY ? '  (DRY RUN)' : '') + '\n');

    const stats = { verified: 0, contradicted: 0, unverified: 0, proposed: 0 };
    let i = 0;

    async function worker() {
        while (i < leads.length) {
            const lead = leads[i++];
            const r = await verifyLead(lead);
            stats[r.status] = (stats[r.status] || 0) + 1;
            if (r.proposed) stats.proposed++;

            const tag = r.status === 'verified' ? 'OK  ' : (r.status === 'contradicted' ? 'WRONG' : '  . ');
            if (r.status !== 'unverified' || r.proposed) {
                console.log(tag + ' #' + lead.id + ' ' + String(lead.name).slice(0, 34)
                    + '  file=' + (lead.owner_name || '(none)')
                    + '  site=' + (r.found || '(none)'));
            }
            if (!DRY) {
                const patch = {
                    owner_name_verify_status: r.status,
                    owner_name_verify_source: r.source || null,
                    owner_name_found: r.found || null,
                    owner_name_last_verified: new Date().toISOString(),
                };
                if (r.status === 'verified') patch.owner_direct_confirmed = true;
                if (r.status === 'contradicted') {
                    patch.owner_direct_confirmed = false;
                    patch.owner_name_previous = lead.owner_name || null;
                }
                await db.from('leads').update(patch).eq('id', lead.id);
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const checked = leads.length || 1;
    console.log('\n--- results ---');
    console.log('  verified     ' + (stats.verified || 0) + '  (' + (100 * (stats.verified || 0) / checked).toFixed(1) + '%)  safe to use in copy');
    console.log('  contradicted ' + (stats.contradicted || 0) + '  site names someone else');
    console.log('  unverified   ' + (stats.unverified || 0) + '  no owner attribution found');
    console.log('  of those, a name was PROPOSED for a lead that had none: ' + (stats.proposed || 0));
    if (DRY) console.log('\nDry run. Nothing written.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
