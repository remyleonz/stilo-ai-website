/**
 * POST /api/prospects/save-contacts
 * Body: { id, field: 'owner_name' | 'front_desk_name', value }
 *
 * Persists a contact name a rep captured (or corrected) on a call, from the
 * editable Contacts card in the admin and SDR lead drawers. One field per
 * call, matching the save-on-blur UX.
 *
 * A rep typing a name they just heard on the phone is the strongest
 * verification we have, stronger than the website scrape in
 * scripts/verify_owner_names.js. So an owner_name edit also stamps the
 * verify columns: status 'verified', source 'rep_confirmed', and keeps the
 * old name in owner_name_previous. Outbound copy already gates on
 * owner_name_verify_status === 'verified', so a corrected name flows into
 * future calls/emails/SMS with no extra wiring. Clearing the field clears
 * the verify stamps too (an empty name is not a verified name).
 *
 * front_desk_name is a plain column with no verify machinery; it exists so
 * the rep can greet the gatekeeper by name on the next dial.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const EDITABLE_FIELDS = ['owner_name', 'front_desk_name'];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const id = safeNumberId(body.id);
    if (id == null) return res.status(400).json({ error: 'missing_id' });
    const field = String(body.field || '');
    if (EDITABLE_FIELDS.indexOf(field) === -1) return res.status(400).json({ error: 'bad_field' });
    const raw = body.value == null ? '' : String(body.value);
    const value = raw.trim().slice(0, 120) || null;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });

    const update = { updated_at: new Date().toISOString() };
    update[field] = value;

    if (field === 'owner_name') {
        const { data: cur } = await sb.from('leads').select('owner_name').eq('id', id).limit(1);
        const prev = cur && cur[0] ? cur[0].owner_name : null;
        if (prev && prev !== value) update.owner_name_previous = prev;
        update.owner_name_verify_status = value ? 'verified' : null;
        update.owner_name_verify_source = value ? 'rep_confirmed' : null;
        update.owner_name_last_verified = value ? new Date().toISOString() : null;
        // The rep's answer REPLACES every other owner name on file. Clearing
        // the scrape's candidate (owner_name_found) pulls the lead out of the
        // contradicted-review queue and stops any later job from suggesting
        // the old name again. owner_name itself is the single column all
        // outbound copy and both dashboards read.
        if (value) update.owner_name_found = null;
    }

    const { error } = await sb.from('leads').update(update).eq('id', id);
    if (error) return res.status(500).json({ error: 'save_failed', detail: error.message });
    return res.status(200).json({ ok: true, id: id, field: field, value: value });
};
