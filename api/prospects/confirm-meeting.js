/**
 * GET /api/prospects/confirm-meeting?token=<signed>
 *
 * Public endpoint the prospect hits from the "Confirm my meeting" button in the
 * STILO confirmation email. It:
 *   1. Verifies the signed token (lead id + agent + expiry, HMAC)
 *   2. Marks the lead's meeting confirmed (nurture_stage + confirmed timestamp)
 *   3. Redirects to the VSL landing page for the agent we agreed to sell them
 *
 * No auth gate: the signed token IS the auth. Verification is constant-time and
 * the token expires. Failure still redirects to the VSL page (never a dead end).
 *
 * The confirm EMAIL is only sent when VSL_FLOW_ENABLED === 'true', so in
 * practice no real prospect can reach this until the flow is switched on.
 */
const { createClient } = require('@supabase/supabase-js');
const { verifyConfirmToken, agentKey, landingUrl } = require('./_vsl');

module.exports = async function handler(req, res) {
    const token = (req.query && req.query.token) || '';
    const payload = verifyConfirmToken(token);

    // Even on a bad/expired token, land them somewhere sensible.
    if (!payload) {
        res.writeHead(302, { Location: landingUrl('receptionist') });
        return res.end();
    }

    const agent = agentKey(payload.a);
    const leadId = payload.lead;

    // Best-effort: record the confirmation. Never block the redirect on a DB hiccup.
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (url && key && leadId != null) {
            const supabase = createClient(url, key, { auth: { persistSession: false } });
            await supabase.schema('prospecting').from('leads')
                .update({
                    nurture_stage: 'meeting_confirmed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', leadId);
        }
    } catch (e) { /* swallow — redirect regardless */ }

    res.writeHead(302, { Location: landingUrl(agent, leadId) });
    return res.end();
};
