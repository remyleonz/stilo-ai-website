#!/usr/bin/env node
/**
 * Sanity-check Marcus's lead pipeline by hitting the LIVE production
 * endpoint with an admin-generated Supabase session JWT. The endpoint
 * accepts admin tokens (assertAdmin-equivalent path) so we don't have to
 * sign in as Marcus himself.
 *
 * Run: node scripts/verify_marcus_leads_live.js
 */
const fs = require('fs');
const path = require('path');

(function loadEnv() {
    const file = path.resolve(__dirname, '..', '.env.local');
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const re = /^([A-Z][A-Z0-9_]*)=("(?:[^"\\]|\\.)*"|.*?)$/gm;
    let m;
    while ((m = re.exec(raw)) !== null) {
        if (process.env[m[1]] != null) continue;
        let v = m[2];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
        process.env[m[1]] = v;
    }
})();

const { createClient } = require('@supabase/supabase-js');

const MARCUS_ID = 'bb2e4438-1306-43d7-a56a-4a1c3632816f';
const PROD_URL  = 'https://stiloaipartners.com/api/client-leads?client_id=' + MARCUS_ID;
const ADMIN_EMAIL = 'remyleon11@gmail.com';

(async () => {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    // Generate a magic-link token for the admin (we don't redeem it on email;
    // we extract the access_token via the admin API and use it as a bearer).
    const { data, error } = await sb.auth.admin.generateLink({
        type: 'magiclink',
        email: ADMIN_EMAIL
    });
    if (error) { console.error('generateLink failed:', error.message); process.exit(1); }
    // Sign in directly with the OTP token.
    const { data: sess, error: sessErr } = await sb.auth.verifyOtp({
        email: ADMIN_EMAIL,
        token: data.properties.email_otp,
        type: 'email'
    });
    if (sessErr) { console.error('verifyOtp failed:', sessErr.message); process.exit(2); }
    const jwt = sess.session.access_token;
    console.log('admin JWT acquired, calling endpoint...');

    const resp = await fetch(PROD_URL, { headers: { 'Authorization': 'Bearer ' + jwt } });
    const body = await resp.text();
    console.log('HTTP', resp.status);
    try {
        const j = JSON.parse(body);
        if (j.results) {
            console.log('results:', j.results.length, 'leads');
            console.log('source :', j.source ? j.source.name : '(none)');
            console.log('sample :', j.results.slice(0, 3).map(r => r.business_name).join(', '));
        } else if (j.note) {
            console.log('note   :', j.note);
            console.log('hint   :', j.hint || '');
        } else {
            console.log('body   :', JSON.stringify(j).slice(0, 400));
        }
    } catch (_) {
        console.log('raw    :', body.slice(0, 400));
    }
})().catch(e => { console.error('FATAL:', e); process.exit(99); });
