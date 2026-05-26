/**
 * GET    /api/admin/deals/[id]                deal + events + relations
 * PATCH  /api/admin/deals/[id]                update stage/notes/sdr/etc
 * DELETE /api/admin/deals/[id]                hard delete (rare; usually mark CLOSED_LOST instead)
 *
 * PATCH body shapes:
 *   { stage: 'PAID' | 'ONBOARDING' | 'LIVE' | 'CHURNED' | 'CLOSED_LOST', lost_reason?, churn_reason? }
 *   { sdr_id: <uuid>, note?: 'optional reassign note' }
 *   { notes: 'free text update' }
 *   { paused_until: '2026-08-01' }
 *
 * All updates write a deal_events row.
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const sb = gate.sb;
    const userId = gate.userId;

    // Vercel routes /api/admin/deals/abc to this file with req.query.id = 'abc'.
    // Local serve.js dispatch needs the path parsed manually.
    let dealId = (req.query && req.query.id) || null;
    if (!dealId) {
        const m = (req.url || '').match(/\/api\/admin\/deals\/([^/?]+)/);
        if (m) dealId = m[1];
    }
    if (!dealId) return res.status(400).json({ error: 'missing_deal_id' });

    if (req.method === 'GET') {
        const { data: deal, error } = await sb.from('deals')
            .select(`*, sdr_users(id, display_name, sdr_key, initials, avatar_color, email), clients(id, business_name, contact_name, email, status)`)
            .eq('id', dealId)
            .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!deal) return res.status(404).json({ error: 'not_found' });

        const { data: events } = await sb.from('deal_events')
            .select('*')
            .eq('deal_id', dealId)
            .order('created_at', { ascending: false })
            .limit(200);

        return res.status(200).json({ deal, events: events || [] });
    }

    if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const { data: existing } = await sb.from('deals').select('*').eq('id', dealId).maybeSingle();
        if (!existing) return res.status(404).json({ error: 'not_found' });

        const update = { updated_at: new Date().toISOString() };
        const events = [];

        if (body.stage && body.stage !== existing.stage) {
            // Stage transition validation
            if (body.stage === 'CLOSED_LOST' && !body.lost_reason) {
                return res.status(400).json({ error: 'lost_reason_required' });
            }
            if (body.stage === 'CHURNED' && !body.churn_reason) {
                return res.status(400).json({ error: 'churn_reason_required' });
            }
            update.stage = body.stage;
            if (body.lost_reason) update.lost_reason = body.lost_reason;
            if (body.churn_reason) update.churn_reason = body.churn_reason;
            if (body.stage === 'CHURNED') update.churned_at = new Date().toISOString();
            if (body.stage === 'PAID') update.paid_at = update.paid_at || new Date().toISOString();
            // stage_change event auto-logged by trigger; we add a body note if there is one
            if (body.notes_for_change) {
                events.push({ event_type: 'note', body: body.notes_for_change });
            }
        }

        if (body.sdr_id !== undefined && body.sdr_id !== existing.sdr_id) {
            update.sdr_id = body.sdr_id;
            const { data: newSdr } = body.sdr_id
                ? await sb.from('sdr_users').select('display_name').eq('id', body.sdr_id).maybeSingle()
                : { data: null };
            const { data: oldSdr } = existing.sdr_id
                ? await sb.from('sdr_users').select('display_name').eq('id', existing.sdr_id).maybeSingle()
                : { data: null };
            events.push({
                event_type: 'reassigned',
                from_value: oldSdr ? oldSdr.display_name : 'unassigned',
                to_value: newSdr ? newSdr.display_name : 'unassigned',
                body: body.note || null
            });
        }

        if (typeof body.notes === 'string') {
            update.notes = body.notes.slice(0, 5000);
            events.push({ event_type: 'note', body: body.notes.slice(0, 1000) });
        }

        if (body.paused_until !== undefined) update.paused_until = body.paused_until;

        const { data: updated, error: updErr } = await sb.from('deals')
            .update(update)
            .eq('id', dealId)
            .select('*')
            .single();
        if (updErr) return res.status(500).json({ error: updErr.message });

        // Insert any manual events alongside the auto stage_change trigger
        for (const e of events) {
            await logEvent(sb, dealId, e.event_type, {
                fromValue: e.from_value, toValue: e.to_value, body: e.body, actorUserId: userId
            });
        }

        return res.status(200).json({ deal: updated });
    }

    if (req.method === 'DELETE') {
        // Hard delete — rare. Usually you'd mark CLOSED_LOST instead.
        const { error } = await sb.from('deals').delete().eq('id', dealId);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
    }

    return methodNotAllowed(res, 'GET, PATCH, DELETE');
};
