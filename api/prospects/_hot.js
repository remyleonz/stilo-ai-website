/**
 * api/prospects/_hot.js
 *
 * "Call now" queue + the warm list + the team alert, in ONE place.
 *
 * A lead goes hot the moment a human does something that deserves a call
 * inside 5 minutes: texts back, replies to an email, plays the video, finishes
 * the quiz, leaves contact details, answers an Instagram DM, calls us and
 * misses. Every trigger calls markHot() here, which:
 *
 *   1. stamps leads.hot_at + hot_reason (a newer trigger overwrites an older
 *      one; the reason should describe the latest thing they did),
 *   2. promotes leads.engagement_tier cold -> warm (never downgrades; hot is a
 *      rep's call from the drawer, see /api/prospects/pipeline),
 *   3. sends ONE group text to the team (Quo, from the STILO line, `to` array)
 *      with who it is, what they did, who dialed them last so nobody double
 *      calls, and a link that opens the lead in the dashboard. Debounced: the
 *      same lead does not re-alert inside 20 minutes (a video play fires
 *      play / progress / complete in a row).
 *
 * The dashboards read the queue through /api/prospects/hot-leads and the lead
 * drawer shows the reason on top of the script. Clearing happens when a call
 * is logged after hot_at, or by hand from the strip.
 *
 * Env: TEAM_ALERT_NUMBERS (comma list of E.164 cells; falls back to the
 * reps' PERSONAL map), TEAM_ALERT_FROM (Quo line; falls back to REMY_LINE),
 * TEAM_ALERTS=off to silence the text without touching the stamps.
 */
const DEBOUNCE_MIN = 20;
const MAX_TEXTS_PER_LEAD = 3;   // alert + escalations, between two real calls (Remy, 2026-10-08)
const SITE = 'https://stiloaipartners.com';

