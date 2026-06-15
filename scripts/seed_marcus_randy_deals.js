#!/usr/bin/env node
/**
 * Seed demo deals for Marcus Lindsey Cleaning + Randy Rejuvenation Clinic.
 *
 * Marcus (last month, the 10th):  Lead Generator (scout)  $4,000 + $2,000/mo
 * Randy  (this month):  Website (forge)         $6,000 + $500/mo
 *                       AI SEO (signal)         $1,500 one-time
 *
 * Both flagged with notes='SEED:2026-05-26 — temporary; see memory note
 * for removal instructions.' so cleanup is easy later.
 *
 * Idempotent: skips inserts if a SEED deal already exists for the client.
 */

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) return;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
});

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const SEED_TAG = 'SEED:2026-05-26';

// ------------------------------------------------------------------
async function getOrCreateAuthUser(email, metadata) {
    let page = 1;
    while (page < 20) {
        const { data: listed } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        const match = (listed.users || []).find(u => (u.email || '').toLowerCase() === email.toLowerCase());
        if (match) return match.id;
        if (!listed.users || listed.users.length < 1000) break;
        page++;
    }
    const { data: created, error } = await sb.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: metadata || {}
    });
    if (error) throw new Error('auth_create_failed: ' + error.message);
    return created.user.id;
}

async function getOrCreateClient(opts) {
    // opts: { email, business_name, contact_name, phone? }
    const { data: existing } = await sb.from('clients').select('*').eq('email', opts.email).maybeSingle();
    if (existing) {
        const patch = {};
        if (existing.business_name !== opts.business_name) patch.business_name = opts.business_name;
        if (opts.contact_name && existing.contact_name !== opts.contact_name) patch.contact_name = opts.contact_name;
        if (opts.phone && existing.phone !== opts.phone) patch.phone = opts.phone;
        if (existing.status !== 'active') patch.status = 'active';
        if (Object.keys(patch).length) await sb.from('clients').update(patch).eq('id', existing.id);
        return existing.id;
    }
    const authId = await getOrCreateAuthUser(opts.email, {
        business_name: opts.business_name, source: 'admin_seed'
    });
    // Trigger creates the clients row from auth.users insert. Update it now.
    await new Promise(r => setTimeout(r, 500));
    const { data: postTrigger } = await sb.from('clients').select('*').eq('id', authId).maybeSingle();
    if (postTrigger) {
        await sb.from('clients').update({
            business_name: opts.business_name,
            contact_name: opts.contact_name || null,
            phone: opts.phone || null,
            status: 'active'
        }).eq('id', authId);
    } else {
        // Trigger didn't fire (shouldn't happen). Manual insert.
        await sb.from('clients').insert({
            id: authId,
            email: opts.email,
            business_name: opts.business_name,
            contact_name: opts.contact_name || null,
            phone: opts.phone || null,
            status: 'active'
        });
    }
    return authId;
}

async function ensureClientAgent(clientId, agentType, status, activatedAt) {
    const { data: existing } = await sb.from('client_agents')
        .select('id, status')
        .eq('client_id', clientId).eq('agent_type', agentType).maybeSingle();
    if (existing) {
        if (existing.status !== status) {
            await sb.from('client_agents').update({
                status, activated_at: activatedAt || new Date().toISOString()
            }).eq('id', existing.id);
        }
        return existing.id;
    }
    const { data: created, error } = await sb.from('client_agents').insert({
        client_id: clientId,
        agent_type: agentType,
        status,
        activated_at: activatedAt || new Date().toISOString(),
        config: { provisioned_via: 'admin_seed_2026_05_26' }
    }).select('id').single();
    if (error) throw new Error('client_agents insert failed: ' + error.message);
    return created.id;
}

