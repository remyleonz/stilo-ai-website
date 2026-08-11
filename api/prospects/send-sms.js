/**
 * POST /api/prospects/send-sms
 * Body: { lead_id, target_id?, body }
 *
 * A human answering, by hand, someone who texted us. This is deliberately NOT
 * the campaign sender, and the differences are the whole point:
 *
 *   - The campaign SEND WINDOW does not apply. If a prospect texts at 8pm, the
 *     answer goes back at 8pm. The window exists so a cold drip never wakes a
 *     stranger up; it has nothing to say about a conversation already running.
 *   - The DAILY and PER-LINE CAPS do not apply. Those pace cold volume against
 *     what a carrier tolerates. A 1-to-1 reply to an inbound message is not
 *     volume, and burning a cap slot on it would starve the drip for no reason.
 *   - OUTBOUND_SEND_ENABLED does not apply. That lock stops the drip from
 *     firing on its own. It was never meant to stop Remy from answering a
 *     message already sitting in front of him, and gating on it here would mean
 *     the board can show a reply nobody is allowed to answer.
 *
 * What DOES still apply, every time, no override: leads.do_not_call, the
 * public.lcr_suppressions opt-out list, and a target that is opted_out or dead.
 * Those are consent, not pacing, and consent has no "but the prospect is
 * waiting" exception.
 *
 * The provider call itself is _sms.js sendSms, the same helper the nurture and
 * meeting-reminder crons use. That helper also carries the per-lead runaway
 * guard (identical body inside 24h, or more than 5 messages to one lead in
 * 24h), so a stuck send button cannot turn into the 40-text loop of 2026-07-20.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { sendSms, REMY_LINE } = require('./_sms');
const { normalizePhone } = require('../openphone/_shared');
const ob = require('./_outbound');

const ADMINS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

// Carriers split anything longer, and a split reply reads as two half thoughts
// on the prospect's phone. Same ceiling the campaign body editor enforces.
const MAX_BODY = 320;

function last10(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
}

/**
 * Every reason we would refuse to text this person, checked in the order a
 * human would care about. Shared with conversation.js so the compose box can
 * grey itself out with the real reason instead of letting someone type a reply
 * that the server was always going to reject.
 *
 * Returns { ok } or { ok:false, reason, message } where message is written for
 * the person reading the screen, not for a log.
 */
async function checkCompliance(pub, lead, target, toPhone) {
    if (!toPhone) {
        return { ok: false, reason: 'no_phone', message: 'No mobile number on file for this lead.' };
    }
    if (lead && lead.do_not_call) {
        return { ok: false, reason: 'do_not_call', message: 'This lead is marked do not call. Nothing goes out from here.' };
    }
    if (target && target.stage === 'opted_out') {
        return { ok: false, reason: 'stage_opted_out', message: 'They opted out of this campaign. Nothing goes out from here.' };
    }
    if (target && target.stage === 'dead') {
        return { ok: false, reason: 'stage_dead', message: 'This card is marked dead. Move it back to the board before texting.' };
    }

    // Opt-outs land in public.lcr_suppressions in whatever shape the source
    // gave us, so match on all three plausible spellings of the same number
    // rather than trusting one format.
    const d10 = last10(toPhone);
    if (d10.length === 10) {
        const variants = ['+1' + d10, '1' + d10, d10, normalizePhone(toPhone)]
            .filter(Boolean)
            .filter(function (v, i, a) { return a.indexOf(v) === i; });
        try {
            const { data, error } = await pub.from('lcr_suppressions')
                .select('phone,source,opted_out_at')
                .in('phone', variants)
                .limit(1);
            // A read failure is not a clean list. Refuse rather than guess:
            // sending to someone who opted out is the expensive mistake here.
            if (error) {
                return { ok: false, reason: 'suppression_check_failed', message: 'Could not read the opt-out list, so nothing was sent. Try again in a moment.' };
            }
            if (data && data.length) {
                return { ok: false, reason: 'suppressed', message: 'This number is on the opt-out list. Nothing goes out from here.' };
            }
        } catch (e) {
            return { ok: false, reason: 'suppression_check_failed', message: 'Could not read the opt-out list, so nothing was sent. Try again in a moment.' };
        }
    }
    return { ok: true };
}

/**
 * Which line the text goes out from, in priority order:
 *   1. The target's from_line. The prospect already has a thread with it, and
 *      answering from a different number reads as a second stranger.
 *   2. The assigned rep's own Quo line from public.sdr_users.
 *   3. The owner line. Never a random line, and never nothing.
 */
