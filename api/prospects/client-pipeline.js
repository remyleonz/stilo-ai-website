/**
 * GET /api/prospects/client-pipeline?client_id=<uuid>
 *
 * The client-account CRM view (Blason). Grouped server-side into the questions
 * a rep asks at 8am:
 *   hottest  : rep-pinned (pinned_at). Named a machine or a concrete plan.
 *              Always on top regardless of call window (2026-09-25: Pareen
 *              and Health Carpenter were rows 22 and 29 when sorted by time).
 *   booked   : a visit or meeting is on the calendar.
 *   today    : a written next step is due today, or they texted us and are
 *              waiting on a human. This is today's dial list.
 *   overdue  : a written next step whose date already passed. Promised and
 *              missed: call it or re-date it.
 *   upcoming : a written next step with a future date (revive Oct 8, etc).
 *   no_plan  : had a pulse (ENGAGED / callback_requested) but nobody wrote
 *              down what happens next. A front desk saying "call back" used to
 *              land here as "Hot" and inflated the count to 72 (2026-09-25).
 *              These need a decision, not a dial.
 *   working  : reached a human, no resolution logged.
 *   closed   : won / lost, for the record.
 *
 * Admins see the whole client pool. A client_account SDR sees their client's
 * pool, assigned to them only.
 */
