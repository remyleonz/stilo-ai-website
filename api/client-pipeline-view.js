/**
 * GET /api/client-pipeline-view?client_id=<uuid>
 *
 * The CLIENT-FACING slice of the sales pipeline: what Manuel is allowed to
 * see about the prospecting STILO runs for him. Auth mirrors client-leads.js
 * (admin token for impersonation, or the client's own session where
 * session.user.id === client_id).
 *
 * Deliberately sanitized versus /api/prospects/client-pipeline (the admin
 * view): no rep notes, no next-step instructions, no SMS reply bodies, no
 * internal outcome labels. Those columns carry rep coaching and internal
 * commentary that is not client-facing. The client sees WHO is booked and
 * when, who is hot, and honest totals. Nothing else.
 */
const { createClient } = require('@supabase/supabase-js');
const { ADMIN_EMAILS } = require('./_admin-config');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'method_not_allowed' });
    }
    const clientId = String((req.query || {}).client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });

    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await pub.auth.getUser(token);
    const email = userData && userData.user && (userData.user.email || '').toLowerCase();
    const userId = userData && userData.user && userData.user.id;
    if (userErr || !email) return res.status(401).json({ error: 'invalid_token' });
    const isAdmin = ADMIN_EMAILS.includes(email);
    if (!isAdmin && userId !== clientId) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
    const COLS = 'id,name,address,niche,category,stage,last_called_outcome,next_action_type,next_action_due_at,next_step,meeting_scheduled_at,do_not_call';
    let leads = [], from = 0;
    for (;;) {
        const { data, error } = await sb.from('leads').select(COLS).eq('client_id', clientId).range(from, from + 999);
        if (error) return res.status(500).json({ error: 'leads_read_failed' });
        leads = leads.concat(data || []);
        if (!data || data.length < 1000) break; from += 1000;
    }
    const { data: killed } = await sb.from('outbound_targets')
        .select('lead_id').in('stage', ['dead', 'opted_out', 'blocked']);
    const killedSet = new Set((killed || []).map(t => t.lead_id));
    const { data: replied } = await sb.from('outbound_targets')
        .select('lead_id').eq('stage', 'replied');
    const repliedSet = new Set((replied || []).map(t => t.lead_id));

    const city = a => (String(a || '').match(/,\s*([^,]+),\s*FL/i) || [])[1] || '';
    const out = { booked: [], hot: [], working: 0, won: 0, lost: 0 };
    for (const l of leads) {
        if (l.stage === 'CLOSED_WON') { out.won++; continue; }
        if (l.stage === 'CLOSED_LOST') { out.lost++; continue; }
        if (l.do_not_call || killedSet.has(l.id) || ['owner_uninterested', 'do_not_call', 'wrong_number'].includes(String(l.last_called_outcome || ''))) continue;
        if (l.stage === 'MEETING_BOOKED' || l.meeting_scheduled_at) {
            out.booked.push({ name: l.name, city: city(l.address), niche: l.niche || l.category || '', when: l.meeting_scheduled_at || null });
            continue;
        }
        const hot = (l.next_action_due_at && l.next_action_type === 'callback' && l.next_step)
            || l.last_called_outcome === 'callback_requested'
            || ['ENGAGED', 'QUALIFIED'].includes(String(l.stage || ''))
            || repliedSet.has(l.id);
        if (hot) { out.hot.push({ name: l.name, city: city(l.address), niche: l.niche || l.category || '' }); continue; }
        if (l.last_called_outcome === 'answered') out.working++;
    }
    out.booked.sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        ok: true,
        counts: { booked: out.booked.length, hot: out.hot.length, working: out.working, won: out.won, lost: out.lost },
        booked: out.booked,
        hot: out.hot.slice(0, 30),
    });
};
