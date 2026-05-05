/**
 * POST /api/openphone/sync-contacts
 *
 * Push every callable prospect into Quo as a contact so the user can dial
 * them from the Quo iPhone or Mac app without retyping. Idempotent — uses
 * Quo's externalId field to dedupe (set to "stilo_prospect_<id>"). Existing
 * contacts are skipped.
 *
 * Body: { force?: boolean } — set force=true to re-sync prospects that
 * already have a Quo contact (will create duplicates; only use after a
 * Quo-side delete).
 *
 * Returns: { created: number, skipped: number, failed: number, errors: [] }
 */

const { assertAdmin, methodNotAllowed, readJsonBody } = require('../prospects/_shared');
const { serviceClient, openphoneFetch } = require('./_shared');

async function findExistingContact(externalId) {
    const r = await openphoneFetch({
        method: 'GET',
        path: '/contacts?externalIds=' + encodeURIComponent(externalId)
    });
    if (r.status !== 200) return null;
    const data = (r.json && (r.json.data || r.json.contacts || [])) || [];
    return data[0] || null;
}

function buildContactBody(p) {
    const parts = (p.owner_name || '').trim().split(/\s+/);
    return {
        externalId: 'stilo_prospect_' + p.id,
        defaultFields: {
            firstName: parts[0] || p.business_name,
            lastName: parts.slice(1).join(' ') || '',
            company: p.business_name,
            role: p.tier + ' lead · score ' + p.prospect_score + ' · ' + (p.niche || ''),
            phoneNumbers: p.owner_phone ? [{ name: 'Owner', value: p.owner_phone }] : [],
            emails: p.owner_email ? [{ name: 'Work', value: p.owner_email }] : []
        }
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const force = !!body.force;

    const sb = serviceClient();
    const { data: prospects, error } = await sb.from('prospects')
        .select('id, business_name, owner_name, owner_phone, owner_email, niche, tier, prospect_score')
        .eq('status', 'callable')
        .not('owner_phone', 'is', null);
    if (error) return res.status(500).json({ error: 'prospect_lookup_failed', detail: error.message });

    let created = 0, skipped = 0, failed = 0;
    const errors = [];
    for (const p of prospects) {
        const externalId = 'stilo_prospect_' + p.id;
        if (!force) {
            const existing = await findExistingContact(externalId);
            if (existing) { skipped++; continue; }
        }
        const r = await openphoneFetch({
            method: 'POST',
            path: '/contacts',
            body: buildContactBody(p)
        });
        if (r.status === 200 || r.status === 201) created++;
        else { failed++; errors.push({ id: p.id, status: r.status, detail: r.json }); }
    }
    return res.status(200).json({ created, skipped, failed, total: prospects.length, errors });
};
