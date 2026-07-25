/**
 * POST /api/admin/deals/send-invoice-email
 *
 * The confirm-send step after Close Deal. The closer reviews an editable
 * email (short, personalized, no footer: Workspace signatures handle that),
 * sees the invoice PDF + payment link, can fix the client's email/phone/name,
 * then either:
 *
 *   action: "send"         send the email FROM THE LOGGED-IN ADMIN'S OWN
 *                          Workspace mailbox (per-user gmail grant, token row
 *                          'gmail:<their email>'), invoice PDF attached, and
 *                          optionally an SMS with the payment link from their
 *                          Quo line.
 *   action: "mark_manual"  the closer emailed it themselves by hand; just
 *                          record that on the deal timeline.
 *
 * If the admin has never connected their mailbox, returns 428 with
 * connect_start so the UI can show a "Connect Google" button
 * (/api/oauth?provider=gmail&action=start&personal=1&mode=json with their
 * Bearer token, then open the returned URL).
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');
const { gmailAccessToken } = require('../../prospects/_gmail_send');

let stripeClient = null;
function getStripe() {
    if (stripeClient) return stripeClient;
    if (!process.env.STRIPE_SECRET_KEY) return null;
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
    return stripeClient;
}

// Which Quo line each closer texts from. David's personal line left the Quo
// workspace 2026-07; he works the 754 line.
const SMS_LINE_BY_ADMIN = {
    'davidcoira@stiloaipartners.com': '+17547075311',
    'remyleon@stiloaipartners.com': '+17868376639'
};

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sanitizeHeader(v) {
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}
function encodeHeader(v) {
    const s = String(v == null ? '' : v);
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// multipart/mixed: plain-text body + PDF attachment. No footer on purpose:
// the sender's Workspace signature is appended by Google Admin rules.
function buildRawWithAttachment(opts) {
    const boundary = 'stilo_' + Date.now().toString(36);
    const head = [
        'From: ' + encodeHeader(opts.fromName) + ' <' + sanitizeHeader(opts.fromEmail) + '>',
        'To: ' + sanitizeHeader(opts.to),
        'Subject: ' + encodeHeader(sanitizeHeader(opts.subject)),
        'Reply-To: ' + sanitizeHeader(opts.fromEmail),
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="' + boundary + '"',
        '',
        '--' + boundary,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        String(opts.text || ''),
        ''
    ];
    for (const a of (opts.attachments || [])) {
        head.push('--' + boundary);
        head.push('Content-Type: ' + a.mime + '; name="' + a.filename + '"');
        head.push('Content-Disposition: attachment; filename="' + a.filename + '"');
        head.push('Content-Transfer-Encoding: base64');
        head.push('');
        head.push(a.contentBase64.replace(/(.{76})/g, '$1\r\n'));
        head.push('');
    }
    head.push('--' + boundary + '--');
    return b64url(Buffer.from(head.join('\r\n'), 'utf8'));
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const sb = gate.sb;
    const body = await readJsonBody(req);
    if (!body.deal_id) return res.status(400).json({ error: 'deal_id_required' });

    const { data: deal, error } = await sb.from('deals').select('*').eq('id', body.deal_id).maybeSingle();
    if (error || !deal) return res.status(404).json({ error: 'deal_not_found' });

    // The confirm screen lets the closer correct client contact info in place.
    const contactPatch = {};
    if (body.to && body.to !== deal.contact_email) contactPatch.contact_email = String(body.to).toLowerCase().slice(0, 200);
    if (body.name && body.name !== deal.contact_name) contactPatch.contact_name = String(body.name).slice(0, 200);
    if (body.phone && body.phone !== deal.contact_phone) contactPatch.contact_phone = String(body.phone).slice(0, 50);
    if (Object.keys(contactPatch).length) {
        contactPatch.updated_at = new Date().toISOString();
        await sb.from('deals').update(contactPatch).eq('id', deal.id);
    }

    if (body.action === 'mark_manual') {
        await sb.from('deals').update({ invoice_sent_at: new Date().toISOString() }).eq('id', deal.id);
        await logEvent(sb, deal.id, 'invoice_emailed', {
            body: 'Invoice email sent manually by ' + gate.email + ' (outside the system).',
            actorUserId: gate.userId
        });
        return res.status(200).json({ ok: true, marked_manual: true });
    }

    // action: send
    const to = String(body.to || deal.contact_email || '').trim();
    if (!to) return res.status(400).json({ error: 'no_recipient' });
    if (!body.subject || !body.body) return res.status(400).json({ error: 'subject_and_body_required' });

    // Per-user Gmail token for the logged-in admin.
    const senderEmail = String(gate.email || '').toLowerCase();
    const { data: tok } = await sb.from('oauth_tokens')
        .select('refresh_token').eq('provider', 'gmail:' + senderEmail).maybeSingle();
    if (!tok || !tok.refresh_token) {
        return res.status(428).json({
            error: 'gmail_not_connected',
            detail: 'Connect your Google Workspace mailbox once and every invoice email sends as you.',
            connect_start: '/api/oauth?provider=gmail&action=start&personal=1&mode=json'
        });
    }

    // Attach the deposit invoice PDF straight from Stripe.
    const attachments = [];
    let hostedUrl = null;
    const stripe = getStripe();
    if (stripe && deal.stripe_deposit_invoice_id) {
        try {
            const inv = await stripe.invoices.retrieve(deal.stripe_deposit_invoice_id);
            hostedUrl = inv.hosted_invoice_url;
            if (inv.invoice_pdf) {
                const pr = await fetch(inv.invoice_pdf);
                if (pr.ok) {
                    const buf = Buffer.from(await pr.arrayBuffer());
                    attachments.push({ filename: 'STILO-invoice.pdf', mime: 'application/pdf', contentBase64: buf.toString('base64') });
                }
            }
        } catch (e) {
            console.warn('[send-invoice-email] invoice pdf fetch failed:', e.message);
        }
    }

    const senderName = (gate.user && gate.user.user_metadata && gate.user.user_metadata.contact_name) || senderEmail.split('@')[0];
    let accessToken;
    try {
        accessToken = await gmailAccessToken(tok.refresh_token);
    } catch (e) {
        return res.status(428).json({
            error: 'gmail_token_dead',
            detail: e.message,
            connect_start: '/api/oauth?provider=gmail&action=start&personal=1&mode=json'
        });
    }

    const raw = buildRawWithAttachment({
        fromName: senderName, fromEmail: senderEmail,
        to: to, subject: body.subject, text: body.body,
        attachments: attachments
    });
    const gr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: raw })
    });
    const gj = await gr.json().catch(function () { return {}; });
    if (!gr.ok) {
        return res.status(502).json({ error: 'gmail_send_failed', status: gr.status, detail: JSON.stringify(gj).slice(0, 300) });
    }

    await sb.from('deals').update({ invoice_sent_at: new Date().toISOString() }).eq('id', deal.id);
    await logEvent(sb, deal.id, 'invoice_emailed', {
        body: 'Invoice email sent from ' + senderEmail + ' to ' + to + (attachments.length ? ' (PDF attached)' : ''),
        actorUserId: gate.userId
    });

    // Optional SMS with the payment link from the closer's Quo line.
    let smsResult = null;
    if (body.send_sms && body.sms_body) {
        const phone = String(body.phone || deal.contact_phone || '').trim();
        if (phone) {
            try {
                const { sendSms } = require('../../prospects/_sms');
                const fromLine = SMS_LINE_BY_ADMIN[senderEmail] || SMS_LINE_BY_ADMIN['remyleon@stiloaipartners.com'];
                smsResult = await sendSms(fromLine, phone, body.sms_body, { leadId: deal.source_lead_id || null });
                if (smsResult && !smsResult.err && !smsResult.skip) {
                    await logEvent(sb, deal.id, 'invoice_sms_sent', {
                        body: 'Payment-link SMS sent to ' + phone + ' from ' + fromLine,
                        actorUserId: gate.userId
                    });
                    if (deal.source_lead_id) {
                        try {
                            await sb.schema('prospecting').from('lead_messages').insert({
                                lead_id: deal.source_lead_id, direction: 'outbound', channel: 'sms',
                                subject: 'Invoice payment link', body: body.sms_body,
                                sent_at: new Date().toISOString(), sent_by: senderEmail,
                                to_address: phone, provider: 'openphone', status: 'sent'
                            });
                        } catch (_) { /* dashboard logging is best-effort */ }
                    }
                }
            } catch (e) {
                smsResult = { err: e.message };
            }
        } else {
            smsResult = { skip: 'no_phone' };
        }
    }

    return res.status(200).json({ ok: true, via: 'gmail:' + senderEmail, gmail_id: gj.id, hosted_invoice_url: hostedUrl, sms: smsResult });
};
