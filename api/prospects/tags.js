/**
 * /api/prospects/tags
 *   GET    ?id=<lead_id>            → { tags: [{ tag, added_by, added_at }] }
 *   POST   { id, tag }              → adds (no-op if already present)
 *   DELETE { id, tag }              → removes
 *
 * Backed by prospecting.lead_tags. UNIQUE (lead_id, tag).
 */
const { assertAdmin, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
}

function cleanTag(raw) {
    return String(raw || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 48);
}

module.exports = async function handler(req, res) {
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const client = sb();
    if (!client) return res.status(200).json({ tags: [] });

    if (req.method === 'GET') {
        const id = safeNumberId(req.query && (req.query.id || req.query.lead_id));
        if (id == null) return res.status(400).json({ error: 'missing_id' });
        const { data, error } = await client.from('lead_tags')
            .select('tag, added_by, added_at')
            .eq('lead_id', id)
            .order('added_at', { ascending: true });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ tags: data || [] });
    }

    if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const id = safeNumberId(body.id);
        const tag = cleanTag(body.tag);
        if (id == null || !tag) return res.status(400).json({ error: 'missing_id_or_tag' });
        const { error } = await client.from('lead_tags').insert({
            lead_id: id, tag, added_by: gate.email
        });
        // 23505 = unique_violation — already present; treat as success.
        if (error && error.code !== '23505') return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, tag });
    }

    if (req.method === 'DELETE') {
        const body = await readJsonBody(req);
        const id = safeNumberId(body.id);
        const tag = cleanTag(body.tag);
        if (id == null || !tag) return res.status(400).json({ error: 'missing_id_or_tag' });
        const { error } = await client.from('lead_tags').delete().eq('lead_id', id).eq('tag', tag);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return methodNotAllowed(res, 'GET, POST, DELETE');
};
