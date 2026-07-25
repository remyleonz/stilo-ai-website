/**
 * api/admin/deals/_catalog.js
 *
 * The deal catalog: what the Close Deal cart shows and the DEFAULT prices it
 * pre-fills. Prices here are defaults only; the admin can edit every number
 * per deal in the cart (first-degree price discrimination). The edited
 * numbers are what get invoiced, stored on deals.line_items.
 *
 * `code` stays the internal agent_type (echo, ignite, ...) because
 * client_agents provisioning and onboarding are keyed on those. `name` is
 * the ONLY thing a client ever sees: plain function names, no codenames,
 * on invoices, subscriptions, and in the Stripe product catalog.
 *
 * ensureStripeProduct() keeps the Stripe catalog clean: one product per
 * agent, named by function, found by metadata.agent_code. Per-deal prices
 * are created ad hoc against these products, so custom pricing never
 * pollutes the catalog with one-off products.
 */

const DEAL_CATALOG = [
    { code: 'echo',   name: 'AI Receptionist',             install_cents: 60000,  monthly_cents: 50000 },
    { code: 'ignite', name: 'Outbound Lead Reply',         install_cents: 60000,  monthly_cents: 50000 },
    { code: 'forge',  name: 'Website',                     install_cents: 100000, monthly_cents: 20000 },
    { code: 'oracle', name: 'Ontology',                    install_cents: 300000, monthly_cents: 200000 },
    { code: 'scout',  name: 'B2B Lead Generation',         install_cents: 70000,  monthly_cents: 60000 },
    { code: 'signal', name: 'AI SEO',                      install_cents: 100000, monthly_cents: 0 },
    { code: 'revive', name: 'Lost Customer Reactivation',  install_cents: 60000,  monthly_cents: 80000 },
    { code: 'pitch',  name: 'AI Sales',                    install_cents: 60000,  monthly_cents: 50000 },
    { code: 'flux',   name: 'Custom Automations',          install_cents: 0,      monthly_cents: 0 },
];

const BY_CODE = {};
DEAL_CATALOG.forEach(function (a) { BY_CODE[a.code] = a; });

/**
 * Find or create the clean Stripe product for an agent code. Matches on
 * metadata.agent_code so renames never orphan it; renames the product if its
 * name drifted (e.g. still carries an old codename).
 */
async function ensureStripeProduct(stripe, code) {
    const def = BY_CODE[code];
    if (!def) throw new Error('unknown_agent_code: ' + code);

    // Legacy install+monthly product pairs can share one agent_code (both kept
    // active so old env-priced checkouts keep working). Pick the OLDEST match
    // so every deal's line items always land on the same product.
    const found = await stripe.products.search({
        query: "active:'true' AND metadata['agent_code']:'" + code + "'",
        limit: 10
    });
    if (found.data.length) {
        const p = found.data.slice().sort(function (a, b) { return a.created - b.created; })[0];
        if (p.name !== def.name) {
            await stripe.products.update(p.id, { name: def.name });
        }
        return p.id;
    }
    const created = await stripe.products.create({
        name: def.name,
        metadata: { agent_code: code, managed_by: 'stilo_close_deal' }
    });
    return created.id;
}

/**
 * Validate + normalize the cart line items from the Close Deal modal.
 * Input: [{code, install_cents, monthly_cents}] with admin-edited amounts.
 * Unknown codes and negative amounts are rejected; names come from the
 * catalog, never from the client.
 */
function normalizeLineItems(raw) {
    if (!Array.isArray(raw) || !raw.length) return { error: 'no_line_items' };
    const items = [];
    for (const r of raw) {
        const def = BY_CODE[r && r.code];
        if (!def) return { error: 'unknown_agent_code', code: r && r.code };
        const install = Math.round(Number(r.install_cents) || 0);
        const monthly = Math.round(Number(r.monthly_cents) || 0);
        if (install < 0 || monthly < 0) return { error: 'negative_amount', code: def.code };
        if (install === 0 && monthly === 0) continue; // nothing billed for this agent
        items.push({ code: def.code, name: def.name, install_cents: install, monthly_cents: monthly });
    }
    if (!items.length) return { error: 'no_billable_items' };
    return { items: items };
}

module.exports = { DEAL_CATALOG, BY_CODE, ensureStripeProduct, normalizeLineItems };
