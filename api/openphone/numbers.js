/**
 * GET /api/openphone/numbers
 *
 * Returns the OpenPhone phone-number records for this workspace so the admin
 * UI can show a "Calling from 305 / 786" picker. We hit the live API rather
 * than caching env vars so a number bought mid-day shows up without a deploy.
 *
 * Falls back to the configured env vars if OPENPHONE_API_KEY is not yet set
 * (so the UI still shows two lines during pre-API-key bring-up).
 */

const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const { openphoneFetch } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const { status, json } = await openphoneFetch({
        method: 'GET',
        path: '/phone-numbers'
    });

    if (status === 503 || status === 502) {
        const fallback = [];
        if (process.env.OPENPHONE_NUMBER_PRIMARY) {
            fallback.push({ id: process.env.OPENPHONE_NUMBER_PRIMARY, number: process.env.OPENPHONE_NUMBER_PRIMARY, name: 'Primary (305)' });
        }
        if (process.env.OPENPHONE_NUMBER_SECONDARY) {
            fallback.push({ id: process.env.OPENPHONE_NUMBER_SECONDARY, number: process.env.OPENPHONE_NUMBER_SECONDARY, name: 'Secondary (786)' });
        }
        return res.status(200).json({ numbers: fallback, source: 'env_fallback' });
    }
    if (status >= 400) {
        return res.status(status).json({ error: 'openphone_lookup_failed', detail: json });
    }

    const list = (json && (json.data || json.numbers || (Array.isArray(json) ? json : []))) || [];
    const numbers = list.map(function (n) {
        const num = n.number || n.phoneNumber || n.e164 || n.id;
        const id = n.id || num;
        const name = n.name || n.label || (num ? ('Line ' + num.slice(-4)) : 'Line');
        return { id: id, number: num, name: name };
    });

    return res.status(200).json({ numbers: numbers, source: 'openphone_api' });
};
