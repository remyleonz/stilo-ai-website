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

function buildContactBody(lead) {
    // Map David's column names — `name`=business name, owner_name=person,
    // tier=lowercase hot/warm/cold, prospect_tier sometimes as alias.
    const businessName = lead.name || lead.business_name || '(no business name)';
    const tier = (lead.prospect_tier || lead.tier || 'warm').toUpperCase();
    const score = lead.prospect_score != null ? lead.prospect_score : (lead.score != null ? lead.score : '?');
    const niche = lead.category || lead.niche || '';
    const ownerNameParts = (lead.owner_name || '').trim().split(/\s+/);
    const ownerPhone = lead.owner_phone || lead.phone || null;
    const ownerEmail = lead.owner_email || lead.email || null;

    const lines = [];
    lines.push(tier + ' lead · score ' + score + (niche ? ' · ' + niche : ''));
    if (lead.matched_product_name) lines.push('PRODUCT: ' + lead.matched_product_name);
    if (lead.outreach_angle)       lines.push('ANGLE: ' + lead.outreach_angle);
    if (lead.problem_identified)   lines.push('PROBLEM: ' + lead.problem_identified);
    if (lead.business_profile)     lines.push('ABOUT: ' + (typeof lead.business_profile === 'string' ? lead.business_profile.slice(0, 400) : ''));
    if (lead.outreach_draft && typeof lead.outreach_draft === 'string') {
        // outreach_draft is JSON of email variants; not useful in role. Skip.
    }
    if (lead.scoring_reasoning)    lines.push('WHY: ' + lead.scoring_reasoning);
    if (lead.next_action_due_at)   lines.push('NEXT: ' + lead.next_action_due_at);

    return {
        externalId: 'stilo_lead_' + lead.id,
        defaultFields: {
            firstName: ownerNameParts[0] || businessName,
            lastName: ownerNameParts.slice(1).join(' ') || '',
            company: businessName,
            role: lines.join('\n'),
            phoneNumbers: ownerPhone ? [{ name: 'Owner', value: ownerPhone }] : [],
            emails: ownerEmail ? [{ name: 'Work', value: ownerEmail }] : []
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

    const lead = body.record || body.new_record || body.new;
    if (!lead || lead.id == null) return res.status(400).json({ error: 'no_record' });
    const sb = serviceClient(); // points at prospecting schema

    // Compute "should this lead be in Quo Contacts right now?" — the SAME
    // predicate the trigger uses, computed here too so we don't trust the
    // payload's `eligible_now` flag in case schema drift sneaks in.
    const tierLc = String(lead.prospect_tier || lead.tier || '').toLowerCase();
    const phone = lead.owner_phone || lead.phone;
    const eligibleNow = (
        tierLc === 'hot'
        && lead.do_not_call !== true
        && (lead.last_called_outcome || '') !== 'booked_meeting'
        && !!phone
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
    const contactBody = buildContactBody(lead);
    let action, contactId;
    if (lead.quo_contact_id) {
        const r = await openphoneFetch({
            method: 'PATCH',
            path: '/contacts/' + encodeURIComponent(lead.quo_contact_id),
            body: contactBody
        });
        if (r.status >= 400) {
            // Maybe it was deleted on Quo side — fall through to create.
            const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
            if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
            contactId = c.json && c.json.data && c.json.data.id;
            action = 'recreated';
        } else {
            contactId = lead.quo_contact_id;
            action = 'updated';
        }
    } else {
        const c = await openphoneFetch({ method: 'POST', path: '/contacts', body: contactBody });
        if (c.status >= 400) return res.status(c.status).json({ error: 'quo_create_failed', detail: c.json });
        contactId = c.json && c.json.data && c.json.data.id;
        action = 'created';
    }

    if (contactId && contactId !== lead.quo_contact_id) {
        await sb.from('leads').update({ quo_contact_id: contactId }).eq('id', lead.id);
    }
    return res.status(200).json({ ok: true, action, lead_id: lead.id, quo_contact_id: contactId });
};
