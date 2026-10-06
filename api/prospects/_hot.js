/**
 * api/prospects/_hot.js
 *
 * "Call now" queue. A lead goes hot the moment a human does something that
 * deserves a call inside 5 minutes: texts back, replies to an email, plays the
 * video, finishes the quiz, leaves contact details, answers an Instagram DM.
 * Every trigger stamps leads.hot_at + hot_reason here; the dashboards read the
 * queue through /api/prospects/hot-leads and the lead drawer shows the reason
 * on top of the script. A newer trigger overwrites an older one (the reason
 * should describe the latest thing they did). Clearing happens when a call is
 * logged after hot_at, or by hand from the strip.
 */
function sbLeads() {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}

async function markHot(leadId, reason, sb) {
    if (leadId == null) return { skipped: 'no_lead' };
    try {
        const client = sb || sbLeads();
        const { error } = await client.from('leads')
            .update({ hot_at: new Date().toISOString(), hot_reason: String(reason || '').slice(0, 240), hot_cleared_at: null })
            .eq('id', leadId);
        if (error) return { error: error.message };
        return { ok: true };
    } catch (e) { return { error: String(e && e.message || e) }; }
}

module.exports = { markHot };
