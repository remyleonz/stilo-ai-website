/**
 * GET /api/prospects/vsl-watch-alerts?dry=1
 *
 * "Hot lead watched the video" alert. Remy calls a lead, they say they're
 * interested, he texts or emails the VSL link, and then nothing tells him when
 * they actually open it. By the time he follows up the next day the moment is
 * gone. This cron closes that gap: it emails him within 5 minutes of a real
 * human landing on the VSL page.
 *
 * WHO IS COVERED. Every lead we have ever sent something to, which in practice
 * means every VSL email, confirmation email and pre-meeting email: any lead with
 * an outbound row in prospecting.lead_messages. There is no arming step. If a
 * human is on a VSL page carrying our signed lid, we are the ones who put them
 * there, so the alert should just happen. Requiring a prior outbound message is
 * the whole gate: the vsl-event append endpoint is intentionally public, and
 * without this a forged or stray lid in the URL could generate an alert for a
 * lead we never contacted. The old prospecting.leads.vsl_watch_alert boolean is
 * DEPRECATED and read nowhere. It is kept on the table only so existing rows do
 * not break, and it should not be dropped without a migration.
 *
 * WHAT COUNTS AS WATCHING. Only public.vsl_events rows with event 'view' or
 * 'play', which are the two page-level beacons the VSL itself fires.
 * 'email_open' is a tracking-pixel fetch, not a page visit, and 'confirm_open'
 * / 'confirm' belong to the post-booking confirmation flow. A 'play' is much
 * stronger evidence of a human than a 'view' and the email says which it was,
 * because "opened the page" and "started the video" are different sales
 * situations.
 *
 * THE SCANNER TRAP (the reason this file is longer than it looks like it should
 * be). Corporate mail security opens every link in an inbound email before the
 * recipient ever sees it. Those fetches hit the VSL page and write a real
 * vsl_events row. Two independent filters, and an event has to clear both:
 *
 *   1. TIMING. An event inside SCANNER_WINDOW_SEC of one of OUR OWN sends to
 *      that lead (prospecting.lead_messages, direction outbound) is the scanner
 *      chewing through the link, not a person reading the email and deciding to
 *      click. A human takes minutes, not seconds.
 *   2. USER AGENT. Mail proxies and bots announce themselves
 *      (GoogleImageProxy, YahooMailProxy, HeadlessChrome, curl, python-requests
 *      ...), and so do we: the Claude desktop app is an Electron shell, so any
 *      UA containing Claude/Electron is one of us testing, never the prospect.
 *      A bare "Mozilla/5.0" with nothing after it is also never a real browser.
 *
 * FIRING ONCE. vsl_watch_alerted_at is the high-water mark. Only events strictly
 * newer than it can alert, so the 5-minute cron re-reading the same 'play' row
 * forever sends exactly one email. The stamp is written ONLY after Resend
 * returns < 300, same discipline as the outbound reply alert: stamping first
 * would mean a Resend outage silently eats the one alert that mattered. The
 * flip side (a send that succeeds but whose stamp write fails) costs a duplicate
 * email, which is the cheap failure.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin/SDR JWT for manual runs.
 */

const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

// Page-level beacons only. See "WHAT COUNTS AS WATCHING" above.
const WATCH_EVENTS = ['view', 'play'];

// A click this soon after our own send is a link scanner. 60s is deliberately
// generous: a scanner fires in under a second, a human who is genuinely eager
// still has to open the mail app and read a line first.
const SCANNER_WINDOW_SEC = 60;

// Observed on real data (lead 20539, 2026-08-12): the scanner hit at +53s was
// caught by the window, then the SAME agent fetched the page again at +74s and
// sailed through. A burst is one machine, so once an in-window hit has
// identified a user agent as a scanner, every later event from that identical
// agent inside this many seconds is the same burst.
const SCANNER_BURST_SEC = 600;

// Never alert on an event older than this. The table already holds months of
// history, and "they watched it in July" is not a reason to pick up the phone
// right now.
const MAX_EVENT_AGE_HOURS = 48;

