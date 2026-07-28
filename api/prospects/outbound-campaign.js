/**
 * /api/prospects/outbound-campaign
 *
 *   GET                      -> list campaigns with live stage counts
 *   GET  ?id=N               -> one campaign + counts + pacing state
 *   POST { ...fields }       -> create a campaign (always status 'draft')
 *   POST { id, ...fields }   -> update a campaign
 *   POST { id, action:'start'|'pause'|'done' } -> status transition
 *
 * A campaign is created in 'draft' and can only ever be moved to 'running'
 * through an explicit action, never by passing status in a create. Combined
 * with the OUTBOUND_SEND_ENABLED env lock, that means a campaign built and
 * enqueued tonight cannot send until someone deliberately opens both locks.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const ob = require('./_outbound');

const EDITABLE = [
    'name', 'daily_cap', 'per_line_daily_cap', 'drip_interval_seconds',
    'send_window_start', 'send_window_end', 'timezone', 'callback_sla_minutes',
    'step1_guidance', 'step2_guidance', 'step3_guidance', 'notes',
];

async function stageCounts(sb, campaignId) {
    const { data, error } = await sb.from('outbound_targets')
        .select('stage, step').eq('campaign_id', campaignId);
    if (error) return {};
    const out = { queued: 0, sent: 0, replied: 0, booked: 0, dead: 0, blocked: 0, opted_out: 0, failed: 0, total: 0 };
    for (const r of (data || [])) {
        out[r.stage] = (out[r.stage] || 0) + 1;
        out.total++;
    }
    return out;
}

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const sb = ob.serviceClient();

    if (req.method === 'GET') {
        const id = safeNumberId((req.query || {}).id);
        if (id != null) {
            const { data: c, error } = await sb.from('outbound_campaigns').select('*').eq('id', id).maybeSingle();
            if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
            if (!c) return res.status(404).json({ error: 'not_found' });
            const counts = await stageCounts(sb, id);
            const win = ob.windowState(c, new Date());
            let perLine = {};
            try { perLine = await ob.sentTodayByLine(sb, c, new Date()); } catch (_) { perLine = {}; }
            return res.status(200).json({
                campaign: c, counts: counts, window: win, sent_today_by_line: perLine,
                send_enabled_env: ob.SEND_ENABLED,
            });
        }
        const { data, error } = await sb.from('outbound_campaigns').select('*').order('id', { ascending: false });
        if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
        const withCounts = [];
        for (const c of (data || [])) withCounts.push(Object.assign({}, c, { counts: await stageCounts(sb, c.id) }));
        return res.status(200).json({ campaigns: withCounts, send_enabled_env: ob.SEND_ENABLED });
    }

    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);

    // Status transitions are their own verb. Passing status in a create/update
    // payload is ignored on purpose, so no UI bug or stray field can start a
    // campaign as a side effect of saving a caption.
    if (id != null && body.action) {
        const next = { start: 'running', pause: 'paused', done: 'done' }[body.action];
        if (!next) return res.status(400).json({ error: 'bad_action' });
        const patch = { status: next };
        if (next === 'running') patch.started_at = new Date().toISOString();
        const { data, error } = await sb.from('outbound_campaigns').update(patch).eq('id', id).select().maybeSingle();
        if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });
        console.warn('[outbound] campaign ' + id + ' -> ' + next + ' by ' + gate.email);
        return res.status(200).json({
            ok: true, campaign: data,
            // Surfaced so the UI can say "running, but the env lock is closed"
            // instead of letting someone believe messages are going out.
            send_enabled_env: ob.SEND_ENABLED,
            warning: (next === 'running' && !ob.SEND_ENABLED)
                ? 'Campaign is running but OUTBOUND_SEND_ENABLED is not true, so nothing will send.'
                : null,
        });
    }

    const patch = {};
    for (const k of EDITABLE) if (body[k] !== undefined) patch[k] = body[k];

    if (id != null) {
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
        const { data, error } = await sb.from('outbound_campaigns').update(patch).eq('id', id).select().maybeSingle();
        if (error) return res.status(500).json({ error: 'update_failed', detail: error.message });
        return res.status(200).json({ ok: true, campaign: data });
    }

    if (!patch.name) return res.status(400).json({ error: 'name_required' });
    patch.created_by = gate.email;
    patch.status = 'draft';
    const { data, error } = await sb.from('outbound_campaigns').insert(patch).select().maybeSingle();
    if (error) return res.status(500).json({ error: 'create_failed', detail: error.message });
    return res.status(200).json({ ok: true, campaign: data });
};