async function ensureDeal(opts) {
    // Skip if a SEED deal already exists for this client + agent_codes.
    const { data: existing } = await sb.from('deals')
        .select('id, notes')
        .eq('client_id', opts.client_id)
        .like('notes', '%' + SEED_TAG + '%');
    if (existing && existing.length) {
        // Update fees + dates in case caller wants to reseed
        await sb.from('deals').update({
            agent_codes: opts.agent_codes,
            upfront_fee_cents: opts.upfront_fee_cents,
            monthly_retainer_cents: opts.monthly_retainer_cents,
            stage: opts.stage,
            closed_at: opts.closed_at,
            paid_at: opts.paid_at,
            notes: opts.notes
        }).eq('id', existing[0].id);
        return existing[0].id;
    }
    const { data: created, error } = await sb.from('deals').insert({
        client_id: opts.client_id,
        sdr_id: null,                       // closed by Remy directly, no SDR
        business_name: opts.business_name,
        contact_email: opts.contact_email,
        contact_name: opts.contact_name,
        agent_codes: opts.agent_codes,
        upfront_fee_cents: opts.upfront_fee_cents,
        monthly_retainer_cents: opts.monthly_retainer_cents,
        payment_method: 'manual',
        stage: opts.stage,
        closed_at: opts.closed_at,
        paid_at: opts.paid_at,
        notes: opts.notes
    }).select('id').single();
    if (error) throw new Error('deal insert failed: ' + error.message);
    return created.id;
}

// ------------------------------------------------------------------
async function main() {
    const now = new Date();
    // "Last month" close date for Marcus — the 10th of the prior month
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10, 14, 0, 0).toISOString();
    // "This month" for Randy — week ago in current month
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 7), 11, 30, 0).toISOString();

    console.log('Marcus close date:', lastMonth);
    console.log('Randy close date:', thisMonth);
    console.log();

    // Agent codes use the canonical codenames per _agents.js: scout (lead gen),
    // forge (website), signal (AI SEO). Marcus's existing row had the legacy
    // value 'lead_generator' which the rest of the stack doesn't recognize —
    // we migrate it to 'scout' here so AGENT_FEES_MONTHLY lookups work.

    // ----- MARCUS -----
    const marcusClientId = 'bb2e4438-1306-43d7-a56a-4a1c3632816f';
    console.log('[Marcus] migrating client_agent lead_generator → scout...');
    await sb.from('client_agents')
        .update({ agent_type: 'scout' })
        .eq('client_id', marcusClientId)
        .eq('agent_type', 'lead_generator');
    console.log('[Marcus] ensuring Lead Generator client_agent (idempotent)...');
    await ensureClientAgent(marcusClientId, 'scout', 'active', lastMonth);
    console.log('[Marcus] ensuring deal...');
    const marcusDealId = await ensureDeal({
        client_id: marcusClientId,
        business_name: 'Marcus Lindsey Cleaning',
        contact_name: 'Marcus Lindsey',
        contact_email: 'marcuslindsey8@gmail.com',
        agent_codes: ['scout'],
        upfront_fee_cents: 400000,
        monthly_retainer_cents: 200000,
        stage: 'ONBOARDING',
        closed_at: lastMonth,
        paid_at: lastMonth,
        notes: SEED_TAG + ' — Marcus Lindsey Cleaning, Lead Generator, $4,000 + $2,000/mo. Friends-and-family. Eventually make this agent free per Remy.'
    });
    console.log('  → deal', marcusDealId);
    console.log();

    // ----- RANDY -----
    console.log('[Randy] ensuring client...');
    const randyClientId = await getOrCreateClient({
        email: 'randy@randyrejuvenation.com',
        business_name: 'Randy Rejuvenation Clinic',
        contact_name: 'Dr. Randy Lindgren',
        phone: null
    });
    console.log('  client_id', randyClientId);
    console.log('[Randy] ensuring Website + AI SEO client_agents...');
    await ensureClientAgent(randyClientId, 'forge', 'active', thisMonth);
    await ensureClientAgent(randyClientId, 'signal', 'active', thisMonth);
    console.log('[Randy] ensuring deal...');
    const randyDealId = await ensureDeal({
        client_id: randyClientId,
        business_name: 'Randy Rejuvenation Clinic',
        contact_name: 'Dr. Randy Lindgren',
        contact_email: 'randy@randyrejuvenation.com',
        agent_codes: ['forge', 'signal'],
        upfront_fee_cents: 750000,           // 6000 + 1500
        monthly_retainer_cents: 50000,       // 500 (only website is recurring)
        stage: 'ONBOARDING',
        closed_at: thisMonth,
        paid_at: thisMonth,
        notes: SEED_TAG + ' — Randy Rejuvenation Clinic, Website ($6,000 + $500/mo) + AI SEO ($1,500 one-time). Closed this month. Eventually remove this client entirely per Remy.'
    });
    console.log('  → deal', randyDealId);
    console.log();

    console.log('Seeding complete.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
