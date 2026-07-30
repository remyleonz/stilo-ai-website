/**
 * POST /api/prospects/outbound-enqueue
 * Body: { campaign_id, audience?, limit?, dry? }
 *
 * Builds the target list for a campaign. Never sends anything: this only
 * decides WHO is in the campaign, on which line, at which number.
 *
 * audience:
 *   'warm'   (default) leads who already had a 20s+ phone conversation with us
 *            and never booked. The defensible pool: prior contact, a real
 *            relationship, and a rep whose name means something to them.
 *   'dialed' anyone we have called at all, connected or not.
 *   'scripted' every dial-ready lead David has briefed. Includes people we have
 *            never contacted, so this is cold. Named plainly for that reason.
 *
 * Every candidate must clear all of:
 *   - not do_not_call
 *   - never booked a meeting with us
 *   - last outcome isn't wrong_number / disconnected / dnc_request
 *   - has a phone
 *   - scrub_status = 'clear', and the number we will text is the number that
 *     was scrubbed
 *   - the assigned rep has an active Quo line
 *
 * The scrub gate is the reason this can return far fewer rows than you expect.
 * That is working as designed: an unscrubbed lead is an unanswered question,
 * and ?dry=1 tells you exactly how many were held back and why.
 *
 * SCRUB EXEMPTION (campaign.scrub_exempt_prior_contact):
 * When set, a lead with a >=20s connected call on record may enqueue and send
 * without scrub_status='clear'. The reasoning is that the scrub protects against
 * serial TCPA plaintiffs, and anyone in this pool inclined to sue had a cause of
 * action from the phone call, which happened before the campaign existed. A text
 * to them is follow-up, not cold approach.
 *
 * Two things it does NOT do, on purpose:
 *   - it never exempts a cold lead, because prior_contact will be false
 *   - it never overrides do_not_call or a confirmed scrub_status='blocked'
 * The waiver is stamped per target (prior_contact), so "which messages went out
 * without a scrub" is answerable with one query years later.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { normalizePhone } = require('../openphone/_shared');
const ob = require('./_outbound');

module.exports.maxDuration = 60;

const OUT_OF_PIPELINE = ['booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call'];

async function connectedLeadIds(sb) {
    const ids = new Set();
    let from = 0;
    for (;;) {
        const { data, error } = await sb.from('lead_calls')
            .select('lead_id, duration_seconds').range(from, from + 999);
        if (error) throw new Error('lead_calls read failed: ' + error.message);
        if (!data.length) break;
        for (const r of data) if (r.lead_id && (r.duration_seconds || 0) >= 20) ids.add(r.lead_id);
        if (data.length < 1000) break;
        from += 1000;
    }
    return ids;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const campaignId = safeNumberId(body.campaign_id);
    if (campaignId == null) return res.status(400).json({ error: 'campaign_id_required' });
    const audience = body.audience || 'warm';
    const limit = Math.min(Number(body.limit) || 1000, 4000);
    const dry = !!body.dry;

    const sb = ob.serviceClient();
    const { data: campaign, error: cErr } = await sb.from('outbound_campaigns')
        .select('*').eq('id', campaignId).maybeSingle();
    if (cErr) return res.status(500).json({ error: 'campaign_read_failed', detail: cErr.message });
    if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

    let reps;
    try { reps = await ob.loadReps(); }
    catch (e) { return res.status(502).json({ error: 'reps_read_failed', detail: e.message }); }

    // Needed for the warm audience AND for the prior-contact scrub exemption,
    // which can apply to any audience. Computing it only for 'warm' would make
    // an exempt 'dialed' campaign silently stamp prior_contact=false on every
    // target and then hold them all back as unscrubbed.
    let connected = null;
    if (audience === 'warm' || campaign.scrub_exempt_prior_contact === true) {
        try { connected = await connectedLeadIds(sb); }
        catch (e) { return res.status(500).json({ error: 'calls_read_failed', detail: e.message }); }
    }

    // Reasons are counted, not just filtered, so a small result set is
    // explainable instead of mysterious.
    const held = {
        no_phone: 0, do_not_call: 0, already_booked: 0, bad_outcome: 0,
        not_scrubbed: 0, scrub_blocked: 0, scrub_phone_mismatch: 0,
        no_rep_line: 0, not_in_audience: 0, already_in_campaign: 0,
        scrub_waived_prior_contact: 0,
    };

    const { data: existing } = await sb.from('outbound_targets')
        .select('lead_id').eq('campaign_id', campaignId);
    const already = new Set((existing || []).map(r => r.lead_id));

    const rows = [];
    let from = 0;
    for (;;) {
        let q = sb.from('leads').select(
            'id,name,owner_name,niche,category,address,website,pitch_agent,assigned_to,' +
            'owner_phone_e164,owner_phone,phone,do_not_call,meeting_booked_at,last_called_at,' +
            'last_called_outcome,has_cold_call_script,scrub_status,scrub_phone'
        );
        if (audience === 'scripted') q = q.eq('has_cold_call_script', true);
        if (audience === 'dialed') q = q.not('last_called_at', 'is', null);
        const { data, error } = await q.order('id', { ascending: true }).range(from, from + 999);
        if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });
        if (!data.length) break;

        for (const l of data) {
            if (rows.length >= limit) break;
            if (already.has(l.id)) { held.already_in_campaign++; continue; }
            if (audience === 'warm' && !connected.has(l.id)) { held.not_in_audience++; continue; }
            if (l.do_not_call) { held.do_not_call++; continue; }
            if (l.meeting_booked_at) { held.already_booked++; continue; }
            if (OUT_OF_PIPELINE.includes(l.last_called_outcome || '')) { held.bad_outcome++; continue; }

            const to = normalizePhone(l.owner_phone_e164 || l.owner_phone || l.phone || '');
            if (!to) { held.no_phone++; continue; }

            // A confirmed litigator match is never enqueued, exemption or not.
            if (l.scrub_status === 'blocked') { held.scrub_blocked++; continue; }

            // prior_contact is the ONLY basis on which the scrub gate may be
            // waived, and it is stamped per target so the waiver stays auditable
            // long after the campaign settings change.
            const priorContact = connected ? connected.has(l.id) : false;
            const exempt = campaign.scrub_exempt_prior_contact === true && priorContact;

            if (!exempt) {
                if (l.scrub_status !== 'clear') { held.not_scrubbed++; continue; }
                if (l.scrub_phone && l.scrub_phone !== to) { held.scrub_phone_mismatch++; continue; }
            } else {
                held.scrub_waived_prior_contact = (held.scrub_waived_prior_contact || 0) + 1;
            }

            const rep = reps[l.assigned_to];
            if (!rep) { held.no_rep_line++; continue; }

            rows.push({
                campaign_id: campaignId,
                lead_id: l.id,
                assigned_to: l.assigned_to,
                from_line: rep.line,
                to_phone: to,
                stage: 'queued',
                step: 0,
                prior_contact: priorContact,
                prior_call_at: l.last_called_at || null,
                // Assigned ONCE, here, and never recomputed. Deriving the arm at
                // send time (lead_id % 2) would silently re-randomise everyone if
                // the rule were ever edited, retroactively corrupting results
                // already collected. Parity of the lead id is a fine randomiser
                // because ids are assigned by ingest order, which is unrelated to
                // anything the opener could influence.
                variant: campaign.ab_enabled ? (l.id % 2 === 0 ? 'A' : 'B') : null,
            });
        }
        if (rows.length >= limit || data.length < 1000) break;
        from += 1000;
    }

    const byRep = {};
    for (const r of rows) byRep[r.assigned_to] = (byRep[r.assigned_to] || 0) + 1;

    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, audience: audience,
            would_enqueue: rows.length, by_rep: byRep, held_back: held,
            note: 'Nothing written. not_scrubbed is the usual reason for a small number: run the scrub backfill first.',
        });
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        // ignoreDuplicates so a re-run tops the campaign up instead of erroring
        // on the (campaign_id, lead_id) unique constraint.
        const { error } = await sb.from('outbound_targets')
            .upsert(chunk, { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true });
        if (error) return res.status(500).json({ error: 'insert_failed', detail: error.message, inserted: inserted });
        inserted += chunk.length;
    }

    return res.status(200).json({
        ok: true, audience: audience, enqueued: inserted, by_rep: byRep, held_back: held,
        send_enabled_env: ob.SEND_ENABLED, campaign_status: campaign.status,
    });
};
