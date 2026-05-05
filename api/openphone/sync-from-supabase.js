/**
 * POST /api/openphone/sync-from-supabase
 *
 * Auto-sync receiver: a Postgres trigger on public.prospects calls this URL
 * via pg_net whenever a HOT prospect is INSERTed or a row is UPDATEd into
 * the HOT tier. The body is a Supabase-style record payload:
 *   { type: 'INSERT'|'UPDATE', record: {...prospect}, old_record?: {...} }
 *
 * Auth: shared bearer secret in `Authorization: Bearer <SUPABASE_TRIGGER_SECRET>`
 * (set on the database via `alter database ... set app.trigger_secret = '...'`
 * and read in the trigger via current_setting).
 *
 * Effect: creates the contact in Quo (or updates if quo_contact_id is set on
 * the prospect row), then writes back the new quo_contact_id so future
 * updates patch instead of duplicate-create.
 *
 * Public endpoint, gated only by the bearer header — no admin JWT, since
 * Postgres triggers don't have user sessions.
 */

const { serviceClient, openphoneFetch } = require('./_shared');

function buildContactBody(p) {
    const parts = (p.owner_name || '').trim().split(/\s+/);
    const lines = [];
    lines.push((p.tier || 'WARM') + ' lead · score ' + (p.prospect_score != null ? p.prospect_score : '?') + (p.niche ? ' · ' + p.niche : ''));
    if (p.recommended_product) lines.push('PRODUCT: ' + p.recommended_product);
    if (p.talk_track) lines.push('SCRIPT: ' + p.talk_track);
    if (p.next_callback_at) lines.push('CALLBACK DUE: ' + p.next_callback_at);
    return {
        externalId: 'stilo_prospect_' + p.id,
        defaultFields: {
            firstName: parts[0] || p.business_name,
            lastName: parts.slice(1).join(' ') || '',
            company: p.business_name,
            role: lines.join('\n'),
            phoneNumbers: p.owner_phone ? [{ name: 'Owner', value: p.owner_phone }] : [],
            emails: p.owner_email ? [{ name: 'Work', value: p.owner_email }] : []
        }
    };
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

    const p = body.record || body.new_record || body.new;
    if (!p || !p.id) return res.status(400).json({ error: 'no_record' });
    if (p.tier !== 'HOT') return res.status(200).json({ ok: true, skipped: 'not_hot' });
    if (!p.owner_phone) return res.status(200).json({ ok: true, skipped: 'no_phone' });

    const sb = serviceClient();
    const contactBody = buildContactBody(p);

    let action, contactId;
    if (p.quo_contact_id) {
        // Existing contact — patch it
        const r = await openphoneFetch({
            method: 'PATCH',
            path: '/contacts/' + encodeURIComponent(p.quo_contact_id),
            body: contactBody
        });
        if (r.status >= 400) {
            // Maybe it was deleted on Quo side — try create as fallback
            const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
            if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
            contactId = c.json && c.json.data && c.json.data.id;
            action = 'recreated';
        } else {
            contactId = p.quo_contact_id;
            action = 'updated';
        }
    } else {
        const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
        if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
        contactId = c.json && c.json.data && c.json.data.id;
        action = 'created';
    }

    if (contactId && contactId !== p.quo_contact_id) {
        await sb.from('prospects').update({ quo_contact_id: contactId }).eq('id', p.id);
    }
    return res.status(200).json({ ok: true, action, prospect_id: p.id, quo_contact_id: contactId });
};
