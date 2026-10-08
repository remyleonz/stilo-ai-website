/**
 * SDR ↔ admin direct messages, using the support_threads table with
 * thread_type='sdr_dm' and a sdr_id pointer (instead of client_id).
 *
 * GET  /api/sdr/messages?sdr_id=<uuid>
 *   List or open the DM thread for this SDR. Admin can pass any sdr_id.
 *   SDR ignores ?sdr_id and uses their own. If a thread doesn't exist yet,
 *   one is created on-demand (idempotent: exactly one sdr_dm per sdr_id).
 *   Returns { thread, messages: [...] }
 *
 * POST /api/sdr/messages
 *   Body: { sdr_id?, body, attachments?: [...] }
 *   Appends a message. Sender type is 'admin' for admin caller, 'sdr' for SDR.
 *
 * Team chat (2026-10-08): the same endpoint with ?with=
 *   with=remy (default)  -> the sdr_dm thread above (rep <-> Remy/admin)
 *   with=team            -> ONE group thread for everybody (thread_type team_group, peer_key 'team')
 *   with=<sdr_users.id>  -> a peer DM between the caller and that teammate
 *                           (thread_type peer_dm, peer_key = the two ids sorted, ':' joined)
 *   Admins (Remy, David) take part through their own sdr_users row (matched by email).
 *   GET ?summary=1       -> { unread: { remy, team, peers: {id: n} }, roster: [...] }
 * Every message stores sender_email; the response carries sender_name.
 */
const { authSdr, methodNotAllowed, readJsonBody } = require('./_shared');

async function getOrCreateThread(sb, sdrId, sdrDisplayName) {
    // Look up existing sdr_dm thread for this sdr
    let { data: thread } = await sb
        .from('support_threads')
        .select('*')
        .eq('thread_type', 'sdr_dm')
        .eq('sdr_id', sdrId)
        .maybeSingle();

    if (thread) return thread;

    // Create one
    const { data: created, error } = await sb
        .from('support_threads')
        .insert({
            thread_type: 'sdr_dm',
            sdr_id: sdrId,
            client_id: null,
            subject: 'DM with ' + (sdrDisplayName || 'SDR'),
            status: 'open'
        })
        .select('*')
        .single();

    if (error) throw new Error('thread_create_failed: ' + error.message);
    return created;
}


async function callerSdrRow(caller) {
    if (caller.sdr) return caller.sdr;
    const { data } = await caller.sb.from('sdr_users').select('id, email, display_name').ilike('email', caller.email).maybeSingle();
    return data || null;
}
async function roster(sb) {
    const { data } = await sb.from('sdr_users').select('id, email, display_name, active').eq('active', true).order('display_name');
    return data || [];
}
async function peerThread(sb, kind, key, subject) {
    let { data: t } = await sb.from('support_threads').select('*').eq('peer_key', key).maybeSingle();
    if (t) return t;
    const { data: created, error } = await sb.from('support_threads').insert({ thread_type: kind, peer_key: key, client_id: null, sdr_id: null, subject: subject, status: 'open' }).select('*').single();
    if (error) {
        // Lost the race: read the winner.
        const again = await sb.from('support_threads').select('*').eq('peer_key', key).maybeSingle();
        if (again.data) return again.data;
        throw new Error('thread_create_failed: ' + error.message);
    }
    return created;
}

