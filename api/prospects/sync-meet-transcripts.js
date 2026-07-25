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
 *
 * SUMMARIES. After the transcript pass, a second pass finds stored transcripts
 * that have no summary yet and asks Gemini for a summary + next steps, written
 * into lead_meetings.summary / action_items. The admin lead panel already
 * renders both fields on the meeting card, so this is what keeps deal notes
 * current without anyone pasting anything by hand. Capped per run; the hourly
 * cron drains any backlog. ?summarize_only=1 skips the Meet pull (manual
 * backfill of old rows).
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
    const SUMMARY_CAP = Math.min(Number(q.summaries || 3), 8);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

    // Manual backfill of summaries alone, no Meet API involved:
    // ?summarize_only=1 (works even when Meet auth is broken).
    if (String(q.summarize_only || '') === '1') {
        const sres = await summarizePass(sb, dry, SUMMARY_CAP);
        return res.status(200).json({ ok: true, summarize_only: true, dry: dry, summaries: sres });
    }

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

    // Second pass: fill in summary + next steps for any stored transcript that
    // still lacks one (including rows stored moments ago by the loop above).
    const summaries = await summarizePass(sb, dry, SUMMARY_CAP);

    const stored = results.filter(function (r) { return r.inserted || r.updated; }).length;
    return res.status(200).json({
        ok: true, dry: dry, lookback_days: LOOKBACK_DAYS,
        considered: (leads || []).length, stored: stored, results: results,
        summaries: summaries
    });
};

/**
 * Find recent lead_meetings rows that have a real transcript but no summary,
 * summarize with Gemini, and write summary + action_items back. Capped per run
 * so the hourly cron stays inside the function time limit; a backlog just
 * drains over a few runs.
 */
async function summarizePass(sb, dry, cap) {
    if (!process.env.GEMINI_API_KEY) return [{ skip: 'no_gemini_key' }];

    const { data: rows, error } = await sb.from('lead_meetings')
        .select('id,lead_id,title,transcript,summary')
        .is('summary', null).not('transcript', 'is', null)
        .order('occurred_at', { ascending: false, nullsFirst: false })
        .limit(25);
    if (error) return [{ error: 'meetings_read_failed', detail: error.message }];

    // Under ~400 chars there was no real conversation to summarize (a mic test,
    // a dropped call). Skip those forever rather than burning the cap on them.
    const candidates = (rows || []).filter(function (m) { return (m.transcript || '').length >= 400; }).slice(0, cap);
    const out = [];

    for (const m of candidates) {
        if (dry) { out.push({ meeting_id: m.id, lead_id: m.lead_id, would_summarize: true, chars: m.transcript.length }); continue; }
        try {
            const parsed = await geminiSummarize(m.title, m.transcript);
            if (!parsed) { out.push({ meeting_id: m.id, lead_id: m.lead_id, skip: 'gemini_unavailable' }); continue; }
            const { error: uErr } = await sb.from('lead_meetings')
                .update({ summary: parsed.summary, action_items: parsed.action_items, updated_at: new Date().toISOString() })
                .eq('id', m.id);
            if (uErr) throw uErr;
            out.push({ meeting_id: m.id, lead_id: m.lead_id, summarized: true });
        } catch (e) {
            console.error('[sync-meet-transcripts] summarize meeting=' + m.id + ' failed:', (e && e.message) || e);
            out.push({ meeting_id: m.id, lead_id: m.lead_id, error: (e && e.message) || String(e) });
        }
    }
    return out;
}

async function geminiSummarize(title, transcript) {
    const prompt = [
        'You are the sales operations analyst at STILO AI Partners, a Miami agency that sells AI agents (AI receptionist, outbound lead reply, lead generation, client reactivation) to local businesses.',
        'Below is the transcript of a sales meeting' + (title ? ' (' + title + ')' : '') + '. Summarize it for the CRM so anyone can pick up the deal cold.',
        '',
        'Return JSON with exactly two string fields:',
        '- "summary": 5 to 10 short lines. Cover: who the prospect is and what their business does, the pain they named, which agent(s) were pitched, the exact pricing and terms discussed, every objection or concern raised and how it was answered, and how the meeting ended (commitment level, in the prospect\'s own words where possible).',
        '- "action_items": 2 to 6 lines, each starting with "- ". Concrete next steps only, each with an owner (us or the prospect) and a deadline if one was stated. If payment or a contract is pending, that is always the first item.',
        '',
        'Rules: plain text, no markdown headings, no em dashes (use commas or periods), no hype words. Quote real numbers from the call, never invent any. Write like a sharp human taking notes.',
        '',
        'TRANSCRIPT:',
        String(transcript).slice(0, 60000)
    ].join('\n');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3, maxOutputTokens: 1200,
                    responseMimeType: 'application/json',
                    thinkingConfig: { thinkingBudget: 0 }
                }
            })
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const j = await r.json();
        const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
            && j.candidates[0].content.parts && j.candidates[0].content.parts[0]
            && j.candidates[0].content.parts[0].text;
        if (!text) return null;
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
        return {
            summary: parsed.summary.trim(),
            action_items: (typeof parsed.action_items === 'string' && parsed.action_items.trim()) || null
        };
    } catch (_) {
        clearTimeout(timer);
        return null;
    }
}
