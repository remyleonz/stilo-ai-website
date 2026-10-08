/**
 * POST /api/prospects/create-lead
 *
 * The "Add lead" button on both dashboards: a rep meets someone (a DM, a
 * walk-in, a referral) and needs a lead panel for them right now.
 *
 * Body: { name (required), website, owner_name, owner_phone, owner_email,
 *         address | city, primary_language, instagram_handle, facebook_url,
 *         niche, notes, client_id (admin), assigned_to (admin), tier }
 *
 * SDRs: the lead lands in their own book (assigned_to = caller) and in their
 * client pool when they are a client-account rep. Admins may pick both.
 * Dedupe: same phone (any format) or same Instagram handle in the same pool
 * returns the existing lead instead of a second row. Returns { lead_id, created }.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, resolveAssignedTo, resolveClientScope } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function sb() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function e164(p) { const d = String(p || '').replace(/[^\d+]/g, ''); if (!d) return null; if (d[0] === '+') return d; return d.length === 10 ? '+1' + d : (d.length === 11 && d[0] === '1' ? '+' + d : '+' + d); }
function pretty(p) { const e = e164(p); const m = e && e.match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : (p || null); }
function handleOf(h) { h = String(h || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '').replace(/^@/, ''); return h ? '@' + h : null; }

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req) || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const db = sb();

    let assignedTo = gate.email, clientId = null;
    if (gate.isAdmin) {
        assignedTo = body.assigned_to ? await resolveAssignedTo(body.assigned_to) : gate.email;
        clientId = body.client_id ? String(body.client_id) : null;
    }
    if (!clientId) clientId = await resolveClientScope(assignedTo);
    if (!clientId && gate.isAdmin && body.client_id === '') clientId = null;

    const phoneE = e164(body.owner_phone), ig = handleOf(body.instagram_handle);
    // Dedupe inside the pool: phone first, then Instagram handle.
    let dupe = null;
    const poolEq = function (q) { return clientId ? q.eq('client_id', clientId) : q.is('client_id', null); };
    if (phoneE) {
        const { data } = await poolEq(db.from('leads').select('id,name').or('owner_phone_e164.eq.' + phoneE + ',owner_phone.eq.' + pretty(phoneE) + ',phone.eq.' + pretty(phoneE))).limit(1);
        dupe = data && data[0];
    }
    if (!dupe && ig) { const { data } = await poolEq(db.from('leads').select('id,name').eq('instagram_handle', ig)).limit(1); dupe = data && data[0]; }
    if (dupe) return res.status(200).json({ ok: true, lead_id: dupe.id, created: false, name: dupe.name });

    const address = String(body.address || '').trim() || (body.city ? String(body.city).trim() + ', FL' : null);
    const row = {
        name: name, website: body.website ? String(body.website).trim() : null,
        owner_name: body.owner_name ? String(body.owner_name).trim() : null,
        owner_name_verify_status: body.owner_name ? 'rep_confirmed' : null,
        owner_phone: phoneE ? pretty(phoneE) : null, owner_phone_e164: phoneE, phone: phoneE ? pretty(phoneE) : null,
        owner_email: body.owner_email ? String(body.owner_email).trim().toLowerCase() : null,
        address: address, primary_language: body.primary_language === 'es' ? 'es' : 'en',
        instagram_handle: ig, instagram_url: ig ? 'https://www.instagram.com/' + ig.slice(1) + '/' : null,
        facebook_url: body.facebook_url ? String(body.facebook_url).trim() : null,
        niche: body.niche ? String(body.niche).trim() : null, category: body.niche ? String(body.niche).trim() : null,
        rep_notes: body.notes ? String(body.notes).trim() : null,
        client_id: clientId, assigned_to: assignedTo, stage: 'NEW', lead_source: 'manual_' + (gate.isAdmin ? 'admin' : 'sdr'), do_not_call: false,
        engagement_tier: ['warm', 'hot'].indexOf(body.tier) >= 0 ? body.tier : 'cold',
        engagement_tier_at: ['warm', 'hot'].indexOf(body.tier) >= 0 ? new Date().toISOString() : null,
        engagement_tier_reason: ['warm', 'hot'].indexOf(body.tier) >= 0 ? 'added by hand by ' + gate.email : null,
        engagement_tier_by: ['warm', 'hot'].indexOf(body.tier) >= 0 ? gate.email : null,
    };
    const { data, error } = await db.from('leads').insert(row).select('id').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, lead_id: data.id, created: true });
};
