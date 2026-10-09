/**
 * api/prospects/_email_budget.js
 *
 * ONE daily budget for automated campaign email, shared by every sender
 * (Remy, 2026-10-09: "make the cap of automated campaign emails 100, that way
 * I can still manually send emails to leads I call"). All email goes through
 * one Resend account, so a campaign that sends 150 by lunch leaves nothing for
 * the composer. Each campaign sender asks campaignEmailsLeftToday() before it
 * sends and stops at zero.
 *
 * Counted (campaign variants in lead_messages): blason_* (except the
 * composer's blason_vsl_1_dialer), seq_*, vslnur_*, vslplay_*, vsl_campaign,
 * vsl_warm_*. NOT counted: composer sends (A, B, ask, ctx, desk, manual*,
 * blason_vsl_1_dialer), meeting_confirm / meeting_reminder, and the
 * vsl_view_followup / vsl_quiz_followup replies to a live viewer.
 *
 * Day = America/New_York calendar day. CAMPAIGN_EMAIL_DAILY_CAP overrides 100.
 */
function dailyCap() {
    const n = Number(process.env.CAMPAIGN_EMAIL_DAILY_CAP);
    return Number.isFinite(n) && n >= 0 ? n : 100;
}

function isCampaignVariant(v) {
    v = String(v || '');
    if (!v) return false;
    if (v === 'blason_vsl_1_dialer') return false;
    return /^(blason_|seq_|vslnur_|vslplay_|vsl_warm_)/.test(v) || v === 'vsl_campaign';
}

function etMidnightIso(now) {
    const d = now || new Date();
    const et = d.toLocaleString('sv-SE', { timeZone: 'America/New_York' }); // "2026-10-09 16:50:00"
    const offsetMs = Math.round((Date.parse(et.replace(' ', 'T') + 'Z') - d.getTime()) / 60000) * 60000;
    return new Date(Date.parse(et.slice(0, 10) + 'T00:00:00Z') - offsetMs).toISOString();
}

// sb must be a client on the `prospecting` schema (lead_messages lives there).
async function campaignEmailsSentToday(sb) {
    const since = etMidnightIso();
    let from = 0, n = 0;
    for (;;) {
        const { data, error } = await sb.from('lead_messages').select('variant')
            .eq('channel', 'email').eq('direction', 'outbound').gte('sent_at', since)
            .range(from, from + 999);
        if (error) throw new Error('email_budget_read_failed: ' + error.message);
        (data || []).forEach(function (r) { if (isCampaignVariant(r.variant)) n++; });
        if (!data || data.length < 1000) break;
        from += 1000;
    }
    return n;
}

async function campaignEmailsLeftToday(sb) {
    const sent = await campaignEmailsSentToday(sb);
    return { cap: dailyCap(), sent: sent, left: Math.max(0, dailyCap() - sent) };
}

module.exports = { campaignEmailsLeftToday, campaignEmailsSentToday, isCampaignVariant, etMidnightIso, dailyCap };
