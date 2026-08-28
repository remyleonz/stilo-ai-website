/**
 * GET /api/prospects/outbound-tick   (Vercel cron, every 5 min)
 *
 * The send worker. Walks every running campaign and sends the next due message
 * per line, respecting the drip interval, the per-line daily cap, the campaign
 * daily cap, and the send window.
 *
 * ---------------------------------------------------------------------------
 * WHY PER LINE, NOT PER CAMPAIGN
 *
 * The drip is enforced per SENDING LINE, not globally. Six lines each sending
 * one message every 10 minutes is six messages per 10 minutes for the campaign
 * and one per 10 minutes per number, which is what carrier reputation actually
 * scores. Enforcing the interval globally would either crawl (one message per
 * 10 min total) or, if you compensated by shortening it, burst a single line.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WILL NOT DO
 *
 * - Send if OUTBOUND_SEND_ENABLED is not exactly 'true'
 * - Send for a campaign that is not 'running'
 * - Send outside the campaign's local send window
 * - Send to a lead whose scrub_status isn't 'clear'
 * - Send to a number that differs from the one that was scrubbed
 * - Send a step whose body hasn't been generated and reviewed
 * - Send step 2 or 3 to someone who hasn't replied
 *
 * That last one is the important one. Steps 2 and 3 are gated on a HUMAN reply,
 * never on a timer. This is a conversation engine, not a sequence blaster: if
 * nobody answers step 1, that lead simply stops. Adding a timed follow-up to a
 * silent recipient is how a cold campaign turns into a complaint.
 *
 * ?dry=1 reports exactly what it would send, and sends nothing.
 */
const { assertAdminOrSdr } = require('./_shared');
const { sendSms } = require('./_sms');
const ob = require('./_outbound');

// Ceiling on sends per tick, across all campaigns. The cron runs every 5 min;
// this keeps one tick inside maxDuration and stops a misconfigured drip of 0
// from emptying the queue in a single invocation.
const MAX_PER_TICK = Number(process.env.OUTBOUND_MAX_PER_TICK || 40);

// Abort the tick after this many consecutive send failures. Set just above the
// number of active lines so a single bad line cannot trip it, but a provider
// outage stops the run almost immediately.
const MAX_CONSECUTIVE_FAILURES = Number(process.env.OUTBOUND_MAX_CONSECUTIVE_FAILURES || 8);

// A target that has burned this many send attempts is parked as 'failed'
// rather than retried forever. attempt_count is bumped inside the atomic
// claim, so it counts real attempts even when the process dies mid-send.
const MAX_ATTEMPTS_PER_TARGET = Number(process.env.OUTBOUND_MAX_ATTEMPTS_PER_TARGET || 5);

