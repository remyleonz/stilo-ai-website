/**
 * GET /api/prospects/email-activity
 *
 * The admin Emails tab: every outbound email we've sent to a lead, enriched so
 * Remy never has to open Resend to see what went out and who cared.
 *
 * Two modes:
 *   - list (default): all outbound email rows (capped at the most recent 3000),
 *     each joined to its lead (name, category, stage) and stamped with signal
 *     flags: opened, clicked, replied, bounced, plus a lead-level "hot" flag.
 *   - ?thread=<message_id>: one message with its FULL body plus the reply
 *     thread for that lead (inbound rows if any exist, else the reply snapshot
 *     capture-replies stores in raw_payload.reply on the outbound row).
 *
 * Signal definitions (the trap that matters):
 *   - opened   = lead_messages.opened_at OR any vsl_events email_open for the
 *                lead AFTER this send.
 *   - human open = an email_open event that is NOT within 60s of any of our
 *                sends to that lead (link scanners open instantly) and whose
 *                user agent is not HeadlessChrome (that's us rendering).
 *   - hot      = lead replied, OR clicked, OR has human opens on 2+ distinct
 *                days. Distinct-day counting because scanners inflate raw
 *                event counts about 5x.
 *
 * A/B strip: computed here over the A/B-tagged rows with DISTINCT-LEAD
 * counting (sends are per-row; opened/clicked/replied are distinct leads).
 *
 * Admin only. Modeled on sales-overview.js: same gate, batched enrichment.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const kit = require('./_email_kit');

const SCANNER_WINDOW_MS = 60 * 1000; // open <60s after our send = scanner
const MAX_ROWS = 3000;

function pc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function lc() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

// Naive-UTC timestamps show up in this schema; treat zone-less values as UTC.
function toMs(ts) {
    if (!ts) return null;
    let s = String(ts);
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
}
function etDay(ms) {
    return new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}
function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

async function threadMode(res, sb, messageId) {
    const { data: rows, error } = await sb.from('lead_messages')
        .select('id, lead_id, direction, channel, subject, body, body_preview, sent_at, sent_by, to_address, from_address, variant, opened_at, clicked_at, replied_at, bounced_at, status, raw_payload')
        .eq('id', messageId)
        .limit(1);
    if (error) return res.status(500).json({ error: 'thread_read_failed', detail: error.message });
    const msg = rows && rows[0];
    if (!msg) return res.status(404).json({ error: 'message_not_found' });

    // Replies: real inbound rows for this lead first (future-proof), plus the
    // snapshot capture-replies stamps onto the outbound row itself.
    const replies = [];
    if (msg.lead_id != null) {
        try {
            const { data: inbound } = await sb.from('lead_messages')
                .select('id, direction, subject, body, body_preview, sent_at, from_address')
                .eq('lead_id', msg.lead_id)
                .eq('channel', 'email')
                .eq('direction', 'inbound')
                .order('sent_at', { ascending: true })
                .limit(100);
            (inbound || []).forEach(function (r) {
                replies.push({ at: r.sent_at, from: r.from_address || null, subject: r.subject || null, body: r.body || r.body_preview || '' });
            });
        } catch (_) { /* best-effort */ }
    }
    const snap = msg.raw_payload && msg.raw_payload.reply;
    if (snap && !replies.length) {
        replies.push({ at: snap.received_at || msg.replied_at, from: snap.from || null, subject: snap.subject || null, body: snap.snippet || msg.body_preview || '' });
    }
    replies.sort(function (a, b) { return (toMs(a.at) || 0) - (toMs(b.at) || 0); });

    delete msg.raw_payload;
    return res.status(200).json({ message: msg, replies: replies });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const sb = lc();
    const q = req.query || {};
    if (q.thread) return threadMode(res, sb, q.thread);

    // 1. All email rows, newest first, paged past PostgREST's 1000-row cap.
    //    Body stays out of the list payload; the thread call fetches it.
    const all = [];
    let from = 0;
    for (;;) {
        const { data: page, error } = await sb.from('lead_messages')
            .select('id, lead_id, direction, subject, body_preview, sent_at, sent_by, to_address, variant, opened_at, clicked_at, replied_at, bounced_at, status')
            .eq('channel', 'email')
            .order('sent_at', { ascending: false })
            .range(from, from + 999);
        if (error) return res.status(500).json({ error: 'messages_read_failed', detail: error.message });
        if (!page || !page.length) break;
        all.push.apply(all, page);
        if (page.length < 1000 || all.length >= MAX_ROWS) break;
        from += 1000;
    }
    const outbound = all.filter(function (m) { return m.direction !== 'inbound'; });
    const inbound = all.filter(function (m) { return m.direction === 'inbound'; });

    // 2. Lead join: name, category, stage (chunked .in()).
    const leadIds = Array.from(new Set(outbound.map(function (m) { return m.lead_id; }).filter(function (x) { return x != null; })));
    const leadById = {};
    for (const ids of chunk(leadIds, 200)) {
        try {
            const { data: leads } = await sb.from('leads').select('id, name, category, stage').in('id', ids);
            (leads || []).forEach(function (l) { leadById[l.id] = l; });
        } catch (_) { /* stubs below */ }
    }

    // 3. Open events. Small table slice; one fetch covers every lead.
    let opens = [];
    try {
        const pub = pc();
        const { data: evs } = await pub.from('vsl_events')
            .select('lead_id, created_at, ua')
            .eq('event', 'email_open')
            .limit(5000);
        opens = evs || [];
    } catch (_) { /* opens stay empty */ }

    // 4. Rep display names.
    const nameByEmail = {};
    try {
        const pub2 = pc();
        const { data: roster } = await pub2.from('sdr_users').select('email, display_name');
        (roster || []).forEach(function (r) {
            if (r.email) nameByEmail[String(r.email).toLowerCase()] = r.display_name || r.email;
        });
    } catch (_) {}

    // Per-lead prep: send times, open events, inbound reply times.
    const sendsByLead = {};
    outbound.forEach(function (m) {
        if (m.lead_id == null) return;
        const ms = toMs(m.sent_at);
        if (ms != null) (sendsByLead[m.lead_id] || (sendsByLead[m.lead_id] = [])).push(ms);
    });
    const opensByLead = {};
    opens.forEach(function (e) {
        if (e.lead_id == null) return;
        (opensByLead[e.lead_id] || (opensByLead[e.lead_id] = [])).push(e);
    });
    const inboundByLead = {};
    inbound.forEach(function (m) {
        if (m.lead_id == null) return;
        const ms = toMs(m.sent_at);
        if (ms != null) (inboundByLead[m.lead_id] || (inboundByLead[m.lead_id] = [])).push(ms);
    });

    // Human opens per lead: not HeadlessChrome, not within the scanner window
    // after any of our sends. Distinct ET days is the count that matters.
    const humanDaysByLead = {};
    Object.keys(opensByLead).forEach(function (lid) {
        const sends = sendsByLead[lid] || [];
        const days = new Set();
        opensByLead[lid].forEach(function (e) {
            if (/headlesschrome/i.test(String(e.ua || ''))) return;
            const ms = toMs(e.created_at);
            if (ms == null) return;
            const scanner = sends.some(function (s) { return ms >= s && ms - s < SCANNER_WINDOW_MS; });
            if (scanner) return;
            days.add(etDay(ms));
        });
        if (days.size) humanDaysByLead[lid] = days.size;
    });

    // Lead-level flags used by the Hot chip.
    const repliedLeads = new Set();
    const clickedLeads = new Set();
    outbound.forEach(function (m) {
        if (m.lead_id == null) return;
        if (m.replied_at) repliedLeads.add(m.lead_id);
        if (m.clicked_at) clickedLeads.add(m.lead_id);
    });
    Object.keys(inboundByLead).forEach(function (lid) { repliedLeads.add(Number(lid)); });

    const messages = outbound.map(function (m) {
        const lead = leadById[m.lead_id] || {};
        const sentMs = toMs(m.sent_at);
        const evOpen = (opensByLead[m.lead_id] || []).some(function (e) {
            const ms = toMs(e.created_at);
            return ms != null && sentMs != null && ms > sentMs;
        });
        const inboundAfter = (inboundByLead[m.lead_id] || []).some(function (ms) { return sentMs != null && ms > sentMs; });
        const replied = !!m.replied_at || inboundAfter;
        const hot = m.lead_id != null && (repliedLeads.has(m.lead_id) || clickedLeads.has(m.lead_id) || (humanDaysByLead[m.lead_id] || 0) >= 2);
        return {
            id: m.id,
            lead_id: m.lead_id,
            business: lead.name || null,
            category: lead.category || null,
            stage: lead.stage || null,
            subject: m.subject || null,
            sent_at: m.sent_at,
            sent_by: m.sent_by || null,
            sent_by_name: m.sent_by ? (nameByEmail[String(m.sent_by).toLowerCase()] || m.sent_by) : null,
            to_address: m.to_address || null,
            variant: m.variant || null,
            // capture-replies overwrites body_preview with the reply snippet,
            // so on a replied row this preview IS the reply.
            reply_preview: m.replied_at ? (m.body_preview || null) : null,
            opened: !!m.opened_at || evOpen,
            clicked: !!m.clicked_at,
            replied: replied,
            bounced: !!m.bounced_at,
            hot: hot,
            human_open_days: humanDaysByLead[m.lead_id] || 0
        };
    });

    // A/B strip over the tagged arms, distinct-lead counting on the signals.
    const ab = kit.VARIANT_KEYS.map(function (v) {
        const arm = messages.filter(function (m) { return m.variant === v; });
        const leadsOf = function (pred) {
            const s = new Set();
            arm.forEach(function (m) { if (m.lead_id != null && pred(m)) s.add(m.lead_id); });
            return s.size;
        };
        const uniq = leadsOf(function () { return true; });
        const opened = leadsOf(function (m) { return m.opened; });
        const clicked = leadsOf(function (m) { return m.clicked; });
        const replied = leadsOf(function (m) { return m.replied; });
        const pct = function (n) { return uniq ? Math.round((n / uniq) * 1000) / 10 : 0; };
        return {
            variant: v,
            label: kit.VARIANT_LABELS[v] || v,
            sent: arm.length,
            leads: uniq,
            opened: opened, open_rate: pct(opened),
            clicked: clicked, click_rate: pct(clicked),
            replied: replied, reply_rate: pct(replied)
        };
    });

    return res.status(200).json({ total: messages.length, messages: messages, ab: ab });
};
