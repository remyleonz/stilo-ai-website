/**
 * /api/prospects/hot-leads
 *
 * GET  -> the "Call now" queue: leads a human touched in the last 72h (texted
 *         back, replied to an email, played the video, finished the quiz, left
 *         a number, answered an Instagram DM) that nobody has called since.
 *         SDRs see their own leads; admins see everyone's.
 * POST { lead_id, reason }        -> mark a lead hot by hand (Instagram reply,
 *                                   a walk-in, anything the webhooks can't see)
 * POST { lead_id, clear: true }   -> done, drop it from the strip
 *
 * "Called since" is computed from lead_calls, not stored, so a dial logged from
 * Quo clears the row without any extra write (see idempotency-stamps lessons).
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, resolveAssignedTo } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { markHot } = require('./_hot');

const BLASON = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const WINDOW_H = 72;

function sb() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
}
function cityOf(addr) {
    const m = String(addr || '').match(/,\s*([^,]+),\s*FL\b/i);
    return m ? m[1].trim() : '';
}

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const db = sb();

    if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const leadId = parseInt(body && body.lead_id, 10);
        if (!leadId) return res.status(400).json({ error: 'lead_id_required' });
        if (!gate.isAdmin) {
            const { data: own } = await db.from('leads').select('id').eq('id', leadId).eq('assigned_to', gate.email).maybeSingle();
            if (!own) return res.status(403).json({ error: 'not_your_lead' });
        }
        if (body.clear) {
            const { error } = await db.from('leads').update({ hot_cleared_at: new Date().toISOString() }).eq('id', leadId);
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true, cleared: leadId });
        }
        const r = await markHot(leadId, body.reason || 'flagged by ' + gate.email, db);
        if (r.error) return res.status(500).json({ error: r.error });
        return res.status(200).json({ ok: true, lead_id: leadId });
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'POST']);

    const floor = new Date(Date.now() - WINDOW_H * 3600 * 1000).toISOString();
    let q = db.from('leads')
        .select('id,name,owner_name,phone,owner_phone,owner_phone_e164,address,primary_language,assigned_to,client_id,hot_at,hot_reason,stage,next_step')
        .not('hot_at', 'is', null).is('hot_cleared_at', null).gte('hot_at', floor)
        .order('hot_at', { ascending: false }).limit(80);
    // Rep-scoped (Remy, 2026-10-08): Ale only sees signals from ALE's leads.
    // The shared-pool view of 10/07 confused the reps (Ale had Remy's video
    // watchers and callbacks on his board). Admins see everything, or one rep
    // with ?assigned_to= (what the impersonation banner sends).
    if (!gate.isAdmin) q = q.eq('assigned_to', gate.email);
    else if (req.query && req.query.assigned_to) { const a = await resolveAssignedTo(req.query.assigned_to); if (a) q = q.eq('assigned_to', a); }
    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!rows || !rows.length) return res.status(200).json({ ok: true, rows: [] });

    // Calls made after the lead went hot clear it.
    const ids = rows.map(function (r) { return r.id; });
    const minHot = rows.reduce(function (a, r) { return r.hot_at < a ? r.hot_at : a; }, rows[0].hot_at);
    const { data: calls } = await db.from('lead_calls').select('lead_id,called_at,direction')
        .in('lead_id', ids).eq('direction', 'outbound').gte('called_at', minHot);
    const calledAfter = {};
    (calls || []).forEach(function (c) { if (!calledAfter[c.lead_id] || c.called_at > calledAfter[c.lead_id]) calledAfter[c.lead_id] = c.called_at; });
    // Who dialed them last, ever (any rep): the row says it so two reps never
    // call the same warm lead five minutes apart.
    const { data: anyCalls } = await db.from('lead_calls').select('lead_id,called_at,logged_by,outcome')
        .in('lead_id', ids).eq('direction', 'outbound').order('called_at', { ascending: false }).limit(400);
    const lastCall = {};
    (anyCalls || []).forEach(function (c) { if (!lastCall[c.lead_id]) lastCall[c.lead_id] = { by: c.logged_by, at: c.called_at, outcome: c.outcome }; });

    const out = rows.filter(function (r) { return !(calledAfter[r.id] && calledAfter[r.id] > r.hot_at); })
        .map(function (r) {
            return {
                id: r.id, business: r.name, owner: r.owner_name,
                phone: r.owner_phone_e164 || r.owner_phone || r.phone || '',
                city: cityOf(r.address), lang: r.primary_language || 'en',
                assigned_to: r.assigned_to, client: r.client_id === BLASON ? 'Blason' : (r.client_id ? 'client' : 'STILO'),
                hot_at: r.hot_at, reason: r.hot_reason || '', stage: r.stage, next_step: r.next_step || '',
                last_call: lastCall[r.id] || null,
            };
        });
    return res.status(200).json({ ok: true, rows: out, window_hours: WINDOW_H });
};
