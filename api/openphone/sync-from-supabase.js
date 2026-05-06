/**
 * POST /api/openphone/sync-from-supabase
 *
 * Auto-sync receiver: a Postgres trigger on prospecting.leads calls this URL
 * via pg_net whenever a HOT lead is INSERTed or a row is UPDATEd into the
 * HOT tier. The body is a record payload:
 *   { type: 'INSERT'|'UPDATE', record: {...lead}, old_record?: {...} }
 *
 * Auth: shared bearer secret matched against SUPABASE_TRIGGER_SECRET.
 *
 * Effect: creates a contact in Quo (or PATCHes if quo_contact_id is already
 * set on the lead row), then writes the contact id back so future updates
 * patch instead of duplicate-create. Lead's outreach script + business
 * profile go in the contact's role field so when Remy taps the contact in
 * the iPhone Quo app he sees what to say before dialing.
 */

const { serviceClient, openphoneFetch } = require('./_shared');
const gcsScript = require('../prospects/cold-call-script');

// Per-Quo-contact note marker. We prefix our auto-generated script note
// with this so we can detect it on subsequent syncs and update-in-place
// instead of creating duplicates.
const NOTE_MARKER = '[stilo-script]';

function buildContactBody(lead) {
    // Per Remy 2026-05-06: contact name is the OWNER, not the business.
    // Role stays compact — just tier, score, niche. The verbose ABOUT JSON
    // and scoring debug get dropped. The full sales script lives on the
    // contact's notes (see attachScriptNote below).
    const businessName = lead.name || lead.business_name || '';
    const tier = (lead.prospect_tier || lead.tier || 'warm').toUpperCase();
    const score = lead.prospect_score != null ? lead.prospect_score : (lead.score != null ? lead.score : '?');
    const niche = lead.category || lead.niche || '';
    const ownerNameRaw = (lead.owner_name || '').trim();
    const ownerNameParts = ownerNameRaw.split(/\s+/);
    const ownerPhone = lead.owner_phone || lead.phone || null;
    const ownerEmail = lead.owner_email || lead.email || null;

    const role = tier + ' · score ' + score + (niche ? ' · ' + niche : '')
        + (lead.matched_product_name ? ' · pitch ' + lead.matched_product_name : '');

    return {
        externalId: 'stilo_lead_' + lead.id,
        defaultFields: {
            firstName: ownerNameParts[0] || '(unknown)',
            lastName: ownerNameParts.slice(1).join(' ') || '',
            company: businessName,
            role: role,
            phoneNumbers: ownerPhone ? [{ name: 'Owner', value: ownerPhone }] : [],
            emails: ownerEmail ? [{ name: 'Work', value: ownerEmail }] : []
        }
    };
}

