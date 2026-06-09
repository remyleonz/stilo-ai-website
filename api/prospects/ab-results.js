/**
 * GET /api/prospects/ab-results
 *
 * Aggregates the email A/B test: for each template arm (A · Direct,
 * B · Value), how many emails went out, how many got a calendar-link click
 * (from the Resend webhook), how many replied, and how many of those leads
 * went on to book a meeting (synced from the calendar). Powers the "Email A/B"
 * panel in the admin dashboard.
 *
 * "Booked" is lead-based: a lead counts once for its most-recent emailed arm
 * if that lead later booked (leads.meeting_event_id set, or last_called_outcome
 * = 'booked_meeting'). Sent/clicked/replied are per-email-row.
 *
 * Admin only. Honest about sample size: the caller decides significance, we
 * just report the running tally + a "need more data" flag under a threshold.
 */
const { assertAdminOrSdr, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const kit = require('./_email_kit');

const MIN_PER_ARM = 20; // below this per arm, don't imply a winner

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' });

    const sb = leadsClient();

    // All A/B-tagged outbound emails.
    const { data: msgs, error } = await sb.from('lead_messages')
        .select('lead_id, variant, sent_at, clicked_at, opened_at, replied_at, bounced_at')
        .eq('channel', 'email')
        .not('variant', 'is', null)
        .order('sent_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'messages_read_failed', detail: error.message });

    const rows = msgs || [];

    // Which of the emailed leads have booked? One lookup for the lead ids we saw.
    const leadIds = Array.from(new Set(rows.map(function (r) { return r.lead_id; }).filter(Boolean)));
    const bookedLeads = new Set();
    if (leadIds.length) {
        try {
            const { data: booked } = await sb.from('leads')
                .select('id, meeting_event_id, last_called_outcome')
                .in('id', leadIds);
            (booked || []).forEach(function (l) {
                if (l.meeting_event_id || l.last_called_outcome === 'booked_meeting') bookedLeads.add(l.id);
            });
        } catch (_) { /* booked stays empty */ }
    }

    // A lead's "arm" for booking attribution = the arm of its most recent email
    // (rows are already sorted newest first, so first seen wins).
    const leadArm = {};
    rows.forEach(function (r) { if (r.lead_id && !(r.lead_id in leadArm)) leadArm[r.lead_id] = r.variant; });

    const arms = {};
    kit.VARIANT_KEYS.forEach(function (v) {
        arms[v] = { variant: v, label: kit.VARIANT_LABELS[v] || v, sent: 0, unique_leads: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, booked: 0, _leads: new Set() };
    });

    rows.forEach(function (r) {
        const a = arms[r.variant];
        if (!a) return;
        a.sent += 1;
        if (r.lead_id) a._leads.add(r.lead_id);
        if (r.opened_at) a.opened += 1;
        if (r.clicked_at) a.clicked += 1;
        if (r.replied_at) a.replied += 1;
        if (r.bounced_at) a.bounced += 1;
    });

    // Bookings: count each booked lead once, under its most-recent arm.
    Object.keys(leadArm).forEach(function (lid) {
        const v = leadArm[lid];
        if (arms[v] && bookedLeads.has(Number(lid))) arms[v].booked += 1;
    });

    const out = kit.VARIANT_KEYS.map(function (v) {
        const a = arms[v];
        const uniq = a._leads.size;
        const clickRate = a.sent ? a.clicked / a.sent : 0;
        const bookRate = uniq ? a.booked / uniq : 0;
        const replyRate = a.sent ? a.replied / a.sent : 0;
        delete a._leads;
        a.unique_leads = uniq;
        return Object.assign(a, {
            click_rate: Math.round(clickRate * 1000) / 10,
            reply_rate: Math.round(replyRate * 1000) / 10,
            book_rate: Math.round(bookRate * 1000) / 10
        });
    });

    const enough = out.every(function (a) { return a.sent >= MIN_PER_ARM; });
    // A soft "leader" only once both arms have real volume. We lead with the
    // booking rate (the money metric); clicks break ties.
    let leader = null;
    if (enough) {
        const sorted = out.slice().sort(function (x, y) { return (y.book_rate - x.book_rate) || (y.click_rate - x.click_rate); });
        if (sorted[0].book_rate !== sorted[1].book_rate || sorted[0].click_rate !== sorted[1].click_rate) leader = sorted[0].variant;
    }

    return res.status(200).json({
        ok: true,
        min_per_arm: MIN_PER_ARM,
        enough_data: enough,
        leader: leader,
        arms: out
    });
};
