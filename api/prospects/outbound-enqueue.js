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
 *   - belongs to this campaign's pool (campaign.client_id vs leads.client_id)
 *   - has not already told us no: stage isn't CLOSED_*, and the last outcome
 *     isn't wrong_number / disconnected / dnc_request / owner_uninterested
 *   - has a phone
 *   - is not on public.lcr_suppressions (the working do-not-contact list)
 *   - the assigned rep has an active Quo line
 *
 * The IPQS litigator scrub was retired 2026-08-31 and is no longer required.
 * A stored scrub_status of 'blocked' still blocks permanently. ?dry=1 still
 * tells you exactly how many were held back and why.
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

// Outcomes that take a lead out of the campaign. 'owner_uninterested' and
// 'meeting_cancelled' were missing until 2026-08-28, and the first Blason
// enqueue caught it: six people who had told a rep "not interested" the
// previous afternoon were queued for a text the next morning. 4Ever Young,
// NuLife, Rewind Anti-Aging, MD Aesthetics, Bellasa and Modern Dermatology all
// said no on the phone on 08-27 and all six had copy written for them.
//
// A soft no is still a no. _outbound_reply.js already refuses to pitch someone
// who says stop in a text; saying it out loud to a rep has to count for at
// least as much, or the channel becomes the thing that generates complaints
// rather than replies. They keep their long_followup date; that is the path
// back, not a text tomorrow.
const OUT_OF_PIPELINE = [
    'booked_meeting', 'dnc_request', 'wrong_number', 'disconnected', 'do_not_call',
    'owner_uninterested', 'meeting_cancelled',
];

// Stage is the second half of the same rule and it catches what the outcome
// misses: a lead can be closed out by a rep in the dashboard without the call
// log ever recording a declining outcome.
const CLOSED_STAGES = ['CLOSED_LOST', 'CLOSED_WON'];

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

/**
 * lead_id -> email of the rep who most recently DIALLED that lead.
 *
 * The campaign texts from the assigned rep's line, but the person actually
 * working a lead is often someone else, and then the prospect gets a call from
 * one number and a text from another about the same thing. On 2026-08-20
 * Leonardo Miraldi had six missed calls from Remy's line and then a text from
 * Alejandro's line, because the lead was assigned to Alejandro. Two strangers,
 * one conversation.
 *
 * Whoever is on their caller ID is the voice the text should come from, so the
 * last dialler wins over the assignment. Assignment still decides ownership and
 * commission; this only decides which number the message leaves from.
 */
