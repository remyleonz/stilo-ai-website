#!/usr/bin/env node
/**
 * scripts/change_sdr_emails.js
 *
 * One-time: change the login email for each SDR in BOTH Supabase auth.users
 * (admin API, email auto-confirmed so no confirmation email is sent) and
 * public.sdr_users. auth_user_id stays stable, so JWT role + all FK links
 * survive. Also reassigns every prospecting.leads row from the old email to
 * the new email so each SDR keeps their existing queue under the new identity.
 *
 * Idempotent: if a user already has the new email, it is skipped.
 *
 * Run from sites/stilo-ai/:  node scripts/change_sdr_emails.js
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) return;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!process.env[m[1]]) process.env[m[1]] = val;
    });
}

const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const sbLeads = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });

// sdr_key -> new email
const CHANGES = {
    luke:      'huronfire5@gmail.com',
    jack:      'jacksonmaguire0@gmail.com',
    alejandro: 'aleb1027@gmail.com',
};

async function main() {
    const { data: sdrs, error } = await sb.from('sdr_users')
        .select('id, sdr_key, display_name, email, auth_user_id').eq('active', true);
    if (error) throw error;

    const report = [];
    for (const s of sdrs) {
        const newEmail = CHANGES[s.sdr_key];
        if (!newEmail) { report.push({ sdr: s.sdr_key, status: 'no_change_requested' }); continue; }
        const oldEmail = s.email;
        if (oldEmail.toLowerCase() === newEmail.toLowerCase()) { report.push({ sdr: s.sdr_key, status: 'already_set', email: newEmail }); continue; }

        // 1. auth.users email (auto-confirm => no email sent to the SDR)
        if (s.auth_user_id) {
            const { error: authErr } = await sb.auth.admin.updateUserById(s.auth_user_id, { email: newEmail, email_confirm: true });
            if (authErr) { report.push({ sdr: s.sdr_key, status: 'auth_update_failed', error: authErr.message }); continue; }
        }
        // 2. public.sdr_users.email
        const { error: rowErr } = await sb.from('sdr_users').update({ email: newEmail, updated_at: new Date().toISOString() }).eq('id', s.id);
        if (rowErr) { report.push({ sdr: s.sdr_key, status: 'sdr_users_update_failed', error: rowErr.message }); continue; }
        // 3. reassign existing leads old -> new email
        const { count, error: leadErr } = await sbLeads.from('leads')
            .update({ assigned_to: newEmail }, { count: 'exact' })
            .eq('assigned_to', oldEmail);
        report.push({ sdr: s.sdr_key, status: 'changed', old: oldEmail, new: newEmail, leads_reassigned: leadErr ? ('ERR: ' + leadErr.message) : count });
    }

    console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
