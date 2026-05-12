/**
 * GET /api/client-leads?client_id=<uuid>
 *
 * Returns the lead list for a given client. Two auth paths:
 *   1. Admin token (assertAdmin) — works for impersonation from /admin/.
 *   2. The client themselves, authenticated via their own Supabase session,
 *      where session.user.id === client_id.
 *
 * Source of truth (today): David drops a CSV per client into
 * gs://stilo-cold-call-scripts/leads/<slug>-leads-<YYYY-MM-DD>.csv. We map
 * client_id → CSV path via the CLIENT_LEAD_SOURCES table below, fetch the
 * latest matching object using the existing GCP_SCRIPTS_SA_KEY service
 * account, parse it, and return JSON.
 *
 * When David moves to writing into Supabase directly, swap the GCS-fetch
 * branch for a `prospecting.leads WHERE client_id = ?` query — the
 * response shape stays the same so the frontend doesn't change.
 */
const { createClient } = require('@supabase/supabase-js');
const cc = require('./prospects/cold-call-script');

const ADMIN_EMAILS = [
    'remyleon11@gmail.com',
    'stiloaiconsulting@gmail.com',
    'remyleon@stiloaipartners.com',
    'davidcoira@stiloaipartners.com'
];

// Hardcoded fallback for clients onboarded before the user_metadata config
// existed. New clients: set the prefix from the admin UI (writes
// auth.users.user_metadata.lead_source_gcs_prefix via
// /api/admin/clients/set-lead-source), no code push required.
const CLIENT_LEAD_SOURCES_FALLBACK = {
    'bb2e4438-1306-43d7-a56a-4a1c3632816f': 'leads/jacksonville-office-leads-'
};

async function lookupGcsPrefix(sb, clientId) {
    try {
        const { data, error } = await sb.auth.admin.getUserById(clientId);
        if (!error && data && data.user && data.user.user_metadata) {
            const p = data.user.user_metadata.lead_source_gcs_prefix;
            if (p && String(p).trim()) return String(p).trim();
        }
    } catch (_) {}
    return CLIENT_LEAD_SOURCES_FALLBACK[clientId] || null;
}

// Minimal RFC 4180-ish CSV parser. Handles quoted fields with embedded commas
// and "" escapes, plus CRLF/LF line endings. Returns array of arrays.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else { field += c; }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field); rows.push(row);
                row = []; field = '';
            } else { field += c; }
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // Drop trailing empty rows.
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
    return rows;
}

function rowsToLeads(rows) {
    if (!rows.length) return [];
    const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = (r[c] != null ? String(r[c]) : '').trim();
        }
        // Normalize the field names to the same vocabulary the admin leads
        // dashboard uses, so /app/leads.html can reuse the same rendering.
        out.push({
            id: 'gcs:' + (i - 1),
            business_name: obj.name || obj.business_name || '',
            niche: obj.category || obj.niche || '',
            phone: obj.phone || '',
            owner_phone: obj.phone || '',
            website: obj.website || '',
            address: obj.address || '',
            rating: obj.rating ? Number(obj.rating) : null,
            review_count: obj.reviews ? Number(obj.reviews) : null,
            source_query: obj.source_query || ''
        });
    }
    return out;
}

async function findLatestFile(token, bucket, prefix) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + bucket +
        '/o?prefix=' + encodeURIComponent(prefix) +
        '&fields=items(name,updated,size)';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) throw new Error('list_failed_' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const csvs = (j.items || []).filter(it => it.name.endsWith('.csv'));
    if (!csvs.length) return null;
    csvs.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    return csvs[0];
}

async function readObject(token, bucket, name) {
    const url = 'https://storage.googleapis.com/storage/v1/b/' + bucket +
        '/o/' + encodeURIComponent(name) + '?alt=media';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (!r.ok) throw new Error('read_failed_' + r.status);
    return await r.text();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'method_not_allowed' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const clientId = (req.query.client_id || '').trim();
    if (!clientId) return res.status(400).json({ error: 'missing_client_id' });

    // Auth: bearer JWT must be either an admin (impersonation) or the
    // client themselves (session.user.id === client_id).
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    const email = userData && userData.user && (userData.user.email || '').toLowerCase();
    const userId = userData && userData.user && userData.user.id;
    if (userErr || !email) return res.status(401).json({ error: 'invalid_token' });

    const isAdmin = ADMIN_EMAILS.includes(email);
    const isSelf = userId && userId === clientId;
    if (!isAdmin && !isSelf) {
        return res.status(403).json({ error: 'forbidden', detail: 'Not an admin and not this client' });
    }

    const prefix = await lookupGcsPrefix(sb, clientId);
    if (!prefix) {
        return res.status(200).json({
            results: [],
            note: 'no_leads_source_configured',
            hint: 'Set this client\'s GCS prefix from the admin Client drawer (Lead source field).',
            client_id: clientId
        });
    }

    let accessToken;
    try { accessToken = await cc.getAccessToken(); }
    catch (e) {
        return res.status(503).json({ error: 'gcs_auth_failed', detail: String(e.message || e) });
    }

    try {
        const latest = await findLatestFile(accessToken, cc.BUCKET, prefix);
        if (!latest) return res.status(200).json({ results: [], note: 'no_matching_file', prefix });
        const text = await readObject(accessToken, cc.BUCKET, latest.name);
        const rows = parseCsv(text);
        const leads = rowsToLeads(rows);
        res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
        return res.status(200).json({
            results: leads,
            count: leads.length,
            source: { bucket: cc.BUCKET, name: latest.name, updated: latest.updated, size: latest.size },
            client_id: clientId
        });
    } catch (e) {
        return res.status(502).json({ error: 'gcs_fetch_failed', detail: String(e.message || e) });
    }
};
