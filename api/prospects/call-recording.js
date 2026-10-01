/**
 * GET /api/prospects/call-recording?call_id=<lead_calls.id>
 *
 * Returns a playable URL for one call's recording: { url, duration }.
 *
 * Why on demand (2026-10-01): the webhook only saved recording_url when Quo
 * put it inside a call event, and Quo stopped doing that around 8/10. Since
 * then 415 connected calls landed with no recording_url, so the panel showed
 * no play button, while Quo still had every recording. Asking Quo at click
 * time works for every past call too, and never stores a signed link that
 * could expire.
 *
 * Auth: admin, or the SDR the lead is assigned to.
 */
const { assertAdminOrSdr, methodNotAllowed, safeNumberId } = require('./_shared');
const { openphoneFetch } = require('../openphone/_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const id = safeNumberId(req.query && req.query.call_id);
    if (id == null) return res.status(400).json({ error: 'missing_call_id' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
    const { data: call, error } = await sb.from('lead_calls')
        .select('id,lead_id,openphone_call_id,recording_url')
        .eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ error: 'lookup_failed' });
    if (!call) return res.status(404).json({ error: 'call_not_found' });

    if (gate.isSdr && !gate.isAdmin) {
        const { data: lead } = await sb.from('leads').select('assigned_to').eq('id', call.lead_id).maybeSingle();
        if (!lead || lead.assigned_to !== gate.email) return res.status(403).json({ error: 'not_your_lead' });
    }

    if (call.openphone_call_id) {
        const r = await openphoneFetch({ method: 'GET', path: '/call-recordings/' + encodeURIComponent(call.openphone_call_id) });
        const recs = (r.json && Array.isArray(r.json.data)) ? r.json.data : [];
        const rec = recs.find(function (x) { return x && x.url && (!x.status || x.status === 'completed'); }) || recs.find(function (x) { return x && x.url; });
        if (rec) return res.status(200).json({ url: rec.url, duration: rec.duration || null });
    }
    // Legacy rows that did get a URL saved by the webhook.
    if (call.recording_url) return res.status(200).json({ url: call.recording_url, duration: null });
    return res.status(404).json({ error: 'no_recording' });
};
