/**
 * POST /api/admin/deals/send-proposal-email
 *
 * Body: { deal_id, subject?, body? }
 *
 * Sends the proposal PDF + payment link to the prospect via Resend. Subject
 * + body default to a sensible template; admin can override.
 *
 * Requires RESEND_API_KEY in env. Falls back to logging the email content
 * to deal_events if Resend isn't configured (so nothing is silently lost).
 */
const { assertAdmin, readJsonBody, logEvent, methodNotAllowed } = require('./_shared');

async function sendViaResend({ to, subject, html, attachments, fromName }) {
    if (!process.env.RESEND_API_KEY) return { ok: false, reason: 'resend_not_configured' };
    const from = (fromName || 'STILO AI Partners') + ' <hello@stiloaipartners.com>';
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to, subject, html, attachments: attachments || [] })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json && json.message };
    return { ok: true, id: json.id };
}

function buildHtmlBody(deal) {
    const total = (deal.upfront_fee_cents || 0) + (deal.monthly_retainer_cents || 0);
    const f = c => '$' + (Number(c || 0) / 100).toLocaleString();
    return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a0f;max-width:560px;margin:0 auto;line-height:1.55;">
  <p>Hi ${deal.contact_name || ''},</p>
  <p>Great talking with you. As promised, attached is the proposal for ${deal.business_name}.</p>
  <p><strong>Quick recap:</strong></p>
  <ul>
    <li>Agents: ${(deal.agent_codes || []).join(', ').toUpperCase()}</li>
    <li>One-time setup: ${f(deal.upfront_fee_cents)}</li>
    <li>Monthly retainer: ${f(deal.monthly_retainer_cents)} / mo</li>
    <li>Due today: <strong>${f(total)}</strong></li>
  </ul>
  ${deal.proposal_pdf_url ? `<p><strong>Full proposal:</strong> <a href="${deal.proposal_pdf_url}" style="color:#2563EB;">View PDF</a></p>` : ''}
  ${deal.stripe_checkout_session_id || deal.stripe_invoice_id ? `<p style="margin:24px 0;"><a href="${deal.proposal_pdf_url ? '' : ''}" style="display:inline-block;padding:12px 22px;background:#2563EB;color:white;border-radius:8px;text-decoration:none;font-weight:600;">Complete payment</a></p>` : ''}
  <p>Reply to this email if anything needs to change before payment. Once we receive payment, we begin implementation within 7 business days.</p>
  <p>Thanks again,<br/>Remy<br/>STILO AI Partners</p>
</div>`.trim();
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    const body = await readJsonBody(req);
    const dealId = body.deal_id;
    if (!dealId) return res.status(400).json({ error: 'deal_id_required' });

    const { data: deal, error } = await gate.sb.from('deals').select('*').eq('id', dealId).maybeSingle();
    if (error || !deal) return res.status(404).json({ error: 'deal_not_found' });

    const subject = body.subject || `STILO AI Partners — Proposal for ${deal.business_name}`;
    const html = body.body || buildHtmlBody(deal);

    // Inline the PDF as attachment if available
    let attachments = [];
    if (deal.proposal_pdf_url) {
        try {
            const r = await fetch(deal.proposal_pdf_url);
            const buf = Buffer.from(await r.arrayBuffer());
            attachments.push({
                filename: (deal.business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '-proposal.pdf',
                content: buf.toString('base64')
            });
        } catch (e) {
            console.warn('[send-proposal] could not attach pdf:', e.message);
        }
    }

    const result = await sendViaResend({
        to: deal.contact_email,
        subject,
        html,
        attachments,
        fromName: 'STILO AI Partners'
    });

    await logEvent(gate.sb, dealId, 'email', {
        body: 'Proposal email ' + (result.ok ? 'sent' : 'failed: ' + (result.error || result.reason || 'unknown')) + ' to ' + deal.contact_email,
        attachments: deal.proposal_pdf_url ? [{ name: 'proposal.pdf', url: deal.proposal_pdf_url }] : [],
        actorUserId: gate.userId
    });

    if (!result.ok) return res.status(500).json({ error: 'send_failed', detail: result });
    return res.status(200).json({ ok: true, email_id: result.id });
};
