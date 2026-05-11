/**
 * GET /api/admin/integrations-health
 *
 * Probes the live status of Stripe, Retell, and Resend so the Settings
 * tab shows real connection state (and the error message when something
 * is wrong — e.g. a Retell credit cap or a revoked Resend domain).
 *
 * Supabase is probed client-side from the dashboard already; included
 * here too so the response shape is uniform.
 *
 * Response:
 *   {
 *     stripe:   { ok: true,  detail: 'Account live, mode=test' },
 *     retell:   { ok: false, detail: 'invalid_api_key' },
 *     resend:   { ok: true,  detail: '3 verified domains' },
 *     supabase: { ok: true,  detail: 'clients table reachable' }
 *   }
 *
 * Each probe times out at 8s; failures bubble up as { ok: false, detail }.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + '_timeout')), ms))
    ]);
}

async function probeStripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return { ok: false, detail: 'STRIPE_SECRET_KEY not set' };
    try {
        const r = await withTimeout(fetch('https://api.stripe.com/v1/balance', {
            headers: { 'Authorization': 'Bearer ' + key }
        }), 8000, 'stripe');
        if (r.status === 200) {
            const live = key.startsWith('sk_live_');
            return { ok: true, detail: 'Account reachable, mode=' + (live ? 'live' : 'test') };
        }
        const text = (await r.text().catch(() => '')).slice(0, 300);
        return { ok: false, detail: 'HTTP ' + r.status + ': ' + text };
    } catch (e) { return { ok: false, detail: String(e.message || e) }; }
}

async function probeRetell() {
    const key = process.env.RETELL_API_KEY;
    if (!key) return { ok: false, detail: 'RETELL_API_KEY not set' };
    try {
        // /list-phone-numbers is one of the cheapest Retell calls and 200s
        // when the key is valid even on an empty workspace.
        const r = await withTimeout(fetch('https://api.retellai.com/list-phone-numbers', {
            headers: { 'Authorization': 'Bearer ' + key }
        }), 8000, 'retell');
        if (r.status === 200) {
            let count = 0;
            try { const j = await r.json(); count = Array.isArray(j) ? j.length : (j && j.phone_numbers ? j.phone_numbers.length : 0); } catch {}
            return { ok: true, detail: 'Workspace reachable, ' + count + ' phone number(s) provisioned' };
        }
        if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Auth rejected (HTTP ' + r.status + ') — check Retell API key' };
        const text = (await r.text().catch(() => '')).slice(0, 300);
        return { ok: false, detail: 'HTTP ' + r.status + ': ' + text };
    } catch (e) { return { ok: false, detail: String(e.message || e) }; }
}

async function probeResend() {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, detail: 'RESEND_API_KEY not set' };
    try {
        const r = await withTimeout(fetch('https://api.resend.com/domains', {
            headers: { 'Authorization': 'Bearer ' + key }
        }), 8000, 'resend');
        if (r.status === 200) {
            let count = 0;
            try { const j = await r.json(); count = Array.isArray(j && j.data) ? j.data.length : 0; } catch {}
            return { ok: true, detail: count + ' domain(s) registered' };
        }
        const text = (await r.text().catch(() => '')).slice(0, 300);
        if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Auth rejected (HTTP ' + r.status + ') — check Resend API key' };
        return { ok: false, detail: 'HTTP ' + r.status + ': ' + text };
    } catch (e) { return { ok: false, detail: String(e.message || e) }; }
}

async function probeSupabase() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return { ok: false, detail: 'SUPABASE_SERVICE_KEY not set' };
    }
    try {
        const r = await withTimeout(fetch(process.env.SUPABASE_URL + '/rest/v1/clients?select=id&limit=1', {
            headers: {
                'apikey': process.env.SUPABASE_SERVICE_KEY,
                'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY
            }
        }), 6000, 'supabase');
        if (r.status === 200) return { ok: true, detail: 'clients table reachable' };
        return { ok: false, detail: 'HTTP ' + r.status };
    } catch (e) { return { ok: false, detail: String(e.message || e) }; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    // Run all probes in parallel — slowest one (8s) bounds the response time.
    const [stripe, retell, resend, supabase] = await Promise.all([
        probeStripe(), probeRetell(), probeResend(), probeSupabase()
    ]);

    // Short edge cache so rapid Settings tab visits don't pound the upstream
    // APIs. The data isn't actionable below the minute mark anyway.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
    return res.status(200).json({
        stripe: stripe,
        retell: retell,
        resend: resend,
        supabase: supabase,
        checked_at: new Date().toISOString()
    });
};
