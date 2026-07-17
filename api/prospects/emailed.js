/**
 * GET /api/prospects/emailed
 *
 * The rep's "Emailed" tab. Every email that went to a lead the rep owns or
 * booked, newest first, with engagement attached so the rep knows whether to
 * chase a confirmation or a re-view.
 *
 * Three kinds of email land here:
 *   - manual   : the rep hit the Email button (lead_messages.sent_by = rep).
 *   - vsl       : the auto cold VSL blast (variant vsl_campaign / vsl_warm_*).
 *   - confirm  : the auto meeting-confirmation (variant meeting_confirm).
 * The auto sends historically wrote sent_by = null, so they never showed up on
 * the rep's page even though "we send them from the SDR." We now also include
 * an automated email when the LEAD is assigned to (or was booked by) the rep,
 * which covers old rows regardless of the sent_by backfill.
 *
 * Per-lead engagement (_engagement) is read from public.vsl_events + the lead's
 * own meeting stamps: opened (email pixel), viewed (clicked to the VSL page),
 * confirmed (tapped Confirm My Meeting), booked (has a meeting). This is what
 * tells Ale "they never opened it, call them to confirm."
 *
 * NOT to be confused with /emailable (the cold-email QUEUE).
 */
const { assertAdminOrSdr, methodNotAllowed, normalizeLead, resolveAssignedTo } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const AUTOMATED = ['vsl_campaign', 'vsl_warm_a', 'vsl_warm_b', 'meeting_confirm'];

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}
function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
}

function emailType(variant) {
    if (variant === 'meeting_confirm') return 'confirm';
    if (variant === 'vsl_campaign' || variant === 'vsl_warm_a' || variant === 'vsl_warm_b') return 'vsl';
    return 'manual';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const sb = leadsClient();

    // Whose emails are we showing? An SDR sees only their own leads. An admin
    // sees everyone, unless they impersonate a rep with ?assigned_to.
    let repEmail = null;
    if (gate.isSdr && !gate.isAdmin) repEmail = (gate.email || '').toLowerCase();
    else if (q.assigned_to) repEmail = (await resolveAssignedTo(q.assigned_to) || '').toLowerCase() || null;

    // Pull recent emails broadly (manual + automated). We filter to the rep in JS
    // once we know each lead's owner, so an automated send with sent_by = null
    // still surfaces on the owning rep's page.
    const { data: msgs, error } = await sb.from('lead_messages')
        .select('lead_id, sent_at, to_address, subject, sent_by, variant')
        .eq('channel', 'email')
        .not('lead_id', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(3000);
    if (error) return res.status(500).json({ error: 'emailed_read_failed', detail: error.message });
    if (!msgs || !msgs.length) return res.status(200).json({ results: [] });

    // Most-recent email per lead, newest first.
    const seen = {};
    const order = [];
    for (const m of msgs) {
        if (seen[m.lead_id]) continue;
        seen[m.lead_id] = m;
        order.push(m.lead_id);
    }

    // Lead rows (owner + booking rep + meeting stamps drive scoping AND engagement).
    let leadsById = {};
    try {
        const { data: leads } = await sb.from('leads').select('*').in('id', order);
        (leads || []).forEach(function (l) { leadsById[l.id] = l; });
    } catch (_) { /* fall back to stubs */ }

    // Scope to the rep: keep a lead if the rep sent the email OR owns/booked it.
    const ownedByRep = function (lead, msg) {
        if (!repEmail) return true; // admin, no impersonation: show all
        if (msg.sent_by && String(msg.sent_by).toLowerCase() === repEmail) return true;
        if (!lead) return false;
        const owner = String(lead.assigned_to || '').toLowerCase();
        const booker = String(lead.meeting_booked_by_sdr || '').toLowerCase();
        return owner === repEmail || booker === repEmail;
    };

    const keptIds = order.filter(function (lid) { return ownedByRep(leadsById[lid], seen[lid]); });
    if (!keptIds.length) return res.status(200).json({ results: [] });

    // Engagement: distinct events per lead from public.vsl_events.
    const engagement = {};
    try {
        const pub = publicClient();
        const { data: evs } = await pub.from('vsl_events')
            .select('lead_id, event')
            .in('lead_id', keptIds)
            .in('event', ['email_open', 'view', 'play', 'confirm_open', 'confirm'])
            .limit(50000);
        (evs || []).forEach(function (e) {
            if (e.lead_id == null) return;
            const g = engagement[e.lead_id] || (engagement[e.lead_id] = {});
            g[e.event] = true;
        });
    } catch (_) { /* engagement is best-effort */ }

    const results = keptIds.map(function (lid) {
        const m = seen[lid];
        const lead = leadsById[lid];
        const base = lead ? normalizeLead(lead) : { id: lid, business_name: 'Lead ' + lid };
        const g = engagement[lid] || {};
        base._email = {
            at: m.sent_at, to: m.to_address, subject: m.subject || null,
            by: m.sent_by || null, type: emailType(m.variant), variant: m.variant || null,
        };
        base._engagement = {
            opened: !!g.email_open,
            viewed: !!(g.view || g.play),
            played: !!g.play,
            confirmed: !!g.confirm || !!(lead && lead.meeting_confirmed_at),
            booked: !!(lead && lead.meeting_booked_at),
        };
        return base;
    });

    return res.status(200).json({ results: results });
};
