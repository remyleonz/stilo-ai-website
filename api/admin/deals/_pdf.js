/**
 * api/admin/deals/_pdf.js
 *
 * Generates the proposal/contract PDF that gets emailed to the prospect
 * on Close Deal. Uses pdf-lib (pure JS, no headless browser required).
 * Stores the PDF in Supabase Storage and returns the public URL.
 *
 * Template v1 is intentionally simple — agency letterhead, deal summary
 * (agents + fees), short SOW boilerplate, payment link. Will iterate.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const BLUE = rgb(0.145, 0.388, 0.922);   // #2563EB
const BLACK = rgb(0.06, 0.06, 0.09);
const GREY = rgb(0.42, 0.42, 0.45);
const LIGHT = rgb(0.85, 0.85, 0.88);

const AGENT_DESCRIPTIONS = {
    echo:    { name: 'ECHO',    desc: 'AI Receptionist — 24/7 inbound call answering, booking, lead capture.' },
    ignite:  { name: 'IGNITE',  desc: 'Lead Response — instant text/email reply to every form fill, ad lead, or missed call.' },
    revive:  { name: 'REVIVE',  desc: 'Customer Reactivation — wins back dormant customers via personalized outreach.' },
    scout:   { name: 'SCOUT',   desc: 'Lead Generator — Google Maps scraping + scoring + cold outreach drafting.' },
    forge:   { name: 'FORGE',   desc: 'AI Website — high-converting modern site with built-in chat and booking.' },
    signal:  { name: 'SIGNAL',  desc: 'AI SEO / GEO — local visibility, schema, AI-search optimization.' },
    oracle:  { name: 'ORACLE',  desc: 'Growth Intelligence — weekly KPI brief + opportunity flagging.' },
    pitch:   { name: 'PITCH',   desc: 'AI Sales Coach — listens to call transcripts, ships scorecards + script rewrites.' },
    flux:    { name: 'FLUX',    desc: 'Custom Automations — workflow + integration buildout to your spec.' }
};

function formatMoney(cents) {
    const n = Number(cents || 0) / 100;
    return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

async function buildProposalPdf(deal, paymentLink) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);  // US Letter
    const { width, height } = page.getSize();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

    let y = height - 64;

    // Header
    page.drawText('STILO AI PARTNERS', {
        x: 56, y, size: 11, font: helvBold, color: BLUE
    });
    page.drawText('PROPOSAL & SERVICE AGREEMENT', {
        x: width - 56 - helv.widthOfTextAtSize('PROPOSAL & SERVICE AGREEMENT', 9),
        y, size: 9, font: helv, color: GREY
    });
    y -= 24;
    page.drawLine({
        start: { x: 56, y }, end: { x: width - 56, y },
        thickness: 0.5, color: LIGHT
    });
    y -= 40;

    // Title block
    page.drawText('Service Proposal for ' + deal.business_name, {
        x: 56, y, size: 22, font: helvBold, color: BLACK
    });
    y -= 24;
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    page.drawText('Date: ' + today + '   ·   Prepared for: ' + (deal.contact_name || deal.contact_email), {
        x: 56, y, size: 10, font: helv, color: GREY
    });
    y -= 36;

    // Intro paragraph
    page.drawText('Thank you for the conversation. This proposal outlines the AI agent', {
        x: 56, y, size: 11, font: helv, color: BLACK });
    y -= 14;
    page.drawText('implementation we discussed for ' + deal.business_name + '.', {
        x: 56, y, size: 11, font: helv, color: BLACK });
    y -= 26;

    // Agents section
    page.drawText('SCOPE OF WORK', { x: 56, y, size: 11, font: helvBold, color: BLUE });
    y -= 4;
    page.drawLine({ start: { x: 56, y }, end: { x: 156, y }, thickness: 1.5, color: BLUE });
    y -= 18;

    const codes = Array.isArray(deal.agent_codes) ? deal.agent_codes : [];
    for (const code of codes) {
        const meta = AGENT_DESCRIPTIONS[code] || { name: code.toUpperCase(), desc: code };
        page.drawText('•  ' + meta.name, { x: 56, y, size: 11, font: helvBold, color: BLACK });
        y -= 13;
        // simple word-wrap
        const desc = meta.desc;
        const maxWidth = width - 112;
        const words = desc.split(' ');
        let line = '';
        for (const w of words) {
            const test = line ? line + ' ' + w : w;
            if (helv.widthOfTextAtSize(test, 10) > maxWidth) {
                page.drawText(line, { x: 72, y, size: 10, font: helv, color: GREY });
                y -= 12;
                line = w;
            } else { line = test; }
        }
        if (line) {
            page.drawText(line, { x: 72, y, size: 10, font: helv, color: GREY });
            y -= 16;
        }
    }

    y -= 12;

    // Investment box
    page.drawText('INVESTMENT', { x: 56, y, size: 11, font: helvBold, color: BLUE });
    y -= 4;
    page.drawLine({ start: { x: 56, y }, end: { x: 156, y }, thickness: 1.5, color: BLUE });
    y -= 18;

    const boxTop = y;
    const boxHeight = 80;
    page.drawRectangle({
        x: 56, y: y - boxHeight, width: width - 112, height: boxHeight,
        borderColor: LIGHT, borderWidth: 0.5
    });

    page.drawText('One-time setup fee', { x: 72, y: y - 20, size: 11, font: helv, color: BLACK });
    page.drawText(formatMoney(deal.upfront_fee_cents), {
        x: width - 72 - helvBold.widthOfTextAtSize(formatMoney(deal.upfront_fee_cents), 11),
        y: y - 20, size: 11, font: helvBold, color: BLACK
    });

    page.drawText('Monthly retainer', { x: 72, y: y - 40, size: 11, font: helv, color: BLACK });
    page.drawText(formatMoney(deal.monthly_retainer_cents) + ' / mo', {
        x: width - 72 - helvBold.widthOfTextAtSize(formatMoney(deal.monthly_retainer_cents) + ' / mo', 11),
        y: y - 40, size: 11, font: helvBold, color: BLACK
    });

    page.drawLine({
        start: { x: 72, y: y - 56 }, end: { x: width - 72, y: y - 56 },
        thickness: 0.5, color: LIGHT
    });

    page.drawText('Due today (setup + first month)', { x: 72, y: y - 70, size: 11, font: helvBold, color: BLACK });
    const dueToday = (deal.upfront_fee_cents || 0) + (deal.monthly_retainer_cents || 0);
    page.drawText(formatMoney(dueToday), {
        x: width - 72 - helvBold.widthOfTextAtSize(formatMoney(dueToday), 11),
        y: y - 70, size: 11, font: helvBold, color: BLUE
    });

    y -= (boxHeight + 24);

    // Terms
    page.drawText('TERMS', { x: 56, y, size: 11, font: helvBold, color: BLUE });
    y -= 4;
    page.drawLine({ start: { x: 56, y }, end: { x: 156, y }, thickness: 1.5, color: BLUE });
    y -= 18;

    const terms = [
        'Month-to-month engagement. Cancel any time with 30 days notice.',
        'Implementation begins within 7 business days of payment.',
        'Monthly retainer covers ongoing optimization, monitoring, and support.',
        'Setup fee is non-refundable once implementation work begins.',
        'STILO AI Partners retains all code, configurations, and AI agent logic.',
        'You retain full ownership of your data, customer records, and outputs.'
    ];
    for (const t of terms) {
        const maxWidth = width - 112;
        const words = t.split(' ');
        let line = '•  ';
        for (const w of words) {
            const test = line + (line === '•  ' ? '' : ' ') + w;
            if (helv.widthOfTextAtSize(test, 10) > maxWidth) {
                page.drawText(line, { x: 56, y, size: 10, font: helv, color: BLACK });
                y -= 12;
                line = '    ' + w;
            } else { line = test; }
        }
        if (line.trim()) {
            page.drawText(line, { x: 56, y, size: 10, font: helv, color: BLACK });
            y -= 16;
        }
    }

    y -= 8;

    // Payment CTA
    page.drawText('NEXT STEP', { x: 56, y, size: 11, font: helvBold, color: BLUE });
    y -= 4;
    page.drawLine({ start: { x: 56, y }, end: { x: 156, y }, thickness: 1.5, color: BLUE });
    y -= 22;

    if (paymentLink) {
        page.drawText('To accept this proposal and begin implementation, complete payment at:', {
            x: 56, y, size: 11, font: helv, color: BLACK
        });
        y -= 18;
        page.drawText(paymentLink, {
            x: 56, y, size: 10, font: helvBold, color: BLUE
        });
        y -= 24;
    } else {
        page.drawText('Reply to this email or call us to confirm next steps.', {
            x: 56, y, size: 11, font: helv, color: BLACK
        });
        y -= 24;
    }

    // Footer
    page.drawLine({
        start: { x: 56, y: 56 }, end: { x: width - 56, y: 56 },
        thickness: 0.5, color: LIGHT
    });
    page.drawText('STILO AI Partners  ·  stiloaipartners.com  ·  Miami, FL', {
        x: 56, y: 40, size: 9, font: helv, color: GREY
    });
    page.drawText('Page 1 of 1', {
        x: width - 56 - helv.widthOfTextAtSize('Page 1 of 1', 9),
        y: 40, size: 9, font: helv, color: GREY
    });

    return await pdf.save();
}

/**
 * Stores PDF bytes in Supabase Storage bucket 'proposals' and returns
 * a public URL. Bucket must be public-read (or we use signed URLs).
 */
async function uploadProposal(sb, dealId, businessName, pdfBytes) {
    const safeName = (businessName || 'proposal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 60);
    const path = `${dealId}/${safeName}-${Date.now()}.pdf`;

    // Ensure bucket exists (idempotent)
    try {
        await sb.storage.createBucket('proposals', { public: true, fileSizeLimit: 10485760 });
    } catch (_) { /* already exists */ }

    const { error } = await sb.storage.from('proposals').upload(path, pdfBytes, {
        contentType: 'application/pdf',
        upsert: true
    });
    if (error) throw new Error('storage_upload_failed: ' + error.message);

    const { data: publicUrl } = sb.storage.from('proposals').getPublicUrl(path);
    return publicUrl.publicUrl;
}

module.exports = { buildProposalPdf, uploadProposal };