const { assertAdminOrSdr, methodNotAllowed, resolveClientScope, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    // POST { id, pinned } pins/unpins a lead into Hottest. SDRs only their own.
    if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const id = safeNumberId(body && body.id);
        if (id == null) return res.status(400).json({ error: 'id_required' });
        const sbw = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false }, db: { schema: 'prospecting' },
        });
        let q = sbw.from('leads').update({ pinned_at: body.pinned ? new Date().toISOString() : null }).eq('id', id).not('client_id', 'is', null);
        if (!gate.isAdmin) q = q.eq('assigned_to', String(gate.email || '').toLowerCase());
        const { data, error } = await q.select('id,pinned_at');
        if (error) return res.status(500).json({ error: 'pin_failed', detail: error.message });
        if (!data || !data.length) return res.status(404).json({ error: 'not_found_or_not_yours' });
        return res.status(200).json({ ok: true, id, pinned_at: data[0].pinned_at });
    }

    let clientId = String((req.query || {}).client_id || '2efae6bf-69d8-4c4d-ac25-6a693db50f8b');
    let repEmail = null;
    if (!gate.isAdmin) {
        const scoped = await resolveClientScope(gate.email);
        if (!scoped) return res.status(200).json({ ok: true, counts: {}, sections: {}, note: 'not_a_client_rep' });
        clientId = scoped;
        repEmail = String(gate.email || '').toLowerCase();
    }
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });

    const COLS = 'id,name,owner_name,phone,owner_phone,address,niche,category,stage,last_called_outcome,last_called_at,call_attempts,next_step,next_step_due,next_action_type,next_action_due_at,meeting_scheduled_at,rep_notes,primary_language,do_not_call,assigned_to,email,owner_email,pinned_at';
    let leads = [], from = 0;
    for (;;) {
        let q = sb.from('leads').select(COLS).eq('client_id', clientId);
        if (repEmail) q = q.eq('assigned_to', repEmail);
        const { data, error } = await q.range(from, from + 999);
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

    // A decline often lives ONLY on the SMS target ("we are not interested"
    // by text flips the target to dead/opted_out while the lead row still
    // carries an innocent callback_requested from an earlier call). Without
    // this, The Salt Room sat in Hot three days after texting a no.
    const { data: killed } = await sb.from('outbound_targets')
        .select('lead_id').in('stage', ['dead', 'opted_out', 'blocked']);
    const killedSet = new Set((killed || []).map(t => t.lead_id));

    const now = Date.now();
    // "Today" is the ET calendar day. next_action_due_at is stored naive UTC.
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const endTodayMs = new Date(todayET + 'T23:59:59-04:00').getTime();
    const startTodayMs = new Date(todayET + 'T00:00:00-04:00').getTime();
    const asUtcMs = (v) => {
        if (!v) return null;
        const s = String(v);
        const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime();
        return isNaN(t) ? null : t;
    };
    const out = { hottest: [], booked: [], today: [], overdue: [], upcoming: [], no_plan: [], working: [], closed: [] };
    for (const l of leads) {
        const reply = replyBy[l.id] || null;
        const dueMs = asUtcMs(l.next_action_due_at)
            || (l.next_step_due ? new Date(l.next_step_due + 'T09:00:00-04:00').getTime() : null);
        const row = {
            id: l.id, name: l.name, owner_name: l.owner_name,
            phone: l.phone, owner_phone: l.owner_phone, email: l.owner_email || l.email || null,
            city: (String(l.address || '').match(/,\s*([^,]+),\s*FL/i) || [])[1] || '',
            niche: l.niche || l.category || '', lang: l.primary_language || 'en',
            stage: l.stage, outcome: l.last_called_outcome,
            last_called_at: l.last_called_at, attempts: l.call_attempts || 0,
            next_step: l.next_step || null,
            due_at: dueMs ? new Date(dueMs).toISOString() : null,
            meeting_at: l.meeting_scheduled_at || null,
            rep: String(l.assigned_to || '').split('@')[0] || null,
            notes: String(l.rep_notes || '').slice(-400),
            pinned: !!l.pinned_at,
            reply: reply ? { body: String(reply.first_reply_body || '').slice(0, 160), at: reply.first_reply_at } : null,
        };
        if (['CLOSED_WON', 'CLOSED_LOST'].includes(l.stage)) { out.closed.push(row); continue; }
        if (l.pinned_at && !l.do_not_call) { out.hottest.push(row); continue; }
        // A dead SMS thread hides the lead UNLESS a human has since written a
        // dated next step (Minik: Brian replied warmly, target still 'dead').
        // Opt-outs stay hidden regardless: they also carry do_not_call.
        const reopened = !!(l.next_step && dueMs);
        if (l.do_not_call || (killedSet.has(l.id) && !reopened) || ['owner_uninterested', 'do_not_call', 'wrong_number'].includes(String(l.last_called_outcome || ''))) continue;
        if (l.stage === 'MEETING_BOOKED' || (l.meeting_scheduled_at && asUtcMs(l.meeting_scheduled_at) > now - 36e5 * 12)) { out.booked.push(row); continue; }
        if (reply && !l.next_step) { row.due_at = row.due_at || reply.at; out.today.push(row); continue; }
        if (l.next_step && dueMs && dueMs < startTodayMs) { out.overdue.push(row); continue; }
        if (l.next_step && dueMs && dueMs <= endTodayMs) { out.today.push(row); continue; }
        if (l.next_step && dueMs) { out.upcoming.push(row); continue; }
        const hadPulse = l.last_called_outcome === 'callback_requested'
            || ['ENGAGED', 'QUALIFIED'].includes(String(l.stage || '')) || !!l.next_step;
        if (hadPulse) { out.no_plan.push(row); continue; }
        if (l.last_called_outcome === 'answered') { out.working.push(row); continue; }
        // Never reached / voicemail churn stays on the Cold Call board.
    }

    const byDue = (a, b) => new Date(a.due_at || '2999-01-01') - new Date(b.due_at || '2999-01-01');
    out.hottest.sort(byDue);
    out.booked.sort((a, b) => new Date(a.meeting_at || 0) - new Date(b.meeting_at || 0));
    out.today.sort(byDue);
    out.overdue.sort(byDue);
    out.upcoming.sort(byDue);
    const byTouch = (a, b) => new Date(b.last_called_at || 0) - new Date(a.last_called_at || 0);
    out.no_plan.sort(byTouch);
    out.working.sort(byTouch);
    out.closed.sort(byTouch);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
        ok: true, client_id: clientId, now: new Date(now).toISOString(),
        counts: Object.fromEntries(Object.keys(out).map(k => [k, out[k].length])),
        won: out.closed.filter(r => r.stage === 'CLOSED_WON').length,
        today_et: todayET,
        sections: out,
    });
};
