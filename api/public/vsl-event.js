/**
 * VSL landing-page analytics capture into public.vsl_events.
 *   POST { event:'view'|'play'|'confirm_open'|'confirm'|..., agent?, lid?, path?, flow? }
 *   GET  ?event=email_open&lid=&agent=&flow=  -> logs + returns a 1x1 gif (email pixel)
 *
 * `flow` splits the two campaigns that share the /agents/<slug> pages:
 *   'campaign' = cold VSL blast (vsl-campaign.js), 'confirm' = post-booking
 *   confirmation (send-confirmations.js), 'organic' = neither.
 * Without it both funnels collapse into one meaningless pile. See
 * api/migrations/vsl_events_flow.sql.
 *
 * No PII, best-effort. A 'confirm' event also stamps leads.meeting_confirmed_at.
 */
const { createClient } = require('@supabase/supabase-js');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const FLOWS = ['campaign', 'confirm', 'organic'];

async function record(fields, ua) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
    const event = String(fields.event || '').slice(0, 40);
    if (!event) return;
    const lead_id = fields.lid != null && /^\d+$/.test(String(fields.lid)) ? parseInt(String(fields.lid), 10) : null;
    const path = fields.path ? String(fields.path).slice(0, 300) : null;
    // The client reads `agent` off the .vsl-play button's data-agent. That lookup
    // returns null for scanners and partial-JS clients that still run the tracker,
    // which dropped those hits out of the per-agent table while still inflating
    // the totals. The slug is always in the path, so fall back to it.
    let agent = fields.agent ? String(fields.agent).slice(0, 40) : null;
    if (!agent && path) {
        const m = /^\/agents\/([a-z0-9-]+)/.exec(path);
        if (m) agent = m[1];
    }
    // 'confirm' and 'confirm_open' can only come from confirm mode regardless of
    // what the client claims; email_open's pixel only exists in that email.
    let flow = FLOWS.indexOf(String(fields.flow || '')) !== -1 ? String(fields.flow) : null;
    if (event === 'confirm' || event === 'confirm_open' || event === 'email_open') flow = 'confirm';
    if (!flow) flow = lead_id != null ? 'campaign' : 'organic';
    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        await sb.from('vsl_events').insert({ event: event, agent: agent, lead_id: lead_id, path: path, flow: flow, ua: String(ua || '').slice(0, 300) });
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
