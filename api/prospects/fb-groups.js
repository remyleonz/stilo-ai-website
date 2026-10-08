/**
 * /api/prospects/fb-groups
 *
 * Each rep's Facebook groups (the ones they join from their own account and
 * post in), with a post log so the numbers show up on the Sales tab.
 *
 * GET  [?assigned_to=<email|key>] (admin) -> { groups, counts, reps (admin), posts_today }
 * POST { action, ... }
 *   add     { name, url, audience, language, geo, members, rules, notes }   rep adds to their own list
 *   status  { id, status: to_join|pending|joined|left|rejected }
 *   remove  { id }                                                          (own rows; admin any)
 *   assign  { id, assigned_to }                                             (admin)
 *   post    { group_id, copy, reactions, comments, dms_sent, note }         log a post
 *   post_update { post_id, reactions, comments, dms_sent }                  update the numbers later
 *   import  { groups: [...] }                                               (admin) bulk, dedupe on url
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, resolveAssignedTo } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
const KEYS = { ale: 'aleb1027@gmail.com', alejandro: 'aleb1027@gmail.com', jorge: 'ayesjorge911@gmail.com', george: 'georgegutierrez446@gmail.com', remy: 'remyleon@stiloaipartners.com', david: 'davidcoira@stiloaipartners.com' };
function normUrl(u) { u = String(u || '').trim().toLowerCase(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return u.replace(/\/+$/, '').replace(/[?#].*$/, '').replace(/^https?:\/\/(m|web|www)\.facebook\.com/i, 'https://www.facebook.com').replace(/^https?:\/\/facebook\.com/i, 'https://www.facebook.com'); }
function dayStartET() { const now = new Date(); const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })); const off = now.getTime() - et.getTime(); et.setHours(0, 0, 0, 0); return new Date(et.getTime() + off).toISOString(); }

module.exports = async function handler(req, res) {
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const db = sb(), me = gate.email;

    if (req.method === 'POST') {
        const b = await readJsonBody(req) || {};
        const a = String(b.action || '');
        const now = new Date().toISOString();
        if (a === 'add') {
            const url = normUrl(b.url); if (!url || !/facebook\.com\//i.test(url)) return res.status(400).json({ error: 'facebook_url_required' });
            const to = gate.isAdmin && b.assigned_to ? (await resolveAssignedTo(b.assigned_to) || KEYS[String(b.assigned_to).toLowerCase()] || me) : me;
            const row = { name: String(b.name || url.split('/').pop()).slice(0, 200), url: url, audience: b.audience === 'stilo' ? 'stilo' : 'blason', language: b.language === 'es' ? 'es' : 'en', geo: b.geo || null, members: parseInt(b.members, 10) || null, rules: b.rules || null, notes: b.notes || null, assigned_to: to, status: 'to_join', source: 'manual', created_by: me };
            const { data, error } = await db.from('fb_groups').upsert(row, { onConflict: 'url', ignoreDuplicates: false }).select('id').maybeSingle();
            if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true, id: data && data.id });
        }
        if (a === 'import') {
            if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });
            const rows = (Array.isArray(b.groups) ? b.groups : []).map(function (g) { const u = normUrl(g.url); if (!u) return null; return { name: String(g.name || '').slice(0, 200), url: u, members: parseInt(g.members, 10) || null, privacy: g.privacy || null, rules: g.rules || null, language: g.language === 'es' ? 'es' : 'en', geo: g.geo || null, audience: g.audience === 'stilo' ? 'stilo' : 'blason', assigned_to: g.assigned_to ? (KEYS[String(g.assigned_to).toLowerCase()] || (String(g.assigned_to).indexOf('@') > 0 ? g.assigned_to : null)) : null, notes: g.note || g.notes || null, source: g.source || 'research 2026-10-08', created_by: me }; }).filter(Boolean);
            let n = 0; for (let i = 0; i < rows.length; i += 100) { const { error, data } = await db.from('fb_groups').upsert(rows.slice(i, i + 100), { onConflict: 'url', ignoreDuplicates: true }).select('id'); if (error) return res.status(500).json({ error: error.message }); n += (data || []).length; }
            return res.status(200).json({ ok: true, imported: n, given: rows.length });
        }
        const id = parseInt(b.id || b.group_id, 10);
        if (a === 'post') {
            if (!id) return res.status(400).json({ error: 'group_id_required' });
            const { data: g } = await db.from('fb_groups').select('id,assigned_to').eq('id', id).maybeSingle();
            if (!g || (!gate.isAdmin && g.assigned_to !== me)) return res.status(403).json({ error: 'not_your_group' });
            const { data, error } = await db.from('fb_group_posts').insert({ group_id: id, posted_by: me, copy: String(b.copy || '').slice(0, 2000) || null, reactions: parseInt(b.reactions, 10) || 0, comments: parseInt(b.comments, 10) || 0, dms_sent: parseInt(b.dms_sent, 10) || 0, note: b.note || null }).select('id').single();
            if (error) return res.status(500).json({ error: error.message });
            if (g.status !== 'joined') await db.from('fb_groups').update({ status: 'joined', joined_at: g.joined_at || now, updated_at: now }).eq('id', id);
            return res.status(200).json({ ok: true, post_id: data.id });
        }
        if (a === 'post_update') {
            const pid = parseInt(b.post_id, 10); if (!pid) return res.status(400).json({ error: 'post_id_required' });
            let q = db.from('fb_group_posts').update({ reactions: parseInt(b.reactions, 10) || 0, comments: parseInt(b.comments, 10) || 0, dms_sent: parseInt(b.dms_sent, 10) || 0 }).eq('id', pid);
            if (!gate.isAdmin) q = q.eq('posted_by', me);
            const { error } = await q; if (error) return res.status(500).json({ error: error.message });
            return res.status(200).json({ ok: true });
        }
        if (!id) return res.status(400).json({ error: 'id_required' });
        let own = db.from('fb_groups').select('id,assigned_to,status,joined_at').eq('id', id); const { data: g } = await own.maybeSingle();
        if (!g || (!gate.isAdmin && g.assigned_to !== me)) return res.status(403).json({ error: 'not_your_group' });
        if (a === 'status') {
            const st = String(b.status || ''); if (['to_join', 'pending', 'joined', 'left', 'rejected'].indexOf(st) < 0) return res.status(400).json({ error: 'bad_status' });
            const { error } = await db.from('fb_groups').update({ status: st, joined_at: st === 'joined' ? (g.joined_at || now) : g.joined_at, updated_at: now }).eq('id', id);
            if (error) return res.status(500).json({ error: error.message }); return res.status(200).json({ ok: true });
        }
        if (a === 'remove') { const { error } = await db.from('fb_groups').update({ assigned_to: null, status: 'to_join', updated_at: now }).eq('id', id); if (error) return res.status(500).json({ error: error.message }); return res.status(200).json({ ok: true }); }
        if (a === 'assign') {
            if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });
            const to = b.assigned_to ? (await resolveAssignedTo(b.assigned_to) || KEYS[String(b.assigned_to).toLowerCase()] || null) : null;
            const { error } = await db.from('fb_groups').update({ assigned_to: to, status: 'to_join', updated_at: now }).eq('id', id);
            if (error) return res.status(500).json({ error: error.message }); return res.status(200).json({ ok: true, assigned_to: to });
        }
        return res.status(400).json({ error: 'bad_action' });
    }
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET', 'POST']);

    let email = me;
    if (gate.isAdmin) email = (req.query && req.query.assigned_to) ? (await resolveAssignedTo(req.query.assigned_to) || KEYS[String(req.query.assigned_to).toLowerCase()] || null) : null;
    let q = db.from('fb_groups').select('*').order('audience').order('status').order('members', { ascending: false, nullsFirst: false });
    if (email) q = q.eq('assigned_to', email);
    const { data: groups, error } = await q.limit(500);
    if (error) return res.status(500).json({ error: error.message });
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    let pq = db.from('fb_group_posts').select('id,group_id,posted_by,posted_at,copy,reactions,comments,dms_sent').gte('posted_at', since).order('posted_at', { ascending: false }).limit(2000);
    if (email) pq = pq.eq('posted_by', email);
    const { data: posts } = await pq;
    const day = dayStartET();
    const counts = { groups: (groups || []).length, joined: (groups || []).filter(function (g) { return g.status === 'joined'; }).length, to_join: (groups || []).filter(function (g) { return g.status === 'to_join'; }).length, posts_today: (posts || []).filter(function (p) { return p.posted_at >= day; }).length, posts_14d: (posts || []).length, reactions_14d: (posts || []).reduce(function (a, p) { return a + (p.reactions || 0) + (p.comments || 0); }, 0), dms_14d: (posts || []).reduce(function (a, p) { return a + (p.dms_sent || 0); }, 0) };
    let reps = null;
    if (gate.isAdmin && !email) {
        const by = {};
        (groups || []).forEach(function (g) { const k = g.assigned_to || 'pool'; by[k] = by[k] || { email: k, groups: 0, joined: 0, posts_today: 0, posts_14d: 0, reactions_14d: 0, dms_14d: 0 }; by[k].groups++; if (g.status === 'joined') by[k].joined++; });
        (posts || []).forEach(function (p) { const k = p.posted_by; by[k] = by[k] || { email: k, groups: 0, joined: 0, posts_today: 0, posts_14d: 0, reactions_14d: 0, dms_14d: 0 }; by[k].posts_14d++; if (p.posted_at >= day) by[k].posts_today++; by[k].reactions_14d += (p.reactions || 0) + (p.comments || 0); by[k].dms_14d += (p.dms_sent || 0); });
        reps = Object.values(by);
    }
    return res.status(200).json({ ok: true, groups: groups || [], posts: posts || [], counts: counts, reps: reps, scope: email || 'all' });
};
