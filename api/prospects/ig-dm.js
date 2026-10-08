/**
 * /api/prospects/ig-dm
 *
 * The Instagram DM worklist, in the dashboard instead of a CSV by email.
 * Table: prospecting.ig_dm_queue (one row per handle; lead_id when the clinic
 * is in the CRM; assigned_to = the rep whose own account sends it).
 *
 * GET  [?status=queued|sent|replied|done|all] [&channel=instagram|facebook] [&limit=] [&assigned_to=] (admin)
 *      -> { rows, counts: {queued, sent_today, sent_total, replied, booked},
 *           reps: [{email, queued, sent_today, replied, booked}] (admin) }
 * POST { id, action, ... }
 *      sent            -> step 1 went out (status sent, sent_at, sent_by)
 *      step            -> the next message in the sequence went out (step++)
 *      replied         -> { reply_text, reply_kind } ; lead goes WARM + call-now
 *      booked          -> { notes }                   ; lead goes HOT
 *      not_interested  -> two hard no's; stays logged, lead stays as is
 *      bot             -> auto-reply / front desk; lead warm, call the main line
 *      skip | requeue
 *      lang            -> { lang: 'en'|'es' } rewrite message_1/2 in the other language (same arm)
 * POST { action: 'assign', assigned_to, n }   (admin) hand n queued rows to a rep
 *
 * Every write stamps updated_at. Replies go through _hot.markHot so the team
 * group text and the warm list stay the single source of truth.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, resolveAssignedTo } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { markHot, markWarm } = require('./_hot');
const { dmCopy, stiloDmCopy } = require('./_dm_copy');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function dayStartET() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const off = now.getTime() - et.getTime();
    et.setHours(0, 0, 0, 0);
    return new Date(et.getTime() + off).toISOString();
}
const DONE = ['booked', 'not_interested', 'bot', 'skipped'];

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const db = sb();
    const me = gate.email;

    if (req.method === 'POST') {
        const body = await readJsonBody(req) || {};
        const action = String(body.action || '');
        const now = new Date().toISOString();

        if (action === 'assign') {
            if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });
            const to = await resolveAssignedTo(body.assigned_to);
            const n = Math.max(1, Math.min(500, parseInt(body.n, 10) || 50));
            if (!to) return res.status(400).json({ error: 'assigned_to_required' });
            const ch = body.channel === 'facebook' ? 'facebook' : 'instagram';
            const { data: pick } = await db.from('ig_dm_queue').select('id').eq('status', 'queued').eq('channel', ch).is('assigned_to', null).order('id').limit(n);
            const ids = (pick || []).map(function (r) { return r.id; });
            if (ids.length) await db.from('ig_dm_queue').update({ assigned_to: to, updated_at: now }).in('id', ids);
            return res.status(200).json({ ok: true, assigned: ids.length, to: to });
        }

        const id = parseInt(body.id, 10);
        if (!id) return res.status(400).json({ error: 'id_required' });
        let rq = db.from('ig_dm_queue').select('id,lead_id,business,handle,assigned_to,status,step,reply_text,arm,lang,first_name,vsl_link,channel,client_id').eq('id', id);
        if (!gate.isAdmin) rq = rq.eq('assigned_to', me);
        const { data: row } = await rq.maybeSingle();
        if (!row) return res.status(403).json({ error: 'not_your_row' });

        const upd = { updated_at: now };
        let leadNote = null, hot = false, tier = 'warm';
        if (action === 'sent') { upd.status = row.status === 'queued' ? 'sent' : row.status; upd.step = Math.max(1, row.step || 0); upd.sent_at = row.status === 'queued' ? now : undefined; upd.sent_by = me; upd.last_step_at = now; }
        else if (action === 'step') { upd.step = Math.min(3, (row.step || 1) + 1); upd.last_step_at = now; if (row.status === 'queued') { upd.status = 'sent'; upd.sent_at = now; upd.sent_by = me; } }
        else if (action === 'replied') {
            upd.status = 'replied'; upd.replied_at = now; upd.reply_text = String(body.reply_text || '').slice(0, 1000); upd.reply_kind = String(body.reply_kind || 'other').slice(0, 40);
            if (!row.sent_at) { upd.sent_at = now; upd.sent_by = me; }
            leadNote = 'Instagram: ' + (upd.reply_text ? '"' + upd.reply_text.slice(0, 160) + '"' : 'replied to the DM') + (body.reply_kind ? ' (' + body.reply_kind.replace(/_/g, ' ') + ')' : ''); hot = true;
        }
        else if (action === 'booked') { upd.status = 'booked'; upd.booked_at = now; if (body.notes) upd.notes = String(body.notes).slice(0, 500); leadNote = 'Instagram: booked ' + (body.notes ? String(body.notes).slice(0, 160) : 'a call / visit'); hot = true; tier = 'hot'; }
        else if (action === 'not_interested') { upd.status = 'not_interested'; if (body.reply_text) upd.reply_text = String(body.reply_text).slice(0, 1000); upd.reply_kind = 'not_interested'; if (!upd.replied_at) upd.replied_at = now; }
        else if (action === 'bot') { upd.status = 'bot'; upd.reply_kind = 'bot_or_desk'; upd.replied_at = now; if (body.reply_text) upd.reply_text = String(body.reply_text).slice(0, 1000); leadNote = 'Instagram: auto-reply or front desk answered, call the main line for the decision maker'; }
        else if (action === 'skip') { upd.status = 'skipped'; }
        else if (action === 'requeue') { upd.status = 'queued'; upd.step = 0; upd.sent_at = null; }
        else if (action === 'note') { upd.notes = String(body.notes || '').slice(0, 500); }
        else if (action === 'lang') {
            const lang = body.lang === 'es' ? 'es' : 'en';
            const c = (row.client_id ? dmCopy : stiloDmCopy)(row, row.arm || 'A', lang);
            upd.lang = lang; upd.message_1 = c.message_1; upd.message_2 = c.message_2;
            if (row.lead_id) await db.from('leads').update({ primary_language: lang }).eq('id', row.lead_id);
        }
        else return res.status(400).json({ error: 'bad_action' });
        Object.keys(upd).forEach(function (k) { if (upd[k] === undefined) delete upd[k]; });

        const { error } = await db.from('ig_dm_queue').update(upd).eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        if (row.lead_id && leadNote) {
            if (hot) await markHot(row.lead_id, leadNote, db, { tier: tier });
            else await markWarm(row.lead_id, leadNote, db);
        }
        return res.status(200).json({ ok: true, id: id, status: upd.status || row.status, step: upd.step != null ? upd.step : row.step });
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'POST']);

    const status = String(req.query && req.query.status || 'queued');
    const channel = (req.query && req.query.channel === 'facebook') ? 'facebook' : 'instagram';
    const limit = Math.max(1, Math.min(500, parseInt(req.query && req.query.limit, 10) || 100));
    let email = me;
    if (gate.isAdmin) email = (req.query && req.query.assigned_to) ? await resolveAssignedTo(req.query.assigned_to) : null;

    let q = db.from('ig_dm_queue').select('id,lead_id,handle,instagram_url,business,first_name,city,lang,arm,message_1,message_2,vsl_link,assigned_to,status,step,sent_at,last_step_at,replied_at,reply_text,reply_kind,booked_at,notes,batch,channel,client_id').eq('channel', channel);
    if (email) q = q.eq('assigned_to', email);
    if (status === 'queued') q = q.eq('status', 'queued').order('id', { ascending: true });
    else if (status === 'sent') q = q.eq('status', 'sent').order('last_step_at', { ascending: false });
    else if (status === 'replied') q = q.in('status', ['replied', 'booked']).order('replied_at', { ascending: false });
    else if (status === 'done') q = q.in('status', DONE).order('updated_at', { ascending: false });
    else q = q.order('updated_at', { ascending: false });
    const { data: rows, error } = await q.limit(limit);
    if (error) return res.status(500).json({ error: error.message });

    // Counts for the header. One grouped read: ~1k rows at most.
    let cq = db.from('ig_dm_queue').select('assigned_to,status,sent_at,replied_at,booked_at').eq('channel', channel).limit(8000);
    if (email) cq = cq.eq('assigned_to', email);
    const { data: all } = await cq;
    const day = dayStartET();
    const agg = function (rs) {
        const c = { queued: 0, sent_today: 0, sent_total: 0, replied: 0, booked: 0, replied_today: 0 };
        (rs || []).forEach(function (r) {
            if (r.status === 'queued') c.queued++;
            if (r.sent_at) { c.sent_total++; if (r.sent_at >= day) c.sent_today++; }
            if (r.replied_at && ['replied', 'booked', 'bot'].indexOf(r.status) >= 0) { c.replied++; if (r.replied_at >= day) c.replied_today++; }
            if (r.booked_at) c.booked++;
        });
        return c;
    };
    const counts = agg(all);
    let reps = null;
    if (gate.isAdmin && !email) {
        const by = {};
        (all || []).forEach(function (r) { const k = r.assigned_to || 'unassigned'; (by[k] = by[k] || []).push(r); });
        reps = Object.keys(by).map(function (k) { return Object.assign({ email: k }, agg(by[k])); }).sort(function (a, b) { return b.sent_today - a.sent_today || b.queued - a.queued; });
    }
    return res.status(200).json({ ok: true, rows: rows || [], counts: counts, reps: reps, scope: email || 'all', channel: channel });
};