async function lastDialerByLead(sb) {
    const map = new Map();
    const seen = new Map();
    let from = 0;
    for (;;) {
        const { data, error } = await sb.from('lead_calls')
            .select('lead_id, logged_by, called_at, direction')
            .eq('direction', 'outbound')
            .order('called_at', { ascending: false })
            .range(from, from + 999);
        if (error) throw new Error('lead_calls read failed: ' + error.message);
        if (!data.length) break;
        for (const r of data) {
            if (!r.lead_id || !r.logged_by) continue;
            const t = new Date(r.called_at).getTime();
            if (!seen.has(r.lead_id) || t > seen.get(r.lead_id)) {
                seen.set(r.lead_id, t);
                map.set(r.lead_id, r.logged_by);
            }
        }
        if (data.length < 1000) break;
        from += 1000;
    }
    return map;
}

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
    // ALWAYS computed. Since 2026-08-24 a connected call is a hard entry
    // condition for every audience, not just 'warm': cold SMS is banned
    // outright (Quo AUP + TCPA), so an audience that would text someone no rep
    // has ever spoken to is not an audience we can enqueue.
    let connected;
    try { connected = await connectedLeadIds(sb); }
    catch (e) { return res.status(500).json({ error: 'calls_read_failed', detail: e.message }); }

    let lastDialer;
    try { lastDialer = await lastDialerByLead(sb); }
    catch (e) { return res.status(500).json({ error: 'calls_read_failed', detail: e.message }); }

    // Reasons are counted, not just filtered, so a small result set is
    // explainable instead of mysterious.
    const held = {
        no_phone: 0, do_not_call: 0, already_booked: 0, bad_outcome: 0, closed_stage: 0, not_connected: 0,
        not_scrubbed: 0, scrub_blocked: 0, scrub_phone_mismatch: 0,
        no_rep_line: 0, not_in_audience: 0, already_in_campaign: 0,
        scrub_waived_prior_contact: 0, line_followed_last_dialer: 0,
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
            'last_called_outcome,stage,has_cold_call_script,scrub_status,scrub_phone'
        );
        // ARCHIVE IS AUTHORITATIVE. archived_batch is how a lead is retired, and
        // until 2026-08-19 this endpoint ignored it entirely, so every retired
        // lead stayed textable. That is how the pre-pivot book (dentists, CPAs,
        // insurance agents) kept reappearing in SMS campaigns months after the
        // Aug 2026 pivot: 230 of the first 259 targets enqueued for campaign 3
        // were retired leads. Retiring a lead now removes it from outbound as
        // well as from the dial boards, which is what everyone already assumed
        // archiving did.
        q = q.is('archived_batch', null);

        // POOL FIREWALL. A campaign declares which book it serves and may only
        // ever enqueue from that book:
        //
        //   campaign.client_id IS NULL  -> STILO's own leads, client_id IS NULL
        //   campaign.client_id = <uuid> -> that client's leads, and only those
        //
        // Until 2026-08-28 there was no filter here at all. Nothing had gone
        // wrong only because no client lead had ever been enqueued, but a
        // 'scripted' enqueue on a STILO campaign would have pulled Blason leads
        // in (1,000 of them carry has_cold_call_script) and texted them STILO
        // copy from a rep the prospect knows as Blason. Every other
        // client-content path already guards on client_id; this was the hole,
        // and it is the one that reaches a phone.
        if (campaign.client_id) q = q.eq('client_id', campaign.client_id);
        else q = q.is('client_id', null);

        if (audience === 'scripted') q = q.eq('has_cold_call_script', true);
        if (audience === 'dialed') q = q.not('last_called_at', 'is', null);
        const { data, error } = await q.order('id', { ascending: true }).range(from, from + 999);
        if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });
        if (!data.length) break;

        for (const l of data) {
            if (rows.length >= limit) break;
            if (already.has(l.id)) { held.already_in_campaign++; continue; }
            // Hard compliance gate: no connected call on record, no SMS. Applies
            // to every audience; preSendCheck enforces the same rule at send
            // time for anything enqueued before this date.
            if (!connected.has(l.id)) { held.not_connected = (held.not_connected || 0) + 1; continue; }
            if (l.do_not_call) { held.do_not_call++; continue; }
            if (l.meeting_booked_at) { held.already_booked++; continue; }
            if (OUT_OF_PIPELINE.includes(l.last_called_outcome || '')) { held.bad_outcome++; continue; }
            if (CLOSED_STAGES.includes(l.stage || '')) { held.closed_stage++; continue; }

            const to = normalizePhone(l.owner_phone_e164 || l.owner_phone || l.phone || '');
            if (!to) { held.no_phone++; continue; }

            // A confirmed litigator match is never enqueued, exemption or not.
            if (l.scrub_status === 'blocked') { held.scrub_blocked++; continue; }

            // prior_contact is the ONLY basis on which the scrub gate may be
            // waived, and it is stamped per target so the waiver stays auditable
            // long after the campaign settings change.
            const priorContact = connected ? connected.has(l.id) : false;
            const exempt = campaign.scrub_exempt_prior_contact === true && priorContact;

            // IPQS RETIRED 2026-08-31. The paid litigator scrub is no longer a
            // subscription we hold, so requiring scrub_status='clear' would hold
            // back every lead forever: 945 of Blason's 1,001 were never scrubbed
            // and never will be by that provider. Requiring a clean bill of health
            // from a service we cannot run is not caution, it is a permanently
            // closed valve.
            //
            // What still blocks, and always will:
            //   - do_not_call on the lead (checked above)
            //   - scrub_status 'blocked'  (checked above, a confirmed match we
            //     already paid for; retiring the vendor does not un-know it)
            //   - public.lcr_suppressions, which is now the working DNC list and
            //     is fed by every decline in every channel
            if (l.scrub_phone && l.scrub_status === 'clear' && l.scrub_phone !== to) {
                held.scrub_phone_mismatch++; continue;
            }
            if (exempt) held.scrub_waived_prior_contact = (held.scrub_waived_prior_contact || 0) + 1;

            // One voice per prospect: text from the number already on their
            // caller ID. Falls back to the assigned rep when nobody has dialled,
            // or when the last dialler has no active line.
            const dialer = lastDialer.get(l.id);
            const voice = (dialer && reps[dialer]) ? dialer : l.assigned_to;
            const rep = reps[voice];
            if (!rep) { held.no_rep_line++; continue; }
            if (voice !== l.assigned_to) held.line_followed_last_dialer++;

            rows.push({
                campaign_id: campaignId,
                lead_id: l.id,
                assigned_to: voice,
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

// Must come AFTER the handler assignment: `module.exports = ...` replaces the
// exports object, so setting maxDuration before it was silently discarded.
module.exports.maxDuration = 60;