// Campaign-level breaker: this many ticks IN A ROW where every attempt failed
// (with at least 2 attempts made) pauses the campaign outright.
const MAX_CONSECUTIVE_FAILED_TICKS = Number(process.env.OUTBOUND_MAX_FAILED_TICKS || 5);

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query || {}).dry || '') === '1';
    const { teamNumberSet } = require('./_team_numbers');
    const teamSet = await teamNumberSet();
    const sb = ob.serviceClient();
    const now = new Date();

    const { data: campaigns, error } = await sb.from('outbound_campaigns')
        .select('*').eq('status', 'running');
    if (error) return res.status(500).json({ error: 'campaign_read_failed', detail: error.message });

    if (!campaigns.length) {
        return res.status(200).json({ ok: true, ran: 0, note: 'No running campaigns.' });
    }
    if (!ob.SEND_ENABLED && !dry) {
        return res.status(200).json({
            ok: true, sent: 0, blocked_by: 'OUTBOUND_SEND_ENABLED',
            note: 'Campaign(s) running but the env lock is closed. Set OUTBOUND_SEND_ENABLED=true to send.',
        });
    }

    let reps;
    try { reps = await ob.loadReps(); }
    catch (e) { return res.status(502).json({ error: 'reps_read_failed', detail: e.message }); }

    const report = [];
    let totalSent = 0;
    // Set when a post-send stamp cannot be written even after a retry. Stops
    // the ENTIRE run, not just the campaign: DB writes failing is global state.
    let halted = null;

    for (const campaign of campaigns) {
        const win = ob.windowState(campaign, now);
        if (!win.open) {
            report.push({ campaign: campaign.id, skipped: 'outside_send_window', local_minutes: win.localMinutes });
            continue;
        }

        let perLine;
        try { perLine = await ob.sentTodayByLine(sb, campaign, now); }
        catch (e) { report.push({ campaign: campaign.id, error: e.message }); continue; }

        const campaignSentToday = Object.values(perLine).reduce((a, b) => a + b, 0);
        if (campaignSentToday >= campaign.daily_cap) {
            report.push({ campaign: campaign.id, skipped: 'daily_cap_reached', sent_today: campaignSentToday });
            continue;
        }

        // Step 1 goes to queued targets. Steps 2 and 3 only ever go to targets
        // that have replied, and only when the body has been generated.
        const { data: due, error: dErr } = await sb.from('outbound_targets')
            .select('*').eq('campaign_id', campaign.id)
            .in('stage', ['queued', 'replied'])
            .order('updated_at', { ascending: true })
            .limit(500);
        if (dErr) { report.push({ campaign: campaign.id, error: dErr.message }); continue; }

        const dripMs = Math.max(0, (campaign.drip_interval_seconds || 600) * 1000);
        // Computed across ALL targets of the campaign, not just the due subset.
        // Deriving it from `due` alone missed every stamp on a target that had
        // already left the queued/replied stages (i.e. the ones that were
        // literally just sent), which quietly disabled the drip.
        let lastSendByLine;
        try { lastSendByLine = await ob.lastSendByLine(sb, campaign); }
        catch (e) { report.push({ campaign: campaign.id, error: e.message }); continue; }

        const results = { sent: 0, skipped: {}, errors: [] };
        const usedLineThisTick = new Set();
        // Consecutive send failures across the whole campaign this tick. A
        // provider outage or a rate-limit must abort the run, not be retried
        // against every remaining target.
        let consecutiveFailures = 0;
        // For the cross-tick breaker: how many real attempts this tick made for
        // this campaign, and how many of them failed.
        let attemptsThisTick = 0;
        let failuresThisTick = 0;

        for (const t of (due || [])) {
            if (totalSent >= MAX_PER_TICK) break;
            if (campaignSentToday + results.sent >= campaign.daily_cap) break;

            const line = t.from_line;
            // One send per line per tick. With a 5-minute cron and a 10-minute
            // drip this is belt and braces, but it also means a shortened drip
            // can never burst a single number inside one invocation.
            if (usedLineThisTick.has(line)) continue;
            if ((perLine[line] || 0) >= campaign.per_line_daily_cap) {
                results.skipped.per_line_cap = (results.skipped.per_line_cap || 0) + 1;
                continue;
            }
            const last = lastSendByLine[line] || 0;
            if (last && (now.getTime() - last) < dripMs) {
                results.skipped.drip_interval = (results.skipped.drip_interval || 0) + 1;
                continue;
            }

            // Park a target that has already burned its attempt budget. Checked
            // before anything else costs money so a poisoned row cannot eat a
            // line slot on every tick forever.
            if ((t.attempt_count || 0) >= MAX_ATTEMPTS_PER_TARGET) {
                await sb.from('outbound_targets')
                    .update({
                        stage: 'failed',
                        last_error: 'attempts_exhausted: ' + t.attempt_count + ' send attempts, none delivered',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', t.id).eq('stage', t.stage);
                results.skipped.attempts_exhausted = (results.skipped.attempts_exhausted || 0) + 1;
                continue;
            }

            const nextStep = t.stage === 'queued' ? 1 : (t.step >= 3 ? null : t.step + 1);
            if (!nextStep) { results.skipped.sequence_complete = (results.skipped.sequence_complete || 0) + 1; continue; }
            const bodyText = t['step' + nextStep + '_body'];
            if (!bodyText) { results.skipped.no_body_generated = (results.skipped.no_body_generated || 0) + 1; continue; }

            const { data: lead } = await sb.from('leads')
                // client_id feeds preSendCheck's pool firewall. Omit it and the
                // undefined coerces to null, which passes every client lead
                // straight through a STILO campaign. Same failure shape as the
                // missing niche/category on 2026-08-11.
                .select('id,name,niche,category,client_id,stage,last_called_outcome,do_not_call,scrub_status,scrub_phone').eq('id', t.lead_id).maybeSingle();

            t.__is_team_number = teamSet.has(require('../openphone/_shared').normalizePhone(t.to_phone) || '');
            const check = ob.preSendCheck(campaign, t, lead);
            if (!check.ok) {
                results.skipped[check.reason] = (results.skipped[check.reason] || 0) + 1;
                if (['do_not_call', 'scrub_blocked'].includes(check.reason)) {
                    await sb.from('outbound_targets')
                        .update({ stage: 'blocked', last_error: check.reason, updated_at: new Date().toISOString() })
                        .eq('id', t.id);
                }
                continue;
            }

            if (dry) {
                results.sent++;
                usedLineThisTick.add(line);
                results.errors.push({ would_send: true, target: t.id, step: nextStep, from: line, to: t.to_phone, body: bodyText });
                continue;
            }

            // Mark the line consumed BEFORE evaluating the result. This used to
            // live in the success branch only, so a failed send left the line
            // unmarked, the loop advanced to the next target on the SAME line,
            // and one transient error cascaded through the entire queue: 540
            // attempts in 309 seconds, which is what triggered the provider's
            // rate limiter. One attempt per line per tick, pass or fail.
            usedLineThisTick.add(line);

            // Atomically CLAIM the target BEFORE the provider call. The
            // .eq('stage', ...) makes the update conditional on the stage we
            // read: if a concurrent invocation (overlapping cron, manual tick,
            // send_now) already moved this row, zero rows come back and we walk
            // away without sending. The old read-check-send-stamp flow left a
            // multi-second window in which two invocations could both pass the
            // check and both text the same person.
            const attemptNo = (t.attempt_count || 0) + 1;
            const { data: claimed, error: claimErr } = await sb.from('outbound_targets')
                .update({ stage: 'sending', attempt_count: attemptNo, updated_at: new Date().toISOString() })
                .eq('id', t.id).eq('stage', t.stage)
                .select('id');
            if (claimErr || !claimed || !claimed.length) {
                results.skipped.claim_lost = (results.skipped.claim_lost || 0) + 1;
                if (claimErr) results.errors.push({ target: t.id, error: 'claim_failed: ' + claimErr.message });
                continue;
            }
            attemptsThisTick++;

            const r = await sendSms(line, t.to_phone, bodyText, { leadId: t.lead_id });
            const ok = r && r.status >= 200 && r.status < 300;
            const patch = { updated_at: new Date().toISOString() };
            if (ok) {
                patch['step' + nextStep + '_sent_at'] = new Date().toISOString();
                patch.step = nextStep;
                patch.stage = 'sent';
                patch.last_error = null;
                results.sent++;
                totalSent++;
                perLine[line] = (perLine[line] || 0) + 1;
                lastSendByLine[line] = Date.now();
                consecutiveFailures = 0;
            } else {
                patch.last_error = (r && (r.err || r.skip)) || 'send_failed';
                if (r && r.blocked) {
                    patch.stage = 'blocked';
                } else if (attemptNo >= MAX_ATTEMPTS_PER_TARGET) {
                    patch.stage = 'failed';
                    patch.last_error = 'attempts_exhausted after ' + attemptNo + ' attempts; last error: ' + patch.last_error;
                } else {
                    // Back to the stage we claimed it from, so the next tick
                    // retries it. attempt_count already carries the attempt.
                    patch.stage = t.stage;
                }
                results.errors.push({ target: t.id, error: patch.last_error });
                consecutiveFailures++;
                failuresThisTick++;
            }

            // Log the send in prospecting.lead_messages AT SEND TIME (same shape
            // as send-meeting-reminders.js). Before this, campaign sends only
            // became visible when Quo's message webhook delivered them, which it
            // never has, so the per-human guard in _sms.js was blind to the very
            // messages it exists to cap. Logging is loud on failure but never
            // triggers a resend.
            if (ok) {
                const { error: logErr } = await sb.from('lead_messages').insert({
                    lead_id: t.lead_id, direction: 'outbound', channel: 'sms',
                    subject: 'Outbound campaign step ' + nextStep,
                    body: bodyText,
                    body_preview: bodyText.slice(0, 300),
                    to_address: t.to_phone, from_address: (r && r.from) || line,
                    provider: 'openphone', status: 'sent',
                    variant: 'outbound_campaign', sent_at: new Date().toISOString(),
                });
                if (logErr) {
                    results.errors.push({ target: t.id, error: 'lead_messages_log_failed: ' + logErr.message, sent: true });
                    console.error('[outbound] lead_messages log failed target=' + t.id + ': ' + logErr.message);
                }
            }

            // The outcome stamp is the one write this loop can never shrug off:
            // an unstamped row sits in stage='sending' with a message already
            // out the door. Retry once; if it still fails, STOP THE WHOLE RUN
            // rather than pile more sends on top of unknown DB state.
            let { error: stampErr } = await sb.from('outbound_targets').update(patch).eq('id', t.id);
            if (stampErr) {
                const second = await sb.from('outbound_targets').update(patch).eq('id', t.id);
                stampErr = second.error;
            }
            if (stampErr) {
                halted = 'stamp_failed on target ' + t.id + ' after retry: ' + stampErr.message
                    + '. The row is stuck in stage=sending and the send outcome (sent=' + ok + ') is NOT recorded.'
                    + ' Fix the row manually before the campaign resumes; the run was stopped to avoid sending on unknown state.';
                results.errors.push({ target: t.id, error: 'STAMP_FAILED_AFTER_RETRY: ' + stampErr.message, sent: ok });
                console.error('[outbound] HALT: ' + halted);
                break;
            }

            // Circuit breaker. If every line in turn is failing, the provider is
            // down, rate-limiting, or the credentials are wrong. Continuing
            // converts one outage into hundreds of failed calls and gets the
            // account throttled harder. Stop and let the next tick retry.
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                results.aborted = 'circuit_breaker_' + consecutiveFailures + '_consecutive_failures';
                console.error('[outbound] circuit breaker tripped on campaign ' + campaign.id);
                break;
            }
        }

        // Cross-tick campaign breaker. A tick that made >=2 real attempts and
        // landed none of them bumps consecutive_failed_ticks; enough of those in
        // a row means retrying every 5 minutes is just feeding an outage, so the
        // campaign pauses itself. Any successful send resets the streak.
        if (!dry) {
            if (results.sent > 0) {
                if (campaign.consecutive_failed_ticks) {
                    const { error: rErr } = await sb.from('outbound_campaigns')
                        .update({ consecutive_failed_ticks: 0 }).eq('id', campaign.id);
                    if (rErr) results.errors.push({ error: 'breaker_reset_failed: ' + rErr.message });
                }
            } else if (attemptsThisTick >= 2 && failuresThisTick === attemptsThisTick) {
                const streak = (campaign.consecutive_failed_ticks || 0) + 1;
                const cPatch = { consecutive_failed_ticks: streak };
                if (streak >= MAX_CONSECUTIVE_FAILED_TICKS) {
                    cPatch.status = 'paused';
                    results.paused_by_breaker = streak + ' consecutive all-failure ticks; campaign auto-paused.'
                        + ' Check last_error on its targets, fix the cause, then set status back to running.';
                    console.error('[outbound] BREAKER: paused campaign ' + campaign.id + ' after ' + streak + ' all-failure ticks');
                }
                const { error: bErr } = await sb.from('outbound_campaigns').update(cPatch).eq('id', campaign.id);
                if (bErr) results.errors.push({ error: 'breaker_update_failed: ' + bErr.message });
            }
        }

        report.push({
            campaign: campaign.id, name: campaign.name,
            sent: results.sent, skipped: results.skipped,
            errors: results.errors.slice(0, 10),
            aborted: results.aborted, paused_by_breaker: results.paused_by_breaker,
            sent_today: campaignSentToday + results.sent,
            per_line_today: perLine,
        });

        if (halted) break;
    }

    return res.status(halted ? 500 : 200).json({
        ok: !halted, dry: dry, send_enabled_env: ob.SEND_ENABLED,
        halted: halted || undefined,
        total_sent: dry ? 0 : totalSent, campaigns: report,
    });
};

// Must come AFTER the handler assignment: `module.exports = ...` replaces the
// exports object, so anything set on it earlier (like this) was silently
// discarded, and Vercel ran this function with the default 10s limit.
module.exports.maxDuration = 60;
