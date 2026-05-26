/**
 * GET  /api/sdr/profile
 *   Returns the caller's sdr_users row + supplemental data:
 *   { sdr, totals: { ...mini-snapshot of dials/meetings... } }
 *
 * PATCH /api/sdr/profile
 *   Body: { display_name?, avatar_color?, openphone_number?, notes? }
 *   SDR can update non-sensitive fields on their own profile.
 *   Admin can also update other SDRs by passing ?sdr_id=<uuid>.
 *
 * POST /api/sdr/profile/reset-password
 *   Body: { new_password }
 *   Resets the SDR's password (requires their session). Admin can reset
 *   anyone's password by passing ?sdr_id=<uuid>.
 */
const { authSdr, methodNotAllowed, readJsonBody } = require('./_shared');

module.exports = async function handler(req, res) {
    const caller = await authSdr(req, res);
    if (!caller.ok) return;

    if (req.method === 'GET') {
        // Get the SDR profile
        const sdrId = (req.query && req.query.sdr_id) || (caller.sdr ? caller.sdr.id : null);
        if (!sdrId) {
            // Admin without sdr_id — return null profile
            return res.status(200).json({ sdr: null });
        }
        // Non-admin caller can only see their own
        if (!caller.isAdmin && (!caller.sdr || caller.sdr.id !== sdrId)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const { data: sdr, error } = await caller.sb
            .from('sdr_users')
            .select('*')
            .eq('id', sdrId)
            .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ sdr });
    }

    if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const sdrId = (req.query && req.query.sdr_id) || (caller.sdr ? caller.sdr.id : null);
        if (!sdrId) return res.status(400).json({ error: 'sdr_id_required' });
        if (!caller.isAdmin && (!caller.sdr || caller.sdr.id !== sdrId)) {
            return res.status(403).json({ error: 'forbidden' });
        }

        // SDR can update: display_name, avatar_color, openphone_number, notes
        // Admin can additionally update: commission_pct, daily_call_quota, active, manager_email
        const update = { updated_at: new Date().toISOString() };
        if (typeof body.display_name === 'string')     update.display_name = body.display_name.slice(0, 80);
        if (typeof body.avatar_color === 'string')     update.avatar_color = body.avatar_color.slice(0, 16);
        if (typeof body.openphone_number === 'string') update.openphone_number = body.openphone_number.slice(0, 30);
        if (typeof body.notes === 'string')            update.notes = body.notes.slice(0, 4000);

        if (caller.isAdmin) {
            if (body.commission_pct !== undefined) update.commission_pct = Number(body.commission_pct);
            if (body.daily_call_quota !== undefined) update.daily_call_quota = parseInt(body.daily_call_quota, 10);
            if (typeof body.active === 'boolean') update.active = body.active;
            if (typeof body.manager_email === 'string') update.manager_email = body.manager_email.slice(0, 120);
        }

        const { data, error } = await caller.sb
            .from('sdr_users')
            .update(update)
            .eq('id', sdrId)
            .select('*')
            .single();

        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ sdr: data });
    }

    if (req.method === 'POST') {
        // Password reset
        const body = await readJsonBody(req);
        const newPassword = (body.new_password || '').toString();
        if (newPassword.length < 10) return res.status(400).json({ error: 'password_too_short' });

        const sdrId = (req.query && req.query.sdr_id) || (caller.sdr ? caller.sdr.id : null);
        if (!sdrId) return res.status(400).json({ error: 'sdr_id_required' });
        if (!caller.isAdmin && (!caller.sdr || caller.sdr.id !== sdrId)) {
            return res.status(403).json({ error: 'forbidden' });
        }

        const { data: sdr } = await caller.sb
            .from('sdr_users')
            .select('auth_user_id')
            .eq('id', sdrId)
            .maybeSingle();
        if (!sdr || !sdr.auth_user_id) return res.status(404).json({ error: 'sdr_not_linked' });

        const { error } = await caller.sb.auth.admin.updateUserById(sdr.auth_user_id, { password: newPassword });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return methodNotAllowed(res, 'GET, PATCH, POST');
};
