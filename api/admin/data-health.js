/**
 * GET /api/admin/data-health
 *
 * One place to catch the data gaps that quietly break sales tracking. For every
 * lead with a booked meeting it flags:
 *   - no_calendar_event   meeting has no Google event (won't show a Join link / can't sync)
 *   - no_owner_name       breaks booking attribution + personalization
 *   - attribution_mismatch  meeting_booked_by_sdr != assigned_to (credit ambiguity)
 *   - past_no_outcome     meeting already happened, no outcome logged -> can't measure meeting->close
 *   - past_no_transcript  meeting happened, no transcript anywhere (lost record)
 *
 * Returns counts + the offending leads so the admin can fix them. Read-only.
 * Auth: admin JWT.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

function psb() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const sb = psb();
    const now = Date.now();

    const { data: booked } = await sb.from('leads')
        .select('id, name, owner_name, stage, meeting_scheduled_at, meeting_event_id, meeting_booked_by_sdr, assigned_to')
        .not('meeting_scheduled_at', 'is', null)
        .order('meeting_scheduled_at', { ascending: true });
    const leads = booked || [];
    const ids = leads.map(l => l.id);

    // Meeting records (outcome rows + transcripts) for the booked set.
    const meetingsByLead = {};
    if (ids.length) {
        const { data: mtgs } = await sb.from('lead_meetings')
            .select('lead_id, title, source, transcript').in('lead_id', ids);
        (mtgs || []).forEach(m => {
            (meetingsByLead[m.lead_id] = meetingsByLead[m.lead_id] || []).push(m);
        });
    }
    // Leads with a real call transcript (covers phone meetings not yet unified).
    const callTranscriptLeads = new Set();
    if (ids.length) {
        const { data: calls } = await sb.from('lead_calls')
            .select('lead_id').in('lead_id', ids).not('transcript', 'is', null).limit(5000);
        (calls || []).forEach(c => callTranscriptLeads.add(c.lead_id));
    }

    const TERMINAL = ['CLOSED_WON', 'CLOSED_LOST'];
    const brief = l => ({ id: l.id, name: l.name, meeting_scheduled_at: l.meeting_scheduled_at, rep: l.meeting_booked_by_sdr || l.assigned_to });

    const issues = {
        no_calendar_event: [],
        no_owner_name: [],
        attribution_mismatch: [],
        past_no_outcome: [],
        past_no_transcript: []
    };

    for (const l of leads) {
        const isPast = new Date(l.meeting_scheduled_at).getTime() < now;
        const mtgs = meetingsByLead[l.id] || [];
        const hasOutcome = mtgs.some(m => (m.title || '').startsWith('Meeting outcome:')) || TERMINAL.includes(String(l.stage || '').toUpperCase());
        const hasTranscript = mtgs.some(m => m.transcript && String(m.transcript).length > 40) || callTranscriptLeads.has(l.id);

        if (!l.meeting_event_id) issues.no_calendar_event.push(brief(l));
        if (!l.owner_name) issues.no_owner_name.push(brief(l));
        if (l.meeting_booked_by_sdr && l.assigned_to && l.meeting_booked_by_sdr !== l.assigned_to) {
            issues.attribution_mismatch.push({ ...brief(l), booked_by: l.meeting_booked_by_sdr, assigned_to: l.assigned_to });
        }
        if (isPast && !hasOutcome) issues.past_no_outcome.push(brief(l));
        if (isPast && !hasTranscript) issues.past_no_transcript.push(brief(l));
    }

    const counts = {};
    Object.keys(issues).forEach(k => { counts[k] = issues[k].length; });
    counts.total_booked = leads.length;

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ ok: true, counts, issues, checked_at: new Date(now).toISOString() });
};
