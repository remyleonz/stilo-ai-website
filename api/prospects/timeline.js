/**
 * GET /api/prospects/timeline?id=<lead_id>
 *
 * Unified activity feed for a single lead. Merges:
 *   - prospecting.lead_calls   (calls + outcomes + transcripts)
 *   - prospecting.lead_messages (SMS + email + voicemail)
 *   - prospecting.lead_stage_history (lifecycle transitions)
 *   - prospecting.lead_meetings (held meetings + outcomes)
 *
 * Returns an array of events sorted newest-first with a normalized shape:
 *   { ts, kind: 'call' | 'message' | 'stage' | 'meeting', ... }
 *
 * Powers the Timeline tab in the lead drawer and the expandable rows on the
 * Sales tab booked-meetings panel.
 */
const { assertAdminOrSdr, scopedQuery, methodNotAllowed, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const id = safeNumberId((req.query && req.query.id) || (req.query && req.query.lead_id));
    if (id == null) return res.status(400).json({ error: 'missing_id' });

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ events: [] });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    try {
        const [callsRes, messagesRes, stagesRes, meetingsRes] = await Promise.all([
            sb.from('lead_calls')
              .select('id, direction, called_at, outcome, duration_seconds, recording_url, transcript, transcript_summary, notes, logged_by, from_number, to_number')
              .eq('lead_id', id)
              .order('called_at', { ascending: false })
              .limit(200),
            sb.from('lead_messages')
              // opened_at and variant drive the nurture panel in the lead drawer:
              // which step of the sequence a message belongs to, and whether the
              // prospect ever opened it.
              .select('id, direction, channel, subject, body, body_preview, sent_at, sent_by, to_address, from_address, status, provider, opened_at, variant')
              .eq('lead_id', id)
              .order('sent_at', { ascending: false })
              .limit(200),
            sb.from('lead_stage_history')
              .select('id, from_stage, to_stage, changed_by, changed_at, reason')
              .eq('lead_id', id)
              .order('changed_at', { ascending: false })
              .limit(200),
            sb.from('lead_meetings')
              .select('id, occurred_at, outcome, source, title, duration_seconds, summary')
              .eq('lead_id', id)
              .order('occurred_at', { ascending: false })
              .limit(50)
        ]);
        if (callsRes.error)    throw callsRes.error;
        if (messagesRes.error) throw messagesRes.error;
        if (stagesRes.error)   throw stagesRes.error;
        if (meetingsRes.error) throw meetingsRes.error;

        const events = [];
        for (const c of callsRes.data || []) {
            events.push({ kind: 'call', ts: c.called_at, ...c });
        }
        for (const m of messagesRes.data || []) {
            events.push({ kind: 'message', ts: m.sent_at, ...m });
        }
        for (const s of stagesRes.data || []) {
            events.push({ kind: 'stage', ts: s.changed_at, ...s });
        }
        for (const m of meetingsRes.data || []) {
            events.push({ kind: 'meeting', ts: m.occurred_at, ...m });
        }
        events.sort((a, b) => (b.ts > a.ts ? 1 : (b.ts < a.ts ? -1 : 0)));

        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            events,
            counts: {
                calls: (callsRes.data || []).length,
                messages: (messagesRes.data || []).length,
                stages: (stagesRes.data || []).length,
                meetings: (meetingsRes.data || []).length
            }
        });
    } catch (e) {
        console.error('[timeline] failed', e);
        return res.status(200).json({ events: [], error: e.message || 'unknown' });
    }
};
