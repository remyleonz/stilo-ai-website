/**
 * scripts/backfill_litigator_scrub.js
 *
 * Scrubs the existing lead base against the litigator / DNC provider and blocks
 * every match. This is the one-time catch-up for the ~21k leads that were
 * ingested before the gate existed; sync-scripts.js handles everything David
 * pushes from here on.
 *
 * Resumable by design. It only ever selects leads whose scrub_status is null,
 * 'pending', or 'error', so killing it and re-running picks up where it left
 * off. Re-running after a provider outage retries exactly the failures.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/backfill_litigator_scrub.js --dry
 *   node sites/stilo-ai/scripts/backfill_litigator_scrub.js --limit=200
 *   node sites/stilo-ai/scripts/backfill_litigator_scrub.js
 *   node sites/stilo-ai/scripts/backfill_litigator_scrub.js --probe --phone=+13055551234
 *
 * Flags:
 *   --dry           count what would be scrubbed, spend nothing, write nothing
 *   --limit=N       stop after N leads (use a small N for the first paid run)
 *   --scripted      only leads that are dial-ready (has_cold_call_script)
 *   --dialed        only leads we have already called at least once
 *   --probe         single-number lookup, dumps the RAW provider JSON and exits
 *   --phone=NUM     the number for --probe
 *   --rps=N         requests per second (default 5, be polite and stay in plan)
 *
 * Providers bill per lookup, and the full lead base is ~21.5k rows against a
 * dial-ready set of ~1.9k. Scrub what you actually contact before you scrub the
 * archive: --scripted first, then --dialed, then the rest if it is ever worth it.
 *
 * FIRST RUN ORDER, do not skip:
 *   1. --probe against a number you own. Paste the raw JSON so the response
 *      mapping in api/prospects/_scrub.js can be confirmed against reality.
 *   2. --dry to see the volume, which is what the provider will bill you for.
 *   3. --limit=50 for a real paid run. Check the status breakdown.
 *   4. Full run once 'error' is near zero.
 *
 * A large 'error' count on step 3 means the response mapping is still wrong.
 * That is the intended behavior, not a bug: an unreadable response is recorded
 * as unanswered rather than guessed clean.
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

try {
    const envFile = path.join(__dirname, '..', '.env.local');
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const scrub = require('../api/prospects/_scrub');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const a = args.find(x => x.startsWith(f + '=')); return a ? a.split('=')[1] : null; };

const DRY = has('--dry');
const PROBE = has('--probe');
const SCRIPTED = has('--scripted');
const DIALED = has('--dialed');
const LIMIT = Number(val('--limit') || 0);
const RPS = Number(val('--rps') || 5);
const PAGE = 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pro() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Check sites/stilo-ai/.env.local');
        process.exit(1);
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}

async function probe() {
    const phone = val('--phone');
    if (!phone) { console.error('--probe requires --phone=+1XXXXXXXXXX'); process.exit(1); }
    console.log('provider:', scrub.PROVIDER);
    const res = await scrub.scrubPhone(phone);
    console.log('\nverdict :', res.status, res.reason ? '(' + res.reason + ')' : '');
    console.log('\nRAW PROVIDER RESPONSE — paste this back to finalize the mapping:');
    console.log(JSON.stringify(res.flags, null, 2));
    if (res.status === 'error' && res.reason === 'unrecognized_response') {
        console.log('\nExpected on first run. mapBlacklistAlliance() in api/prospects/_scrub.js needs');
        console.log('the real field names from the JSON above.');
    }
}

async function main() {
    if (PROBE) return probe();

    const sb = pro();
    const stats = { seen: 0, clear: 0, blocked: 0, error: 0, pending: 0, skipped_no_phone: 0 };
    const delay = Math.max(0, Math.floor(1000 / Math.max(1, RPS)));

    // Only leads that have a number worth checking and no answer on file yet.
    // The .or() on scrub_status must include the null case explicitly: in
    // Postgres `scrub_status <> 'clear'` is NULL (not true) for a null column,
    // which silently drops every never-scrubbed lead. Same trap that made the
    // callable queue return 0 rows once already.
    const baseFilter = (q) => {
        let out = q
            .eq('client_id', '2efae6bf-69d8-4c4d-ac25-6a693db50f8b')   // Blason pool ONLY
            .or('owner_phone_e164.not.is.null,owner_phone.not.is.null,phone.not.is.null')
            .or('scrub_status.is.null,scrub_status.eq.pending,scrub_status.eq.error');
        if (SCRIPTED) out = out.eq('has_cold_call_script', true);
        if (DIALED) out = out.not('last_called_at', 'is', null);
        return out;
    };

    if (DRY) {
        const { count, error } = await baseFilter(
            sb.from('leads').select('id', { count: 'exact', head: true })
        );
        if (error) { console.error('count failed:', error.message); process.exit(1); }
        console.log('provider        :', scrub.PROVIDER);
        console.log('scope           :',
            SCRIPTED ? 'dial-ready only' : DIALED ? 'previously dialed only' : 'ALL leads');
        console.log('leads to scrub  :', count);
        console.log('est. requests   :', count, '(one lookup per lead, billed per lookup)');
        console.log('\nDry run. Nothing written, nothing spent.');
        return;
    }

    let offset = 0;
    for (;;) {
        const { data, error } = await baseFilter(
            sb.from('leads').select('id,name,owner_phone_e164,owner_phone,phone')
        ).order('id', { ascending: true }).range(offset, offset + PAGE - 1);

        if (error) { console.error('read failed:', error.message); process.exit(1); }
        if (!data || !data.length) break;

        for (const lead of data) {
            if (LIMIT && stats.seen >= LIMIT) break;
            stats.seen++;

            if (!scrub.pickPhone(lead)) { stats.skipped_no_phone++; continue; }

            const res = await scrub.scrubLead(sb, lead, 'backfill');
            stats[res.status] = (stats[res.status] || 0) + 1;

            if (res.status === 'blocked') {
                console.log('BLOCKED  ' + lead.id + '  ' + (lead.name || '') + '  reason=' + res.reason);
            }
            if (res.write_error) {
                console.error('write failed for ' + lead.id + ': ' + res.write_error);
            }
            if (stats.seen % 100 === 0) {
                console.log('...' + stats.seen + ' processed  (blocked ' + stats.blocked + ', error ' + stats.error + ')');
            }
            if (delay) await sleep(delay);
        }

        if (LIMIT && stats.seen >= LIMIT) break;
        // No offset advance: scrubbed rows drop out of the filter, so the next
        // page always starts at the remaining work. Advancing would skip rows
        // whenever a lead was written between pages.
        if (data.length < PAGE) break;
    }

    console.log('\n--- scrub backfill complete ---');
    console.log(JSON.stringify(stats, null, 2));
    if (stats.pending) {
        console.log('\n' + stats.pending + ' pending = no API key configured. Set BLACKLIST_ALLIANCE_KEY');
        console.log('(or SCRUB_PROVIDER=ipqualityscore + IPQS_API_KEY) in sites/stilo-ai/.env.local');
    }
    if (stats.error) {
        console.log('\n' + stats.error + ' errors. Run with --probe to inspect a raw response, then');
        console.log('tighten mapBlacklistAlliance() in api/prospects/_scrub.js and re-run to retry them.');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
