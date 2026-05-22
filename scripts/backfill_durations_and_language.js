#!/usr/bin/env node
/**
 * One-off backfill for the two bugs we just shipped fixes for:
 *
 *   1. duration_seconds was always NULL on Quo rows because the webhook
 *      was looking for a `call.duration` field that doesn't exist.
 *      Compute it from raw_payload.data.object.{answeredAt, completedAt}.
 *
 *   2. leads.primary_language is brand-new; existing transcripts haven't
 *      been classified yet. Re-run the same conservative detector the
 *      webhook now uses on every historical transcript, stamping the
 *      lead row (only when primary_language IS NULL — we never overwrite).
 *
 * Dry run by default. Pass --apply to write.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

(function loadEnv() {
    const f = path.resolve(__dirname, '..', '.env.local');
    if (!fs.existsSync(f)) return;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
        if (!m || process.env[m[1]] != null) return;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
    });
})();

const apply = process.argv.includes('--apply');

const SPANISH_WORDS = ['hola','gracias','sí','está','tiene','buenos días','buenas tardes','cómo está','cómo estás','español','claro que sí','muchas gracias','por favor','mucho gusto','perdón','disculpe','dígame','permítame','dispense','de nada','llamo','llamando','negocio','dueño','propietario','¿cómo','¿qué','¿dónde','¿cuándo','está bien','está usted','no entiendo','no problema'];
function detectLanguage(transcript) {
    if (!transcript || typeof transcript !== 'string') return null;
    const t = transcript.toLowerCase();
    if (t.length < 50) return null;
    if (/[ñ¿¡]/.test(transcript)) return 'es';
    let hits = 0;
    for (const w of SPANISH_WORDS) {
        if (t.indexOf(w) !== -1) hits++;
        if (hits >= 3) return 'es';
    }
    return 'en';
}
function deriveDur(call) {
    if (!call) return null;
    const completed = call.completedAt || call.endedAt;
    const answered = call.answeredAt;
    if (!completed) return null;
    if (!answered) return 0;
    const ms = new Date(completed).getTime() - new Date(answered).getTime();
    if (!isFinite(ms) || ms < 0) return null;
    return Math.round(ms / 1000);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    db: { schema: 'prospecting' }
});

async function backfillDurations() {
    console.log('\n=== DURATION BACKFILL ===');
    const { data: rows } = await sb.from('lead_calls')
        .select('id, openphone_call_id, duration_seconds, raw_payload')
        .not('openphone_call_id', 'is', null);
    let computed = 0;
    let already = 0;
    let cantCompute = 0;
    const updates = [];
    for (const r of rows) {
        if (r.duration_seconds != null) { already++; continue; }
        const rp = r.raw_payload || {};
        const inner = (rp.data && (rp.data.object || rp.data.call)) || rp.data || {};
        const d = deriveDur(inner);
        if (d == null) { cantCompute++; continue; }
        updates.push({ id: r.id, duration_seconds: d });
        computed++;
    }
    console.log('  already set:           ' + already);
    console.log('  newly computed:        ' + computed);
    console.log('  no timestamps to use:  ' + cantCompute + '  (these rows only ever got call.summary.completed)');
    if (apply && updates.length) {
        for (const u of updates) {
            await sb.from('lead_calls').update({ duration_seconds: u.duration_seconds }).eq('id', u.id);
        }
        console.log('  applied:               ' + updates.length);
    } else if (updates.length) {
        console.log('  (dry run — would update ' + updates.length + ' rows. Use --apply to write.)');
        console.log('  sample:', JSON.stringify(updates.slice(0, 5)));
    }
}

async function backfillLanguage() {
    console.log('\n=== LANGUAGE BACKFILL ===');
    const { data: calls } = await sb.from('lead_calls')
        .select('id, lead_id, transcript')
        .not('transcript', 'is', null)
        .not('lead_id', 'is', null);
    const detectedByLead = new Map();
    for (const c of calls) {
        const lang = detectLanguage(c.transcript);
        if (!lang) continue;
        // First non-null transcript per lead wins. If we ever see Spanish,
        // Spanish wins (rare for an English-default lead to slip a Spanish
        // call in; if it happens it's the more salient signal).
        const prior = detectedByLead.get(c.lead_id);
        if (!prior || (prior === 'en' && lang === 'es')) {
            detectedByLead.set(c.lead_id, lang);
        }
    }
    console.log('  leads with at least one transcript: ' + detectedByLead.size);
    const langCounts = {};
    detectedByLead.forEach(v => { langCounts[v] = (langCounts[v]||0) + 1; });
    Object.entries(langCounts).forEach(([k,v]) => console.log('    ' + k + ': ' + v));

    if (apply) {
        let wrote = 0;
        for (const [leadId, lang] of detectedByLead) {
            const { error } = await sb.from('leads')
                .update({ primary_language: lang })
                .eq('id', leadId)
                .is('primary_language', null);
            if (!error) wrote++;
        }
        console.log('  applied:               ' + wrote + ' (only rows where primary_language was NULL)');
    } else {
        console.log('  (dry run — use --apply to write)');
    }
}

(async () => {
    await backfillDurations();
    await backfillLanguage();
    console.log(apply ? '\nDone (writes applied).' : '\nDone (dry run). Re-run with --apply to write.');
})().catch(e => { console.error('Backfill failed:', e); process.exit(1); });
