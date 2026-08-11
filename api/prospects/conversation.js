/**
 * GET /api/prospects/conversation?lead_id=N[&target_id=M]
 *
 * The whole relationship with one lead, oldest first, as a single thread the
 * Outbound tab renders like a messages app.
 *
 * Two sources, merged on purpose:
 *
 *   1. prospecting.lead_messages. Every email in the drip, every nurture and
 *      meeting-reminder text, every manual reply sent from this panel.
 *   2. The outbound_targets row itself. The campaign tick stamps stepN_sent_at
 *      on the target but does not always write a lead_messages row for it, and
 *      the reply capture stores the prospect's answer in first_reply_body, not
 *      in lead_messages, when the inbound number never matched a lead. Reading
 *      only lead_messages would show a thread with the campaign's own texts
 *      missing, which is worse than no thread at all.
 *
 * Merged entries are deduped against lead_messages by body plus a five-minute
 * window, so a step that WAS logged does not appear twice.
 *
 * Email is included, not filtered out. Anyone answering a text needs to know we
 * already emailed this person four times; hiding it makes for a confident reply
 * that contradicts what is already in their inbox. Every entry carries its own
 * channel label so the two never read as one stream.
 *
 * SDRs see only their own targets, the same rule the board uses.
 */
const { assertAdminOrSdr, methodNotAllowed, safeNumberId } = require('./_shared');
const { checkCompliance } = require('./send-sms');
const ob = require('./_outbound');

const ADMINS = ['remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function ts(v) { return v ? new Date(v).getTime() : null; }
function head(s) { return String(s || '').trim().slice(0, 120).toLowerCase(); }

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    const leadId = safeNumberId(q.lead_id);
    const targetId = safeNumberId(q.target_id);
    if (leadId == null) return res.status(400).json({ error: 'lead_id_required' });

    const sb = ob.serviceClient();
    const pub = ob.publicClient();

    const { data: lead, error: leadErr } = await sb.from('leads')
        .select('id,name,owner_name,niche,category,address,website,owner_phone,phone,owner_email,email,do_not_call,stage,pitch_agent,call_attempts,last_called_at,last_called_outcome')
        .eq('id', leadId).maybeSingle();
    if (leadErr) return res.status(500).json({ error: 'lead_read_failed', detail: leadErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    let target = null;
    if (targetId != null) {
        const { data } = await sb.from('outbound_targets').select('*').eq('id', targetId).maybeSingle();
        if (data && data.lead_id === leadId) target = data;
    }
    if (!target) {
        const { data } = await sb.from('outbound_targets').select('*')
            .eq('lead_id', leadId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        target = data || null;
    }

    const isAdmin = ADMINS.indexOf(String(gate.email || '').toLowerCase()) >= 0 || gate.isAdmin;
    if (!isAdmin && target && target.assigned_to && target.assigned_to !== gate.email) {
        return res.status(403).json({ error: 'not_your_lead' });
    }

    const { data: rows, error: msgErr } = await sb.from('lead_messages')
        .select('id,direction,channel,subject,body,body_preview,sent_at,sent_by,to_address,from_address,provider,status,variant,opened_at,replied_at,bounced_at')
        .eq('lead_id', leadId)
        .order('sent_at', { ascending: true })
        .limit(400);
    if (msgErr) return res.status(500).json({ error: 'messages_read_failed', detail: msgErr.message });

    const messages = (rows || []).map(function (m) {
        return {
            key: 'm' + m.id,
            direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
            channel: m.channel || 'sms',
            subject: m.subject || null,
            body: m.body || m.body_preview || '',
            at: m.sent_at,
            by: m.sent_by || null,
            from: m.from_address || null,
            to: m.to_address || null,
            status: m.status || null,
            source: 'lead_messages',
        };
    });

    // Anything already in lead_messages within five minutes of the same text.
    function alreadyLogged(bodyText, at) {
        const h = head(bodyText);
        const t = ts(at);
        if (!h) return true;
        return messages.some(function (m) {
            if (head(m.body) !== h) return false;
            const mt = ts(m.at);
            if (t == null || mt == null) return true;
            return Math.abs(mt - t) <= DEDUPE_WINDOW_MS;
        });
    }

    if (target) {
        for (const step of [1, 2, 3]) {
            const at = target['step' + step + '_sent_at'];
            const text = target['step' + step + '_body'];
            if (!at || !text) continue;
            if (alreadyLogged(text, at)) continue;
            messages.push({
                key: 't' + target.id + 's' + step,
                direction: 'outbound',
                channel: 'sms',
                subject: 'Campaign step ' + step,
                body: text,
                at: at,
                by: target.assigned_to || null,
                from: target.from_line || null,
                to: target.to_phone || null,
                status: 'sent',
                source: 'campaign_step',
            });
        }
        if (target.first_reply_at && target.first_reply_body
            && !alreadyLogged(target.first_reply_body, target.first_reply_at)) {
            messages.push({
                key: 't' + target.id + 'r',
                direction: 'inbound',
                channel: 'sms',
                subject: null,
                body: target.first_reply_body,
                at: target.first_reply_at,
                by: null,
                from: target.to_phone || null,
                to: target.from_line || null,
                status: 'received',
                source: 'campaign_reply',
            });
        }
    }

    // Oldest at top. Anything with no timestamp sorts to the end rather than
    // silently claiming 1970.
    messages.sort(function (a, b) {
        const at = ts(a.at), bt = ts(b.at);
        if (at == null) return 1;
        if (bt == null) return -1;
        return at - bt;
    });

    // The rep on the card, resolved to a human name and their own line.
    let rep = null;
    const repEmail = (target && target.assigned_to) || null;
    if (repEmail) {
        rep = { email: repEmail, name: repEmail.split('@')[0], openphone_number: null };
        try {
            const { data } = await pub.from('sdr_users')
                .select('display_name,openphone_number')
                .eq('email', repEmail).maybeSingle();
            if (data) {
                if (data.display_name) rep.name = data.display_name;
                rep.openphone_number = data.openphone_number || null;
            }
        } catch (_) { /* the email alone is still useful */ }
    }

    const toPhone = (target && target.to_phone) || lead.owner_phone || lead.phone || null;
    const compliance = await checkCompliance(pub, lead, target, toPhone);

    return res.status(200).json({
        ok: true,
        lead: {
            id: lead.id,
            business: lead.name || null,
            owner_name: lead.owner_name || null,
            niche: lead.niche || lead.category || null,
            phone: toPhone,
            email: lead.owner_email || lead.email || null,
            do_not_call: !!lead.do_not_call,
            lifecycle_stage: lead.stage || null,
            pitch_agent: lead.pitch_agent || null,
            call_attempts: lead.call_attempts || 0,
            last_called_at: lead.last_called_at || null,
        },
        target: target ? {
            id: target.id,
            campaign_id: target.campaign_id,
            stage: target.stage,
            step: target.step,
            assigned_to: target.assigned_to,
            from_line: target.from_line,
            to_phone: target.to_phone,
            first_reply_at: target.first_reply_at,
            callback_due_at: target.callback_due_at,
            called_back_at: target.called_back_at,
            called_back_by: target.called_back_by,
        } : null,
        rep: rep,
        messages: messages,
        can_send: !!compliance.ok,
        block_reason: compliance.ok ? null : compliance.reason,
        block_message: compliance.ok ? null : compliance.message,
        server_time: new Date().toISOString(),
    });
};