function sbLeads() {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}
function ago(iso) {
    if (!iso) return '';
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 36) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
}
function repFirst(email) {
    const e = String(email || '').toLowerCase();
    if (!e) return '';
    if (e.startsWith('remyleon')) return 'Remy';
    if (e.startsWith('davidcoira')) return 'David';
    if (e.startsWith('aleb')) return 'Ale';
    if (e.startsWith('georgegutierrez')) return 'George';
    if (e.startsWith('ayesjorge')) return 'Jorge';
    return e.split('@')[0];
}
function cityOf(addr) {
    const m = String(addr || '').match(/,\s*([^,]+),\s*FL\b/i);
    return m ? m[1].trim() : '';
}
function teamNumbers() {
    const env = String(process.env.TEAM_ALERT_NUMBERS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (env.length) return env.slice(0, 10);
    try { return Object.values(require('./_team_numbers').PERSONAL).slice(0, 10); } catch (_) { return []; }
}

/** The text everybody reads before they dial. Blank lines between the parts:
 *  a group thread shows it as one bubble, so the spacing is the formatting. */
function alertText(lead, lastCall) {
    const phone = lead.owner_phone_e164 || lead.owner_phone || lead.phone || '';
    const dialed = lastCall
        ? (repFirst(lastCall.logged_by) || 'us') + ', ' + ago(lastCall.called_at) + (lastCall.outcome ? ' (' + String(lastCall.outcome).replace(/_/g, ' ') + ')' : '')
        : 'nobody yet';
    const owner = lead.assigned_to ? repFirst(lead.assigned_to) + "'s lead" : 'unassigned';
    return ['WARM LEAD',
        lead.name + (cityOf(lead.address) ? ' (' + cityOf(lead.address) + ')' : ''),
        (lead.owner_name ? 'Owner: ' + lead.owner_name + '\n' : '') + 'What they did: ' + (lead.hot_reason || 'a human reached out'),
        '',
        'Rep: ' + owner,
        'Last dialed: ' + dialed,
        '',
        (phone ? 'Tap to call in Quo (' + phone + '):\n' + SITE + '/call/?to=' + encodeURIComponent(phone.replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1')) : 'No phone on file.'),
        '',
        'Lead panel: ' + SITE + '/sdr/#lead=' + lead.id].join('\n');
}

/**
 * Cap: at most MAX_TEXTS_PER_LEAD team texts for one lead between two real
 * calls. The counter restarts when an outbound call lands after it started,
 * so a lead that got called and went warm again gets a fresh three.
 * Claims the slot (increments) before the send: idempotent sends.
 */
async function claimTextSlot(client, leadId) {
    const { data: lead } = await client.from('leads').select('id,hot_alert_count,hot_alert_count_since').eq('id', leadId).maybeSingle();
    if (!lead) return { ok: false, why: 'no_lead' };
    let count = lead.hot_alert_count || 0, since = lead.hot_alert_count_since;
    if (since) {
        const { data: calls } = await client.from('lead_calls').select('id').eq('lead_id', leadId).eq('direction', 'outbound').gt('called_at', since).limit(1);
        if (calls && calls.length) { count = 0; since = null; }
    }
    if (count >= MAX_TEXTS_PER_LEAD) return { ok: false, why: 'cap', count: count };
    const upd = { hot_alert_count: count + 1, hot_alert_count_since: since || new Date().toISOString() };
    const { error } = await client.from('leads').update(upd).eq('id', leadId);
    if (error) return { ok: false, why: error.message };
    return { ok: true, count: count + 1 };
}

async function sendTeamAlert(client, leadId) {
    if (String(process.env.TEAM_ALERTS || '').toLowerCase() === 'off') return { skipped: 'off' };
    const to = teamNumbers();
    if (!to.length) return { skipped: 'no_numbers' };
    const { data: lead } = await client.from('leads')
        .select('id,name,owner_name,address,phone,owner_phone,owner_phone_e164,assigned_to,hot_reason,hot_alert_sent_at')
        .eq('id', leadId).maybeSingle();
    if (!lead) return { skipped: 'no_lead' };
    // Claim before sending (idempotent sends): a second trigger inside the
    // window sees the stamp and stops here.
    const floor = new Date(Date.now() - DEBOUNCE_MIN * 60000).toISOString();
    const claim = await client.from('leads').update({ hot_alert_sent_at: new Date().toISOString() })
        .eq('id', leadId).or('hot_alert_sent_at.is.null,hot_alert_sent_at.lt.' + floor).select('id');
    if (claim.error || !claim.data || !claim.data.length) return { skipped: 'debounced' };
    const slot = await claimTextSlot(client, leadId);
    if (!slot.ok) return { skipped: slot.why, count: slot.count };
    const { data: calls } = await client.from('lead_calls').select('logged_by,called_at,outcome')
        .eq('lead_id', leadId).eq('direction', 'outbound').order('called_at', { ascending: false }).limit(1);
    const text = alertText(lead, calls && calls[0]);
    return sendToTeam(text, to);
}

/**
 * One text per person, not a group MMS (2026-10-08): the five-recipient
 * group message was "delivered" per Quo and reached the reps, but Remy's
 * iPhone never showed it. Individual SMS always lands. TEAM_ALERT_MODE=group
 * brings the single group thread back.
 */
async function sendToTeam(text, to) {
    try {
        const { openphoneFetch } = require('../openphone/_shared');
        const { REMY_LINE } = require('./_sms');
        const from = process.env.TEAM_ALERT_FROM || REMY_LINE;
        // Group thread by default again (2026-10-08 evening): the group MMS did
        // reach Remy, late. The team saves the Quo line as STILO ALERTS.
        if (String(process.env.TEAM_ALERT_MODE || 'group').toLowerCase() === 'group') {
            const r = await openphoneFetch({ path: '/messages', method: 'POST', body: { from: from, to: to, content: text } });
            return { ok: r.status >= 200 && r.status < 300, status: r.status, detail: r.json && r.json.message };
        }
        const results = [];
        for (const n of to) {
            const r = await openphoneFetch({ path: '/messages', method: 'POST', body: { from: from, to: [n], content: text } });
            results.push({ to: n, status: r.status, detail: r.json && r.json.message });
        }
        return { ok: results.every(function (x) { return x.status >= 200 && x.status < 300; }), sent: results.length, results: results };
    } catch (e) { return { error: String(e && e.message || e) }; }
}

/**
 * markHot(leadId, reason, sb, opts)
 *   opts.alert   default true: send the team text
 *   opts.tier    'warm' (default) or 'hot': floor for engagement_tier
 */
async function markHot(leadId, reason, sb, opts) {
    if (leadId == null) return { skipped: 'no_lead' };
    opts = opts || {};
    try {
        const client = sb || sbLeads();
        const now = new Date().toISOString();
        const { error } = await client.from('leads')
            .update({ hot_at: now, hot_reason: String(reason || '').slice(0, 240), hot_cleared_at: null })
            .eq('id', leadId);
        if (error) return { error: error.message };
        // Promote, never demote. 'cold' is the default so the filter is exact.
        const floor = opts.tier === 'hot' ? ['cold', 'warm'] : ['cold'];
        await client.from('leads')
            .update({ engagement_tier: opts.tier === 'hot' ? 'hot' : 'warm', engagement_tier_at: now, engagement_tier_reason: String(reason || '').slice(0, 240), engagement_tier_by: 'auto' })
            .eq('id', leadId).in('engagement_tier', floor);
        let alert = null;
        if (opts.alert !== false) alert = await sendTeamAlert(client, leadId);
        return { ok: true, alert: alert };
    } catch (e) { return { error: String(e && e.message || e) }; }
}

/** Warm without the "call now" stamp (a decision maker reached on our own dial
 *  is warm, but nobody needs a text about a call we just made). */
async function markWarm(leadId, reason, sb) {
    if (leadId == null) return { skipped: 'no_lead' };
    try {
        const client = sb || sbLeads();
        const { error } = await client.from('leads')
            .update({ engagement_tier: 'warm', engagement_tier_at: new Date().toISOString(), engagement_tier_reason: String(reason || '').slice(0, 240), engagement_tier_by: 'auto' })
            .eq('id', leadId).eq('engagement_tier', 'cold');
        return error ? { error: error.message } : { ok: true };
    } catch (e) { return { error: String(e && e.message || e) }; }
}

module.exports = { markHot, markWarm, sendTeamAlert, sendToTeam, alertText, repFirst, ago, claimTextSlot, MAX_TEXTS_PER_LEAD };
