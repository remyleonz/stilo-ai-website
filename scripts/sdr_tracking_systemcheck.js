#!/usr/bin/env node
/**
 * scripts/sdr_tracking_systemcheck.js
 *
 * Pre-launch system check for the 3 new SDR phone lines (Luke / Jack / Ale).
 *
 * It does NOT place real calls. Instead it forges valid, HMAC-signed Quo
 * webhook events (call.completed + call.transcript.completed) and runs them
 * through the REAL handler at api/openphone/webhook.js against the LIVE
 * Supabase DB, exactly as Quo's servers would. That exercises the whole
 * chain: signature verification -> event parse -> lead resolution ->
 * number-based SDR attribution -> transcript storage -> lead stamping.
 *
 * It then verifies each call landed in prospecting.lead_calls with the right
 * lead_id, logged_by (the rep), and transcript, prints a PASS/FAIL report,
 * and CLEANS UP after itself (deletes the synthetic rows + restores the
 * leads it touched). Pass --keep to leave the synthetic rows in place.
 *
 * It also queries Quo's GET /v1/webhooks so we can confirm the webhook is
 * actually subscribed to the two brand-new numbers (the one gap a forged
 * event can't prove on its own).
 *
 *   node scripts/sdr_tracking_systemcheck.js            # run + clean up
 *   node scripts/sdr_tracking_systemcheck.js --keep     # run + leave rows
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Load .env.local (no dotenv dependency) ──────────────────────────────────
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) return;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!process.env[m[1]]) process.env[m[1]] = val;
    });
}

const { createClient } = require('@supabase/supabase-js');
const { openphoneFetch } = require('../api/openphone/_shared.js');
const webhookHandler = require('../api/openphone/webhook.js');

const KEEP = process.argv.includes('--keep');
// OPENPHONE_WEBHOOK_SIGNING_SECRET is a comma-separated list of per-webhook
// keys (calls, transcripts, summaries). Real call.completed events come from
// the calls webhook, so sign with the first key.
const SIGNING_SECRET = (process.env.OPENPHONE_WEBHOOK_SIGNING_SECRET || '').split(',')[0].trim();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'prospecting' }
});

// ── Test matrix ─────────────────────────────────────────────────────────────
// 1-3: happy path, each rep's line -> their own assigned lead.
// 4:   isolation test — Luke's line -> a lead owned by REMY, with no Quo user
//      id. The ONLY thing that can credit Luke here is the new phone-line map
//      (no seat, lead not his). If this returns Luke, the fix is proven.
const TESTS = [
    { label: 'Luke happy',  expect: 'lukehuron@stiloaipartners.com',        line: '+17868768677', userId: null,        leadId: 12062, to: '(305) 408-0303', biz: 'Trujillo Chiropractic Center' },
    { label: 'Jack happy',  expect: 'jackmaguire@stiloaipartners.com',      line: '+17869819302', userId: 'USCFfV4w6g', leadId: 18586, to: '(305) 821-1800', biz: 'Walter Sanchez Chiropractic' },
    { label: 'Ale happy',   expect: 'alejandrobarrios@stiloaipartners.com', line: '+17867557104', userId: 'USHJZZYPss', leadId: 14634, to: '(561) 232-0263', biz: 'Infinity Beauty Lab Med Spa' },
    { label: 'Luke→Remy lead (isolation)', expect: 'lukehuron@stiloaipartners.com', line: '+17868768677', userId: null, leadId: 2390, to: '(561) 395-1486', biz: 'East Boca Dental' },
];

function sign(rawStr) {
    const ts = Date.now().toString();
    const key = Buffer.from(SIGNING_SECRET, 'base64');
    const sig = crypto.createHmac('sha256', key).update(ts + '.' + rawStr).digest('base64');
    return 'hmac;1;' + ts + ';' + sig;
}

function mockRes() {
    const r = { _status: null, _json: null, _headers: {} };
    r.setHeader = (k, v) => { r._headers[k] = v; };
    r.status = (c) => { r._status = c; return r; };
    r.json = (b) => { r._json = b; return r; };
    return r;
}

async function deliver(event) {
    const rawStr = JSON.stringify(event);
    const req = {
        method: 'POST',
        headers: { 'openphone-signature': sign(rawStr) },
        rawBody: Buffer.from(rawStr, 'utf8'),
    };
    const res = mockRes();
    await webhookHandler(req, res);
    return res;
}

function isoAgo(sec) { return new Date(Date.now() - sec * 1000).toISOString(); }

async function main() {
    if (!SIGNING_SECRET) { console.error('Missing OPENPHONE_WEBHOOK_SIGNING_SECRET'); process.exit(1); }
    console.log('\n================  SDR TRACKING SYSTEM CHECK  ================\n');

    // ── 0. Quo webhook coverage ─────────────────────────────────────────────
    console.log('— Quo webhook subscription (GET /v1/webhooks) —');
    try {
        const wh = await openphoneFetch({ path: '/webhooks' });
        if (wh.status === 200 && wh.json) {
            const hooks = wh.json.data || wh.json;
            (Array.isArray(hooks) ? hooks : [hooks]).forEach(h => {
                console.log('  • ' + (h.url || '(no url)'));
                console.log('    status: ' + (h.status || '?') + ' | events: ' + JSON.stringify(h.events || h.resourceType || '?'));
                const scope = h.resourceIds || h.phoneNumberIds || h.resourceId || null;
                console.log('    scope:  ' + (scope ? JSON.stringify(scope) : 'ALL numbers (no resourceIds filter)'));
            });
        } else {
            console.log('  (could not list webhooks: status ' + wh.status + ' ' + JSON.stringify(wh.json) + ')');
        }
    } catch (e) { console.log('  (webhook list error: ' + (e.message || e) + ')'); }
    console.log('');

    // ── 1. Snapshot the leads we touch, so we can restore them ──────────────
    const touchedLeadIds = [...new Set(TESTS.map(t => t.leadId))];
    const { data: snap } = await sb.from('leads')
        .select('id, assigned_to, last_called_at, last_called_outcome, call_attempts, next_action_type, next_action_due_at, primary_language')
        .in('id', touchedLeadIds);
    const snapshot = new Map((snap || []).map(r => [r.id, r]));

    const syntheticIds = [];
    const results = [];

    // ── 2. Run each test ────────────────────────────────────────────────────
    for (let i = 0; i < TESTS.length; i++) {
        const t = TESTS[i];
        const callId = 'TEST-SYSCHECK-' + t.line.replace('+', '') + '-' + Date.now() + '-' + i;
        syntheticIds.push(callId);

        const callObj = {
            id: callId, direction: 'outgoing', from: t.line, to: t.to,
            status: 'completed', createdAt: isoAgo(100), answeredAt: isoAgo(92), completedAt: isoAgo(0),
        };
        if (t.userId) callObj.userId = t.userId;

        const completedRes = await deliver({ type: 'call.completed', data: { object: callObj } });

        const transcriptRes = await deliver({
            type: 'call.transcript.completed',
            data: { object: {
                id: callId, direction: 'outgoing', from: t.line, to: t.to,
                dialogue: [
                    { userId: t.userId || 'rep', identifier: t.line, content: 'Hi, this is a STILO AI Partners rep calling for the owner.' },
                    { userId: null, identifier: t.to, content: 'Speaking — what is this about?' },
                    { userId: t.userId || 'rep', identifier: t.line, content: 'We help local businesses add AI. Could I book 15 minutes with you?' },
                ],
            } },
        });

        const { data: row } = await sb.from('lead_calls')
            .select('id, lead_id, logged_by, outcome, duration_seconds, transcript, from_number, to_number, openphone_call_id')
            .eq('openphone_call_id', callId).maybeSingle();

        const pass = !!row
            && row.lead_id === t.leadId
            && row.logged_by === t.expect
            && !!row.transcript
            && row.outcome === 'answered'
            && row.duration_seconds > 0;

        results.push({ t, completedRes, transcriptRes, row, pass });
    }

    // ── 3. Report ───────────────────────────────────────────────────────────
    console.log('— End-to-end results (forged signed events → real handler → live DB) —\n');
    for (const r of results) {
        const { t, completedRes, transcriptRes, row, pass } = r;
        console.log((pass ? '  ✅ PASS  ' : '  ❌ FAIL  ') + t.label + '  (' + t.biz + ')');
        console.log('     completed→ HTTP ' + completedRes._status + '  ' + JSON.stringify(completedRes._json));
        console.log('     transcript→ HTTP ' + transcriptRes._status + '  ' + JSON.stringify(transcriptRes._json));
        if (row) {
            console.log('     lead_id:    ' + row.lead_id + (row.lead_id === t.leadId ? ' ✓' : ' ✗ expected ' + t.leadId));
            console.log('     logged_by:  ' + row.logged_by + (row.logged_by === t.expect ? ' ✓' : ' ✗ expected ' + t.expect));
            console.log('     from→to:    ' + row.from_number + ' → ' + row.to_number);
            console.log('     duration:   ' + row.duration_seconds + 's | outcome: ' + row.outcome);
            console.log('     transcript: ' + (row.transcript ? '"' + row.transcript.slice(0, 60).replace(/\n/g, ' ') + '..." ✓' : 'MISSING ✗'));
        } else {
            console.log('     NO ROW written for ' + t.line);
        }
        console.log('');
    }
    const passed = results.filter(r => r.pass).length;
    console.log('  ' + passed + ' / ' + results.length + ' passed.\n');

    // ── 4. Cleanup ──────────────────────────────────────────────────────────
    if (KEEP) {
        console.log('— --keep set: leaving synthetic rows + lead changes in place. —');
        console.log('  synthetic openphone_call_ids: ' + JSON.stringify(syntheticIds));
        return;
    }
    console.log('— Cleanup —');
    const { error: delErr, count } = await sb.from('lead_calls')
        .delete({ count: 'exact' }).in('openphone_call_id', syntheticIds);
    console.log('  deleted ' + (count != null ? count : '?') + ' synthetic lead_calls rows' + (delErr ? ' (err: ' + delErr.message + ')' : ''));

    for (const id of touchedLeadIds) {
        const s = snapshot.get(id);
        if (!s) continue;
        const { error } = await sb.from('leads').update({
            last_called_at: s.last_called_at,
            last_called_outcome: s.last_called_outcome,
            call_attempts: s.call_attempts,
            next_action_type: s.next_action_type,
            next_action_due_at: s.next_action_due_at,
            primary_language: s.primary_language,
        }).eq('id', id);
        console.log('  restored lead ' + id + (error ? ' (err: ' + error.message + ')' : ' ✓'));
    }
    console.log('\n  Lead assignments were NOT touched (Luke/Jack/Ale keep their test leads).');
    console.log('============================================================\n');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
