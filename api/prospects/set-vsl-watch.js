/**
 * POST /api/prospects/set-vsl-watch
 * Body: { id, on }
 *
 * Arms or disarms the "tell me the moment they watch the video" alert on one
 * lead. Same shape as save-notes: admin/SDR JWT, one lead, one boolean column,
 * nothing else touched. The cron that reads it is
 * api/prospects/vsl-watch-alerts.js.
 *
 * Turning it ON also clears vsl_watch_alerted_at. Re-arming a lead is Remy
 * saying "I just sent them the link again, tell me when they look this time",
 * and a stale high-water mark from a previous round would suppress exactly that
 * alert.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    const on = body.on === true || body.on === 'true' || body.on === 1 || body.on === '1';

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const patch = { vsl_watch_alert: on, updated_at: new Date().toISOString() };
    if (on) patch.vsl_watch_alerted_at = null;

    const { error } = await sb.from('leads').update(patch).eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, vsl_watch_alert: on });
};