async function resolveFromLine(pub, target, assignedTo) {
    if (target && target.from_line) return { from: target.from_line, source: 'target' };
    const email = String(assignedTo || '').toLowerCase();
    if (email) {
        try {
            const { data } = await pub.from('sdr_users')
                .select('openphone_number').eq('email', email).maybeSingle();
            if (data && data.openphone_number) return { from: data.openphone_number, source: 'rep' };
        } catch (_) { /* fall through to the owner line */ }
    }
    return { from: REMY_LINE, source: 'owner' };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.lead_id);
    const targetId = safeNumberId(body.target_id);
    const text = String(body.body || '').trim();

    if (leadId == null) return res.status(400).json({ error: 'lead_id_required' });
    if (!text) return res.status(400).json({ error: 'body_required', detail: 'Type something first.' });
    if (text.length > MAX_BODY) {
        return res.status(400).json({ error: 'body_too_long', detail: 'Keep it under ' + MAX_BODY + ' characters or the carrier splits it into two texts.' });
    }

    const sb = ob.serviceClient();
    const pub = ob.publicClient();

    const { data: lead, error: leadErr } = await sb.from('leads')
        .select('id,name,owner_name,do_not_call,owner_phone,phone')
        .eq('id', leadId).maybeSingle();
    if (leadErr) return res.status(500).json({ error: 'lead_read_failed', detail: leadErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    let target = null;
    if (targetId != null) {
        const { data } = await sb.from('outbound_targets').select('*').eq('id', targetId).maybeSingle();
        target = data || null;
        if (target && target.lead_id !== leadId) {
            return res.status(400).json({ error: 'target_lead_mismatch' });
        }
    }
    if (!target) {
        const { data } = await sb.from('outbound_targets').select('*')
            .eq('lead_id', leadId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        target = data || null;
    }

    // Same scoping rule as the board: an SDR only touches their own rows.
    const isAdmin = ADMINS.indexOf(String(gate.email || '').toLowerCase()) >= 0 || gate.isAdmin;
    if (!isAdmin && target && target.assigned_to && target.assigned_to !== gate.email) {
        return res.status(403).json({ error: 'not_your_lead' });
    }

    const toPhone = (target && target.to_phone) || lead.owner_phone || lead.phone || null;
    const check = await checkCompliance(pub, lead, target, toPhone);
    if (!check.ok) {
        return res.status(409).json({ error: 'blocked', reason: check.reason, detail: check.message });
    }

    const line = await resolveFromLine(pub, target, (target && target.assigned_to) || gate.email);

    const r = await sendSms(line.from, toPhone, text, { leadId: leadId });
    const ok = r && r.status >= 200 && r.status < 300;
    if (!ok) {
        // The runaway guard returns a skip rather than an HTTP status. Say which
        // it was, because "duplicate" and "the provider is down" want different
        // reactions from the person standing there.
        if (r && r.blocked) {
            return res.status(409).json({ error: 'blocked', reason: r.skip, detail: r.skip === 'rate_cap_24h' ? 'Too many messages to this lead in the last 24 hours. Call them instead.' : 'That exact message already went to this lead in the last 24 hours.' });
        }
        return res.status(502).json({ error: 'send_failed', detail: (r && (r.err || r.skip)) || null });
    }

    const sentAt = new Date().toISOString();
    // Log at send time, not from the Quo webhook. The per-human guard in
    // _sms.js reads this table, and a message the guard cannot see is a message
    // it cannot count.
    const row = {
        lead_id: leadId,
        direction: 'outbound',
        channel: 'sms',
        subject: 'Manual reply',
        body: text,
        body_preview: text.slice(0, 300),
        to_address: toPhone,
        from_address: (r && r.from) || line.from,
        provider: 'openphone',
        // sendSms returns status/from/fellBack, not the provider payload, and
        // _sms.js is off limits here. So the id stays null on our row and the
        // Quo webhook fills it in when the delivery event lands, which is the
        // same shape every other at-send-time log in this codebase has.
        provider_message_id: (r && r.messageId) || null,
        status: 'sent',
        sent_by: gate.email,
        variant: 'manual_reply',
        sent_at: sentAt,
    };
    const { data: logged, error: logErr } = await sb.from('lead_messages').insert(row).select().maybeSingle();
    if (logErr) console.error('[send-sms] lead_messages log failed lead=' + leadId + ': ' + logErr.message);

    return res.status(200).json({
        ok: true,
        sent_at: sentAt,
        from: (r && r.from) || line.from,
        from_source: line.source,
        to: toPhone,
        fell_back: !!(r && r.fellBack),
        logged: !logErr,
        message: logged || row,
    });
};

module.exports.checkCompliance = checkCompliance;
module.exports.resolveFromLine = resolveFromLine;
module.exports.MAX_BODY = MAX_BODY;
