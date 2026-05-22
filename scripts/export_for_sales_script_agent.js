#!/usr/bin/env node
/**
 * Dump every lead + every call (transcript, summary, outcome, notes) from
 * Supabase into a pair of files (JSON + CSV) that the sales script agent
 * can read directly.
 *
 * Two outputs, written side-by-side with a timestamp suffix:
 *   - sales_script_export_<ISO>.json  -- nested: { lead, calls: [...] }
 *   - sales_script_export_<ISO>.csv   -- flat: one row per call
 *
 * Default destination is the client deliverables folder so the file is
 * versioned alongside everything else we hand to the agent:
 *   Clients/STILO AI Partners/data/
 *
 * The latest export is also copied to a stable filename (no timestamp) so
 * the agent can always read the most recent dump without scanning:
 *   sales_script_export_latest.json
 *   sales_script_export_latest.csv
 *
 * Usage:
 *   node sites/stilo-ai/scripts/export_for_sales_script_agent.js
 *   node sites/stilo-ai/scripts/export_for_sales_script_agent.js --since 2026-05-01
 *   node sites/stilo-ai/scripts/export_for_sales_script_agent.js --sdr davidcoira@stiloaipartners.com
 *   node sites/stilo-ai/scripts/export_for_sales_script_agent.js --only-with-transcripts
 *   node sites/stilo-ai/scripts/export_for_sales_script_agent.js --out /tmp/export
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in env. Loaded automatically
 * from sites/stilo-ai/.env.local if present.
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
    const out = {
        since: null,
        until: null,
        sdr: null,
        onlyWithTranscripts: false,
        out: null
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--since' && argv[i + 1]) { out.since = argv[++i]; }
        else if (a === '--until' && argv[i + 1]) { out.until = argv[++i]; }
        else if (a === '--sdr' && argv[i + 1]) { out.sdr = argv[++i]; }
        else if (a === '--only-with-transcripts') { out.onlyWithTranscripts = true; }
        else if (a === '--out' && argv[i + 1]) { out.out = argv[++i]; }
        else if (a === '--help' || a === '-h') {
            console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
            process.exit(0);
        }
    }
    return out;
}

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (s.indexOf('"') !== -1 || s.indexOf(',') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

const CSV_COLUMNS = [
    'call_id',
    'called_at',
    'direction',
    'outcome',
    'duration_seconds',
    'logged_by',
    'notes',
    'transcript_summary',
    'transcript',
    'recording_url',
    'openphone_call_id',
    'lead_id',
    'lead_name',
    'owner_name',
    'owner_phone',
    'owner_email',
    'category',
    'prospect_tier',
    'tier',
    'prospect_score',
    'score',
    'stage',
    'pipeline_status',
    'business_profile',
    'outreach_angle',
    'matched_product_name',
    'pain_signals',
    'problem_identified',
    'website',
    'address',
    'rating',
    'reviews',
    'lead_source',
    'assigned_to',
    'do_not_call',
    'lead_last_called_at',
    'lead_last_called_outcome',
    'lead_call_attempts'
];

async function fetchAllLeadCalls(sb, args) {
    // Use prospecting schema for both queries.
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
        let q = sb.from('lead_calls')
            .select('id, lead_id, direction, called_at, outcome, duration_seconds, transcript, transcript_summary, notes, recording_url, openphone_call_id, logged_by, from_number, to_number')
            .order('called_at', { ascending: false })
            .range(from, from + pageSize - 1);
        if (args.since) q = q.gte('called_at', args.since);
        if (args.until) q = q.lte('called_at', args.until);
        if (args.sdr) q = q.eq('logged_by', args.sdr);
        if (args.onlyWithTranscripts) q = q.not('transcript', 'is', null);
        const { data, error } = await q;
        if (error) throw error;
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all;
}

async function fetchLeadsByIds(sb, ids) {
    if (!ids.length) return new Map();
    const pageSize = 200;
    const byId = new Map();
    for (let i = 0; i < ids.length; i += pageSize) {
        const chunk = ids.slice(i, i + pageSize);
        const { data, error } = await sb.from('leads')
            .select('id, name, owner_name, owner_phone, phone, owner_email, email, category, prospect_tier, tier, prospect_score, score, business_profile, outreach_angle, matched_product_name, pain_signals, problem_identified, website, address, rating, reviews, assigned_to, do_not_call, last_called_at, last_called_outcome, call_attempts, stage, pipeline_status, outreach_status, lead_source, source_query, call_notes')
            .in('id', chunk);
        if (error) throw error;
        for (const row of (data || [])) byId.set(row.id, row);
    }
    return byId;
}

function buildNested(calls, leadsById) {
    const byLead = new Map();
    for (const c of calls) {
        const leadId = c.lead_id;
        if (!byLead.has(leadId)) {
            const lead = leadsById.get(leadId) || { id: leadId, name: '(unknown lead)' };
            byLead.set(leadId, { lead, calls: [] });
        }
        byLead.get(leadId).calls.push(c);
    }
    return Array.from(byLead.values()).sort((a, b) => {
        const aLast = a.calls[0] && a.calls[0].called_at;
        const bLast = b.calls[0] && b.calls[0].called_at;
        return (bLast || '').localeCompare(aLast || '');
    });
}

function buildCsv(calls, leadsById) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const c of calls) {
        const l = leadsById.get(c.lead_id) || {};
        const row = [
            c.id,
            c.called_at,
            c.direction,
            c.outcome,
            c.duration_seconds,
            c.logged_by,
            c.notes,
            c.transcript_summary,
            c.transcript,
            c.recording_url,
            c.openphone_call_id,
            c.lead_id,
            l.name,
            l.owner_name,
            l.owner_phone || l.phone,
            l.owner_email || l.email,
            l.category,
            l.prospect_tier,
            l.prospect_score,
            l.business_profile,
            l.outreach_angle,
            l.matched_product_name,
            l.website,
            l.address,
            l.assigned_to,
            l.do_not_call,
            l.last_called_at,
            l.last_called_outcome,
            l.call_attempts
        ].map(csvEscape);
        lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
}

async function main() {
    loadEnvFile();
    const args = parseArgs(process.argv);

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
        console.error('Set them in your shell or in sites/stilo-ai/.env.local before running.');
        process.exit(1);
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    console.log('Pulling lead_calls...');
    const calls = await fetchAllLeadCalls(sb, args);
    console.log('  ' + calls.length + ' calls matched filters.');

    const leadIds = Array.from(new Set(calls.map(c => c.lead_id).filter(x => x != null)));
    console.log('Pulling ' + leadIds.length + ' linked leads...');
    const leadsById = await fetchLeadsByIds(sb, leadIds);
    console.log('  ' + leadsById.size + ' lead rows resolved.');

    const orphanCount = calls.filter(c => !leadsById.has(c.lead_id)).length;
    if (orphanCount) {
        console.warn('  warning: ' + orphanCount + ' call(s) had no matching lead row (likely deleted or stubbed).');
    }

    const nested = buildNested(calls, leadsById);
    const csv = buildCsv(calls, leadsById);

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const defaultOutDir = path.join(repoRoot, 'Clients', 'STILO AI Partners', 'data');
    const outDir = args.out ? path.resolve(args.out) : defaultOutDir;
    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outDir, 'sales_script_export_' + stamp + '.json');
    const csvPath  = path.join(outDir, 'sales_script_export_' + stamp + '.csv');
    const latestJsonPath = path.join(outDir, 'sales_script_export_latest.json');
    const latestCsvPath  = path.join(outDir, 'sales_script_export_latest.csv');

    const meta = {
        generated_at: new Date().toISOString(),
        filters: args,
        counts: {
            total_calls: calls.length,
            unique_leads: leadsById.size,
            calls_with_transcript: calls.filter(c => c.transcript && c.transcript.length).length,
            calls_with_summary: calls.filter(c => c.transcript_summary && c.transcript_summary.length).length,
            orphan_calls: orphanCount
        }
    };

    fs.writeFileSync(jsonPath, JSON.stringify({ meta, leads: nested }, null, 2));
    fs.writeFileSync(latestJsonPath, JSON.stringify({ meta, leads: nested }, null, 2));
    fs.writeFileSync(csvPath, csv);
    fs.writeFileSync(latestCsvPath, csv);

    console.log('\nWrote:');
    console.log('  ' + jsonPath);
    console.log('  ' + csvPath);
    console.log('  ' + latestJsonPath + '  (always points at the latest dump)');
    console.log('  ' + latestCsvPath);
    console.log('\nCounts:');
    console.log('  total calls:           ' + meta.counts.total_calls);
    console.log('  unique leads:          ' + meta.counts.unique_leads);
    console.log('  calls with transcript: ' + meta.counts.calls_with_transcript);
    console.log('  calls with summary:    ' + meta.counts.calls_with_summary);
    if (orphanCount) console.log('  orphan calls:          ' + orphanCount);
}

main().catch(err => {
    console.error('Export failed:', err.message || err);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
