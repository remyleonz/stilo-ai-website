/**
 * GET|POST /api/prospects/schedule-nurture   (Vercel cron, every 15 min)
 * Optional: ?lead=N to (re)plan one lead, ?dry=1 to preview, ?replan=1 to rebuild
 *
 * Plans the value-touch sequence for every upcoming meeting that doesn't have
 * one yet, and generates the content up front so the whole plan is readable in
 * the dashboard before anything sends.
 *
 * WHY A CRON AND NOT JUST A HOOK IN book-meeting.js: bookings arrive through
 * more than one door. A rep books in the dashboard, a prospect books themselves
 * off a VSL page, and sync-bookings imports from the calendar every 5 minutes.
 * Hooking one door means the other two silently produce meetings with no
 * nurture. This claims any meeting, however it arrived.
 *
 * COLUMN NAME: the lead's scheduled time is leads.meeting_scheduled_at. There is no
 * leads.meeting_at; an earlier version of this file read that and would have 500'd on
 * every cron tick, silently meaning the value sequence never fired for anyone.
 * nurture_touches.meeting_at IS ours and is deliberately named differently.
 *
 * REBOOKINGS: the plan is keyed on (lead_id, step_key, channel, meeting_at). A
 * rebooked meeting has a different meeting_at, so it gets a fresh sequence
 * rather than inheriting the old one's spent stamps. That inheritance is
 * exactly the bug that made a previous rebooking skip its whole sequence, and
 * the schema is shaped to make it impossible here.
 *
 * Pending touches for a meeting time that no longer matches the lead's current
 * booking are cancelled, so moving a meeting doesn't leave orphan sends
 * pointing at the old time.
 */
const { assertAdminOrSdr, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const nv = require('./_nurture_value');

const LOOKAHEAD_DAYS = 14;

async function senderFor(pub, email) {
    if (!email) return { first_name: 'Remy' };
    try {
        const { data } = await pub.from('sdr_users').select('display_name').eq('email', email).maybeSingle();
        const n = (data && data.display_name) || '';
        return { first_name: n.trim().split(/\s+/)[0] || 'Remy' };
    } catch (_) { return { first_name: 'Remy' }; }
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const q = req.query || {};
    const dry = String(q.dry || '') === '1';
    const replan = String(q.replan || '') === '1';
    const onlyLead = safeNumberId(q.lead);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const now = new Date();
    const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);

    let lq = sb.from('leads')
        .select('id,name,owner_name,owner_email,email,niche,category,address,pitch_agent,meeting_scheduled_at,meeting_booked_by_sdr,do_not_call,owner_phone_e164,owner_phone,phone,primary_language')
        // Client-account leads never enter STILO's pre-meeting nurture: every
        // touch is STILO offer content (VSL, value assets). Guarded at the
        // PLANNER so no nurture_touches rows exist for them at all.
        .is('client_id', null)
        .not('meeting_scheduled_at', 'is', null)
        .gte('meeting_scheduled_at', now.toISOString())
        .lte('meeting_scheduled_at', horizon.toISOString());
    if (onlyLead != null) lq = lq.eq('id', onlyLead);

    const { data: leads, error } = await lq.limit(200);
    if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });

    const report = { considered: 0, planned: 0, touches_created: 0, skipped: {}, cancelled_stale: 0, details: [] };

    for (const lead of (leads || [])) {
        report.considered++;
        if (lead.do_not_call) { report.skipped.do_not_call = (report.skipped.do_not_call || 0) + 1; continue; }

        const meetingIso = new Date(lead.meeting_scheduled_at).toISOString();

        // Cancel anything still pending for a DIFFERENT meeting time on this
        // lead. That is the rebooking case: the meeting moved, so the old plan
        // is pointing at a time that will never happen.
        if (!dry) {
            const { data: stale } = await sb.from('nurture_touches')
                .select('id').eq('lead_id', lead.id).eq('status', 'pending').neq('meeting_at', meetingIso);
            if (stale && stale.length) {
                await sb.from('nurture_touches')
                    .update({ status: 'skipped', error: 'meeting_rescheduled', updated_at: now.toISOString() })
                    .in('id', stale.map(r => r.id));
                report.cancelled_stale += stale.length;
            }
        }

        const { data: existing } = await sb.from('nurture_touches')
            .select('id').eq('lead_id', lead.id).eq('meeting_at', meetingIso).limit(1);
        if (existing && existing.length && !replan) {
            report.skipped.already_planned = (report.skipped.already_planned || 0) + 1;
            continue;
        }

        const schedule = nv.buildSchedule(lead.meeting_scheduled_at, { now: now });
        if (!schedule.length) {
            report.skipped.too_close_to_meeting = (report.skipped.too_close_to_meeting || 0) + 1;
            continue;
        }

        const hasEmail = !!(lead.owner_email || lead.email);
        const hasPhone = !!(lead.owner_phone_e164 || lead.owner_phone || lead.phone);
        const sender = await senderFor(pub, lead.meeting_booked_by_sdr);

        const rows = [];
        for (const slot of schedule) {
            if (slot.channel === 'email' && !hasEmail) { report.skipped.no_email = (report.skipped.no_email || 0) + 1; continue; }
            if (slot.channel === 'sms' && !hasPhone) { report.skipped.no_phone = (report.skipped.no_phone || 0) + 1; continue; }

            let content = { subject: null, body: '(pending generation)' };
            if (!dry) {
                try { content = await nv.generateTouch(slot.step_key, lead, sender); }
                catch (e) { content = { subject: null, body: null, error: String(e.message || e) }; }
            }
            if (!content || !content.body) { report.skipped.generation_failed = (report.skipped.generation_failed || 0) + 1; continue; }

            rows.push({
                lead_id: lead.id,
                step_key: slot.step_key,
                channel: slot.channel,
                scheduled_for: slot.scheduled_for,
                meeting_at: slot.meeting_at,
                subject: content.subject,
                body: content.body,
                status: 'pending',
            });
        }

        if (!rows.length) continue;

        if (dry) {
            report.details.push({ lead_id: lead.id, business: lead.name, meeting_at: meetingIso, would_create: rows.length, slots: schedule.map(s => s.step_key + '@' + s.scheduled_for) });
            report.planned++;
            report.touches_created += rows.length;
            continue;
        }

        const { error: insErr } = await sb.from('nurture_touches')
            .upsert(rows, { onConflict: 'lead_id,step_key,channel,meeting_at', ignoreDuplicates: true });
        if (insErr) {
            report.skipped.insert_failed = (report.skipped.insert_failed || 0) + 1;
            console.error('[nurture] insert failed lead=' + lead.id + ': ' + insErr.message);
            continue;
        }
        report.planned++;
        report.touches_created += rows.length;
        report.details.push({ lead_id: lead.id, business: lead.name, meeting_at: meetingIso, created: rows.length });
    }

    return res.status(200).json(Object.assign({ ok: true, dry: dry }, report, { details: report.details.slice(0, 25) }));
};

// Must come AFTER the handler assignment: `module.exports = ...` replaces the
// exports object, so setting maxDuration before it was silently discarded.
module.exports.maxDuration = 300;
