#!/usr/bin/env node
/**
 * Backfill prospecting.lead_calls rows that were lost when the live
 * /api/prospects/log-call handler ran without SUPABASE_SERVICE_KEY set on
 * prod (or otherwise failed the Supabase INSERT silently). Yesterday's six
 * calls went through the upstream forward — which updates prospecting.leads
 * (so Called Today + Cold Call demotion work) — but never landed in
 * lead_calls, so My Call History is empty.
 *
 * What this script does:
 *   1. Fetches prospecting.leads where last_called_at is in the chosen
 *      window AND last_called_outcome is set AND assigned_to is non-null.
 *   2. For each lead, checks whether a matching lead_calls row already
 *      exists (lead_id + called_at within 5 minutes of last_called_at). If
 *      it does, skips. Otherwise queues an INSERT.
 *   3. With --apply: writes a synthesized row with notes flagging the
 *      backfill, logged_by inferred from assigned_to (falling back to
 *      DEFAULT_LOGGED_BY).
 *
 * Usage:
 *   node sites/stilo-ai/scripts/backfill_lead_calls.js                 # dry run
 *   node sites/stilo-ai/scripts/backfill_lead_calls.js --apply         # write
 *   node sites/stilo-ai/scripts/backfill_lead_calls.js --since 2026-05-12 --until 2026-05-13 --apply
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in env. Pulls them from
 * sites/stilo-ai/.env.local if present.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnvFile() {
    const candidate = path.resolve(__dirname, '..', '.env.local');
    if (!fs.existsSync(candidate)) return;
    const lines = fs.readFileSync(candidate, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
        if (!m) continue;
        if (process.env[m[1]] != null) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
    }
}

function parseArgs(argv) {
    const out = { apply: false, since: null, until: null, defaultLoggedBy: 'remyleon@stiloaipartners.com' };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--since' && argv[i + 1]) { out.since = argv[++i]; }
        else if (a === '--until' && argv[i + 1]) { out.until = argv[++i]; }
        else if (a === '--default-logged-by' && argv[i + 1]) { out.defaultLoggedBy = argv[++i]; }
    }
    if (!out.since && !out.until) {
        // Default window: yesterday 00:00 ET to today 00:00 ET.
        // ET is UTC-4 (DST) — close enough for a one-off backfill, the
        // 5-minute matching window absorbs slack.
        const now = new Date();
        const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0));
        const yesterdayUtcMidnight = new Date(todayUtcMidnight.getTime() - 24 * 60 * 60 * 1000);
        out.since = yesterdayUtcMidnight.toISOString();
        out.until = todayUtcMidnight.toISOString();
    }
    return out;
}

function sdrEmailFromAssignedTo(assignedTo, fallback) {
    if (!assignedTo) return fallback;
    const v = String(assignedTo).trim().toLowerCase();
    // assigned_to could be either the email or the sdr key. Normalize both.
    if (v.includes('@')) return v;
    if (v === 'remy') return 'remyleon@stiloaipartners.com';
    if (v === 'david') return 'davidcoira@stiloaipartners.com';
    return fallback;
}

async function main() {
    loadEnvFile();
    const args = parseArgs(process.argv);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Add them to sites/stilo-ai/.env.local or export them.');
        process.exit(2);
    }
    console.log('window:', args.since, '→', args.until);
    console.log('apply :', args.apply ? 'YES (will INSERT)' : 'no (dry run)');
    console.log('fallback logged_by:', args.defaultLoggedBy);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const { data: leads, error: leadsErr } = await sb.from('leads')
        .select('id, name, owner_name, assigned_to, last_called_at, last_called_outcome')
        .gte('last_called_at', args.since)
        .lt('last_called_at', args.until)
        .not('last_called_outcome', 'is', null)
        .order('last_called_at', { ascending: true });
    if (leadsErr) { console.error('leads fetch failed:', leadsErr.message); process.exit(1); }
    console.log('candidate leads:', leads.length);

    const inserts = [];
    for (const lead of leads) {
        const stamp = new Date(lead.last_called_at);
        const lo = new Date(stamp.getTime() - 5 * 60 * 1000).toISOString();
        const hi = new Date(stamp.getTime() + 5 * 60 * 1000).toISOString();
        const { data: existing, error: existsErr } = await sb.from('lead_calls')
            .select('id, called_at, logged_by')
            .eq('lead_id', lead.id)
            .gte('called_at', lo)
            .lte('called_at', hi)
            .limit(1);
        if (existsErr) { console.warn('  exists check failed for lead', lead.id, existsErr.message); continue; }
        if (existing && existing.length) {
            console.log('  skip lead', lead.id, '(already has lead_calls row at', existing[0].called_at, ')');
            continue;
        }
        const loggedBy = sdrEmailFromAssignedTo(lead.assigned_to, args.defaultLoggedBy);
        const row = {
            lead_id: lead.id,
            direction: 'outbound',
            called_at: lead.last_called_at,
            outcome: lead.last_called_outcome,
            notes: '[backfilled ' + new Date().toISOString().slice(0, 10) + ' — original log-call lost to env var miss]',
            logged_by: loggedBy
        };
        inserts.push(row);
        console.log('  queue lead', lead.id, lead.name || lead.owner_name || '', '→', loggedBy, '@', lead.last_called_at);
    }

    console.log('total to insert:', inserts.length);
    if (!args.apply) {
        console.log('dry run — pass --apply to write.');
        return;
    }
    if (!inserts.length) {
        console.log('nothing to insert.');
        return;
    }

    // Insert in small batches to keep the response payload reasonable.
    for (let i = 0; i < inserts.length; i += 50) {
        const batch = inserts.slice(i, i + 50);
        const { error: insErr } = await sb.from('lead_calls').insert(batch);
        if (insErr) { console.error('  batch insert failed:', insErr.message); process.exit(1); }
        console.log('  inserted', batch.length);
    }
    console.log('done.');
}

main().catch(e => { console.error(e); process.exit(1); });
