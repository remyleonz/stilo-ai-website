/**
 * GET /api/prospects/outbound-board?campaign_id=N[&stage=replied&rep=email&limit=200]
 *
 * Kanban data for the Outbound tab. Returns targets joined to the lead fields
 * the board renders, grouped by stage, with the callback countdown precomputed
 * server-side.
 *
 * Countdown is computed here rather than in the browser because a tab left open
 * overnight, a laptop that slept, or a clock that drifted all produce a wrong
 * timer client-side, and this particular timer is the one the whole campaign is
 * built around. The client just renders seconds_remaining.
 *
 * SDRs see only their own rows. Admins see everything, which is the same rule
 * the rest of the prospecting surface uses.
 */
const { assertAdminOrSdr, methodNotAllowed, safeNumberId } = require('./_shared');
const ob = require('./_outbound');

const STAGES = ['queued', 'sent', 'replied', 'booked', 'dead', 'blocked', 'opted_out', 'failed'];
const ADMINS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const campaignId = safeNumberId(q.campaign_id);
    if (campaignId == null) return res.status(400).json({ error: 'campaign_id_required' });
    const limit = Math.min(Number(q.limit) || 400, 1000);

    const sb = ob.serviceClient();
    const { data: campaign } = await sb.from('outbound_campaigns').select('*').eq('id', campaignId).maybeSingle();
    if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

    let query = sb.from('outbound_targets').select('*').eq('campaign_id', campaignId);
    if (q.stage && STAGES.includes(q.stage)) query = query.eq('stage', q.stage);

    const isAdmin = ADMINS.includes(String(gate.email || '').toLowerCase());
    if (!isAdmin) query = query.eq('assigned_to', gate.email);
    else if (q.rep) query = query.eq('assigned_to', q.rep);

    // Replied first: it is the only column with a clock running on it.
    const { data: targets, error } = await query
        .order('first_reply_at', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .limit(limit);
    if (error) return res.status(500).json({ error: 'targets_read_failed', detail: error.message });

    const leadIds = Array.from(new Set((targets || []).map(t => t.lead_id)));
    const leadById = {};
    for (let i = 0; i < leadIds.length; i += 300) {
        const { data: leads } = await sb.from('leads')
            .select('id,name,owner_name,niche,category,address,website,pitch_agent,last_called_outcome,last_called_at')
            .in('id', leadIds.slice(i, i + 300));
        for (const l of (leads || [])) leadById[l.id] = l;
    }

    // Most recent successful send on this campaign, campaign-wide (not just the
    // filtered slice). last_error sticks to a row until that row is retried, so
    // a credit outage days ago leaves hundreds of queued rows carrying an error
    // long after sending recovered. Anything older than the last good send is
    // history, not a live problem, and the board must not raise an alarm for it.
    let lastSuccessAt = null;
    for (const col of ['step1_sent_at', 'step2_sent_at', 'step3_sent_at']) {
        const { data: row } = await sb.from('outbound_targets')
            .select(col).eq('campaign_id', campaignId)
            .not(col, 'is', null).order(col, { ascending: false }).limit(1).maybeSingle();
        const v = row && row[col] ? new Date(row[col]).getTime() : null;
        if (v != null && (lastSuccessAt == null || v > lastSuccessAt)) lastSuccessAt = v;
    }

    const now = Date.now();
    const grouped = {};
    for (const s of STAGES) grouped[s] = [];

    for (const t of (targets || [])) {
        const lead = leadById[t.lead_id] || {};
        let secondsRemaining = null;
        let overdue = false;
        if (t.callback_due_at && !t.called_back_at) {
            secondsRemaining = Math.round((new Date(t.callback_due_at).getTime() - now) / 1000);
            overdue = secondsRemaining < 0;
        }
        (grouped[t.stage] || (grouped[t.stage] = [])).push({
            id: t.id,
            lead_id: t.lead_id,
            business: lead.name || null,
            owner_name: lead.owner_name || null,
            niche: lead.niche || lead.category || null,
            address: lead.address || null,
            pitch_agent: lead.pitch_agent || null,
            last_called_outcome: lead.last_called_outcome || null,
            assigned_to: t.assigned_to,
            from_line: t.from_line,
            to_phone: t.to_phone,
            stage: t.stage,
            step: t.step,
            step1_body: t.step1_body, step1_sent_at: t.step1_sent_at,
            step2_body: t.step2_body, step2_sent_at: t.step2_sent_at,
            step3_body: t.step3_body, step3_sent_at: t.step3_sent_at,
            first_reply_at: t.first_reply_at,
            first_reply_body: t.first_reply_body,
            callback_due_at: t.callback_due_at,
            called_back_at: t.called_back_at,
            called_back_by: t.called_back_by,
            seconds_remaining: secondsRemaining,
            overdue: overdue,
            last_error: t.last_error,
            // updated_at is the closest thing the row has to an error timestamp:
            // every write that sets last_error also stamps updated_at.
            last_error_at: t.last_error ? t.updated_at : null,
            error_stale: !!(t.last_error && lastSuccessAt != null
                && new Date(t.updated_at).getTime() <= lastSuccessAt),
            // Deep link that opens the thread on the rep's own phone.
            quo_link: 'https://my.openphone.com/inbox?contact=' + encodeURIComponent(t.to_phone || ''),
            tel_link: 'tel:' + String(t.to_phone || '').replace(/[^\d+]/g, ''),
        });
    }

    const counts = {};
    for (const s of STAGES) counts[s] = grouped[s].length;

    let perLine = {};
    try { perLine = await ob.sentTodayByLine(sb, campaign, new Date()); } catch (_) { perLine = {}; }
    const win = ob.windowState(campaign, new Date());

    return res.status(200).json({
        ok: true,
        campaign: campaign,
        stages: grouped,
        counts: counts,
        window: win,
        sent_today_by_line: perLine,
        sent_today_total: Object.values(perLine).reduce((a, b) => a + b, 0),
        last_success_at: lastSuccessAt == null ? null : new Date(lastSuccessAt).toISOString(),
        send_enabled_env: ob.SEND_ENABLED,
        is_admin: isAdmin,
        server_time: new Date().toISOString(),
    });
};
