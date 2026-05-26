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
 * PATCH /api/sdr/messages/<message_id>/read
 *   Marks a message as read by the caller (writes read_at).
 *   Not implemented as a separate route — handled by setting ?read=<id>.
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

module.exports = async function handler(req, res) {
    const caller = await authSdr(req, res);
    if (!caller.ok) return;

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
        const body = await readJsonBody(req);
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
