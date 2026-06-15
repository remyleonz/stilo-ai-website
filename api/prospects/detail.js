/**
 * GET /api/prospects/detail?id=42
 * GET /api/prospects/detail?phone=...
 * GET /api/prospects/detail?business_name=...
 *
 * Lookup by id (primary) or by phone / business_name. Forwards to David's
 * `/api/prospects/{id}` for the lead record, then merges in `call_history`
 * by querying `prospecting.lead_calls` directly with the service-role
 * key. David's API doesn't expose call history yet (his /api/prospects/{id}
 * response doesn't include it), so we merge here instead of waiting on him.
 *
 * Each row in lead_calls is one OpenPhone call event. The webhook upserts
 * keyed on openphone_call_id, so transcripts + recordings + summaries
 * accumulate as they land. The drawer reads `call_history` and renders a
 * timeline.
 */
const { assertAdminOrSdr, methodNotAllowed, safeNumberId, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
}

// Fetch a single lead straight from Supabase. Replaces the old forward to
// David's Cloud Run /api/prospects/{id}, which hangs under load and left the
// lead drawer stuck on "Loading lead…".
async function fetchLead({ id, phone, business_name, email }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    const sb = leadsClient();
    let q = sb.from('leads').select('*');
    if (id != null) q = q.eq('id', id);
    else if (phone) q = q.or(`owner_phone.eq.${phone},phone.eq.${phone}`);
    else if (email) q = q.or(`owner_email.eq.${email},email.eq.${email}`);
    else if (business_name) q = q.ilike('name', `%${business_name}%`);
    else return null;
    const { data, error } = await q.limit(1);
    if (error || !data || !data.length) return null;
    return normalizeLead(data[0]);
}

async function fetchCallHistory(leadId) {
    if (leadId == null) return [];
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return [];
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        const { data, error } = await sb.from('lead_calls')
            .select('id,openphone_call_id,direction,from_number,to_number,called_at,duration_seconds,outcome,transcript,transcript_summary,recording_url,logged_by')
            .eq('lead_id', leadId)
            .order('called_at', { ascending: false, nullsFirst: false })
            .limit(50);
        if (error) return [];
        return data || [];
    } catch (_) { return []; }
}

// Sales-meeting records (Tactiq summaries + manual transcripts) for the lead's
// "Meeting transcripts" panel section. Newest first.
async function fetchMeetings(leadId) {
    if (leadId == null || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return [];
    try {
        const sb = leadsClient();
        const { data, error } = await sb.from('lead_meetings')
            .select('id, source, tactiq_meeting_id, title, occurred_at, duration_seconds, attendees, summary, action_items, transcript, meet_url, created_by, created_at')
            .eq('lead_id', leadId)
            .order('occurred_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return [];
        return data || [];
    } catch (_) { return []; }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const id = safeNumberId(q.id);
    if (id == null && !q.phone && !q.business_name && !q.email) {
        return res.status(400).json({ error: 'missing_lookup_key' });
    }

    // Fetch lead + call history in parallel — most leads have 0 calls, so
    // the lead_calls query is essentially free. Merge after both resolve.
    const [lead, callHistory, meetings] = await Promise.all([
        fetchLead({ id: id, phone: q.phone, business_name: q.business_name, email: q.email }),
        id != null ? fetchCallHistory(id) : Promise.resolve([]),
        id != null ? fetchMeetings(id) : Promise.resolve([])
    ]);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    lead.call_history = callHistory;
    lead.meetings = meetings;
    const status = 200;
    const json = lead;

    // Compliance audit: log every lead-drawer open. Fire-and-forget so we
    // never block the response. Captures who accessed which lead and when.
    if (id != null) {
        try {
            const auditSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
                auth: { persistSession: false }
            });
            const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
            auditSb.from('lead_access_log').insert({
                lead_id: id,
                user_id: null,  // We have email but not the auth.uid() here without an extra lookup
                user_email: gate.email || null,
                user_role: gate.role || null,
                user_agent: (req.headers['user-agent'] || '').slice(0, 250),
                ip: xf || (req.headers['x-real-ip'] || '').slice(0, 50) || null
            }).then(() => {}).catch(() => {});
        } catch (_) { /* never block */ }
    }

    return res.status(status).json(json);
};
