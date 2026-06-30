/**
 * GET/POST /api/prospects/sync-meetings
 *
 * Unifies meeting transcripts into prospecting.lead_meetings so there is ONE
 * source of truth for "meetings", regardless of channel:
 *   - Video meetings (Google Meet) come in via Granola/Tactiq -> already in
 *     lead_meetings.
 *   - PHONE meetings (the prospect did the call over Quo/OpenPhone instead of
 *     joining Meet) only land in lead_calls. This job copies them across.
 *
 * A lead_calls row IS the meeting when it has a transcript and its called_at is
 * within 2h of the lead's meeting_scheduled_at (the call that happened at the
 * booked time). Idempotent: keyed on raw->openphone_call_id, and never touches a
 * lead that already has a Granola/Tactiq meeting row.
 *
 * Auth: Vercel cron (Bearer CRON_SECRET) or an admin/SDR JWT.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const WINDOW_MS = 2 * 3600 * 1000;

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) {
        const gate = await assertAdminOrSdr(req, res);
        if (!gate.ok) return;
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const sb = leadsClient();
    const { data: leads } = await sb.from('leads')
        .select('id, name, owner_name, meeting_scheduled_at, meeting_meet_link, meeting_booked_by_sdr, assigned_to')
        .not('meeting_scheduled_at', 'is', null);

    let created = 0, skipped = 0;
    const made = [];
    for (const l of leads || []) {
        const { data: calls } = await sb.from('lead_calls')
            .select('openphone_call_id, duration_seconds, called_at, transcript, transcript_summary')
            .eq('lead_id', l.id).not('transcript', 'is', null);
        const sched = new Date(l.meeting_scheduled_at).getTime();
        const mtgCall = (calls || [])
            .filter(x => x.transcript && Math.abs(new Date(x.called_at).getTime() - sched) < WINDOW_MS)
            .sort((a, b) => (b.duration_seconds || 0) - (a.duration_seconds || 0))[0];
        if (!mtgCall) continue;

        const { data: existing } = await sb.from('lead_meetings').select('id, raw, source').eq('lead_id', l.id);
        const already = (existing || []).some(m =>
            (m.raw && m.raw.openphone_call_id === mtgCall.openphone_call_id)
            || (m.source && (m.source.startsWith('granola') || m.source.startsWith('tactiq'))));
        if (already) { skipped++; continue; }

        const row = {
            lead_id: l.id, source: 'openphone',
            title: 'Sales meeting (phone) — ' + l.name,
            occurred_at: mtgCall.called_at,
            duration_seconds: mtgCall.duration_seconds || null,
            attendees: [{ name: l.owner_name || 'Prospect', role: 'prospect' }, { name: 'STILO', email: l.meeting_booked_by_sdr || l.assigned_to, role: 'host' }],
            summary: mtgCall.transcript_summary || null,
            transcript: mtgCall.transcript,
            meet_url: l.meeting_meet_link || null,
            raw: { openphone_call_id: mtgCall.openphone_call_id, source_table: 'lead_calls' },
            created_by: 'cron:sync-meetings'
        };
        const { error } = await sb.from('lead_meetings').insert(row);
        if (error) { console.error('[sync-meetings] insert failed', l.id, error.message); continue; }
        created++; made.push({ lead_id: l.id, name: l.name });
    }

    return res.status(200).json({ ok: true, created, skipped, made });
};
