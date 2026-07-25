/**
 * scripts/setup_stripe_catalog.js
 *
 * Cleans the Stripe product catalog so clients only ever see function names,
 * never internal codenames (ECHO, IGNITE, ORACLE...).
 *
 *   node scripts/setup_stripe_catalog.js --dry     preview
 *   node scripts/setup_stripe_catalog.js           apply
 *
 * Reads STRIPE_SECRET_KEY from the environment (source .env.local first).
 * Safe on live: it only renames/tags/archives PRODUCTS. Prices and past
 * invoices are untouched (Stripe invoices keep their line descriptions).
 *
 * What it does:
 *   1. For every product whose name contains a codename, rename it to the
 *      function name and tag metadata.agent_code so the Close Deal flow
 *      reuses it instead of creating a duplicate.
 *   2. Create clean products for any agent that has none.
 *   3. If several active products end up tagged with the same agent_code,
 *      keep the oldest and archive the rest.
 */
const { DEAL_CATALOG } = require('../api/admin/deals/_catalog');

const CODENAME_TO_CODE = {
    ECHO: 'echo', IGNITE: 'ignite', REVIVE: 'revive', SCOUT: 'scout',
    FORGE: 'forge', SIGNAL: 'signal', ORACLE: 'oracle', PITCH: 'pitch', FLUX: 'flux'
};

async function main() {
    const dry = process.argv.includes('--dry');
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) { console.error('STRIPE_SECRET_KEY not set. Source .env.local first.'); process.exit(1); }
    const stripe = require('stripe')(key);
    const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
    console.log('Mode: ' + mode + (dry ? ' (dry run)' : ''));

    const byCode = {};
    DEAL_CATALOG.forEach(function (a) { byCode[a.code] = a; });

    const products = [];
    for await (const p of stripe.products.list({ active: true, limit: 100 })) products.push(p);
    console.log(products.length + ' active products found.');

    // Pass 1: tag + rename anything carrying a codename.
    for (const p of products) {
        let code = p.metadata && p.metadata.agent_code;
        if (!code) {
            const hit = Object.keys(CODENAME_TO_CODE).find(function (cn) {
                return new RegExp('\\b' + cn + '\\b', 'i').test(p.name);
            });
            if (hit) code = CODENAME_TO_CODE[hit];
        }
        if (!code || !byCode[code]) continue;
        const want = byCode[code].name;
        if (p.name !== want || !(p.metadata && p.metadata.agent_code)) {
            console.log('rename+tag: "' + p.name + '" -> "' + want + '" (agent_code=' + code + ') [' + p.id + ']');
            if (!dry) await stripe.products.update(p.id, { name: want, metadata: Object.assign({}, p.metadata, { agent_code: code, managed_by: 'stilo_close_deal' }) });
            p.name = want; p.metadata = Object.assign({}, p.metadata, { agent_code: code });
        }
    }

    // Pass 2: dedupe per agent_code (keep oldest), then create the missing ones.
    for (const a of DEAL_CATALOG) {
        const matches = products.filter(function (p) { return p.metadata && p.metadata.agent_code === a.code; })
            .sort(function (x, y) { return x.created - y.created; });
        if (matches.length > 1) {
            for (const extra of matches.slice(1)) {
                console.log('archive duplicate: "' + extra.name + '" [' + extra.id + ']');
                if (!dry) await stripe.products.update(extra.id, { active: false });
            }
        }
        if (!matches.length) {
            console.log('create: "' + a.name + '" (agent_code=' + a.code + ')');
            if (!dry) await stripe.products.create({ name: a.name, metadata: { agent_code: a.code, managed_by: 'stilo_close_deal' } });
        }
    }
    console.log('Done.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
