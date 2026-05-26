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
const { assertAdminOrSdr, scopedQuery, forwardToProspecting, methodNotAllowed, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

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

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};
    const id = safeNumberId(q.id);
    let upstreamPath;
    let query;
    if (id != null) {
        upstreamPath = '/api/prospects/' + id;
        query = undefined;
    } else if (q.phone || q.business_name || q.email) {
        upstreamPath = '/api/prospects/detail';
        query = { phone: q.phone, business_name: q.business_name, email: q.email };
    } else {
        return res.status(400).json({ error: 'missing_lookup_key' });
    }

    // Fetch lead + call history in parallel — most leads have 0 calls, so
    // the lead_calls query is essentially free. Merge after both resolve.
    const [{ status, json }, callHistory] = await Promise.all([
        forwardToProspecting({ method: 'GET', path: upstreamPath, query: query }),
        id != null ? fetchCallHistory(id) : Promise.resolve([])
    ]);
    if (status >= 200 && status < 300 && json && typeof json === 'object') {
        json.call_history = callHistory;
    }

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
