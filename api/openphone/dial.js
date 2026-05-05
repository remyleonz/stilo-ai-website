/**
 * POST /api/openphone/dial
 * Body: { prospect_id, from_number_id }
 *
 * NOTE (2026-05-04): Quo (formerly OpenPhone) does NOT publicly document a
 * POST /v1/calls endpoint for programmatic dialing. The dialer in admin uses
 * the deep-link path (openphone:// → opens the Quo desktop/mobile app
 * pre-filled with the number, user taps Call themselves). This handler is
 * kept as a stub so the moment Quo ships outbound dial we can flip the
 * frontend back without restructuring routes.
 *
 * If you have docs for the actual outbound endpoint, update OPENPHONE_API_BASE
 * and the body shape in this file. Otherwise this returns 501 Not Implemented
 * so a stale frontend call surfaces immediately rather than silently failing.
 */

const { assertAdmin, readJsonBody, methodNotAllowed, safeNumberId } = require('../prospects/_shared');
const { openphoneFetch, serviceClient, normalizePhone } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    // Short-circuit: Quo doesn't expose programmatic dial. Tell the caller to
    // use the deep-link route instead.
    if (process.env.OPENPHONE_DIAL_ENABLED !== 'true') {
        return res.status(501).json({
            error: 'programmatic_dial_not_supported',
            detail: 'Quo (OpenPhone) does not expose POST /v1/calls. Use /api/openphone/deep-link to open the Quo app pre-filled with the prospect phone, and tap call inside the app.'
        });
    }

    const body = await readJsonBody(req);
    const prospectId = safeNumberId(body.prospect_id);
    const fromNumberId = body.from_number_id || null;

    if (prospectId == null) return res.status(400).json({ error: 'missing_prospect_id' });

    const sb = serviceClient();
    const { data: prospect, error } = await sb
        .from('prospects')
        .select('id, business_name, owner_phone, owner_name')
        .eq('id', prospectId)
        .maybeSingle();
    if (error) return res.status(500).json({ error: 'prospect_lookup_failed', detail: error.message });
    if (!prospect) return res.status(404).json({ error: 'prospect_not_found' });
    if (!prospect.owner_phone) return res.status(400).json({ error: 'prospect_has_no_phone' });

    const toNumber = normalizePhone(prospect.owner_phone);
    const fromNumber = fromNumberId
        || process.env.OPENPHONE_NUMBER_PRIMARY
        || null;
    if (!fromNumber) return res.status(503).json({ error: 'no_openphone_line_configured' });
    if (!process.env.OPENPHONE_USER_ID) return res.status(503).json({ error: 'no_openphone_user_configured' });

    const dial = await openphoneFetch({
        method: 'POST',
        path: '/calls',
        body: {
            from: fromNumber,
            to: [toNumber],
            userId: process.env.OPENPHONE_USER_ID,
            metadata: {
                prospect_id: String(prospectId),
                logged_by: gate.email
            }
        }
    });

    if (dial.status >= 400) {
        return res.status(dial.status).json({ error: 'openphone_dial_failed', detail: dial.json });
    }

    const openphoneCallId = (dial.json && (dial.json.id || dial.json.callId || (dial.json.data && dial.json.data.id))) || null;

    if (openphoneCallId) {
        await sb.from('prospect_calls').upsert({
            openphone_call_id: openphoneCallId,
            prospect_id: prospectId,
            direction: 'outbound',
            from_number: fromNumber,
            to_number: toNumber,
            outcome: null,
            logged_by: gate.email,
            raw_payload: { event: 'dial_initiated', dial_response: dial.json }
        }, { onConflict: 'openphone_call_id' });
    }

    return res.status(200).json({
        ok: true,
        call_id: openphoneCallId,
        from: fromNumber,
        to: toNumber,
        prospect_id: prospectId
    });
};
