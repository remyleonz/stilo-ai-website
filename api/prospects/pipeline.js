/**
 * /api/prospects/pipeline
 *
 * The rep's Pipeline tab: every lead by engagement tier.
 *
 * GET  [?assigned_to=<email|sdr_key>] (admins only; SDRs are forced to their
 *      own leads) -> { hot: [...], warm: [...], cold_count, counts }
 *      One row per lead: who, phone, city, language, tier + why + when, the
 *      "call now" stamp if it is still live, who on the team dialed them last
 *      (any rep, so nobody double-calls), next step, meeting.
 * POST { lead_id, tier: 'cold'|'warm'|'hot', reason? }
 *      Sets the tier by hand from the drawer. Moving to cold also clears the
 *      call-now stamp. SDRs can only touch their own leads.
 *
 * engagement_tier is the rep-facing temperature (default cold; any human
 * signal promotes to warm through _hot.js; hot is this endpoint, by hand). It
 * is NOT prospect_tier / brief_tier, which rank how good a fit the business is.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, resolveAssignedTo, resolveClientScope } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const TIERS = ['cold', 'warm', 'hot'];
const COLS = 'id,name,owner_name,phone,owner_phone,owner_phone_e164,address,primary_language,assigned_to,client_id,stage,next_step,next_step_due,meeting_scheduled_at,hot_at,hot_reason,hot_cleared_at,engagement_tier,engagement_tier_at,engagement_tier_reason,engagement_tier_by,last_called_at,last_called_outcome,call_attempts,instagram_handle,do_not_call';

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function cityOf(addr) { const m = String(addr || '').match(/,\s*([^,]+),\s*FL\b/i); return m ? m[1].trim() : ''; }

async function scopeEmail(gate, req) {
    if (!gate.isAdmin) return gate.email;
    const a = req.query && req.query.assigned_to;
    return a ? await resolveAssignedTo(a) : null;
}

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const db = sb();

    if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const leadId = parseInt(body && body.lead_id, 10);
        const tier = String(body && body.tier || '').toLowerCase();
        if (!leadId) return res.status(400).json({ error: 'lead_id_required' });
        if (TIERS.indexOf(tier) < 0) return res.status(400).json({ error: 'bad_tier' });
        if (!gate.isAdmin) {
            const { data: own } = await db.from('leads').select('id').eq('id', leadId).eq('assigned_to', gate.email).maybeSingle();
            if (!own) return res.status(403).json({ error: 'not_your_lead' });
        }
        const now = new Date().toISOString();
        const upd = { engagement_tier: tier, engagement_tier_at: now, engagement_tier_reason: String(body.reason || ('set by ' + gate.email)).slice(0, 240), engagement_tier_by: gate.email };
        if (tier === 'cold') upd.hot_cleared_at = now;
        const { error } = await db.from('leads').update(upd).eq('id', leadId);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, lead_id: leadId, tier: tier });
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'POST']);

    const email = await scopeEmail(gate, req);
    // A client-account rep's board is their client's pool (Ale dials Blason, not
    // the STILO leads he had before the pivot). Admins see every pool unless
    // they ask for one with ?client_id=.
    let clientId = email ? await resolveClientScope(email) : null;
    if (!clientId && gate.isAdmin && req.query && req.query.client_id) clientId = String(req.query.client_id);
    const stiloOnly = gate.isAdmin && !clientId && req.query && req.query.pool === 'stilo';
    let q = db.from('leads').select(COLS).in('engagement_tier', ['warm', 'hot'])
        .or('do_not_call.is.null,do_not_call.eq.false')
        .order('engagement_tier_at', { ascending: false, nullsFirst: false }).limit(400);
    if (email) q = q.eq('assigned_to', email);
    // Inbound unknown callers are stubbed with client_id null even when they
    // rang a Blason rep's line, so a live call-now stamp always qualifies.
    if (clientId) q = q.or('client_id.eq.' + clientId + ',hot_at.not.is.null');
    if (stiloOnly) q = q.is('client_id', null);
    const { data: rows, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    let cq = db.from('leads').select('id', { count: 'exact', head: true }).eq('engagement_tier', 'cold')
        .or('do_not_call.is.null,do_not_call.eq.false').not('stage', 'in', '(CLOSED_LOST,CLOSED_WON)');
    if (email) cq = cq.eq('assigned_to', email);
    if (clientId) cq = cq.eq('client_id', clientId);
    if (stiloOnly) cq = cq.is('client_id', null);
    const { count: coldCount } = await cq;

    const ids = (rows || []).map(function (r) { return r.id; });
    const lastCall = {};
    if (ids.length) {
        const { data: calls } = await db.from('lead_calls').select('lead_id,called_at,logged_by,outcome,duration_seconds,decision_maker')
            .in('lead_id', ids).eq('direction', 'outbound').order('called_at', { ascending: false }).limit(1500);
        (calls || []).forEach(function (c) { if (!lastCall[c.lead_id]) lastCall[c.lead_id] = { by: c.logged_by, at: c.called_at, outcome: c.outcome, seconds: c.duration_seconds, decision_maker: c.decision_maker }; });
    }
    const out = (rows || []).map(function (r) {
        const live = !!(r.hot_at && !r.hot_cleared_at && !(lastCall[r.id] && lastCall[r.id].at > r.hot_at));
        return {
            id: r.id, business: r.name, owner: r.owner_name, phone: r.owner_phone_e164 || r.owner_phone || r.phone || '',
            city: cityOf(r.address), lang: r.primary_language || 'en', assigned_to: r.assigned_to, client_id: r.client_id,
            tier: r.engagement_tier, tier_at: r.engagement_tier_at, tier_reason: r.engagement_tier_reason || '', tier_by: r.engagement_tier_by || '',
            call_now: live, hot_at: r.hot_at, hot_reason: r.hot_reason || '',
            last_call: lastCall[r.id] || null, call_attempts: r.call_attempts || 0,
            stage: r.stage, next_step: r.next_step || '', next_step_due: r.next_step_due, meeting_at: r.meeting_scheduled_at,
            instagram: r.instagram_handle || '',
        };
    });
    const hot = out.filter(function (r) { return r.tier === 'hot'; });
    const warm = out.filter(function (r) { return r.tier === 'warm'; });
    // Live call-now signals float to the top of each group, then newest.
    const sortFn = function (a, b) { return (b.call_now - a.call_now) || (String(b.hot_at || b.tier_at || '') > String(a.hot_at || a.tier_at || '') ? 1 : -1); };
    hot.sort(sortFn); warm.sort(sortFn);
    return res.status(200).json({ ok: true, hot: hot, warm: warm, cold_count: coldCount || 0, counts: { hot: hot.length, warm: warm.length, cold: coldCount || 0, call_now: out.filter(function (r) { return r.call_now; }).length }, scope: email || 'all', client_id: clientId || null });
};
