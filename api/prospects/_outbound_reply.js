/**
 * api/prospects/_outbound_reply.js
 *
 * Handles an inbound SMS that belongs to an Outbound campaign target. Called
 * from openphone/webhook.js the moment a reply lands, because the whole point
 * of the campaign is speed to lead and a cron that runs every 5 minutes would
 * burn most of a 4-minute SLA before anyone knew there was a reply.
 *
 * Three things happen, in this order:
 *   1. STOP-word check. An opt-out is terminal: the target goes to 'opted_out'
 *      AND the lead is flagged do_not_call, so it drops out of every dialing
 *      surface too, not just this campaign. Opting out of a text and then
 *      getting a cold call is the complaint that ends an account.
 *   2. Otherwise the target moves to 'replied' and the callback clock starts.
 *   3. An email fires to the assigned rep and to the owner inbox.
 *
 * The alert is idempotent via reply_alert_sent_at, so a webhook redelivery (Quo
 * retries on any non-2xx) cannot spam the same alert repeatedly.
 */

const { createClient } = require('@supabase/supabase-js');

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'remove', 'optout', 'opt out'];

function isStop(text) {
    const t = String(text || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
    if (!t) return false;
    // Only treat a SHORT message as an opt-out. "stop by tomorrow and take a
    // look" is interest, not an unsubscribe, and auto-DNCing it would delete a
    // live lead.
    if (t.split(/\s+/).length > 3) return false;
    return STOP_WORDS.some(w => t === w || t.startsWith(w + ' '));
}

/**
 * Negative-intent routing for replies of ANY length. isStop above only catches
 * short bare keywords, so "please stop texting me, wrong number" fell through
 * to stage='replied', and 'replied' is what unlocks the step-2 pitch. Pitching
 * someone who just said stop is the exact complaint that ends an account.
 *
 * Returns:
 *   'opt_out' -> do_not_call + stage='opted_out' (stop/unsubscribe/remove/
 *                quit/cancel/don't-text variants, leave me alone)
 *   'dead'    -> stage='dead' (wrong number, not interested); no DNC flag,
 *                they didn't ask us to never contact them, just not to pitch
 *   'replied' -> everything else, the normal callback path
 */
/**
 * An explicit request to be taken off the list. This outranks everything except
 * an autoresponder, and it is evaluated across the WHOLE message rather than by
 * whichever pattern happens to appear first.
 *
 * That ordering is the bug this replaced. Boss Bay Beauty answered the Blason
 * opener with "Not interested. Take this number off your list". The old
 * classifier matched NEGATIVE_RE, found "not interested" first because it comes
 * first in the sentence, and returned 'dead' - which carries no DNC flag, so a
 * person who had just asked in writing to be removed stayed live in the dial
 * pool. This file's own header names that exact outcome as the complaint that
 * ends an account: opting out of a text and then getting a cold call.
 *
 * "take this number off your list" was also not in the pattern set at all; only
 * "remove me" was.
 */
const OPT_OUT_RE = new RegExp([
    "\\bstop\\b", "\\bunsubscribe\\b", "\\bquit\\b", "\\bcancel\\b",
    "remove (?:me|us|this|my)", "take (?:me|us|this number|my number|it) off",
    "off (?:your|the|this) (?:list|mailing)", "delete (?:me|my number|this number)",
    "don'?t (?:text|message|contact|call)", "do not (?:text|message|contact|call)",
    "no (?:more|further) (?:texts?|messages?)", "leave me alone", "lose my number",
    "no me escriba", "deje de escribir", "b[o\u00f3]rreme", "elim[i\u00ed]neme",
    "s[a\u00e1]queme de (?:la|su) lista", "qu[i\u00ed]teme de (?:la|su) lista",
    "no me (?:llame|contacte)",
].join('|'), 'i');

// Not an opt-out and not a polite decline: a flat statement that this is the
// wrong person or the wrong fit. Same destination as DECLINE_RE.
const DEAD_RE = /\b(?:wrong number|not interested|no estoy interesad|n[u\u00fa]mero equivocado)\b/i;

/**
 * The polite decline. Routes to 'dead', never to opt_out: these people did not
 * ask us to stop contacting them, they said no to this offer.
 *
 * Added 2026-08-28 after the first reply the Blason campaign ever received.
 * Tre Medspa answered "No thank you" two minutes after the text, which matched
 * nothing in NEGATIVE_RE, so it landed at stage='replied'. That is the stage
 * that unlocks the step-2 pitch AND it started a five-minute callback SLA, so
 * the system's considered response to a polite no was to alert a rep to phone
 * them about it. This file already learned this exact lesson once, for
 * "please stop texting me, wrong number"; "no thanks" is simply the most common
 * way a person declines and it was not on the list.
 *
 * Spanish is here from the start rather than after the first miss: 9 of the
 * campaign's targets are Spanish-speaking and will decline in Spanish.
 *
 * Deliberately excluded as too ambiguous: "we're good", "all set", "pass".
 * "all set for tuesday" is a confirmation, and reading it as a decline would
 * bury a booked meeting.
 */
const DECLINE_RE = new RegExp([
    "no,?\\s*thank\\s*you", "no,?\\s*thanks", "no\\s*thx",
    "not\\s+(?:looking|interested)", "no\\s+need", "we'?re\\s+not\\s+looking",
    "not\\s+(?:right\\s+now|at\\s+this\\s+time|at\\s+the\\s+moment)",
    "no,?\\s*gracias", "no\\s+me\\s+interesa", "no\\s+estamos?\\s+interesad",
    "no\\s+por\\s+ahora", "por\\s+ahora\\s+no", "ahora\\s+no",
].join('|'), 'i');
// "stop by tomorrow", "stop in when you can", "quit early Friday": friendly uses
// where the next word makes it plainly not an opt-out. Narrow and deliberate; if
// a phrase is ambiguous it stays an opt-out, because a false opt-out costs one
// lead and a missed one costs the account.
const FRIENDLY_STOP_RE = /\b(?:stop|quit)\s+(by|in|over|back|through|at|on)\b/i;
/**
 * A machine answered, not a person.
 *
 * These businesses run AI receptionists and auto-responders on the same number
 * we text. Hello Sugar replied to the Blason opener in under a second with
 * "Please give me a moment and I will connect you with an agent to assist you."
 * That is not a reply, but the classifier had no way to say so, so the target
 * went to stage='replied' (which unlocks the step-2 pitch), started a
 * five-minute callback SLA, and emailed Alejandro to phone a bot. The same
 * businesses do it on the voice side too: the Hello Sugar call transcript opens
 * "This is Sky from Hello Sugar Orlando, how can I help you today?"
 *
 * Routed to 'auto': the body is recorded, the target stays at its current stage
 * so no pitch is unlocked, no SLA starts and no rep is alerted. The lead is NOT
 * dead. A human may well read the thread later, and the rep can still call.
 *
 * False positives here are cheap (we skip one alert) and false negatives are
 * the status quo, so this leans inclusive.
 */
const AUTORESPONDER_RE = new RegExp([
    "connect you (?:with|to) (?:an?|our) (?:agent|team|representative|specialist)",
    "(?:just )?missed your call", "we'?ll get (?:right )?back to you",
    "will get (?:right )?back to you", "get back to you (?:as soon as|shortly|asap)",
    "this is an automated", "automated (?:reply|response|message)",
    "do not reply to this", "please do not reply",
    "out of (?:the )?office", "currently (?:closed|unavailable)",
    "our (?:business |office )?hours are", "for (?:a )?faster (?:response|service)",
    "thank you for (?:contacting|reaching out|your message)",
    "please hold", "one moment please", "give me a moment",
    "reply stop to unsubscribe",
    "gracias por (?:contactarnos|su mensaje|comunicarse)",
    "le responderemos", "en breve le", "fuera de (?:la )?oficina",
].join('|'), 'i');

/**
 * STRICTLY ORDERED BY SEVERITY, not by where a phrase sits in the sentence.
 * Every message is tested against every band. First-match-wins on a single
 * combined regex is what let "Not interested. Take this number off your list"
 * resolve as a mere decline.
 */
function classifyReply(text) {
    const s = String(text || '');
    // 1. A machine. Checked first because away-messages routinely carry a
    //    "Reply STOP to unsubscribe" footer, and routing that to opt_out would
    //    DNC a lead no human has ever answered for.
    if (AUTORESPONDER_RE.test(s)) return 'auto';

    // 2. An explicit removal request. Outranks any decline in the same message.
    if (OPT_OUT_RE.test(s)) {
        // The one forgiveness: a friendly "stop by tomorrow" / "quit early
        // Friday", and only when no other opt-out signal is present. If a
        // phrase is ambiguous it stays an opt-out, because a false opt-out
        // costs one lead and a missed one costs the account.
        const onlyStopish = !/(unsubscribe|remove (?:me|us|this|my)|take (?:me|us|this number|my number|it) off|off (?:your|the|this) (?:list|mailing)|delete (?:me|my number|this number)|don'?t (?:text|message|contact|call)|do not (?:text|message|contact|call)|leave me alone|lose my number|no me escriba|deje de escribir|b[o\u00f3]rreme|elim[i\u00ed]neme|s[a\u00e1]queme de|qu[i\u00ed]teme de|no me (?:llame|contacte))/i.test(s);
        if (onlyStopish && FRIENDLY_STOP_RE.test(s)) return 'replied';
        return 'opt_out';
    }

    // 3. A no, without a removal request. Lead stays callable elsewhere.
    if (DEAD_RE.test(s) || DECLINE_RE.test(s)) return 'dead';

    // 4. Everything else is a real person worth calling back.
    return 'replied';
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendAlert(opts) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    const fromName = process.env.STILO_SENDER_NAME || 'STILO Outbound';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const owner = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';
    // The inbox Remy actually watches on his phone. health-alerts.js has always
    // used this one, and reply alerts used only STILO_REPLY_TO, so a prospect
    // reply landed in a work inbox nobody was refreshing. A four-minute callback
    // SLA is worthless if the alert goes somewhere unread, so send to both.
    const alertInbox = process.env.HEALTH_ALERT_TO || 'remyleon11@gmail.com';

    const to = Array.from(new Set(
        [opts.repEmail, owner, alertInbox]
            .map(function (e) { return String(e || '').toLowerCase().trim(); })
            .filter(function (e) { return e && /.+@.+\..+/.test(e); })
    ));
    const adminUrl = 'https://stiloaipartners.com/admin/?lead=' + opts.leadId;
    const telLink = 'tel:' + String(opts.phone || '').replace(/[^\d+]/g, '');

    const html = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">',
        '<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;font-weight:700">Reply received</p>',
        '<h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">' + esc(opts.business || 'A lead') + ' just texted back</h1>',
        '<div style="background:#F3F4F6;border-left:3px solid #2563EB;padding:14px 16px;margin:0 0 20px;border-radius:4px">',
        '<p style="margin:0;font-size:16px;line-height:1.5;white-space:pre-wrap">' + esc(opts.replyBody) + '</p>',
        '</div>',
        '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">',
        '<tr><td style="padding:5px 0;color:#6B7280;width:120px">Phone</td><td style="padding:5px 0"><a href="' + telLink + '" style="color:#2563EB;text-decoration:none;font-weight:600">' + esc(opts.phone) + '</a></td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Owner</td><td style="padding:5px 0">' + esc(opts.ownerName || 'unknown') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Industry</td><td style="padding:5px 0">' + esc(opts.niche || '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Assigned to</td><td style="padding:5px 0">' + esc(opts.repName || opts.repEmail || '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">We sent</td><td style="padding:5px 0;color:#6B7280">' + esc(opts.lastSent || '') + '</td></tr>',
        '</table>',
        '<p style="margin:0 0 8px;font-size:15px;font-weight:600">Call them within ' + opts.slaMinutes + ' minutes.</p>',
        '<p style="margin:0 0 20px;font-size:14px;color:#6B7280">Callback due by ' + esc(opts.dueLocal) + '.</p>',
        '<a href="' + adminUrl + '" style="display:inline-block;background:#2563EB;color:#fff;padding:11px 20px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px">Open the lead</a>',
        '</div>',
    ].join('');

    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: to,
            reply_to: owner,
            subject: 'Reply: ' + (opts.business || 'lead') + ', call within ' + opts.slaMinutes + ' min',
            html: html,
        }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
}

