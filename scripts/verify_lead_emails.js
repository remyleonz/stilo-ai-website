/**
 * scripts/verify_lead_emails.js
 *
 * Free email verification for the whole lead base. No API key, no subscription,
 * no per-record cost. DNS only.
 *
 * WHY THIS EXISTS
 *
 * The sending domain was running a 14.9% bounce rate (75 bounces on 505 sends).
 * Healthy is under 2%; 5% is where mailbox providers start throttling and Resend
 * starts suspending accounts. At 14.9% every campaign was quietly degrading the
 * domain that the whole email channel depends on.
 *
 * A sweep of all 3,190 distinct addresses found the cause, and it was not copy:
 *
 *     463 addresses (14.5%) sit on domains with NO MX RECORD AT ALL
 *   2,423 addresses (76%)   are role inboxes (info@, sales@, office@ ...)
 *
 * 14.5% dead domains against a 14.9% observed bounce rate is not a coincidence.
 * The bounce problem was never a mystery and never needed a paid verifier: a
 * domain with no mail server cannot receive mail, and that is one free DNS
 * lookup away from being known.
 *
 * Role inboxes are a separate, softer problem: they DO accept mail, they just
 * bounce at 22.3% historically and produced 1 open and 0 replies across 103
 * sends. They are marked distinctly rather than lumped in with the dead ones,
 * because "never bulk-mail this" and "this address does not exist" deserve
 * different handling.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No SMTP handshake probing (RCPT TO). It is slow, many servers accept-then-
 * discard so the answer is unreliable, and hammering strangers' mail servers
 * from your sending IP is a good way to get that IP listed. MX presence plus
 * syntax plus role detection captures essentially all of the recoverable signal
 * for free. Whatever is left needs a paid verifier, and given the numbers above
 * there is very little left.
 *
 * Domain results are cached in prospecting.email_domain_cache, so re-runs cost
 * almost nothing: 3,190 addresses share only 2,980 domains, and MX records
 * rarely change.
 *
 * Usage:
 *   node sites/stilo-ai/scripts/verify_lead_emails.js --dry
 *   node sites/stilo-ai/scripts/verify_lead_emails.js
 *   node sites/stilo-ai/scripts/verify_lead_emails.js --recheck   (ignore cache)
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const RECHECK = args.includes('--recheck');
const CONCURRENCY = 40;

// Role prefixes that reach a shared mailbox rather than a decision maker.
const ROLE = /^(info|sales|office|contact|admin|hello|support|team|billing|service|help|enquiries|inquiries|reception|frontdesk|front desk|accounts|noreply|no-reply)@/i;
const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
        process.exit(1);
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}

async function loadDomainCache(db) {
    if (RECHECK) return new Map();
    const cache = new Map();
    let from = 0;
    for (;;) {
        const { data, error } = await db.from('email_domain_cache').select('domain,has_mx,mx_host').range(from, from + 999);
        if (error) break;
        if (!data.length) break;
        for (const r of data) cache.set(r.domain, { has_mx: r.has_mx, mx_host: r.mx_host });
        if (data.length < 1000) break;
        from += 1000;
    }
    return cache;
}

async function resolveDomains(domains, cache) {
    const todo = domains.filter(d => !cache.has(d));
    const fresh = [];
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
        await Promise.all(todo.slice(i, i + CONCURRENCY).map(async function (d) {
            let rec = { has_mx: false, mx_host: null };
            try {
                const mx = await dns.resolveMx(d);
                if (mx && mx.length) {
                    mx.sort((a, b) => a.priority - b.priority);
                    rec = { has_mx: true, mx_host: mx[0].exchange };
                }
            } catch (e) {
                // ENOTFOUND / ENODATA / SERVFAIL all mean "cannot receive mail
                // via a resolvable MX". Recorded as dead; --recheck retries.
                rec = { has_mx: false, mx_host: null };
            }
            cache.set(d, rec);
            fresh.push({ domain: d, has_mx: rec.has_mx, mx_host: rec.mx_host });
        }));
        if ((i / CONCURRENCY) % 10 === 0 && i) process.stdout.write('   ...' + i + '/' + todo.length + ' domains\n');
    }
    return fresh;
}

function classify(email, cache) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return { status: 'unchecked', reason: 'no_address' };
    if (!SYNTAX.test(e)) return { status: 'malformed', reason: 'bad_syntax' };
    const d = e.split('@')[1];
    const rec = cache.get(d);
    if (!rec || !rec.has_mx) return { status: 'dead_domain', reason: 'no_mx_record' };
    if (ROLE.test(e)) return { status: 'role_inbox', reason: 'shared_mailbox' };
    return { status: 'deliverable', reason: null };
}

(async () => {
    const db = sb();

    let leads = [], from = 0;
    for (;;) {
        const { data, error } = await db.from('leads')
            .select('id,owner_email,email').order('id', { ascending: true }).range(from, from + 999);
        if (error) { console.error('leads read failed: ' + error.message); process.exit(1); }
        if (!data.length) break;
        leads = leads.concat(data);
        if (data.length < 1000) break;
        from += 1000;
    }

    const withAddr = leads
        .map(l => ({ id: l.id, addr: String(l.owner_email || l.email || '').trim().toLowerCase() }))
        .filter(l => l.addr);

    const domains = [...new Set(withAddr.map(l => l.addr.split('@')[1]).filter(Boolean))];
    console.log('leads: ' + leads.length + '  |  with an address: ' + withAddr.length + '  |  distinct domains: ' + domains.length);

    const cache = await loadDomainCache(db);
    console.log('domain cache hits: ' + cache.size + '  |  to resolve: ' + domains.filter(d => !cache.has(d)).length);
    const fresh = await resolveDomains(domains, cache);

    if (!DRY && fresh.length) {
        for (let i = 0; i < fresh.length; i += 500) {
            await db.from('email_domain_cache').upsert(fresh.slice(i, i + 500), { onConflict: 'domain' });
        }
        console.log('cached ' + fresh.length + ' domain results');
    }

    const stats = { deliverable: 0, dead_domain: 0, role_inbox: 0, malformed: 0 };
    const updates = [];
    const now = new Date().toISOString();
    for (const l of withAddr) {
        const v = classify(l.addr, cache);
        stats[v.status] = (stats[v.status] || 0) + 1;
        updates.push({ id: l.id, email_verify_status: v.status, email_verify_reason: v.reason, email_verify_checked_at: now, email_verify_address: l.addr });
    }

    console.log('\n--- verdicts ---');
    const tot = withAddr.length;
    Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
        console.log('  ' + k.padEnd(14) + String(v).padStart(6) + '   ' + (100 * v / tot).toFixed(1) + '%'));
    console.log('\n  BULK-MAILABLE (deliverable only): ' + stats.deliverable);

    if (DRY) { console.log('\nDry run. Nothing written.'); return; }

    let wrote = 0;
    for (const u of updates) {
        const { error } = await db.from('leads').update({
            email_verify_status: u.email_verify_status,
            email_verify_reason: u.email_verify_reason,
            email_verify_checked_at: u.email_verify_checked_at,
            email_verify_address: u.email_verify_address,
        }).eq('id', u.id);
        if (!error) wrote++;
        if (wrote % 500 === 0 && wrote) console.log('   ...' + wrote + ' leads stamped');
    }
    console.log('\nstamped ' + wrote + ' of ' + updates.length + ' leads');
})().catch(e => { console.error(e); process.exit(1); });
