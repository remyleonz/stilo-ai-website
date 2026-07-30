/**
 * POST /api/prospects/outbound-generate
 * Body: { campaign_id, step?, limit?, regenerate?, target_id? }
 *
 * Writes a personalized message body onto each target WITHOUT sending anything.
 *
 * Split out from the send worker on purpose. Generation is the part you want to
 * read before you commit: 700 messages written by a model at 11pm should be
 * reviewable at 11:05pm and sendable at 8am, not generated one-at-a-time inside
 * the loop that is also dialing out. It also means a bad guidance prompt costs
 * you a regenerate, not 700 sent texts.
 *
 * Each message is personalized from the lead's own record: business name, owner
 * first name, industry, location, what we would sell them, and how the last
 * call went. The campaign's step guidance is the authoring brief.
 *
 * regenerate=true overwrites bodies that already exist. Without it, targets that
 * already have a body for this step are skipped, so re-running tops up new
 * targets instead of rewriting approved copy.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const ob = require('./_outbound');

module.exports.maxDuration = 300;

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    // Same auth shape as sync-scripts.js and outbound-tick.js: a Vercel cron /
    // operator bearer OR an admin JWT. Without the bearer path these endpoints
    // can only be driven from a logged-in browser, which makes scripted setup
    // and recovery impossible.
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    let gate = { ok: true, email: 'cron@stiloaipartners.com' };
    if (!cronOk) { gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const body = await readJsonBody(req);
    const campaignId = safeNumberId(body.campaign_id);
    if (campaignId == null) return res.status(400).json({ error: 'campaign_id_required' });
    const step = [1, 2, 3].includes(Number(body.step)) ? Number(body.step) : 1;
    const limit = Math.min(Number(body.limit) || 250, 1000);
    const regenerate = !!body.regenerate;
    const onlyTarget = safeNumberId(body.target_id);

    const sb = ob.serviceClient();
    const { data: campaign, error: cErr } = await sb.from('outbound_campaigns')
        .select('*').eq('id', campaignId).maybeSingle();
    if (cErr) return res.status(500).json({ error: 'campaign_read_failed', detail: cErr.message });
    if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

    let reps;
    try { reps = await ob.loadReps(); }
    catch (e) { return res.status(502).json({ error: 'reps_read_failed', detail: e.message }); }

    const bodyCol = 'step' + step + '_body';
    let q = sb.from('outbound_targets')
        .select('id, lead_id, assigned_to, from_line, to_phone, stage, variant, ' + bodyCol)
        .eq('campaign_id', campaignId)
        .in('stage', step === 1 ? ['queued'] : ['sent', 'replied']);
    if (onlyTarget != null) q = q.eq('id', onlyTarget);
    if (!regenerate) q = q.is(bodyCol, null);

    const { data: targets, error } = await q.order('id', { ascending: true }).limit(limit);
    if (error) return res.status(500).json({ error: 'targets_read_failed', detail: error.message });
    if (!targets.length) {
        return res.status(200).json({ ok: true, generated: 0, note: 'Nothing pending for step ' + step + '.' });
    }

    const leadIds = targets.map(t => t.lead_id);
    const { data: leads, error: lErr } = await sb.from('leads')
        .select('id,name,owner_name,niche,category,address,website,pitch_agent,last_called_outcome')
        .in('id', leadIds);
    if (lErr) return res.status(500).json({ error: 'leads_read_failed', detail: lErr.message });
    const leadById = {};
    for (const l of (leads || [])) leadById[l.id] = l;

    let generated = 0, modelWritten = 0, fellBack = 0, failed = 0;
    const samples = [];

    for (const t of targets) {
        const lead = leadById[t.lead_id];
        if (!lead) { failed++; continue; }
        const rep = reps[t.assigned_to] || { first_name: 'me', line: t.from_line, display_name: '' };
        try {
            const out = await ob.generateStepBody(lead, campaign, step, rep, t.variant);
            const patch = { updated_at: new Date().toISOString() };
            patch[bodyCol] = out.body;
            const { error: uErr } = await sb.from('outbound_targets').update(patch).eq('id', t.id);
            if (uErr) { failed++; continue; }
            generated++;
            if (out.generated) modelWritten++; else fellBack++;
            if (samples.length < 8) {
                samples.push({ target_id: t.id, arm: t.variant || '-', business: lead.name, to: t.to_phone, from: t.from_line, body: out.body });
            }
        } catch (e) {
            failed++;
            await sb.from('outbound_targets')
                .update({ last_error: String(e.message || e).slice(0, 200) }).eq('id', t.id);
        }
    }

    const { count: remaining } = await sb.from('outbound_targets')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId).is(bodyCol, null)
        .in('stage', step === 1 ? ['queued'] : ['sent', 'replied']);

    return res.status(200).json({
        ok: true, step: step,
        generated: generated,
        model_written: modelWritten,
        used_fallback: fellBack,
        failed: failed,
        remaining_without_body: remaining || 0,
        samples: samples,
        note: 'Nothing was sent. Review the samples, then run again with regenerate:true if the copy needs work.',
    });
};
