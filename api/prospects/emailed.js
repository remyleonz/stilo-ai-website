/**
 * GET /api/prospects/emailed
 *
 * Leads the caller has emailed via the lead-drawer Email button. Sourced from
 * prospecting.lead_messages (channel='email', sent_by=<rep>). Returns the most
 * recent email per lead, newest first, with the lead row normalized like the
 * other prospect lists plus an `_email` block (when, to, subject).
 *
 * NOT to be confused with /emailable (the cold-email QUEUE of leads that have
 * an owner_email). This is leads ALREADY emailed.
 */
const { assertAdminOrSdr, methodNotAllowed, normalizeLead } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    // SDRs are scoped to their own sent emails. Admins may pass ?assigned_to to
    // view a specific rep (impersonation), else they see all emailed leads.
    const q = req.query || {};
    const sb = leadsClient();

    let mq = sb.from('lead_messages')
        .select('lead_id, sent_at, to_address, subject, sent_by')
        .eq('channel', 'email')
        .not('lead_id', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(1000);

    if (gate.isSdr && !gate.isAdmin) {
        mq = mq.ilike('sent_by', gate.email);
    } else if (q.assigned_to) {
        mq = mq.ilike('sent_by', String(q.assigned_to));
    }

    const { data: msgs, error } = await mq;
    if (error) return res.status(500).json({ error: 'emailed_read_failed', detail: error.message });
    if (!msgs || !msgs.length) return res.status(200).json({ results: [] });

    // Most-recent email per lead, preserving order.
    const seen = {};
    const order = [];
    for (const m of msgs) {
        if (seen[m.lead_id]) continue;
        seen[m.lead_id] = m;
        order.push(m.lead_id);
    }

    let leadsById = {};
    try {
        const { data: leads } = await sb.from('leads').select('*').in('id', order);
        (leads || []).forEach(function (l) { leadsById[l.id] = l; });
    } catch (_) { /* fall back to stubs */ }

    const results = order.map(function (lid) {
        const m = seen[lid];
        const lead = leadsById[lid];
        const base = lead ? normalizeLead(lead) : { id: lid, business_name: 'Lead ' + lid };
        base._email = { at: m.sent_at, to: m.to_address, subject: m.subject || null, by: m.sent_by || null };
        return base;
    });

    return res.status(200).json({ results: results });
};