// Best-effort fetch + attach of the per-lead cold-call script as a Quo note.
// Idempotent: if a note tagged with NOTE_MARKER already exists for this
// contact, PATCH it in place; else POST a fresh one. Failures here never
// block the contact upsert — script availability lags lead enrichment by
// up to one hour (David's GCS sync cadence) and we still want the contact
// in Quo immediately.
async function attachScriptNote(contactId, lead) {
    if (!contactId) return { skipped: 'no_contact_id' };
    const businessName = lead.name || lead.business_name || '';
    if (!businessName) return { skipped: 'no_business_name' };
    if (!process.env.GCP_SCRIPTS_SA_KEY) return { skipped: 'gcs_not_configured' };

    const slug = gcsScript.slugify(businessName);
    if (!slug) return { skipped: 'slug_empty' };

    let token, item;
    try {
        token = await gcsScript.getAccessToken();
        item = await gcsScript.findScriptByListing(token, slug);
    } catch (e) {
        return { skipped: 'gcs_lookup_failed', detail: String(e.message || e) };
    }
    if (!item) return { skipped: 'no_script_in_bucket', slug: slug };

    let scriptMd;
    try { scriptMd = await gcsScript.readObject(token, item.name); }
    catch (e) { return { skipped: 'gcs_read_failed', detail: String(e.message || e) }; }

    // Quo contact-notes API: GET /v1/contact-notes?contactIds=X to list,
    // POST to create, PATCH to update. We tag with a marker so we don't
    // duplicate every time the lead's lifecycle fields change.
    const noteBody = NOTE_MARKER + ' ' + (item.name || '').split('/').pop() + '\n\n' + scriptMd;

    const list = await openphoneFetch({
        method: 'GET',
        path: '/contact-notes?contactIds=' + encodeURIComponent(contactId)
    });
    const existing = (list.json && list.json.data && Array.isArray(list.json.data))
        ? list.json.data.find(function (n) { return typeof n.body === 'string' && n.body.indexOf(NOTE_MARKER) === 0; })
        : null;

    if (existing && existing.id) {
        const patched = await openphoneFetch({
            method: 'PATCH',
            path: '/contact-notes/' + encodeURIComponent(existing.id),
            body: { body: noteBody }
        });
        return { action: 'updated', note_id: existing.id, status: patched.status };
    }
    const created = await openphoneFetch({
        method: 'POST',
        path: '/contact-notes',
        body: { contactId: contactId, body: noteBody }
    });
    return { action: 'created', status: created.status, note_id: created.json && created.json.data && created.json.data.id };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'method_not_allowed' });
    }
    const auth = req.headers.authorization || '';
    const expected = 'Bearer ' + (process.env.SUPABASE_TRIGGER_SECRET || '');
    if (!process.env.SUPABASE_TRIGGER_SECRET || auth !== expected) {
        return res.status(401).json({ error: 'invalid_trigger_secret' });
    }

    let body = req.body;
    if (!body || typeof body !== 'object') {
        try {
            const chunks = [];
            for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch { return res.status(400).json({ error: 'invalid_json' }); }
    }

    const lead = body.record || body.new_record || body.new;
    if (!lead || lead.id == null) return res.status(400).json({ error: 'no_record' });
    const sb = serviceClient(); // points at prospecting schema

    // Compute "should this lead be in Quo Contacts right now?" — the SAME
    // predicate the trigger uses, computed here too so we don't trust the
    // payload's `eligible_now` flag in case schema drift sneaks in.
    // Per Remy 2026-05-06: also require a non-empty owner_name so we don't
    // sync "(unknown)" contacts. Leads without an owner name shouldn't be
    // in the dialer until phone-finder/enrich surfaces one.
    const tierLc = String(lead.prospect_tier || lead.tier || '').toLowerCase();
    const phone = lead.owner_phone || lead.phone;
    const ownerName = (lead.owner_name || '').trim();
    const eligibleNow = (
        tierLc === 'hot'
        && lead.do_not_call !== true
        && (lead.last_called_outcome || '') !== 'booked_meeting'
        && !!phone
        && !!ownerName
    );

    // ---- DELETE PATH: lead is no longer eligible but has a Quo contact ----
    if (!eligibleNow) {
        if (!lead.quo_contact_id) {
            return res.status(200).json({ ok: true, action: 'noop_not_eligible' });
        }
        const reason = lead.do_not_call === true
            ? 'do_not_call'
            : (lead.last_called_outcome === 'booked_meeting'
                ? 'booked_meeting'
                : (tierLc !== 'hot' ? 'tier_demoted_to_' + (tierLc || 'unknown') : 'no_phone'));
        const del = await openphoneFetch({
            method: 'DELETE',
            path: '/contacts/' + encodeURIComponent(lead.quo_contact_id)
        });
        // 404 means it was already deleted on Quo side — treat as success.
        const ok = del.status < 400 || del.status === 404;
        if (ok) {
            await sb.from('leads').update({ quo_contact_id: null }).eq('id', lead.id);
            return res.status(200).json({ ok: true, action: 'deleted', reason: reason, lead_id: lead.id });
        }
        return res.status(del.status).json({ error: 'quo_delete_failed', detail: del.json, reason: reason });
    }

    // ---- UPSERT PATH: lead IS eligible, ensure Quo contact reflects state ----
    // Receiver is self-healing: if quo_contact_id is missing on the row (e.g.
    // because the prior back-write failed silently when PostgREST hadn't yet
    // exposed the prospecting schema), look the contact up by externalId
    // first, then PATCH. Avoids creating duplicates on retry.
    const contactBody = buildContactBody(lead);
    let action, contactId = lead.quo_contact_id || null;

    if (!contactId) {
        const ext = 'stilo_lead_' + lead.id;
        const lookup = await openphoneFetch({
            method: 'GET',
            path: '/contacts?externalIds=' + encodeURIComponent(ext)
        });
        const existing = lookup.json && (lookup.json.data || []).find(function (c) { return c.externalId === ext; });
        if (existing) contactId = existing.id;
    }

    if (contactId) {
        const r = await openphoneFetch({
            method: 'PATCH',
            path: '/contacts/' + encodeURIComponent(contactId),
            body: contactBody
        });
        if (r.status >= 400) {
            // Contact was deleted Quo-side — recreate.
            const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
            if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
            contactId = c.json && c.json.data && c.json.data.id;
            action = 'recreated';
        } else {
            action = lead.quo_contact_id ? 'updated' : 'patched_via_external_id';
        }
    } else {
        const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
        if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
        contactId = c.json && c.json.data && c.json.data.id;
        action = 'created';
    }

    if (contactId && contactId !== lead.quo_contact_id) {
        // Best-effort back-write. Silently no-ops if PostgREST hasn't exposed
        // the prospecting schema (toggle in Supabase dashboard → Data API).
        // Without it, every sync does the externalId lookup; harmless but +1 API call.
        try {
            await sb.from('leads').update({ quo_contact_id: contactId }).eq('id', lead.id);
        } catch (_) { /* swallow */ }
    }

    // Attach the per-lead cold-call script as a Quo contact note. Best-
    // effort: failures don't block the contact upsert. Idempotent: subsequent
    // syncs PATCH the same note in place rather than duplicating.
    let noteResult = null;
    try { noteResult = await attachScriptNote(contactId, lead); }
    catch (e) { noteResult = { error: String(e.message || e) }; }

    return res.status(200).json({ ok: true, action, lead_id: lead.id, quo_contact_id: contactId, note: noteResult });
};
