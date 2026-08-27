/**
 * Backfill prospecting.lead_calls.client_account (and lead_messages).
 *
 * An account belongs to the CALL, not the caller. See
 * api/migrations/lead_calls_client_account.sql for why.
 *
 * Rule: a call is client work IFF the lead carries that client_id AND the call
 * happened at or after that client's created_at. The date half matters — a
 * client's lead list overlaps STILO's own prospecting ICP, so leads we called
 * months earlier can carry a client_id today.
 *
 * Usage:  node scripts/backfill_call_accounts.js [--apply]
 * Default is a dry run that prints what would change and writes nothing.
 */
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env.local');
fs.readFileSync(envFile, 'utf8').split('\n').forEach(function (l) {
    const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
});
const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const APPLY = process.argv.indexOf('--apply') !== -1;

function headers(schema) {
    return {
        apikey: K, Authorization: 'Bearer ' + K,
        'Accept-Profile': schema, 'Content-Profile': schema,
        'Content-Type': 'application/json'
    };
}
async function pull(schema, p) {
    const out = []; let from = 0;
    for (;;) {
        const r = await fetch(U + '/rest/v1/' + p, { headers: Object.assign({}, headers(schema), { Range: from + '-' + (from + 999) }) });
        const d = await r.json();
        if (!Array.isArray(d)) { console.error('read failed:', JSON.stringify(d).slice(0, 200)); process.exit(1); }
        out.push.apply(out, d);
        if (d.length < 1000) break;
        from += 1000;
    }
    return out;
}

(async function () {
    const clients = await pull('public', 'clients?select=id,business_name,created_at');
    const byId = {};
    clients.forEach(function (c) { byId[c.id] = c; });
    console.log('clients:', clients.map(function (c) { return c.business_name + ' (since ' + String(c.created_at).slice(0, 10) + ')'; }).join(', ') || '(none)');

    // Only leads that belong to a client can produce client work.
    const leads = await pull('prospecting', 'leads?select=id,client_id&client_id=not.is.null');
    const leadClient = {};
    leads.forEach(function (l) { leadClient[l.id] = l.client_id; });
    console.log('leads owned by a client:', leads.length);

    for (const table of ['lead_calls', 'lead_messages']) {
        const tsCol = table === 'lead_calls' ? 'called_at' : 'sent_at';
        const rows = await pull('prospecting', table + '?select=id,lead_id,' + tsCol + ',client_account');
        const changes = [];
        rows.forEach(function (r) {
            const cid = r.lead_id != null ? leadClient[r.lead_id] : null;
            let want = null;
            if (cid && byId[cid]) {
                const when = r[tsCol] ? new Date(r[tsCol]).getTime() : null;
                const since = new Date(byId[cid].created_at).getTime();
                // No timestamp means we cannot prove it happened during the
                // engagement, so it stays STILO work rather than being guessed
                // into a client's numbers.
                if (when !== null && when >= since) want = byId[cid].business_name;
            }
            const have = r.client_account || null;
            if (want !== have) changes.push({ id: r.id, from: have, to: want });
        });
        const toClient = changes.filter(function (c) { return c.to; });
        console.log('\n' + table + ': ' + rows.length + ' rows, ' + changes.length + ' to change (' + toClient.length + ' -> a client, ' + (changes.length - toClient.length) + ' -> NULL)');
        const byAcct = {};
        toClient.forEach(function (c) { byAcct[c.to] = (byAcct[c.to] || 0) + 1; });
        Object.keys(byAcct).forEach(function (a) { console.log('   ' + a + ': ' + byAcct[a]); });

        if (!APPLY) { console.log('   (dry run, nothing written)'); continue; }
        // Group by target value so this is a handful of statements, not one per row.
        const groups = {};
        changes.forEach(function (c) { const k = c.to === null ? ' null' : c.to; (groups[k] = groups[k] || []).push(c.id); });
        for (const k of Object.keys(groups)) {
            const ids = groups[k];
            const value = k === ' null' ? null : k;
            for (let i = 0; i < ids.length; i += 200) {
                const chunk = ids.slice(i, i + 200);
                const r = await fetch(U + '/rest/v1/' + table + '?id=in.(' + chunk.join(',') + ')', {
                    method: 'PATCH', headers: headers('prospecting'),
                    body: JSON.stringify({ client_account: value })
                });
                if (!r.ok) { console.error('   PATCH failed:', r.status, (await r.text()).slice(0, 160)); process.exit(1); }
            }
            console.log('   wrote ' + ids.length + ' rows -> ' + (value === null ? 'NULL' : value));
        }
    }
    if (!APPLY) console.log('\nRe-run with --apply to write.');
})();
