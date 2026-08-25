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

    // sdr_type / client_account arrive with api/migrations/sdr_type_and_rep_e.sql.
    // Vercel deploys and Supabase migrations are two separate manual steps here,
    // so whichever lands first must not take the roster down: a missing column
    // is a 42703 from PostgREST, and without this the whole SDR dashboard 500s
    // on load. Drop the fallback once the migration is applied everywhere.
    const BASE_COLS = 'id, email, sdr_key, display_name, initials, avatar_color, commission_pct, commission_mrr_pct, daily_call_quota, openphone_number, active, hired_at, auth_user_id';

    async function pull(cols) {
        let q = caller.sb.from('sdr_users').select(cols).order('hired_at', { ascending: true });
        if (!includeInactive) q = q.eq('active', true);
        return q;
    }

    let { data, error } = await pull(BASE_COLS + ', sdr_type, client_account');
    if (error && error.code === '42703') ({ data, error } = await pull(BASE_COLS));
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ sdrs: data || [] });
};