module.exports = async function handler(req, res) {
    const caller = await authSdr(req, res);
    if (!caller.ok) return;
    const withParam = String((req.query && req.query.with) || '').trim();
    const body = (req.method === 'POST') ? (await readJsonBody(req) || {}) : {};
    const target = withParam || String(body.with || '').trim();

    // ── Team chat threads (group + peer DMs) ──────────────────────────────
    if (target && target !== 'remy') {
        const me = await callerSdrRow(caller);
        if (!me) return res.status(400).json({ error: 'no_sdr_row_for_caller' });
        const people = await roster(caller.sb);
        const names = {}; people.forEach(function (p) { names[String(p.email).toLowerCase()] = p.display_name; names[p.id] = p.display_name; });
        let thread;
        if (target === 'team') thread = await peerThread(caller.sb, 'team_group', 'team', 'Team');
        else {
            const other = people.find(function (p) { return p.id === target; });
            if (!other) return res.status(404).json({ error: 'teammate_not_found' });
            if (other.id === me.id) return res.status(400).json({ error: 'cannot_dm_yourself' });
            const key = [me.id, other.id].sort().join(':');
            thread = await peerThread(caller.sb, 'peer_dm', key, me.display_name + ' / ' + other.display_name);
        }
        if (req.method === 'GET') {
            const { data: messages, error } = await caller.sb.from('support_messages')
                .select('id, sender_type, sender_id, sender_email, body, attachments, created_at, read_at').eq('thread_id', thread.id).order('created_at', { ascending: true }).limit(500);
            if (error) return res.status(500).json({ error: error.message });
            // Peer DM: mark the other side's messages read. Group: read_at is per message, not per reader; leave it.
            if (thread.thread_type === 'peer_dm') {
                const unread = (messages || []).filter(function (m) { return (m.sender_email || '').toLowerCase() !== caller.email && !m.read_at; }).map(function (m) { return m.id; });
                if (unread.length) await caller.sb.from('support_messages').update({ read_at: new Date().toISOString() }).in('id', unread);
            }
            return res.status(200).json({ thread: thread, messages: (messages || []).map(function (m) { return Object.assign({}, m, { sender_name: names[(m.sender_email || '').toLowerCase()] || (m.sender_type === 'admin' ? 'Remy' : 'Teammate'), mine: (m.sender_email || '').toLowerCase() === caller.email }); }), roster: people.filter(function (p) { return p.id !== me.id; }), me: me.id });
        }
        if (req.method === 'POST') {
            const text = String(body.body || '').trim();
            if (!text) return res.status(400).json({ error: 'body_required' });
            if (text.length > 8000) return res.status(400).json({ error: 'body_too_long' });
            const { data: inserted, error } = await caller.sb.from('support_messages')
                .insert({ thread_id: thread.id, sender_type: caller.isAdmin ? 'admin' : 'sdr', sender_id: caller.userId, sender_email: caller.email, body: text, attachments: [] }).select('*').single();
            if (error) return res.status(500).json({ error: error.message });
            await caller.sb.from('support_threads').update({ last_message_at: new Date().toISOString() }).eq('id', thread.id);
            return res.status(200).json({ message: inserted });
        }
        return methodNotAllowed(res, 'GET, POST');
    }

    // ── Summary for the nav badge + recipient picker ─────────────────────
    if (req.method === 'GET' && req.query && req.query.summary) {
        const me = await callerSdrRow(caller);
        const people = await roster(caller.sb);
        const out = { remy: 0, team: 0, peers: {} };
        if (me) {
            const { data: th } = await caller.sb.from('support_threads').select('id, thread_type, peer_key, sdr_id').or('peer_key.eq.team,peer_key.like.%' + me.id + '%,and(thread_type.eq.sdr_dm,sdr_id.eq.' + me.id + ')');
            const ids = (th || []).map(function (t) { return t.id; });
            if (ids.length) {
                const { data: ms } = await caller.sb.from('support_messages').select('thread_id, sender_email, sender_type, read_at, created_at').in('thread_id', ids).is('read_at', null).gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString()).limit(2000);
                (ms || []).forEach(function (m) {
                    const t = (th || []).find(function (x) { return x.id === m.thread_id; }); if (!t) return;
                    const mine = (m.sender_email || '').toLowerCase() === caller.email || (t.thread_type === 'sdr_dm' && !m.sender_email && ((caller.isAdmin && m.sender_type === 'admin') || (!caller.isAdmin && m.sender_type === 'sdr')));
                    if (mine) return;
                    if (t.thread_type === 'sdr_dm') out.remy++;
                    else if (t.thread_type === 'team_group') out.team++;
                    else { const other = String(t.peer_key || '').split(':').find(function (k) { return k !== me.id; }); if (other) out.peers[other] = (out.peers[other] || 0) + 1; }
                });
            }
        }
        return res.status(200).json({ unread: out, roster: people.filter(function (p) { return !me || p.id !== me.id; }), me: me ? me.id : null });
    }

    // ── Original rep <-> Remy thread (unchanged) ─────────────────────────

    // Resolve target sdrId
    let sdrId = null;
    let sdrRow = null;
    if (caller.isSdr && caller.sdr) {
        sdrId = caller.sdr.id;
        sdrRow = caller.sdr;
    } else {
        // Admin path
        sdrId = (req.query && req.query.sdr_id) || (req.body && req.body.sdr_id) || null;
        if (!sdrId) return res.status(400).json({ error: 'sdr_id_required' });
        const { data } = await caller.sb
            .from('sdr_users')
            .select('id, display_name')
            .eq('id', sdrId)
            .maybeSingle();
        sdrRow = data;
        if (!sdrRow) return res.status(404).json({ error: 'sdr_not_found' });
    }

    if (req.method === 'GET') {
        const thread = await getOrCreateThread(caller.sb, sdrId, sdrRow.display_name);
        const { data: messages, error: msgErr } = await caller.sb
            .from('support_messages')
            .select('id, sender_type, sender_id, body, attachments, created_at, read_at')
            .eq('thread_id', thread.id)
            .order('created_at', { ascending: true });
        if (msgErr) return res.status(500).json({ error: msgErr.message });

        // Mark unread messages from the other side as read
        const otherSenderType = caller.isAdmin ? 'sdr' : 'admin';
        const unreadIds = (messages || [])
            .filter(m => m.sender_type === otherSenderType && !m.read_at)
            .map(m => m.id);
        if (unreadIds.length) {
            await caller.sb
                .from('support_messages')
                .update({ read_at: new Date().toISOString() })
                .in('id', unreadIds);
        }

        return res.status(200).json({ thread, messages: messages || [] });
    }

    if (req.method === 'POST') {
        const text = (body.body || '').toString().trim();
        if (!text) return res.status(400).json({ error: 'body_required' });
        if (text.length > 8000) return res.status(400).json({ error: 'body_too_long' });

        const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
        const senderType = caller.isAdmin ? 'admin' : 'sdr';

        const thread = await getOrCreateThread(caller.sb, sdrId, sdrRow.display_name);
        const { data: inserted, error: insertErr } = await caller.sb
            .from('support_messages')
            .insert({
                thread_id: thread.id,
                sender_type: senderType,
                sender_id: caller.userId,
                sender_email: caller.email,
                body: text,
                attachments
            })
            .select('*')
            .single();

        if (insertErr) return res.status(500).json({ error: insertErr.message });
        return res.status(200).json({ message: inserted });
    }

    return methodNotAllowed(res, 'GET, POST');
};
