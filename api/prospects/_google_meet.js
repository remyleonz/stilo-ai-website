/**
 * Google Meet REST API helpers (transcripts).
 *
 * Requires Workspace Business Standard or higher on the MEETING ORGANISER's
 * account. Every STILO meeting is created on remyleon@stiloaipartners.com by
 * api/prospects/book-meeting.js, so one upgraded seat covers every prospect
 * call — the transcript always lands in that account's Drive and is readable
 * through this API.
 *
 * SEPARATE OAUTH ROW ON PURPOSE. The 'google-meet' provider gets its own
 * public.oauth_tokens row rather than widening 'google-calendar', for the same
 * reason 'gmail-inbox' is separate: re-authorizing one must never clobber the
 * other. The booking calendar going dark because someone re-linked transcripts
 * would take bookings offline.
 *
 * THIRTY-DAY WINDOW: transcript ENTRIES (the actual speaker-attributed text)
 * are deleted 30 days after the conference. The Drive document survives longer,
 * but the API text does not. A sync that falls behind by a month loses the
 * words permanently, which is why the cron runs hourly and why the backfill
 * window is capped well inside 30 days.
 *
 * Scope: https://www.googleapis.com/auth/meetings.space.readonly
 */
const { createClient } = require('@supabase/supabase-js');
const { accessTokenFromRefresh, isReauthError } = require('./_google_calendar');

const MEET_API = 'https://meet.googleapis.com/v2';
const REAUTH_URL = '/api/oauth?provider=google-meet&action=start';

async function getMeetRefreshToken() {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
            const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
            const { data } = await sb.from('oauth_tokens')
                .select('refresh_token').eq('provider', 'google-meet').maybeSingle();
            if (data && data.refresh_token) return data.refresh_token;
        } catch (_) { /* fall through */ }
    }
    return process.env.GOOGLE_MEET_REFRESH_TOKEN || null;
}

async function meetFetch(accessToken, path, params) {
    const qs = params ? ('?' + new URLSearchParams(params).toString()) : '';
    const r = await fetch(MEET_API + path + qs, {
        headers: { Authorization: 'Bearer ' + accessToken }
    });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch (_) { /* non-JSON error page */ }
    if (!r.ok) {
        const msg = (json && json.error && json.error.message) || body.slice(0, 300);
        const err = new Error('meet_api_' + r.status + ': ' + msg);
        err.status = r.status;
        throw err;
    }
    return json || {};
}

// "https://meet.google.com/abc-defg-hij?authuser=0" -> "abc-defg-hij"
function meetingCodeFromLink(link) {
    if (!link) return null;
    const m = String(link).match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return m ? m[1].toLowerCase() : null;
}

// Conference records for one meeting code. A recurring or restarted meeting can
// produce several, so the caller decides which to keep (we take the longest).
async function listConferenceRecords(accessToken, meetingCode) {
    const out = await meetFetch(accessToken, '/conferenceRecords', {
        filter: 'space.meeting_code="' + meetingCode + '"',
        pageSize: '20'
    });
    return out.conferenceRecords || [];
}

async function listTranscripts(accessToken, recordName) {
    const out = await meetFetch(accessToken, '/' + recordName + '/transcripts', { pageSize: '10' });
    return out.transcripts || [];
}

// Entries are paginated and a 30-minute call runs to several hundred, so this
// must follow nextPageToken or transcripts silently truncate mid-sentence.
async function listAllEntries(accessToken, transcriptName) {
    const entries = [];
    let pageToken = null;
    for (let guard = 0; guard < 25; guard++) {
        const params = { pageSize: '1000' };
        if (pageToken) params.pageToken = pageToken;
        const out = await meetFetch(accessToken, '/' + transcriptName + '/entries', params);
        (out.transcriptEntries || []).forEach(function (e) { entries.push(e); });
        pageToken = out.nextPageToken || null;
        if (!pageToken) break;
    }
    return entries;
}

