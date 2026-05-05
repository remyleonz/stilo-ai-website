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

    const sb = serviceClient();
    const { data: prospect, error } = await sb
        .from('prospects')
        .select('id, owner_phone')
        .eq('id', prospectId)
        .maybeSingle();
    if (error) return res.status(500).json({ error: 'prospect_lookup_failed', detail: error.message });
    if (!prospect || !prospect.owner_phone) return res.status(404).json({ error: 'prospect_not_found_or_no_phone' });

    const to = normalizePhone(prospect.owner_phone);
    const enc = encodeURIComponent(to);

    // Quo (formerly OpenPhone) keeps the legacy openphone:// scheme registered
    // on installed desktops, but newer installs may register quo:// instead.
    // The web URL works as a fallback for both. The browser tries the desktop
    // scheme first; if no handler is registered it silently no-ops, then the
    // 1s setTimeout opens the web URL in a new tab.
    return res.status(200).json({
        to: to,
        desktop: 'openphone://call?to=' + enc,
        desktop_alt: 'quo://call?to=' + enc,
        web: 'https://app.quo.com/calls/new?to=' + enc,
        web_legacy: 'https://my.openphone.com/calls/new?to=' + enc
    });
};
