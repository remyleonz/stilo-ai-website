/**
 * Lead attribution token for public VSL-landing bookings.
 *
 * When we email a lead their VSL link we append ?lid=<id>&t=<token>. The public
 * booking endpoint verifies the token and books straight onto that exact lead,
 * so the meeting auto-appears in the admin dashboard with zero fuzzy matching.
 *
 * The HMAC key reuses SUPABASE_SERVICE_KEY (already present locally + on Vercel,
 * server-only, never shipped to the browser) so there's no new secret to manage.
 * Set BOOKING_TOKEN_SECRET to override.
 */
const crypto = require('crypto');

function secret() {
    return process.env.BOOKING_TOKEN_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
}

// 22-char base64url HMAC of the lead id. Short enough for a clean URL, long
// enough that it can't be guessed without the server secret.
function signLead(leadId) {
    const s = secret();
    if (!s || leadId == null) return null;
    return crypto.createHmac('sha256', s).update('lead:' + String(leadId)).digest('base64url').slice(0, 22);
}

function verifyLead(leadId, token) {
    if (leadId == null || !token) return false;
    const good = signLead(leadId);
    if (!good) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(good);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signLead, verifyLead };
