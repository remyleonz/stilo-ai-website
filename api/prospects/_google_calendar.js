/**
 * Shared Google Calendar OAuth helpers for the booking flow.
 *
 * The booking calendar (remyleon@stiloaipartners.com) is a single STILO-owned
 * connection. Its refresh token lives in public.oauth_tokens (written by the
 * /api/oauth callback when Remy re-authorizes) and falls back to the
 * GOOGLE_OAUTH_REFRESH_TOKEN env var for backward compatibility.
 *
 * Preferring the DB means a re-auth takes effect immediately with no Vercel
 * env redeploy.
 *
 * The consent screen is in PRODUCTION. Refresh tokens do NOT expire on a
 * 7-day clock. This file used to claim they did, which sent people chasing a
 * publishing status that was already correct. Evidence: the stored calendar
 * token was minted 2026-06-16 and still exchanged fine on 2026-07-20, 34 days
 * later. If a token stops working, diagnose it by exchanging it and reading the
 * actual error, not by assuming the consent screen.
 */
const { createClient } = require('@supabase/supabase-js');

// Where Remy re-links the booking calendar. Opening this (signed into Google as
// remyleon@stiloaipartners.com) mints a fresh refresh token into oauth_tokens.
const REAUTH_URL = '/api/oauth?provider=google-calendar&action=start';

// True when the failure is a dead refresh token (expired/revoked), which is
// fixable only by re-authorizing, not by retrying. Google returns
// "invalid_grant" for this. Real causes: the grant was revoked in the Google
// account, the OAuth client secret was rotated, or the account password
// changed. NOT a publishing-status problem — the consent screen is in
// Production and tokens do not expire on a timer.
function isReauthError(err) {
    const m = String((err && err.message) || err || '');
    return /invalid_grant|oauth_refresh_failed|Token has been expired or revoked/i.test(m);
}

async function getCalendarRefreshToken() {
    // Prefer the most-recently-authorized token in the DB.
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
            const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
            const { data } = await sb.from('oauth_tokens')
                .select('refresh_token').eq('provider', 'google-calendar').maybeSingle();
            if (data && data.refresh_token) return data.refresh_token;
        } catch (_) { /* fall through to env */ }
    }
    return process.env.GOOGLE_OAUTH_REFRESH_TOKEN || null;
}

async function accessTokenFromRefresh(refreshToken) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });
    if (!r.ok) throw new Error('oauth_refresh_failed: ' + (await r.text()).slice(0, 200));
    return (await r.json()).access_token;
}

module.exports = { getCalendarRefreshToken, accessTokenFromRefresh, isReauthError, REAUTH_URL };
