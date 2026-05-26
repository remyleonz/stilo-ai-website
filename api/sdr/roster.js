/**
 * GET /api/sdr/roster
 *
 * Returns the active SDR roster. Admins see all (active + inactive optional
 * via ?include_inactive=true). SDRs see only the active roster, with their
 * own row first (used to populate the SDR selector in admin UI and the
 * profile display in SDR UI).
 */
const { authSdr, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');

    const caller = await authSdr(req, res);
    if (!caller.ok) return;

    const includeInactive = caller.isAdmin && (req.query && req.query.include_inactive === 'true');

    let q = caller.sb
        .from('sdr_users')
        .select('id, email, sdr_key, display_name, initials, avatar_color, commission_pct, daily_call_quota, openphone_number, active, hired_at, auth_user_id')
        .order('hired_at', { ascending: true });

    if (!includeInactive) q = q.eq('active', true);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ sdrs: data || [] });
};
