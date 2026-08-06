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

// Nurture-sequence signal: how many outbound value emails we've sent this lead,
// plus the most recent one. Drives the pre-meeting nurture stepper's derivation
// of the 'value' stage in the admin drawer (the nurture automation isn't built
// yet, so we derive it). Cheap COUNT + a one-row lookup for the timestamp.
async function fetchOutboundEmailStats(leadId) {
    if (leadId == null || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return { count: 0, last_sent_at: null };
    }
    try {
        const sb = leadsClient();
        const { count } = await sb.from('lead_messages')
            .select('id', { count: 'exact', head: true })
            .eq('lead_id', leadId)
            .eq('direction', 'outbound')
            .eq('channel', 'email');
        const { data } = await sb.from('lead_messages')
            .select('sent_at')
            .eq('lead_id', leadId)
            .eq('direction', 'outbound')
            .eq('channel', 'email')
            .order('sent_at', { ascending: false, nullsFirst: false })
            .limit(1);
        return { count: count || 0, last_sent_at: (data && data[0] && data[0].sent_at) || null };
    } catch (_) { return { count: 0, last_sent_at: null }; }
}

// Everything the nurture stepper needs to show WHAT we actually sent and whether
// it landed. The old stepper only knew a stage name, so "VSL sent" was a claim
// with nothing behind it -- you could not see the email, the SMS, or whether the
// prospect ever opened either. This returns the real artifacts.
//
// Two sources, kept separate on purpose:
//   messages  - what we sent (prospecting.lead_messages), full body included
//   vsl       - what they did (public.vsl_events), the engagement signal
//
// `body` is selected alongside `body_preview` deliberately. A preview is a
// summary line, and for the confirmation and reminder emails that line was a
// DESCRIPTION ("Confirmation + VSL link for Friday") rather than the words the
// prospect read. Reading the actual email in the panel means never having to go
// find it in a mailbox, and it is the only way to click the link we sent.
// Bodies stay short (plain-text sales copy), so the extra bytes are noise.
async function fetchNurtureDetail(leadId) {
    const empty = { messages: [], vsl: [] };
    if (leadId == null || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return empty;
    const out = { messages: [], vsl: [] };
    try {
        const sb = leadsClient();
        const { data } = await sb.from('lead_messages')
            .select('id,direction,channel,variant,subject,body,body_preview,to_address,from_address,sent_by,provider,status,sent_at,delivered_at,opened_at,clicked_at,replied_at,bounced_at')
            .eq('lead_id', leadId)
            .order('sent_at', { ascending: false, nullsFirst: false })
            .limit(200);
        out.messages = data || [];
    } catch (_) { /* stepper degrades to stage-only */ }
    try {
        // vsl_events lives in public, not prospecting.
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data } = await pub.from('vsl_events')
            .select('event,flow,agent,path,created_at')
            .eq('lead_id', leadId)
            .order('created_at', { ascending: true })
            .limit(500);
        out.vsl = data || [];
    } catch (_) { /* engagement pills just won't light up */ }
    return out;
}

// Sales-meeting records (Tactiq summaries + manual transcripts) for the lead's
// "Meeting transcripts" panel section. Newest first. `outcome` drives the
// nurture stepper's derivation of the 'showed' stage.
async function fetchMeetings(leadId) {
    if (leadId == null || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return [];
    try {
        const sb = leadsClient();
        const { data, error } = await sb.from('lead_meetings')
            .select('id, source, tactiq_meeting_id, title, occurred_at, duration_seconds, attendees, summary, action_items, transcript, meet_url, outcome, created_by, created_at')
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
    const [lead, callHistory, meetings, emailStats, nurture] = await Promise.all([
        fetchLead({ id: id, phone: q.phone, business_name: q.business_name, email: q.email }),
        id != null ? fetchCallHistory(id) : Promise.resolve([]),
        id != null ? fetchMeetings(id) : Promise.resolve([]),
        id != null ? fetchOutboundEmailStats(id) : Promise.resolve({ count: 0, last_sent_at: null }),
        id != null ? fetchNurtureDetail(id) : Promise.resolve({ messages: [], vsl: [] })
    ]);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    lead.call_history = callHistory;
    lead.meetings = meetings;
    // Nurture-stepper signals (see set-nurture-stage.js + the admin drawer's
    // nurtureStageFrom() derivation). nurture_stage itself comes through the
    // select('*') on the lead row.
    lead.nurture_email_count = emailStats.count;
    lead.nurture_last_email_at = emailStats.last_sent_at;
    lead.nurture_messages = nurture.messages;
    lead.nurture_vsl = nurture.vsl;
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
