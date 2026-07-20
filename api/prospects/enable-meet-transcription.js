/**
 * GET /api/prospects/enable-meet-transcription   (Vercel cron, hourly at :50)
 *
 * Turns auto-transcription ON for every UPCOMING meeting's Meet space.
 *
 * book-meeting.js sets this at creation time, but that only helps meetings
 * booked from now on. This backfills the ones already on the calendar, and acts
 * as a repair pass for any booking where the config call failed (it is
 * deliberately best-effort there, because a booking must never fail over
 * transcription setup).
 *
 * WHY THIS EXISTS AT ALL: Google Meet does not transcribe by default. Upgrading
 * the Workspace seat grants the ability; a human still has to click Start in
 * every call. That lost Hugo Garcia's 33-minute meeting on 2026-07-20 — the
 * conference record existed with both participants and zero transcripts.
 *
 * The org-wide Admin console default ("Meetings are transcribed by default")
 * requires Business Plus. On Business Standard the per-space Meet API call is
 * the only programmatic route. The Calendar API cannot do it — its Events
 * resource has no meeting-records field.
 *
 * Idempotent and cheap: setting ON when it is already ON is a no-op, and the
 * candidate set is only meetings in the future.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin JWT. ?dry=1 previews.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const {
    getMeetRefreshToken, accessTokenFromRefresh, isReauthError,
    meetingCodeFromLink, enableAutoTranscription, REAUTH_URL
} = require('./_google_meet');

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const q = req.query || {};
    const dry = String(q.dry || '') === '1';
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    const refresh = await getMeetRefreshToken();
    if (!refresh) {
        return res.status(428).json({
            error: 'meet_not_authorized',
            fix: 'Open ' + REAUTH_URL + ' signed in as remyleon@stiloaipartners.com.'
        });
    }
    let accessToken;
    try { accessToken = await accessTokenFromRefresh(refresh); }
    catch (e) {
        return res.status(isReauthError(e) ? 428 : 500).json({
            error: 'meet_token_failed', detail: (e && e.message) || String(e),
            fix: isReauthError(e) ? ('Re-authorize: ' + REAUTH_URL) : undefined
        });
    }

    const explicitIds = String(q.lead_ids || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let leadQ = sb.from('leads')
        .select('id,name,meeting_meet_link,meeting_scheduled_at')
        .not('meeting_meet_link', 'is', null);
    leadQ = explicitIds.length
        ? leadQ.in('id', explicitIds)
        : leadQ.gt('meeting_scheduled_at', new Date().toISOString());

    const { data: leads, error } = await leadQ.order('meeting_scheduled_at', { ascending: true }).limit(100);
    if (error) return res.status(500).json({ error: 'leads_read_failed', detail: error.message });

    const results = [];
    for (const ld of (leads || [])) {
        const code = meetingCodeFromLink(ld.meeting_meet_link);
        if (!code) { results.push({ id: ld.id, skip: 'no_meeting_code' }); continue; }
        if (dry) { results.push({ id: ld.id, name: ld.name, code: code, would_enable: true }); continue; }
        try {
            const r = await enableAutoTranscription(accessToken, code);
            results.push({ id: ld.id, name: ld.name, code: code, auto_transcription: r.autoTranscription, space: r.space });
        } catch (e) {
            const msg = (e && e.message) || String(e);
            // 403 here means the scope was never granted, or this Workspace
            // edition does not allow the API to set auto-artifacts. Say which.
            const hint = /meet_api_403/.test(msg)
                ? 'Grant meetings.space.settings by re-running ' + REAUTH_URL + ' — and if it persists, this edition may not permit API-set auto-artifacts.'
                : undefined;
            console.error('[enable-meet-transcription] lead=' + ld.id + ' failed:', msg);
            results.push({ id: ld.id, code: code, error: msg, hint: hint });
        }
    }

    const on = results.filter(function (r) { return r.auto_transcription === 'ON'; }).length;
    return res.status(200).json({ ok: true, dry: dry, considered: (leads || []).length, enabled: on, results: results });
};
