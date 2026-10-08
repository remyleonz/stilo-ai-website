/**
 * GET /api/prospects/hot-escalate   (Vercel cron, every 5 minutes)
 *
 * The second text. A warm lead got the group text (_hot.sendTeamAlert) and
 * ten minutes later nobody has dialed them: one more group message, naming
 * the rep who owns the lead, so the 5-minute rule has teeth. Once per hot
 * stamp (leads.hot_escalated_at), never for cleared leads, never when any
 * outbound call was logged after hot_at.
 *
 * Auth: Bearer CRON_SECRET (Vercel cron) or an admin JWT for a manual run.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { repFirst, ago, sendToTeam, claimTextSlot } = require('./_hot');

const WAIT_MIN = 10, SITE = 'https://stiloaipartners.com';

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; if (!gate.isAdmin) return res.status(403).json({ error: 'admin_only' }); }
    if (String(process.env.TEAM_ALERTS || '').toLowerCase() === 'off') return res.status(200).json({ ok: true, skipped: 'off' });

    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const cutoff = new Date(Date.now() - WAIT_MIN * 60000).toISOString();
    const floor = new Date(Date.now() - 6 * 3600000).toISOString();
    const { data: rows, error } = await db.from('leads')
        .select('id,name,owner_name,address,phone,owner_phone,owner_phone_e164,assigned_to,hot_at,hot_reason,hot_alert_sent_at')
        .not('hot_at', 'is', null).is('hot_cleared_at', null).is('hot_escalated_at', null)
        .not('hot_alert_sent_at', 'is', null).lte('hot_alert_sent_at', cutoff).gte('hot_at', floor).limit(50);
    if (error) return res.status(500).json({ error: error.message });
    const out = [];
    const to = String(process.env.TEAM_ALERT_NUMBERS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10);
    for (const l of rows || []) {
        const { data: calls } = await db.from('lead_calls').select('called_at,logged_by').eq('lead_id', l.id).eq('direction', 'outbound').gt('called_at', l.hot_at).limit(1);
        if (calls && calls.length) { await db.from('leads').update({ hot_escalated_at: new Date().toISOString() }).eq('id', l.id); out.push({ id: l.id, result: 'called' }); continue; }
        // Claim first (idempotent sends).
        const claim = await db.from('leads').update({ hot_escalated_at: new Date().toISOString() }).eq('id', l.id).is('hot_escalated_at', null).select('id');
        if (!claim.data || !claim.data.length) continue;
        if (!to.length) { out.push({ id: l.id, result: 'no_numbers' }); continue; }
        const slot = await claimTextSlot(db, l.id);
        if (!slot.ok) { out.push({ id: l.id, result: 'skipped_' + slot.why }); continue; }
        const owner = l.assigned_to ? repFirst(l.assigned_to) : 'nobody';
        const text = ['STILL NOT CALLED (' + ago(l.hot_alert_sent_at || l.hot_at).replace(' ago', '') + ' since the alert)',
            (l.name || 'lead ' + l.id) + (l.owner_name ? '\nOwner: ' + l.owner_name : ''),
            'What they did: ' + (l.hot_reason || 'a human reached out'),
            '',
            owner === 'nobody' ? 'Unassigned lead.' : owner + ', this one is yours.',
            'Whoever is free, call now: ' + (l.owner_phone_e164 || l.owner_phone || l.phone || 'no phone'),
            '',
            SITE + '/sdr/#lead=' + l.id].join('\n');
        const r = await sendToTeam(text, to);
        out.push({ id: l.id, result: r.ok ? 'sent' : (r.error || 'failed'), sent: r.sent });
    }
    return res.status(200).json({ ok: true, checked: (rows || []).length, escalated: out });
};
