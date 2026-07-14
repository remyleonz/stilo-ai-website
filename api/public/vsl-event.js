/**
 * VSL landing-page analytics capture into public.vsl_events.
 *   POST { event:'view'|'play'|'confirm_open'|'confirm'|..., agent?, lid?, path? }
 *   GET  ?event=email_open&lid=&agent=   -> logs + returns a 1x1 gif (email pixel)
 *
 * No PII, best-effort. A 'confirm' event also stamps leads.meeting_confirmed_at.
 */
const { createClient } = require('@supabase/supabase-js');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function record(fields, ua) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
    const event = String(fields.event || '').slice(0, 40);
    if (!event) return;
    const agent = fields.agent ? String(fields.agent).slice(0, 40) : null;
    const lead_id = fields.lid != null && /^\d+$/.test(String(fields.lid)) ? parseInt(String(fields.lid), 10) : null;
    const path = fields.path ? String(fields.path).slice(0, 300) : null;
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        await sb.from('vsl_events').insert({ event: event, agent: agent, lead_id: lead_id, path: path, ua: String(ua || '').slice(0, 300) });
        if (event === 'confirm' && lead_id != null) {
            const psb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
            await psb.from('leads').update({ meeting_confirmed_at: new Date().toISOString() }).eq('id', lead_id).is('meeting_confirmed_at', null);
        }
    } catch (_) { /* best-effort */ }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return res.status(204).end(); }

    // Email-open pixel: GET returns a transparent gif and logs the open.
    if (req.method === 'GET') {
        await record(req.query || {}, req.headers['user-agent']);
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.status(200).send(PIXEL);
    }

    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
    let body = req.body;
    if (!body || typeof body !== 'object') {
        const chunks = [];
        for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
    }
    if (!body.event) return res.status(400).json({ error: 'missing_event' });
    await record(body, req.headers['user-agent']);
    return res.status(200).json({ ok: true });
};
