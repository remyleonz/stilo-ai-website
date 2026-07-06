/**
 * GET /api/prospects/list-booked?limit=400
 *
 * Server-side query against prospecting.leads using the service-role key.
 * Returns leads with last_called_outcome='booked_meeting', ordered by
 * last_called_at desc (most recently booked first).
 */
const { assertAdminOrSdr, scopedQuery, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts', 'call_notes',
    'next_action_due_at', 'owner_phone_strict_pass', 'assigned_to',
    'meeting_event_id', 'meeting_event_link', 'meeting_meet_link',
    'meeting_scheduled_at', 'meeting_duration_min', 'meeting_booked_by_sdr',
    'nurture_stage'
].join(',');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '400', 10), 1), 1000);

    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        const resp = await sb.from('leads')
            .select(SELECT_COLS)
            .not('meeting_scheduled_at', 'is', null)
            .order('meeting_scheduled_at', { ascending: true, nullsFirst: false })
            .limit(limit);
        if (resp.error) throw resp.error;
        return res.status(200).json({ results: resp.data || [] });
    } catch (e) {
        console.error('[list-booked]', e);
        return res.status(500).json({ error: 'list_booked_failed', detail: String(e.message || e) });
    }
};
