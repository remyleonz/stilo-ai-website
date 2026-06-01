#!/usr/bin/env node
/**
 * scripts/mint_calendar_token.js
 *
 * One-time: mint a fresh Google Calendar refresh token for the STILO booking
 * flow using the EXISTING Desktop OAuth client (which supports a 127.0.0.1
 * loopback redirect — no web redirect URI registration needed). Stores the
 * refresh token in Supabase public.oauth_tokens (provider='google-calendar'),
 * which the booking handlers read DB-first.
 *
 * Run from sites/stilo-ai/:  node scripts/mint_calendar_token.js
 * It prints a consent URL. Open it signed in as remyleon@stiloaipartners.com,
 * click Allow; the loopback catches the code, exchanges it, and stores the token.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// load .env.local
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) return;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[m[1]]) process.env[m[1]] = v;
    });
}

const { createClient } = require('@supabase/supabase-js');
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 47990;
const REDIRECT = 'http://127.0.0.1:' + PORT;
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

if (!CLIENT_ID || !CLIENT_SECRET) { console.error('Missing GOOGLE_OAUTH_CLIENT_ID/SECRET in .env.local'); process.exit(1); }

const consentUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    login_hint: 'remyleon@stiloaipartners.com'
}).toString();

console.log('\n=== OPEN THIS URL (signed in as remyleon@stiloaipartners.com), then click Allow ===\n');
console.log(consentUrl);
console.log('\n(Waiting for the redirect on ' + REDIRECT + ' ...)\n');

const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/?') !== 0 && req.url.indexOf('/favicon') === 0) { res.end(); return; }
    const u = new URL(req.url, REDIRECT);
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (err) { res.end('Error: ' + err); console.error('CONSENT_ERROR: ' + err); server.close(); process.exit(1); }
    if (!code) { res.statusCode = 400; res.end('No code'); return; }
    try {
        const tr = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code' })
        });
        const tj = await tr.json();
        if (!tr.ok || !tj.refresh_token) {
            res.end('Token exchange failed: ' + JSON.stringify(tj));
            console.error('TOKEN_FAIL: ' + JSON.stringify(tj));
            server.close(); process.exit(1);
        }
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        await sb.from('oauth_tokens').upsert({
            provider: 'google-calendar', refresh_token: tj.refresh_token,
            access_token: tj.access_token || null, scope: tj.scope || null,
            account_email: 'remyleon@stiloaipartners.com', updated_at: new Date().toISOString()
        }, { onConflict: 'provider' });
        res.setHeader('Content-Type', 'text/html');
        res.end('<h2 style="font-family:system-ui">STILO booking calendar connected. You can close this tab.</h2>');
        console.log('SUCCESS: refresh token stored in public.oauth_tokens (provider=google-calendar).');
        server.close(); process.exit(0);
    } catch (e) {
        res.end('Error: ' + e.message); console.error('FATAL: ' + e.message); server.close(); process.exit(1);
    }
});
server.listen(PORT, '127.0.0.1');
setTimeout(() => { console.error('TIMEOUT: no consent within 10 min'); process.exit(1); }, 600000);
