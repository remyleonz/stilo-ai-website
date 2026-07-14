/**
 * POST /api/public/vsl-event
 * Body: { event: 'view'|'play'|'confirm_click'|..., agent?, lid?, path? }
 *
 * Lightweight public analytics capture for the VSL landing pages. Records page
 * views vs play-button clicks (and later confirm/book clicks) into
 * public.vsl_events, so the admin Sales tab can show the VSL funnel. No PII,
 * best-effort, never blocks the page.
 */
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return res.status(204).end(); }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

    let body = req.body;
    if (!body || typeof body !== 'object') {
        const chunks = [];
        for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
    }
    const event = String(body.event || '').slice(0, 40);
    if (!event) return res.status(400).json({ error: 'missing_event' });
    const agent = body.agent ? String(body.agent).slice(0, 40) : null;
    const lead_id = body.lid != null && /^\d+$/.test(String(body.lid)) ? parseInt(String(body.lid), 10) : null;
    const path = body.path ? String(body.path).slice(0, 300) : null;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(200).json({ ok: true, skipped: true });
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        await sb.from('vsl_events').insert({ event: event, agent: agent, lead_id: lead_id, path: path, ua: String(req.headers['user-agent'] || '').slice(0, 300) });
    } catch (_) { /* best-effort */ }
    return res.status(200).json({ ok: true });
};
