/**
 * POST /api/prospects/outbound-target
 * Body: { target_id, action, body? }
 *
 * Per-card actions on the Outbound board.
 *
 *   called_back  stop the callback clock (the rep dialed)
 *   booked       they agreed to a meeting; terminal success
 *   dead         not interested / wrong person; terminal
 *   opt_out      manual opt-out; also sets leads.do_not_call
 *   requeue      put a failed/blocked card back to queued after a fix
 *   edit_body    replace a generated message before it sends
 *   send_now     send the next step immediately, ignoring the drip
 *
 * send_now still honours every safety gate except the drip interval: the env
 * lock, campaign status, scrub verdict, phone match, and do_not_call all still
 * apply. It exists for the one case the drip is wrong for, which is a prospect
 * actively texting back right now and waiting on an answer.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { sendSms } = require('./_sms');
const ob = require('./_outbound');

const TERMINAL = { booked: 'booked', dead: 'dead' };

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const targetId = safeNumberId(body.target_id);
    const action = String(body.action || '');
    if (targetId == null) return res.status(400).json({ error: 'target_id_required' });

    const sb = ob.serviceClient();
    const { data: t, error } = await sb.from('outbound_targets').select('*').eq('id', targetId).maybeSingle();
    if (error) return res.status(500).json({ error: 'read_failed', detail: error.message });
    if (!t) return res.status(404).json({ error: 'target_not_found' });

    const now = new Date().toISOString();
    const patch = { updated_at: now };

    if (action === 'called_back') {
        patch.called_back_at = now;
        patch.called_back_by = gate.email;
    } else if (TERMINAL[action]) {
        patch.stage = TERMINAL[action];
        if (!t.called_back_at) { patch.called_back_at = now; patch.called_back_by = gate.email; }
    } else if (action === 'opt_out') {
        patch.stage = 'opted_out';
        await sb.from('leads').update({ do_not_call: true }).eq('id', t.lead_id);
    } else if (action === 'requeue') {
        patch.stage = 'queued';
        patch.last_error = null;
    } else if (action === 'edit_body') {
        const step = [1, 2, 3].includes(Number(body.step)) ? Number(body.step) : 1;
        if (t['step' + step + '_sent_at']) {
            return res.status(409).json({ error: 'already_sent', detail: 'Step ' + step + ' already went out; editing it changes nothing.' });
        }
        const text = String(body.body || '').trim();
        if (!text) return res.status(400).json({ error: 'body_required' });
        if (text.length > 320) return res.status(400).json({ error: 'body_too_long', detail: 'Keep it under 320 characters or the carrier splits it.' });
        patch['step' + step + '_body'] = text;
    } else if (action === 'send_now') {
        const { data: campaign } = await sb.from('outbound_campaigns').select('*').eq('id', t.campaign_id).maybeSingle();
        if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });
        const { data: lead } = await sb.from('leads')
            .select('id,name,do_not_call,scrub_status,scrub_phone').eq('id', t.lead_id).maybeSingle();

        const nextStep = t.stage === 'queued' ? 1 : (t.step >= 3 ? null : t.step + 1);
        if (!nextStep) return res.status(400).json({ error: 'sequence_complete' });
        const text = t['step' + nextStep + '_body'];
        if (!text) return res.status(400).json({ error: 'no_body_generated', detail: 'Generate step ' + nextStep + ' first.' });

        const check = ob.preSendCheck(campaign, t, lead);
        if (!check.ok) return res.status(409).json({ error: 'blocked', reason: check.reason });

        const r = await sendSms(t.from_line, t.to_phone, text, { leadId: t.lead_id });
        const ok = r && r.status >= 200 && r.status < 300;
        if (!ok) {
            await sb.from('outbound_targets')
                .update({ last_error: (r && (r.err || r.skip)) || 'send_failed', updated_at: now }).eq('id', targetId);
            return res.status(502).json({ error: 'send_failed', detail: (r && (r.err || r.skip)) || null });
        }
        patch['step' + nextStep + '_sent_at'] = now;
        patch.step = nextStep;
        patch.stage = 'sent';
        patch.last_error = null;
    } else {
        return res.status(400).json({ error: 'unknown_action' });
    }

    const { data: updated, error: uErr } = await sb.from('outbound_targets')
        .update(patch).eq('id', targetId).select().maybeSingle();
    if (uErr) return res.status(500).json({ error: 'update_failed', detail: uErr.message });

    return res.status(200).json({ ok: true, target: updated });
};