// A dry run pulls a wider window than a live tick so the report can show the
// near misses and say out loud why each one was skipped. Bounded, because the
// gate is no longer a short list of armed leads and an unbounded read would
// walk the whole vsl_events table.
const DRY_LOOKBACK_HOURS = 14 * 24;

// Safety valve on the event read. Real volume is tens of rows per 48h, so this
// only matters if something starts spraying events.
const MAX_EVENTS = 3000;

// Substrings that mean the request was not a prospect in a browser. Lowercased
// compare. Order is irrelevant, any hit disqualifies.
const BOT_UA = [
    'headlesschrome', 'claude', 'electron', 'phantomjs', 'puppeteer', 'playwright',
    'googleimageproxy', 'yahoomailproxy', 'ggpht.com', 'mailproxy', 'proxy',
    'bot', 'crawler', 'spider', 'preview', 'scanner', 'monitor',
    'curl', 'wget', 'python-requests', 'python-urllib', 'go-http-client',
    'okhttp', 'java/', 'axios', 'node-fetch', 'apache-httpclient',
    'microsoft office', 'ms-office', 'outlook', 'barracuda', 'proofpoint',
    'mimecast', 'symantec', 'forcepoint', 'slackbot', 'facebookexternalhit',
    'whatsapp', 'telegrambot', 'twitterbot', 'discordbot', 'skypeuripreview',
];

/**
 * @returns {string|null} the reason this UA is not a human, or null if it looks
 * like a real browser.
 */
function botReason(ua) {
    const s = String(ua || '').toLowerCase().trim();
    if (!s) return 'no user agent';
    // A real browser's UA is long and names a rendering engine. "Mozilla/5.0"
    // on its own is a pixel fetcher pretending.
    if (s.length < 24 || !/(applewebkit|gecko|trident|khtml|edge|firefox)/.test(s)) {
        return 'stub user agent (' + String(ua).slice(0, 40) + ')';
    }
    const hit = BOT_UA.find(function (b) { return s.indexOf(b) !== -1; });
    return hit ? 'bot user agent (' + hit + ')' : null;
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function etStamp(iso) {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        }).format(new Date(iso));
    } catch (_) { return String(iso); }
}

function minutesAgo(iso, now) {
    const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m === 1) return '1 minute ago';
    if (m < 60) return m + ' minutes ago';
    const h = Math.round(m / 60);
    return h === 1 ? 'about an hour ago' : 'about ' + h + ' hours ago';
}

function firstName(name) {
    const n = String(name || '').trim();
    if (!n) return '';
    return n.split(/\s+/)[0];
}

/**
 * One-line description of the last thing we sent them, so Remy opens the call
 * knowing what's on their screen.
 */
function describeSend(msg) {
    if (!msg) return 'nothing on file';
    const when = etStamp(msg.sent_at);
    const what = msg.subject || (msg.channel === 'sms' ? 'text message' : 'email');
    return (msg.channel === 'sms' ? 'Text' : 'Email') + ' "' + what + '" on ' + when;
}

/**
 * The alert itself. Recipients: the personal inbox Remy actually watches on his
 * phone PLUS the work reply-to address, deduped. Reply alerts used to go only to
 * the work inbox and sat unread; a speed-to-lead alert that lands somewhere
 * nobody refreshes is worth nothing.
 */