/**
 * @param {string} fromPhone E.164 the reply came FROM (the prospect)
 * @param {string} toPhone   E.164 the reply came TO (our line)
 * @param {string} text      message body
 * @returns {object|null}    null when this reply isn't part of any campaign
 */
/**
 * Record the number in public.lcr_suppressions so every channel skips it, even
 * when we cannot match it to a lead. Select-then-insert, not upsert: the
 * uniqueness there is a PARTIAL index and Postgres cannot infer one from an
 * ON CONFLICT list (it raises 42P10). Best effort, never throws: a failure here
 * must not stop the lead-level opt-out from being written.
 */
async function suppressPhone(phone) {
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
        });
        const { data: existing } = await pub.from('lcr_suppressions')
            .select('id').eq('client_slug', 'prospecting').eq('phone', phone).limit(1);
        if (existing && existing.length) return;
        const { error } = await pub.from('lcr_suppressions').insert({
            client_slug: 'prospecting', phone: phone,
            source: 'sms_stop', opted_out_at: new Date().toISOString(),
        });
        if (error && error.code !== '23505') {
            console.error('[outbound] suppressPhone insert failed:', error.message);
        }
    } catch (e) {
        console.error('[outbound] suppressPhone threw:', e && e.message);
    }
}

async function handleInboundSms(fromPhone, toPhone, text) {
    if (!fromPhone) return null;
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });

    // Match on the number we texted, which is exact, rather than re-deriving the
    // lead from its phone columns. A lead can carry three different numbers and
    // the campaign knows precisely which one it used.
    const { data: targets, error } = await sb.from('outbound_targets')
        .select('*').eq('to_phone', fromPhone)
        .in('stage', ['sent', 'replied', 'queued'])
        .order('id', { ascending: false }).limit(1);

    // No campaign target does NOT mean we can ignore the message. Nurture texts,
    // meeting reminders and reply-to-a-rep all reach people who were never in a
    // campaign, and an opt-out from any of them is legally binding (audit
    // 2026-08-10: this path used to return null and drop the STOP on the floor).
    if (error || !targets || !targets.length) {
        if (classifyReply(text) !== 'opt_out' && !isStop(text)) return null;
        const digits = String(fromPhone).replace(/[^\d]/g, '').slice(-10);
        const { data: leads } = await sb.from('leads')
            .select('id')
            .or('owner_phone_e164.eq.' + fromPhone + ',phone.ilike.%' + digits + '%,owner_phone.ilike.%' + digits + '%')
            .limit(25);
        const ids = (leads || []).map(function (l) { return l.id; });
        if (ids.length) {
            await sb.from('leads').update({ do_not_call: true }).in('id', ids);
        }
        await suppressPhone(fromPhone);
        console.warn('[outbound] OPT-OUT with no campaign target, phone=' + fromPhone
            + ' leads=' + (ids.join(',') || 'none') + ' (suppressed regardless)');
        return { action: 'opted_out', lead_ids: ids, no_target: true };
    }
    const t = targets[0];

    const now = new Date();

    const intent = classifyReply(text);
    if (isStop(text) || intent === 'opt_out') {
        await sb.from('outbound_targets').update({
            stage: 'opted_out', first_reply_at: t.first_reply_at || now.toISOString(),
            first_reply_body: t.first_reply_body || text, updated_at: now.toISOString(),
        }).eq('id', t.id);
        // Terminal across the whole system, not just this campaign. Check the
        // error: a silently failed DNC write is the difference between honoring
        // an opt-out and texting someone who told us to stop.
        const { error: dncErr } = await sb.from('leads')
            .update({ do_not_call: true }).eq('id', t.lead_id);
        if (dncErr) console.error('[outbound] DNC WRITE FAILED lead=' + t.lead_id + ': ' + dncErr.message);
        await suppressPhone(fromPhone);
        console.warn('[outbound] OPT-OUT lead=' + t.lead_id + ' phone=' + fromPhone);
        return { action: 'opted_out', lead_id: t.lead_id };
    }

    // "wrong number" / "not interested": the sequence must end (a step-2 pitch
    // to either is indefensible) but nobody asked to be DNC'd, so the lead
    // stays callable elsewhere. No rep alert either: there is no 4-minute
    // callback race to win against someone who said no.
    if (intent === 'dead') {
        await sb.from('outbound_targets').update({
            stage: 'dead', first_reply_at: t.first_reply_at || now.toISOString(),
            first_reply_body: t.first_reply_body || String(text || '').slice(0, 1000),
            updated_at: now.toISOString(),
        }).eq('id', t.id);
        return { action: 'dead', lead_id: t.lead_id };
    }

    // A machine answered. Record it, change nothing else: the stage stays where
    // it is so the step-2 pitch is not unlocked, no callback SLA starts, and no
    // rep is alerted. Alerting on an away-message trains people to ignore the
    // alert that matters.
    if (intent === 'auto') {
        await sb.from('outbound_targets').update({
            first_reply_at: t.first_reply_at || now.toISOString(),
            first_reply_body: t.first_reply_body || String(text || '').slice(0, 1000),
            updated_at: now.toISOString(),
        }).eq('id', t.id);
        console.log('[outbound] autoresponder lead=' + t.lead_id + ' target=' + t.id);
        return { action: 'auto', lead_id: t.lead_id };
    }

    const { data: campaign } = await sb.from('outbound_campaigns')
        .select('id,name,callback_sla_minutes,timezone').eq('id', t.campaign_id).maybeSingle();
    const sla = (campaign && campaign.callback_sla_minutes) || 4;
    const due = new Date(now.getTime() + sla * 60 * 1000);

    const isFirstReply = !t.first_reply_at;
    const patch = {
        stage: 'replied',
        updated_at: now.toISOString(),
    };
    if (isFirstReply) {
        patch.first_reply_at = now.toISOString();
        patch.first_reply_body = String(text || '').slice(0, 1000);
        patch.callback_due_at = due.toISOString();
    }
    await sb.from('outbound_targets').update(patch).eq('id', t.id);

    // ALERT ON EVERY REPLY, not once per target.
    //
    // This used to bail out whenever reply_alert_sent_at was already set, on the
    // theory that a second message before anyone called back is "the same lead,
    // not a new one." That theory is wrong the moment the conversation actually
    // starts, and it cost us a deal on 2026-08-12: Neville Walters (lead 17339)
    // replied "I don't understand your book sales" at 1:37pm, which alerted.
    // Marcus texted back, and then Neville sent "Yes call me tomorrow morning at
    // 9am" at 7:29pm. That message raised no email, nobody called at 9am, and
    // two days later he was still texting and re-opening the VSL. His most
    // valuable message was the one the idempotency gate threw away.
    //
    // Redelivery protection now lives where it belongs: a unique index on
    // lead_messages.provider_message_id, so the webhook only reaches this
    // function for a genuinely new message. Every new inbound message from a
    // live prospect is worth an email.
    const { data: lead } = await sb.from('leads')
        .select('id,name,owner_name,niche,category').eq('id', t.lead_id).maybeSingle();

    let repName = t.assigned_to;
    try {
        const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
        const { data: rep } = await pub.from('sdr_users').select('display_name').eq('email', t.assigned_to).maybeSingle();
        if (rep && rep.display_name) repName = rep.display_name;
    } catch (_) { /* cosmetic only */ }

    const dueLocal = new Intl.DateTimeFormat('en-US', {
        timeZone: (campaign && campaign.timezone) || 'America/New_York',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(due);

    const lastSent = t.step3_sent_at ? t.step3_body : (t.step2_sent_at ? t.step2_body : t.step1_body);

    let alert = { skipped: 'not_attempted' };
    try {
        alert = await sendAlert({
            repEmail: t.assigned_to,
            repName: repName,
            leadId: t.lead_id,
            business: lead && lead.name,
            ownerName: lead && lead.owner_name,
            niche: lead && (lead.niche || lead.category),
            phone: fromPhone,
            replyBody: text,
            lastSent: lastSent,
            slaMinutes: sla,
            dueLocal: dueLocal,
        });
    } catch (e) {
        console.error('[outbound] reply alert failed lead=' + t.lead_id + ': ' + (e && e.message));
    }

    if (alert && !alert.error && alert.status && alert.status < 300) {
        await sb.from('outbound_targets').update({ reply_alert_sent_at: now.toISOString() }).eq('id', t.id);
    }

    return { action: 'replied', lead_id: t.lead_id, alerted: !!(alert && alert.id), callback_due_at: due.toISOString() };
}

module.exports = { handleInboundSms, isStop, classifyReply };
