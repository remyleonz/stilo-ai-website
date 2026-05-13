#!/usr/bin/env node
/**
 * Root-cause probe for "My Call History empty even though Called Today populated".
 * Read-only. Asks Supabase:
 *   - does prospecting.lead_calls exist + is it queryable with the service key?
 *   - how many rows are in lead_calls TOTAL? per logged_by?
 *   - what leads have last_called_at in the last 48h?
 *   - for each of those, is there a matching lead_calls row?
 *   - can the service key INSERT a probe row (then immediately delete it)?
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

(function loadEnv() {
    const file = path.resolve(__dirname, '..', '.env.local');
    if (!fs.existsSync(file)) return;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
        if (!m) return;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] == null) process.env[m[1]] = v;
    });
})();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
    process.exit(2);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'prospecting' }
});

async function step(label, fn) {
    console.log('\n=== ' + label + ' ===');
    try { await fn(); } catch (e) { console.error('  ERROR:', e.message || e); }
}

(async () => {
    await step('lead_calls reachable?', async () => {
        const { count, error } = await sb.from('lead_calls').select('id', { count: 'exact', head: true });
        if (error) throw error;
        console.log('  total rows:', count);
    });

    await step('leads reachable?', async () => {
        const { count, error } = await sb.from('leads').select('id', { count: 'exact', head: true });
        if (error) throw error;
        console.log('  total rows:', count);
    });

    await step('lead_calls by logged_by (top 10)', async () => {
        const { data, error } = await sb.from('lead_calls').select('logged_by, called_at').order('called_at', { ascending: false }).limit(500);
        if (error) throw error;
        const tally = {};
        data.forEach(r => { const k = r.logged_by || '(null)'; tally[k] = (tally[k] || 0) + 1; });
        Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v]) => console.log('  ' + v.toString().padStart(4) + '  ' + k));
        console.log('  most recent called_at:', data[0] && data[0].called_at);
    });

    await step('leads last_called_at in last 48h', async () => {
        const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        const { data, error } = await sb.from('leads')
            .select('id, name, owner_name, assigned_to, last_called_at, last_called_outcome')
            .gte('last_called_at', since)
            .order('last_called_at', { ascending: false });
        if (error) throw error;
        console.log('  count:', data.length);
        data.forEach(r => console.log('  ', r.id, '|', r.last_called_at, '|', r.last_called_outcome, '|', r.assigned_to, '|', (r.name || r.owner_name || '').slice(0, 40)));
        // For each, check if a lead_calls row exists within ±5 min
        console.log('\n  matching lead_calls within ±5 min:');
        for (const lead of data) {
            const ts = new Date(lead.last_called_at).getTime();
            const lo = new Date(ts - 5 * 60 * 1000).toISOString();
            const hi = new Date(ts + 5 * 60 * 1000).toISOString();
            const { data: matches } = await sb.from('lead_calls')
                .select('id, called_at, outcome, logged_by')
                .eq('lead_id', lead.id)
                .gte('called_at', lo)
                .lte('called_at', hi);
            console.log('  ', lead.id, '→', matches && matches.length ? (matches.length + ' row(s), logged_by=' + matches.map(m=>m.logged_by).join(',')) : 'MISSING');
        }
    });

    await step('service-key INSERT probe (then DELETE)', async () => {
        // Pick a real lead id to attach to
        const { data: lead } = await sb.from('leads').select('id').limit(1).single();
        if (!lead) { console.log('  no leads to attach probe to, skipping'); return; }
        const probe = {
            lead_id: lead.id,
            direction: 'outbound',
            called_at: new Date().toISOString(),
            outcome: 'diagnostic_probe',
            notes: '[diagnostic probe — auto-deleted]',
            logged_by: 'diagnostic@stilo-test.invalid'
        };
        const { data: ins, error: insErr } = await sb.from('lead_calls').insert(probe).select().single();
        if (insErr) throw insErr;
        console.log('  INSERT ok, row id =', ins.id);
        const { error: delErr } = await sb.from('lead_calls').delete().eq('id', ins.id);
        if (delErr) throw delErr;
        console.log('  DELETE ok (cleaned up)');
    });

    await step('logged_by values in lead_calls — exact match audit', async () => {
        // Are there rows where logged_by looks like the SDR but with whitespace
        // or wrong casing? That would explain my-history empty even with rows
        // present.
        const { data, error } = await sb.from('lead_calls')
            .select('logged_by')
            .limit(2000);
        if (error) throw error;
        const distinct = new Set();
        data.forEach(r => distinct.add(JSON.stringify(r.logged_by)));
        console.log('  distinct logged_by values (', distinct.size, '):');
        Array.from(distinct).slice(0, 20).forEach(v => console.log('  ', v));
    });
})();
