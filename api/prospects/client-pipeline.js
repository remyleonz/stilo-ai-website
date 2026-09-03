/**
 * GET /api/prospects/client-pipeline?client_id=<uuid>
 *
 * The client-account CRM view. The STILO pipeline has Booked/Sales tabs, but
 * a client campaign (Blason) only had the raw lead list: hot leads, showroom
 * visits and promised callbacks lived in Remy's head and in ad-hoc exports
 * (2026-09-03, Beauty House / "things like this get lost in the cracks").
 *
 * One read, grouped server-side into the four questions a rep actually asks:
 *   booked  — a visit or meeting is on the calendar. Don't lose it.
 *   hot     — a live conversation with a committed next step (callback pin,
 *             callback_requested outcome, SMS reply, ENGAGED/QUALIFIED stage).
 *   working — we reached a human, no resolution yet.
 *   closed  — won / lost, for the record.
 *
 * Sorting: booked by meeting time, hot by next-action due (overdue first),
 * working by last touch. Every row carries next_step + notes so the list IS
 * the to-do, not a pointer to one.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const clientId = String((req.query || {}).client_id || '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });

    const COLS = 'id,name,owner_name,phone,owner_phone,address,niche,category,stage,last_called_outcome,last_called_at,call_attempts,next_step,next_action_type,next_action_due_at,meeting_scheduled_at,rep_notes,primary_language,do_not_call';
    let leads = [], from = 0;
    for (;;) {
        const { data, error } = await sb.from('leads').select(COLS)
            .eq('client_id', clientId).range(from, from + 999);
        if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });
        leads = leads.concat(data || []);
        if (!data || data.length < 1000) break; from += 1000;
    }

    // Live SMS threads: a campaign target sitting on 'replied' is a person
    // who answered us and may still be waiting on a human.
    const { data: replied } = await sb.from('outbound_targets')
        .select('lead_id, first_reply_body, first_reply_at')
        .eq('stage', 'replied');
    const replyBy = {};
    (replied || []).forEach(t => { replyBy[t.lead_id] = t; });

    const now = Date.now();
    const out = { booked: [], hot: [], working: [], closed: [] };
    for (const l of leads) {
        const reply = replyBy[l.id] || null;
        const row = {
            id: l.id, name: l.name, owner_name: l.owner_name,
            phone: l.phone, owner_phone: l.owner_phone, city: (String(l.address || '').match(/,\s*([^,]+),\s*FL/i) || [])[1] || '',
            niche: l.niche || l.category || '', lang: l.primary_language || 'en',
            stage: l.stage, outcome: l.last_called_outcome,
            last_called_at: l.last_called_at, attempts: l.call_attempts || 0,
            next_step: l.next_step || null, due_at: l.next_action_due_at || null,
            meeting_at: l.meeting_scheduled_at || null,
            notes: String(l.rep_notes || '').slice(-400),
            reply: reply ? { body: String(reply.first_reply_body || '').slice(0, 160), at: reply.first_reply_at } : null,
        };
        if (['CLOSED_WON', 'CLOSED_LOST'].includes(l.stage)) { out.closed.push(row); continue; }
        if (l.do_not_call || ['owner_uninterested', 'do_not_call', 'wrong_number'].includes(String(l.last_called_outcome || ''))) continue;
        if (l.stage === 'MEETING_BOOKED' || l.meeting_scheduled_at) { out.booked.push(row); continue; }
        const isHot = (l.next_action_due_at && l.next_action_type === 'callback' && l.next_step)
            || l.last_called_outcome === 'callback_requested'
            || ['ENGAGED', 'QUALIFIED'].includes(String(l.stage || ''))
            || !!reply;
        if (isHot) { out.hot.push(row); continue; }
        if (l.last_called_outcome === 'answered') { out.working.push(row); continue; }
        // Everything else (never reached, voicemail churn) stays on the Cold
        // Call board; the pipeline view is only what has a pulse.
    }

    out.booked.sort((a, b) => new Date(a.meeting_at || 0) - new Date(b.meeting_at || 0));
    out.hot.sort((a, b) => new Date(a.due_at || '2999-01-01') - new Date(b.due_at || '2999-01-01'));
    out.working.sort((a, b) => new Date(b.last_called_at || 0) - new Date(a.last_called_at || 0));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        ok: true, client_id: clientId, now: new Date(now).toISOString(),
        counts: { booked: out.booked.length, hot: out.hot.length, working: out.working.length, closed: out.closed.length },
        sections: out,
    });
};
