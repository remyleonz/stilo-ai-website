/**
 * GET /api/prospects/sync-meet-transcripts   (Vercel cron, hourly at :35)
 *
 * Pulls Google Meet transcripts into prospecting.lead_meetings so every sales
 * call is searchable next to the lead it belongs to, with no notetaker bot, no
 * third-party vendor, and nothing for anyone to remember to press.
 *
 * LEAD-DRIVEN, NOT FEED-DRIVEN. It walks leads that had a meeting in the recent
 * past and pulls the transcript for that lead's own Meet link, rather than
 * listing every conference on the account and guessing which lead each belongs
 * to. leads.meeting_meet_link already holds the exact link book-meeting.js
 * created, so the match is exact. Fuzzy date+name matching is what made the old
 * Tactiq path unreliable.
 *
 * WHY HOURLY: transcript entries are deleted by Google 30 days after the
 * conference. Falling a month behind loses the words permanently. Hourly with a
 * 14-day lookback leaves a wide margin.
 *
 * Idempotent via the (lead_id, meet_conference_record) unique index. Re-running
 * updates an existing row rather than duplicating it, so a transcript that was
 * still processing on the first pass gets filled in on the next.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin JWT. ?dry=1 previews without
 * writing. ?lead_ids=1,2 forces specific leads (manual backfill).
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const {
    getMeetRefreshToken, accessTokenFromRefresh, isReauthError,
    meetingCodeFromLink, listConferenceRecords, listTranscripts,
    listAllEntries, participantNameMap, renderTranscript, REAUTH_URL
} = require('./_google_meet');

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const q = req.query || {};
    const dry = String(q.dry || '') === '1';
    const LOOKBACK_DAYS = Math.min(Number(q.days || process.env.MEET_SYNC_LOOKBACK_DAYS || 14), 29);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    const refresh = await getMeetRefreshToken();
    if (!refresh) {
        return res.status(428).json({
            error: 'meet_not_authorized',
            fix: 'Open ' + REAUTH_URL + ' while signed into Google as remyleon@stiloaipartners.com.',
            note: 'Requires Workspace Business Standard or higher on that account.'
        });
    }

    let accessToken;
    try {
        accessToken = await accessTokenFromRefresh(refresh);
    } catch (e) {
        return res.status(isReauthError(e) ? 428 : 500).json({
            error: 'meet_token_failed', detail: (e && e.message) || String(e),
            fix: isReauthError(e) ? ('Re-authorize: ' + REAUTH_URL) : undefined
        });
    }

    // Candidate leads: meeting already happened, inside the window, has a Meet
    // link. The 20-minute floor avoids racing a call that is still in progress
    // (Google finalizes the transcript only after everyone leaves).
    const nowMs = Date.now();
    const endedBefore = new Date(nowMs - 20 * 60 * 1000).toISOString();
    const since = new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString();

    const explicitIds = String(q.lead_ids || '')
        .split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });

    let leadQ = sb.from('leads')
        .select('id,name,owner_name,meeting_meet_link,meeting_scheduled_at')
        .not('meeting_meet_link', 'is', null);
    if (explicitIds.length) {
        leadQ = leadQ.in('id', explicitIds);
    } else {
        leadQ = leadQ.gte('meeting_scheduled_at', since).lte('meeting_scheduled_at', endedBefore);
    }
    const { data: leads, error: lErr } = await leadQ.order('meeting_scheduled_at', { ascending: false }).limit(100);
    if (lErr) return res.status(500).json({ error: 'leads_read_failed', detail: lErr.message });

    // Which of those already have a Meet transcript stored.
    const ids = (leads || []).map(function (l) { return l.id; });
    const haveByLead = {};
    if (ids.length) {
        const { data: existing } = await sb.from('lead_meetings')
            .select('lead_id,meet_conference_record,transcript')
            .in('lead_id', ids).not('meet_conference_record', 'is', null);
        (existing || []).forEach(function (m) {
            haveByLead[m.lead_id] = haveByLead[m.lead_id] || {};
            // Only treat it as done if we actually captured words. A row stored
            // while Google was still processing has an empty transcript and
            // should be retried, not skipped forever.
            haveByLead[m.lead_id][m.meet_conference_record] = (m.transcript || '').length > 40;
        });
    }

    // WHO IS INTERNAL. The no-show guard has to distinguish "two of our people
    // sat in an empty room" from "a real meeting", and a bare participant COUNT
    // cannot: on 2026-07-21 Alejandro and David waited 26 minutes for a prospect
    // who never joined, and the count-only guard happily filed their private
    // conversation onto Dale's Tires as a client meeting.
    const internal = new Set(['remy leon', 'david coira']);
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data: sdrs } = await pub.from('sdr_users').select('display_name');
        (sdrs || []).forEach(function (u) {
            if (u && u.display_name) internal.add(String(u.display_name).toLowerCase().trim());
        });
    } catch (e) {
        console.error('[sync-meet-transcripts] sdr_users roster unavailable, falling back to the built-in internal list:', (e && e.message) || e);
    }

    const results = [];
    for (const ld of (leads || [])) {
        const code = meetingCodeFromLink(ld.meeting_meet_link);
        if (!code) { results.push({ id: ld.id, skip: 'no_meeting_code' }); continue; }

        try {
            const records = await listConferenceRecords(accessToken, code);
            if (!records.length) { results.push({ id: ld.id, code: code, skip: 'no_conference_record' }); continue; }

            // A restarted or recurring meeting yields several records. Keep the
            // longest — that is the real call, not the 30-second one where
            // someone joined early and dropped.
            const durationOf = function (r) {
                if (!r.startTime || !r.endTime) return 0;
                return new Date(r.endTime).getTime() - new Date(r.startTime).getTime();
            };
            const record = records.slice().sort(function (a, b) { return durationOf(b) - durationOf(a); })[0];

            if ((haveByLead[ld.id] || {})[record.name]) {
                results.push({ id: ld.id, record: record.name, skip: 'already_stored' });
                continue;
            }

            const transcripts = await listTranscripts(accessToken, record.name);
            if (!transcripts.length) {
                results.push({ id: ld.id, record: record.name, skip: 'no_transcript_yet' });
                continue;
            }

            const nameMap = await participantNameMap(accessToken, record.name);
            let allEntries = [];
            for (const t of transcripts) {
                const e = await listAllEntries(accessToken, t.name);
                allEntries = allEntries.concat(e);
            }
            allEntries.sort(function (a, b) { return new Date(a.startTime || 0) - new Date(b.startTime || 0); });

            const text = renderTranscript(allEntries, nameMap);
            if (!text) {
                results.push({ id: ld.id, record: record.name, skip: 'empty_transcript' });
                continue;
            }

            const attendees = Object.keys(nameMap).map(function (k) { return nameMap[k]; })
                .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
            const durSec = durationOf(record) ? Math.round(durationOf(record) / 1000) : null;

            // NO-SHOW GUARD. A conference record exists even when the prospect
            // never joins, and Meet keeps transcribing whatever is said in the
            // room. Storing that files OUR conversation onto THEIR lead.
            //
            // Requiring >= 2 participants was not enough. On 2026-07-21 two STILO
            // employees waited 26 minutes for a no-show, rehearsed the pitch and
            // talked candidly, and that landed on Dale's Tires as if it were a
            // client meeting. The real test is whether anyone EXTERNAL was in the
            // room, so match participants against the sdr_users roster.
            //
            // Unknown names are treated as external on purpose: filing a real
            // meeting is recoverable, silently dropping one is not.
            const externals = attendees.filter(function (n) {
                return !internal.has(String(n).toLowerCase().trim());
            });
            if (!externals.length) {
                results.push({
                    id: ld.id, record: record.name, skip: 'no_prospect_joined',
                    attendees: attendees, chars: text.length,
                    note: 'Everyone in the room was STILO. Prospect never joined, so this is a no-show, not a meeting. Not stored.'
                });
                continue;
            }

            if (dry) {
                results.push({
                    id: ld.id, record: record.name, would_store: true,
                    entries: allEntries.length, chars: text.length,
                    attendees: attendees, preview: text.slice(0, 300)
                });
                continue;
            }

            const row = {
                lead_id: ld.id,
                source: 'google_meet',
                meet_conference_record: record.name,
                title: 'Google Meet — ' + (ld.name || ('Lead ' + ld.id)),
                occurred_at: record.startTime || ld.meeting_scheduled_at || null,
                duration_seconds: durSec,
                attendees: attendees.length ? attendees : null,
                transcript: text,
                meet_url: ld.meeting_meet_link,
                created_by: 'cron:sync-meet-transcripts',
                updated_at: new Date().toISOString()
            };

            // Upsert by hand: the unique index is partial, which PostgREST's
            // on_conflict cannot target.
            const { data: prior } = await sb.from('lead_meetings')
                .select('id').eq('lead_id', ld.id).eq('meet_conference_record', record.name).maybeSingle();

            if (prior) {
                const { error: uErr } = await sb.from('lead_meetings').update(row).eq('id', prior.id);
                if (uErr) throw uErr;
                results.push({ id: ld.id, record: record.name, updated: true, chars: text.length });
            } else {
                const { error: iErr } = await sb.from('lead_meetings').insert(row);
                if (iErr) throw iErr;
                results.push({ id: ld.id, record: record.name, inserted: true, chars: text.length });
            }
        } catch (e) {
            // 403 here almost always means the Workspace edition does not include
            // transcripts, or the scope was never granted. Say so plainly rather
            // than logging a bare status code.
            const msg = (e && e.message) || String(e);
            const hint = /meet_api_403/.test(msg)
                ? 'Check that remyleon@stiloaipartners.com is on Business Standard or higher AND that meetings.space.readonly was granted at ' + REAUTH_URL
                : undefined;
            console.error('[sync-meet-transcripts] lead=' + ld.id + ' failed:', msg);
            results.push({ id: ld.id, error: msg, hint: hint });
        }
    }

    const stored = results.filter(function (r) { return r.inserted || r.updated; }).length;
    return res.status(200).json({
        ok: true, dry: dry, lookback_days: LOOKBACK_DAYS,
        considered: (leads || []).length, stored: stored, results: results
    });
};
