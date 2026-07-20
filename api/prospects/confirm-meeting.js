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
    //
    // This wrote nurture_stage: 'meeting_confirmed' -- a value the
    // leads_nurture_stage_check constraint has never allowed. The UPDATE threw
    // on every confirmation, the catch below swallowed it, and the prospect got
    // redirected as if it worked. It ALSO never wrote the confirmed timestamp
    // the header above claims, so a confirmation was recorded in exactly zero
    // places. That is why the admin "Confirmed" stat has always read 0.
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (url && key && leadId != null) {
            const supabase = createClient(url, key, { auth: { persistSession: false } });
            const nowIso = new Date().toISOString();
            // meeting_confirmed_at is the load-bearing column -- the dashboards,
            // the callback calendar's amber "needs confirm" marker, and the
            // nurture stepper all read it. nurture_stage is display only.
            const { error: confErr } = await supabase.schema('prospecting').from('leads')
                .update({
                    meeting_confirmed_at: nowIso,
                    nurture_stage: 'confirmed',
                    updated_at: nowIso
                })
                .eq('id', leadId);
            if (confErr) {
                console.error('[confirm-meeting] FAILED to record confirmation for lead=' + leadId + ':', confErr.message);
                // Retry the timestamp alone. If nurture_stage is what broke,
                // the confirmation itself must still land.
                const { error: tsErr } = await supabase.schema('prospecting').from('leads')
                    .update({ meeting_confirmed_at: nowIso, updated_at: nowIso })
                    .eq('id', leadId);
                if (tsErr) console.error('[confirm-meeting] timestamp-only retry ALSO failed for lead=' + leadId + ':', tsErr.message);
            }
            // Record the event too, so the confirm funnel has a real signal
            // instead of inferring one. No 'confirm' event has ever existed in
            // vsl_events, which made the funnel's last step permanently zero.
            const { error: evErr } = await supabase.from('vsl_events')
                .insert({ event: 'confirm', flow: 'confirm', agent: agent, lead_id: leadId, path: '/api/prospects/confirm-meeting' });
            if (evErr) console.error('[confirm-meeting] vsl_events insert failed for lead=' + leadId + ':', evErr.message);
        }
    } catch (e) {
        console.error('[confirm-meeting] threw for lead=' + leadId + ':', (e && e.message) || e);
    }

    res.writeHead(302, { Location: landingUrl(agent, leadId) });
    return res.end();
};