async function sendWatchAlert(opts) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };

    const fromName = process.env.STILO_SENDER_NAME || 'STILO Outbound';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const owner = process.env.STILO_REPLY_TO || 'remyleon@stiloaipartners.com';
    const alertInbox = process.env.HEALTH_ALERT_TO || 'remyleon11@gmail.com';

    const to = Array.from(new Set(
        [alertInbox, owner]
            .map(function (e) { return String(e || '').toLowerCase().trim(); })
            .filter(function (e) { return e && /.+@.+\..+/.test(e); })
    ));

    const who = firstName(opts.ownerName);
    const verb = opts.event === 'play' ? 'just played the video' : 'just opened the video page';
    const headline = (who ? who + ' at ' + opts.business : opts.business) + ' ' + verb;

    const adminUrl = 'https://stiloaipartners.com/admin/?lead=' + opts.leadId;
    const digits = String(opts.phone || '').replace(/[^\d+]/g, '');
    const telLink = 'tel:' + digits;

    const html = [
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">',
        '<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#2563EB;font-weight:700">Watching right now</p>',
        '<h1 style="margin:0 0 18px;font-size:22px;line-height:1.25">' + esc(headline) + '</h1>',

        '<div style="background:#2563EB;border-radius:6px;padding:16px 18px;margin:0 0 20px;text-align:center">',
        '<p style="margin:0 0 10px;font-size:17px;font-weight:700;color:#fff;line-height:1.3">Call them now, while it is on their screen.</p>',
        opts.phone
            ? '<a href="' + telLink + '" style="display:inline-block;background:#fff;color:#2563EB;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:700;font-size:18px">' + esc(opts.phone) + '</a>'
            : '<p style="margin:0;font-size:14px;color:#DBEAFE">No phone on file, open the lead.</p>',
        '</div>',

        '<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">',
        '<tr><td style="padding:5px 0;color:#6B7280;width:120px">Business</td><td style="padding:5px 0;font-weight:600">' + esc(opts.business) + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Contact</td><td style="padding:5px 0">' + esc(opts.ownerName || 'unknown') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Industry</td><td style="padding:5px 0">' + esc(opts.niche || '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">What happened</td><td style="padding:5px 0">' + esc(opts.event === 'play' ? 'Pressed play on the video' : 'Loaded the VSL page') + (opts.path ? ' (' + esc(opts.path) + ')' : '') + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">When</td><td style="padding:5px 0">' + esc(opts.whenET) + ' (' + esc(opts.ago) + ')</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">We sent</td><td style="padding:5px 0;color:#6B7280">' + esc(opts.lastSent) + '</td></tr>',
        '<tr><td style="padding:5px 0;color:#6B7280">Assigned to</td><td style="padding:5px 0">' + esc(opts.assignedTo || '') + '</td></tr>',
        '</table>',

        '<a href="' + adminUrl + '" style="display:inline-block;background:#111;color:#fff;padding:11px 20px;border-radius:4px;text-decoration:none;font-weight:600;font-size:15px">Open the lead</a>',
        '<p style="margin:18px 0 0;font-size:12px;color:#9CA3AF">You get this for any lead we have emailed, the moment a real person lands on their video page. Mail-scanner opens are filtered out.</p>',
        '</div>',
    ].join('');

    const text = [
        headline + '.',
        '',
        'Call them now, while it is on their screen.',
        opts.phone ? 'Phone: ' + opts.phone : 'No phone on file.',
        '',
        'Business: ' + opts.business,
        'Contact: ' + (opts.ownerName || 'unknown'),
        'Industry: ' + (opts.niche || ''),
        'What happened: ' + (opts.event === 'play' ? 'Pressed play on the video' : 'Loaded the VSL page') + (opts.path ? ' (' + opts.path + ')' : ''),
        'When: ' + opts.whenET + ' (' + opts.ago + ')',
        'We sent: ' + opts.lastSent,
        '',
        adminUrl,
    ].join('\n');

    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: to,
            reply_to: owner,
            subject: 'Watched the video: ' + opts.business + ', call now',
            html: html,
            text: text,
        }),
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, to: to, error: r.ok ? null : (j.message || 'send_failed') };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    // req.query is not reliable on a Vercel cold start (see the transcript-gap
    // postmortem), so read the URL directly and treat req.query as a fallback.
    let qs = {};
    try { qs = Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (_) { qs = {}; }
    const dry = String(qs.dry || (req.query && req.query.dry) || '') === '1';

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
    });

    const now = new Date();
    const cutoff = new Date(now.getTime() - MAX_EVENT_AGE_HOURS * 3600 * 1000).toISOString();

    // Start from the EVENTS, not from a list of leads. The gate is now "have we
    // ever sent this lead anything", which is most of the table, so asking for
    // those leads first and then their events would be backwards. Almost nobody
    // is on a VSL page in any given window, and every query below is scoped to
    // that handful. The age cutoff is re-applied in the loop rather than relied
    // on here so a dry run can pull a wider window and say out loud WHY each old
    // or bot event was skipped.
    const eventFloor = new Date(
        now.getTime() - (dry ? DRY_LOOKBACK_HOURS : MAX_EVENT_AGE_HOURS) * 3600 * 1000
    ).toISOString();

    const { data: events, error: eErr } = await pub.from('vsl_events')
        .select('id,lead_id,event,flow,agent,path,ua,created_at')
        .in('event', WATCH_EVENTS)
        .not('lead_id', 'is', null)
        .gte('created_at', eventFloor)
        .order('created_at', { ascending: false })
        .limit(MAX_EVENTS);
    if (eErr) return res.status(500).json({ error: 'event_query_failed', detail: eErr.message });

    const seenIds = Array.from(new Set((events || []).map(function (e) { return e.lead_id; })));
    if (!seenIds.length) {
        return res.status(200).json({ ok: true, dry: dry, leads_with_events: 0, alerted: 0, candidates: [] });
    }

    // Our own outbound sends. This one query does double duty: it is the timing
    // half of the scanner filter, AND a lead having any row here is the gate.
    const { data: sends } = await sb.from('lead_messages')
        .select('id,lead_id,channel,subject,sent_at')
        .in('lead_id', seenIds)
        .eq('direction', 'outbound')
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false });

    const sendsByLead = {};
    (sends || []).forEach(function (m) {
        (sendsByLead[m.lead_id] = sendsByLead[m.lead_id] || []).push(m);
    });

    const ids = seenIds.filter(function (id) { return !!sendsByLead[id]; });
    const ungated = seenIds.filter(function (id) { return !sendsByLead[id]; });
    if (!ids.length) {
        return res.status(200).json({
            ok: true, dry: dry, leads_with_events: seenIds.length, alerted: 0,
            skipped_no_outbound: ungated, candidates: [],
        });
    }

    const { data: watched, error: wErr } = await sb.from('leads')
        .select('id,name,owner_name,niche,category,phone,owner_phone_e164,owner_email,assigned_to,stage,meeting_scheduled_at,vsl_watch_alerted_at')
        .in('id', ids);
    if (wErr) return res.status(500).json({ error: 'lead_query_failed', detail: wErr.message });

    const results = [];

    for (const lead of (watched || [])) {
        const mine = (events || []).filter(function (e) { return e.lead_id === lead.id; });
        const leadSends = sendsByLead[lead.id] || [];
        const lastSend = leadSends[0] || null;
        const since = lead.vsl_watch_alerted_at ? new Date(lead.vsl_watch_alerted_at).getTime() : 0;

        const rejected = [];
        const qualifying = [];
        const scannerHits = [];   // in-window hits, used to kill the rest of the burst

        for (const ev of mine) {
            const at = new Date(ev.created_at).getTime();
            // Order here is about the REASON reported, not correctness: any one
            // of these disqualifies. "It was a bot" is the most useful thing to
            // read in a dry run, so it's checked first.
            const bot = botReason(ev.ua);
            if (bot) {
                rejected.push({ event_id: ev.id, event: ev.event, at: ev.created_at, reason: bot });
                continue;
            }
            if (ev.created_at < cutoff) {
                rejected.push({ event_id: ev.id, event: ev.event, at: ev.created_at, reason: 'older than ' + MAX_EVENT_AGE_HOURS + 'h, the moment is gone' });
                continue;
            }
            if (at <= since) {
                rejected.push({ event_id: ev.id, event: ev.event, at: ev.created_at, reason: 'already alerted on or before this event' });
                continue;
            }
            // Timing filter: within a minute of anything WE sent them.
            const near = leadSends.find(function (m) {
                const d = at - new Date(m.sent_at).getTime();
                return d >= 0 && d <= SCANNER_WINDOW_SEC * 1000;
            });
            if (near) {
                rejected.push({
                    event_id: ev.id, event: ev.event, at: ev.created_at,
                    reason: 'fired ' + Math.round((at - new Date(near.sent_at).getTime()) / 1000)
                        + 's after our own ' + near.channel + ' send, link scanner',
                });
                scannerHits.push(ev);
                continue;
            }
            qualifying.push(ev);
        }

        // Second pass: drop what's left of an identified scanner's burst. Only a
        // 'view' can be killed this way. If a 'play' shows up on the same agent
        // a human is at the keyboard, because a link checker does not press play.
        for (let i = qualifying.length - 1; i >= 0; i--) {
            const ev = qualifying[i];
            if (ev.event === 'play') continue;
            const burst = scannerHits.find(function (s) {
                return String(s.ua || '') === String(ev.ua || '')
                    && Math.abs(new Date(ev.created_at) - new Date(s.created_at)) <= SCANNER_BURST_SEC * 1000;
            });
            if (burst) {
                rejected.push({
                    event_id: ev.id, event: ev.event, at: ev.created_at,
                    reason: 'same user agent as the scanner hit at ' + burst.created_at + ', same burst',
                });
                qualifying.splice(i, 1);
            }
        }

        if (!qualifying.length) {
            results.push({
                lead_id: lead.id, business: lead.name, would_alert: false,
                reason: mine.length ? 'no qualifying human event' : 'no view/play in the last ' + MAX_EVENT_AGE_HOURS + 'h',
                rejected: rejected,
            });
            continue;
        }

        // A 'play' outranks a 'view' even if the view is newer: pressing play is
        // the stronger buying signal and it's what the subject line should say.
        // Within a type, newest wins.
        qualifying.sort(function (a, b) {
            const rank = function (e) { return e.event === 'play' ? 1 : 0; };
            if (rank(a) !== rank(b)) return rank(b) - rank(a);
            return new Date(b.created_at) - new Date(a.created_at);
        });
        const best = qualifying[0];
        // The stamp advances past every event we considered this run, not just
        // the one we describe, so a view+play pair from one visit is one email.
        const newestAt = qualifying.reduce(function (acc, e) {
            return new Date(e.created_at) > new Date(acc) ? e.created_at : acc;
        }, best.created_at);

        const payload = {
            leadId: lead.id,
            business: lead.name || ('lead ' + lead.id),
            ownerName: lead.owner_name,
            niche: lead.niche || lead.category,
            phone: lead.owner_phone_e164 || lead.phone,
            assignedTo: lead.assigned_to,
            event: best.event,
            path: best.path,
            whenET: etStamp(best.created_at),
            ago: minutesAgo(best.created_at, now),
            lastSent: describeSend(lastSend),
        };

        const row = {
            lead_id: lead.id,
            business: payload.business,
            would_alert: true,
            event: best.event,
            event_at: best.created_at,
            event_ua: String(best.ua || '').slice(0, 80),
            qualifying_events: qualifying.length,
            phone: payload.phone,
            last_sent: payload.lastSent,
            rejected: rejected,
        };

        if (dry) { results.push(row); continue; }

        let alert = { skipped: 'not_attempted' };
        try {
            alert = await sendWatchAlert(payload);
        } catch (e) {
            console.error('[vsl-watch] send threw lead=' + lead.id + ': ' + (e && e.message));
            alert = { error: (e && e.message) || 'threw' };
        }

        const ok = !!(alert && !alert.error && alert.status && alert.status < 300);
        if (ok) {
            const { error: sErr } = await sb.from('leads')
                .update({ vsl_watch_alerted_at: newestAt })
                .eq('id', lead.id);
            if (sErr) console.error('[vsl-watch] stamp FAILED lead=' + lead.id + ': ' + sErr.message);
        } else {
            console.error('[vsl-watch] NOT stamping lead=' + lead.id + ', send failed: '
                + JSON.stringify(alert && alert.error ? alert.error : alert));
        }

        row.sent = ok;
        row.resend_id = alert && alert.id;
        row.send_error = alert && alert.error;
        results.push(row);
    }

    const alertable = results.filter(function (r) { return r.would_alert; });
    return res.status(200).json({
        ok: true,
        dry: dry,
        leads_with_events: seenIds.length,
        leads_checked: ids.length,
        skipped_no_outbound: ungated,
        alerted: dry ? 0 : alertable.filter(function (r) { return r.sent; }).length,
        would_alert: alertable.length,
        scanner_window_sec: SCANNER_WINDOW_SEC,
        scanner_burst_sec: SCANNER_BURST_SEC,
        max_event_age_hours: MAX_EVENT_AGE_HOURS,
        candidates: results,
    });
};

module.exports.botReason = botReason;
