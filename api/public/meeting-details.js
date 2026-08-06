/**
 * GET /api/public/meeting-details?lid=<id>&t=<token>
 *
 * Returns the prospect's already-booked meeting so the VSL page's "Confirm
 * Meeting" modal, and the /vsl/pre-meeting details panel, can show their real
 * date/time + Meet link. Gated by the same HMAC lead token used for booking
 * attribution (no token = no data). Also returns niche + owner_name so the
 * pre-meeting agenda can be written for their industry by name.
 */
const { createClient } = require('@supabase/supabase-js');
const { verifyLead } = require('./_token');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
    const q = req.query || {};
    const lid = q.lid != null && /^\d+$/.test(String(q.lid)) ? parseInt(String(q.lid), 10) : null;
    if (lid == null || !verifyLead(lid, q.t)) return res.status(403).json({ error: 'bad_token' });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'not_configured' });
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
        const { data: lead } = await sb.from('leads')
            .select('id,name,owner_name,niche,category,meeting_scheduled_at,meeting_duration_min,meeting_meet_link,meeting_event_link,meeting_confirmed_at')
            .eq('id', lid).maybeSingle();
        if (!lead) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({
            business: lead.name || null,
            owner_name: lead.owner_name || null,
            niche: lead.niche || lead.category || null,
            when_iso: lead.meeting_scheduled_at || null,
            duration_min: lead.meeting_duration_min || null,
            meet_link: lead.meeting_meet_link || null,
            event_link: lead.meeting_event_link || null,
            confirmed: !!lead.meeting_confirmed_at
        });
    } catch (e) {
        return res.status(500).json({ error: 'read_failed', detail: String(e.message || e) });
    }
};
