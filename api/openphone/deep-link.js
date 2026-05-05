/**
 * GET /api/openphone/deep-link?prospect_id=42
 *
 * Returns server-vetted deep-link URLs that open the OpenPhone desktop app
 * pre-filled with the prospect's number. Used by the "Call in OpenPhone app"
 * button so the browser never sees the phone number directly until the user
 * is authenticated and authorized.
 *
 * Returns:
 *   {
 *     desktop:  "openphone://call?to=+1305...",
 *     web:      "https://my.openphone.com/calls/new?to=+1305...",
 *     to:       "+1305..."
 *   }
 */

const { assertAdmin, methodNotAllowed, safeNumberId } = require('../prospects/_shared');
const { serviceClient, normalizePhone } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const prospectId = safeNumberId(q.prospect_id);
    if (prospectId == null) return res.status(400).json({ error: 'missing_prospect_id' });

    const sb = serviceClient(); // prospecting schema
    const { data: lead, error } = await sb
        .from('leads')
        .select('id, owner_phone, phone')
        .eq('id', prospectId)
        .maybeSingle();
    if (error) return res.status(500).json({ error: 'lead_lookup_failed', detail: error.message });
    const phoneRaw = lead && (lead.owner_phone || lead.phone);
    if (!lead || !phoneRaw) return res.status(404).json({ error: 'lead_not_found_or_no_phone' });

    const to = normalizePhone(phoneRaw);
    const enc = encodeURIComponent(to);

    // Quo (formerly OpenPhone) keeps the legacy openphone:// scheme registered
    // on installed desktops, but newer installs may register quo:// instead.
    // The web URL works as a fallback for both. The browser tries the desktop
    // scheme first; if no handler is registered it silently no-ops, then the
    // 1s setTimeout opens the web URL in a new tab.
    return res.status(200).json({
        to: to,
        // Quo (formerly OpenPhone) Mac/iPhone app registers the quo:// scheme
        // post-rebrand. Older OpenPhone installs may still respond to
        // openphone://. The web URL is the legacy my.openphone.com host —
        // app.quo.com does NOT resolve (NXDOMAIN). Frontend tries the desktop
        // schemes in order, then opens the web URL in a new tab as fallback.
        desktop: 'quo://call?to=' + enc,
        desktop_legacy: 'openphone://call?to=' + enc,
        web: 'https://my.openphone.com/calls/new?to=' + enc
    });
};
