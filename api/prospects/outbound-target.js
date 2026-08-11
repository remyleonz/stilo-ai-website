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

        // send_now skips exactly ONE control, the drip interval. The send
        // window and both daily caps still apply: "the prospect is waiting"
        // never justifies texting at 11pm or blowing a line's carrier budget.
        const nowDate = new Date();
        const win = ob.windowState(campaign, nowDate);
        if (!win.open) {
            return res.status(409).json({ error: 'blocked', reason: 'outside_send_window', local_minutes: win.localMinutes });
        }
        let perLine;
        try { perLine = await ob.sentTodayByLine(sb, campaign, nowDate); }
        catch (e) { return res.status(500).json({ error: 'pacing_read_failed', detail: e.message }); }
        const campaignSentToday = Object.values(perLine).reduce(function (a, b) { return a + b; }, 0);
        if (campaignSentToday >= campaign.daily_cap) {
            return res.status(409).json({ error: 'blocked', reason: 'daily_cap_reached', sent_today: campaignSentToday });
        }
        if ((perLine[t.from_line] || 0) >= campaign.per_line_daily_cap) {
            return res.status(409).json({ error: 'blocked', reason: 'per_line_cap_reached', line_today: perLine[t.from_line] });
        }

        // Same atomic claim as outbound-tick.js. Conditional on the stage we
        // read, so a concurrent tick (or a double-clicked button) loses the
        // race cleanly instead of double-texting.
        const { data: claimed, error: claimErr } = await sb.from('outbound_targets')
            .update({ stage: 'sending', attempt_count: (t.attempt_count || 0) + 1, updated_at: now })
            .eq('id', targetId).eq('stage', t.stage)
            .select('id');
        if (claimErr) return res.status(500).json({ error: 'claim_failed', detail: claimErr.message });
        if (!claimed || !claimed.length) {
            return res.status(409).json({ error: 'claim_lost', detail: 'Another sender (the tick worker, or a second click) owns this target right now. Do not retry blindly; refresh the board first.' });
        }

        const r = await sendSms(t.from_line, t.to_phone, text, { leadId: t.lead_id });
        const ok = r && r.status >= 200 && r.status < 300;
        if (!ok) {
            // Release the claim back to the stage we took it from so the tick
            // can retry it; attempt_count keeps the attempt on the record.
            const { error: relErr } = await sb.from('outbound_targets')
                .update({ stage: t.stage, last_error: (r && (r.err || r.skip)) || 'send_failed', updated_at: new Date().toISOString() })
                .eq('id', targetId);
            if (relErr) {
                return res.status(500).json({
                    error: 'send_failed_and_release_failed',
                    detail: 'Send failed (' + ((r && (r.err || r.skip)) || 'send_failed') + ') AND the target could not be released: ' + relErr.message
                        + '. The row is stuck in stage=sending; fix it manually (requeue) before retrying.',
                });
            }
            return res.status(502).json({ error: 'send_failed', detail: (r && (r.err || r.skip)) || null });
        }

        // Same at-send-time log as outbound-tick.js, so the _sms.js per-human
        // guard can see manual sends without depending on the Quo webhook.
        const { error: logErr } = await sb.from('lead_messages').insert({
            lead_id: t.lead_id, direction: 'outbound', channel: 'sms',
            subject: 'Outbound campaign step ' + nextStep + ' (send_now)',
            body: text, body_preview: text.slice(0, 300),
            to_address: t.to_phone, from_address: (r && r.from) || t.from_line,
            provider: 'openphone', status: 'sent',
            variant: 'outbound_campaign', sent_at: new Date().toISOString(),
        });
        if (logErr) console.error('[outbound-target] lead_messages log failed target=' + targetId + ': ' + logErr.message);

        // Stamp the outcome and CHECK it. The message is already out, so a
        // failed stamp must be loud and must tell the operator not to retry.
        const sentPatch = {
            updated_at: new Date().toISOString(),
            step: nextStep, stage: 'sent', last_error: null,
        };
        sentPatch['step' + nextStep + '_sent_at'] = new Date().toISOString();
        let { data: updatedRow, error: stampErr } = await sb.from('outbound_targets')
            .update(sentPatch).eq('id', targetId).select().maybeSingle();
        if (stampErr) {
            const second = await sb.from('outbound_targets').update(sentPatch).eq('id', targetId).select().maybeSingle();
            updatedRow = second.data; stampErr = second.error;
        }
        if (stampErr) {
            console.error('[outbound-target] STAMP FAILED after send target=' + targetId + ': ' + stampErr.message);
            return res.status(500).json({
                error: 'sent_but_stamp_failed',
                detail: 'The message WAS SENT but the database stamp failed twice: ' + stampErr.message
                    + '. DO NOT press send again, the prospect already has the text.'
                    + ' The row is stuck in stage=sending; set stage/step' + nextStep + '_sent_at manually.',
                message_log: logErr ? 'also_failed' : 'written',
            });
        }
        return res.status(200).json({ ok: true, target: updatedRow });
    } else {
        return res.status(400).json({ error: 'unknown_action' });
    }

    const { data: updated, error: uErr } = await sb.from('outbound_targets')
        .update(patch).eq('id', targetId).select().maybeSingle();
    if (uErr) return res.status(500).json({ error: 'update_failed', detail: uErr.message });

    return res.status(200).json({ ok: true, target: updated });
};