// participant resource -> a human name. Google puts the name in a different
// field depending on how they joined, and anonymous dial-ins have none.
function participantDisplayName(p) {
    if (!p) return null;
    if (p.signedinUser && p.signedinUser.displayName) return p.signedinUser.displayName;
    if (p.anonymousUser && p.anonymousUser.displayName) return p.anonymousUser.displayName;
    if (p.phoneUser && p.phoneUser.displayName) return p.phoneUser.displayName;
    return null;
}

async function participantNameMap(accessToken, recordName) {
    const map = {};
    try {
        const out = await meetFetch(accessToken, '/' + recordName + '/participants', { pageSize: '100' });
        (out.participants || []).forEach(function (p) {
            if (p.name) map[p.name] = participantDisplayName(p) || 'Participant';
        });
    } catch (_) { /* fall back to raw ids below */ }
    return map;
}

// Render entries as "Speaker: text" lines, merging consecutive lines from the
// same speaker. Meet emits one entry per utterance, so without merging a normal
// conversation reads as hundreds of one-line fragments.
function renderTranscript(entries, nameMap) {
    const lines = [];
    let lastSpeaker = null;
    entries.forEach(function (e) {
        const who = (nameMap && nameMap[e.participant]) || 'Speaker';
        const text = String(e.text || '').trim();
        if (!text) return;
        if (who === lastSpeaker && lines.length) {
            lines[lines.length - 1] += ' ' + text;
        } else {
            lines.push(who + ': ' + text);
            lastSpeaker = who;
        }
    });
    return lines.join('\n');
}

// ---- auto-transcription -----------------------------------------------------
// Google Meet does NOT transcribe by default. Upgrading the Workspace seat only
// grants the ABILITY; someone still has to hit Start in the call. That cost us
// Hugo Garcia's 33-minute meeting on 2026-07-20 — the conference record existed
// with both participants, and zero transcripts.
//
// The org-wide Admin console default ("Meetings are transcribed by default")
// requires Business Plus. On Business Standard the only programmatic route is
// per-space: spaces.patch with the meetings.space.settings scope, which Google
// added in Feb 2025 expressly for spaces created by Calendar.
//
// The Calendar API cannot do this — its Events resource has no meeting-records
// field at all. Don't go looking for one again.

async function meetPatch(accessToken, path, params, body) {
    const qs = params ? ('?' + new URLSearchParams(params).toString()) : '';
    const r = await fetch(MEET_API + path + qs, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* ignore */ }
    if (!r.ok) {
        const msg = (json && json.error && json.error.message) || text.slice(0, 300);
        const err = new Error('meet_api_' + r.status + ': ' + msg);
        err.status = r.status;
        throw err;
    }
    return json || {};
}

// spaces/{meetingCode} is a valid alias for GET, but patch wants the canonical
// server id, so resolve first. Meeting codes are also reusable and expire ~365
// days after last use, so they are never a durable key.
async function resolveSpaceName(accessToken, meetingCode) {
    const s = await meetFetch(accessToken, '/spaces/' + meetingCode);
    return (s && s.name) || null;
}

async function enableAutoTranscription(accessToken, meetingCode) {
    const spaceName = await resolveSpaceName(accessToken, meetingCode);
    if (!spaceName) throw new Error('space_not_found for ' + meetingCode);
    const updated = await meetPatch(
        accessToken, '/' + spaceName,
        { updateMask: 'config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration' },
        { config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: 'ON' } } } }
    );
    const got = updated && updated.config && updated.config.artifactConfig
        && updated.config.artifactConfig.transcriptionConfig
        && updated.config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration;
    return { space: spaceName, autoTranscription: got || null, raw: updated };
}

module.exports = {
    getMeetRefreshToken, accessTokenFromRefresh, isReauthError,
    meetFetch, meetPatch, meetingCodeFromLink, listConferenceRecords, listTranscripts,
    listAllEntries, participantNameMap, renderTranscript,
    resolveSpaceName, enableAutoTranscription, REAUTH_URL
};
