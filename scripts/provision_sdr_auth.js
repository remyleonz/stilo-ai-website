#!/usr/bin/env node
/**
 * scripts/provision_sdr_auth.js
 *
 * Creates Supabase auth users for every row in public.sdr_users that
 * doesn't yet have an auth.users record. Generates a strong temporary
 * password, prints it to stdout, and patches sdr_users.auth_user_id so
 * the dashboard can resolve the SDR from auth.uid().
 *
 * Idempotent: re-running skips SDRs who already have an auth_user_id.
 *
 * Run from sites/stilo-ai/:
 *   node scripts/provision_sdr_auth.js
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in .env.local (already set).
 */

// Load .env.local manually (avoid dotenv dependency)
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, 'utf8');
    envText.split('\n').forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) return;
        const key = m[1];
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
    });
}

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
    process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// GoTrue rejects new-format sb_secret_ keys sent as "Authorization: Bearer",
// so auth admin calls go straight to the REST API with an apikey-only header.
async function authAdmin(method, pathname, body) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1${pathname}`, {
        method,
        headers: { apikey: SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(json.msg || json.message || json.error_description || `auth admin ${method} ${pathname} failed (${res.status})`);
    }
    return json;
}

function genTempPassword() {
    // 20-char alpha-num, easy to read aloud once on a Loom for the new hire.
    return crypto.randomBytes(15).toString('base64')
        .replace(/[+/=]/g, '')
        .slice(0, 20);
}

async function main() {
    const { data: sdrs, error: listErr } = await sb
        .from('sdr_users')
        .select('id, email, display_name, sdr_key, auth_user_id')
        .eq('active', true)
        .order('hired_at');

    if (listErr) throw listErr;

    const results = [];
    for (const sdr of sdrs) {
        if (sdr.auth_user_id) {
            results.push({ sdr_key: sdr.sdr_key, email: sdr.email, status: 'already_provisioned' });
            continue;
        }

        // Check if the auth user already exists (e.g. they signed up via /auth.html)
        let existingUser = null;
        try {
            const existing = await authAdmin('GET', '/admin/users?page=1&per_page=1000');
            existingUser = (existing.users || []).find(
                u => u.email && u.email.toLowerCase() === sdr.email.toLowerCase()
            ) || null;
        } catch (_) { /* fall through to create, same as the old ignored list error */ }

        let userId;
        let tempPassword = null;

        if (existingUser) {
            userId = existingUser.id;
        } else {
            tempPassword = genTempPassword();
            let created;
            try {
                created = await authAdmin('POST', '/admin/users', {
                    email: sdr.email,
                    password: tempPassword,
                    email_confirm: true,
                    user_metadata: {
                        display_name: sdr.display_name,
                        sdr_key: sdr.sdr_key
                    },
                    app_metadata: { role: 'sdr' }
                });
            } catch (createErr) {
                results.push({ sdr_key: sdr.sdr_key, email: sdr.email, status: 'error', error: createErr.message });
                continue;
            }
            userId = created.id;
        }

        // Link sdr_users.auth_user_id
        const { error: updateErr } = await sb
            .from('sdr_users')
            .update({ auth_user_id: userId, updated_at: new Date().toISOString() })
            .eq('id', sdr.id);

        if (updateErr) {
            results.push({ sdr_key: sdr.sdr_key, email: sdr.email, status: 'auth_created_link_failed', error: updateErr.message, temp_password: tempPassword });
            continue;
        }

        results.push({
            sdr_key: sdr.sdr_key,
            email: sdr.email,
            display_name: sdr.display_name,
            auth_user_id: userId,
            temp_password: tempPassword,
            status: tempPassword ? 'created' : 'linked_existing'
        });
    }

    console.log('\n========================================');
    console.log('SDR auth provisioning results');
    console.log('========================================\n');
    for (const r of results) {
        console.log(`SDR:     ${r.display_name || r.sdr_key} (${r.email})`);
        console.log(`Status:  ${r.status}`);
        if (r.temp_password) {
            console.log(`Login:   https://stiloaipartners.com/auth.html`);
            console.log(`Pass:    ${r.temp_password}`);
            console.log(`(They should reset on first login.)`);
        }
        if (r.error) console.log(`Error:   ${r.error}`);
        console.log('');
    }
    console.log('========================================');
    console.log('Save the temp passwords now. They are only printed once.');
    console.log('========================================\n');
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
