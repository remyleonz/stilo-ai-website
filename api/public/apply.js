/**
 * POST /api/public/apply
 *
 * The application form on the hiring VSL page (/careers). Writes one row to
 * public.sdr_applications and emails Remy so the callback happens the same
 * hour. Nothing here touches the lead tables: a candidate is not a prospect.
 *
 * Body: { site:'careers', session_id, visitor_id, name, phone, email?, instagram?,
 *         location, hours, experience, why?, lang?, utm_source?, utm_medium?,
 *         utm_campaign?, referrer? }
 *
 * Same phone twice in one day is treated as a resubmit (200, not a new row), so
 * a double tap on a slow connection never pages Remy twice.
 */
const F = require('./_funnel');

const RL_PER_IP_PER_HOUR = 5;
const _rl = { ipHits: new Map() };
function rateLimited(req) {
    const now = Date.now();
    const ip = F.ipOf(req) || 'unknown';
    const hits = (_rl.ipHits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
    if (hits.length >= RL_PER_IP_PER_HOUR) { _rl.ipHits.set(ip, hits); return true; }
    hits.push(now); _rl.ipHits.set(ip, hits);
    if (_rl.ipHits.size > 5000) _rl.ipHits.clear();
    return false;
}

const ALLOWED = {
    location: ['miami', 'florida', 'elsewhere'],
    hours: ['lt10', '10to20', '20plus'],
    experience: ['d2d', 'retail', 'restaurant', 'sports', 'none'],
};
const LABEL = {
    location: { miami: 'Miami / South Florida', florida: 'Elsewhere in Florida', elsewhere: 'Outside Florida' },
    hours: { lt10: 'Under 10 hours a week', '10to20': '10 to 20 hours a week', '20plus': '20+ hours a week' },
    experience: { d2d: 'Door to door / commission sales', retail: 'Retail or car lot', restaurant: 'Restaurant / hospitality', sports: 'College or competitive sports', none: 'None yet' },
};
function pick(group, v) {
    const s = F.str(v, 20);
    return s && ALLOWED[group].indexOf(s) !== -1 ? s : null;
}

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
    if (!F.configured()) return res.status(503).json({ error: 'not_configured' });

    const name = F.str(body.name, 120);
    const e164 = F.normalizePhone(body.phone);
    const email = F.str(body.email, 320);
    const instagram = (F.str(body.instagram, 60) || '').replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '') || null;
    const location = pick('location', body.location);
    const hours = pick('hours', body.hours);
    const experience = pick('experience', body.experience);
    const why = F.str(body.why, 600);
    const lang = /^es/i.test(String(body.lang || '')) ? 'es' : 'en';

    if (!name) return res.status(400).json({ error: 'missing_name' });
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });
    if (email && !F.isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (!location || !hours || !experience) return res.status(400).json({ error: 'missing_answers' });
    if (rateLimited(req)) return res.status(429).json({ error: 'rate_limited' });

    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const pub = F.sbPublic();
    const phoneFmt = F.phoneDisplay(e164);
    let source = F.str(body.utm_source, 80);
    if (!source && body.referrer) { try { source = new URL(String(body.referrer)).hostname.slice(0, 80); } catch (_) { /* ignore */ } }

    const row = {
        name: name, phone: phoneFmt, phone_e164: e164, email: email, instagram: instagram,
        location: location, hours: hours, experience: experience, why: why, lang: lang,
        source: source, utm_medium: F.str(body.utm_medium, 80), utm_campaign: F.str(body.utm_campaign, 120),
        session_id: F.str(body.session_id, 64), visitor_id: F.str(body.visitor_id, 64),
        ua: ua, ip_hash: F.ipHash(req),
    };

    let id = null, duplicate = false;
    try {
        const { data, error } = await pub.from('sdr_applications').insert(row).select('id').single();
        if (error) {
            if (/duplicate key|unique/i.test(error.message || '')) duplicate = true;
            else { console.error('[apply] insert failed:', error.message); return res.status(500).json({ error: 'insert_failed' }); }
        } else id = data.id;
    } catch (e) {
        console.error('[apply] insert threw:', e && e.message);
        return res.status(500).json({ error: 'insert_failed' });
    }

    try {
        await pub.from('funnel_events').insert({
            site: 'careers', event: 'contact_submitted', session_id: row.session_id, visitor_id: row.visitor_id,
            lead_id: null, lead_claimed: false, meta: { application_id: id, duplicate: duplicate, location: location, hours: hours, experience: experience },
            path: '/careers', lang: lang, ua: ua, ip_hash: row.ip_hash,
            utm_source: row.source, utm_medium: row.utm_medium, utm_campaign: row.utm_campaign,
        });
    } catch (_) { /* analytics never breaks the form */ }

    if (!duplicate) {
        try {
            const igLink = instagram ? '<a href="https://instagram.com/' + F.esc(instagram) + '">@' + F.esc(instagram) + '</a>' : 'no Instagram given';
            const flags = [];
            if (location !== 'miami') flags.push('remote (' + LABEL.location[location] + ')');
            if (hours === 'lt10') flags.push('under 10 hours');
            if (experience === 'none') flags.push('no rejection-heavy job yet');
            await F.notify(
                'SDR application: ' + name + (location === 'miami' ? ' (Miami)' : ''),
                '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
                + '<p><strong>' + F.esc(name) + '</strong> applied on the hiring page' + (lang === 'es' ? ' (Spanish)' : '') + (source ? ' from ' + F.esc(source) : '') + '.</p>'
                + '<p style="font-size:18px"><a href="tel:' + F.esc(e164) + '">' + F.esc(phoneFmt) + '</a>' + (email ? '<br><a href="mailto:' + F.esc(email) + '">' + F.esc(email) + '</a>' : '') + '<br>' + igLink + '</p>'
                + '<ul style="padding-left:18px">'
                + '<li>Where: <strong>' + F.esc(LABEL.location[location]) + '</strong></li>'
                + '<li>Hours: <strong>' + F.esc(LABEL.hours[hours]) + '</strong></li>'
                + '<li>Background: <strong>' + F.esc(LABEL.experience[experience]) + '</strong></li>'
                + (why ? '<li>Why money now: <em>' + F.esc(why) + '</em></li>' : '')
                + '</ul>'
                + (flags.length ? '<p style="color:#A3312F">Flags: ' + F.esc(flags.join(', ')) + '</p>' : '<p style="color:#1b7f3b">No flags. Call now.</p>')
                + '<p>Call inside the hour. The screen is in Strategy/sdr-hiring-call-script-2026-08-09.md: 15 minutes, role-play, paid trial day.</p>'
                + '<p style="color:#555">Application #' + (id || '?') + ' in public.sdr_applications.</p></div>'
            );
        } catch (_) { /* best-effort */ }
    }

    return res.status(200).json({ ok: true, id: id, duplicate: duplicate });
};
