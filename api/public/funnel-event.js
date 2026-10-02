/**
 * POST /api/public/funnel-event
 *
 * Analytics beacon for the client VSL landing pages. Writes one row to
 * public.funnel_events per event. Open on purpose (an anonymous page has to be
 * able to call it) but clamped: site and event must be on their allowlists,
 * the body is size-capped, and a lead is attached ONLY when the signed token
 * verifies. See api/public/_funnel.js for the identity model.
 *
 * Body: { site, event, session_id, visitor_id, lid?, t?, step?, answer?, meta?,
 *         path?, referrer?, utm_source?, utm_medium?, utm_campaign?, lang? }
 *
 * Dual-write: page_view -> vsl_events 'view' and video_play -> vsl_events 'play'
 * (agent = site), so the existing Sales-tab VSL card and the 5-minute
 * vsl-watch-alerts cron ("a human just pressed play, call them") keep working
 * for these pages with no change.
 *
 * Alert: a quiz_complete from a KNOWN lead (token verified) who has not yet left
 * contact details emails Remy right away with the answers. That person is one
 * screen away from booking; a same-hour call beats waiting for the form.
 */
const F = require('./_funnel');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const body = await F.readJsonBody(req);
    if (body && body.error === 'body_too_large') return res.status(413).json({ error: 'body_too_large' });
    const site = F.SITES[String(body.site || '')];
    const event = String(body.event || '');
    if (!site) return res.status(400).json({ error: 'unknown_site' });
    if (F.EVENTS.indexOf(event) === -1) return res.status(400).json({ error: 'unknown_event' });
    if (!F.configured()) return res.status(200).json({ ok: true, stored: false });

    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const leadId = F.verifiedLeadId(body);
    const rawLid = F.intOrNull(body.lid);
    let meta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
    // Keep an unverified lid visible for debugging without ever trusting it.
    if (rawLid != null && leadId == null) meta = Object.assign({}, meta, { lid_unverified: rawLid });
    const metaStr = JSON.stringify(meta);
    if (metaStr.length > 2000) meta = { truncated: true };

    const row = {
        site: body.site, event: event,
        session_id: F.str(body.session_id, 64), visitor_id: F.str(body.visitor_id, 64),
        lead_id: leadId, lead_claimed: leadId != null,
        step: F.intOrNull(body.step), answer: F.str(body.answer, 80),
        meta: meta, path: F.str(body.path, 300), referrer: F.str(body.referrer, 500),
        utm_source: F.str(body.utm_source, 80), utm_medium: F.str(body.utm_medium, 80), utm_campaign: F.str(body.utm_campaign, 120),
        lang: F.str(body.lang, 8), ua: ua, ip_hash: F.ipHash(req),
    };

    try {
        const pub = F.sbPublic();
        await pub.from('funnel_events').insert(row);

        // Dual-write so the existing VSL tooling sees these pages.
        if (event === 'page_view' || event === 'video_play') {
            await pub.from('vsl_events').insert({
                event: event === 'page_view' ? 'view' : 'play', agent: site.agent, lead_id: leadId,
                path: row.path || ('/' + body.site), flow: leadId != null ? 'campaign' : 'organic', ua: ua,
            });
        }

        // Known lead finished the quiz but has not submitted contact yet.
        if (event === 'quiz_complete' && leadId != null && !F.botReason(ua)) {
            try {
                const pros = F.sbProspecting();
                const { data: lead } = await pros.from('leads').select('id,name,owner_name,owner_phone,phone,owner_email,address').eq('id', leadId).maybeSingle();
                const a = meta.answers || {};
                const lines = ['segment', 'interest', 'medical', 'timeline', 'path_pref']
                    .filter(function (k) { return a[k]; })
                    .map(function (k) { return '<li>' + F.esc(k.replace('_pref', '')) + ': <strong>' + F.esc(F.label(k, a[k])) + '</strong></li>'; }).join('');
                const phone = lead && (lead.owner_phone || lead.phone);
                await F.notify(
                    'Blason VSL: ' + ((lead && lead.name) || 'lead #' + leadId) + ' finished the quiz',
                    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
                    + '<p><strong>' + F.esc((lead && lead.name) || 'Lead #' + leadId) + '</strong> finished the machine quiz on the Blason page but has not left contact details yet.</p>'
                    + '<ul style="padding-left:18px">' + lines + '</ul>'
                    + '<p>' + (lead && lead.owner_name ? F.esc(lead.owner_name) + ' · ' : '') + (phone ? '<a href="tel:' + F.esc(phone) + '">' + F.esc(phone) + '</a>' : 'no phone on file') + (lead && lead.owner_email ? ' · ' + F.esc(lead.owner_email) : '') + '</p>'
                    + '<p style="color:#555">Do not mention the quiz or the video on the call. Open with the machine they picked as a question about their room.</p>'
                    + '<p><a href="https://admin.stiloaipartners.com/#prospecting?lead=' + leadId + '">Open lead #' + leadId + '</a></p></div>'
                );
            } catch (_) { /* alert is best-effort */ }
        }
    } catch (_) { /* analytics never breaks the page */ }

    return res.status(200).json({ ok: true, lead: leadId != null });
};
