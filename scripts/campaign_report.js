/**
 * scripts/campaign_report.js
 *
 * The morning campaign report: every SMS and email campaign dissected, with
 * honest verdicts. Backs the /campaign-report skill so the numbers come from
 * one place and every morning's report is comparable to yesterday's.
 *
 * Usage: node sites/stilo-ai/scripts/campaign_report.js   (prints markdown)
 */
const fs = require('fs');
const path = require('path');
try {
    fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Accept-Profile': 'prospecting' };
const BLASON = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';

async function count(pathQ) {
    const r = await fetch(`${URL_}/rest/v1/${pathQ}${pathQ.includes('?') ? '&' : '?'}limit=1`, { headers: { ...H, Prefer: 'count=exact' } });
    return parseInt((r.headers.get('content-range') || '/0').split('/')[1], 10) || 0;
}
async function rows(pathQ) {
    const r = await fetch(`${URL_}/rest/v1/${pathQ}`, { headers: H });
    const j = await r.json();
    return Array.isArray(j) ? j : [];
}
const day = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';

(async () => {
    const out = [];
    const p = (s) => out.push(s);
    p('# Daily Campaign Report — ' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }));
    p('');

    // ---------------- SMS campaigns ----------------
    const camps = await rows('outbound_campaigns?select=id,name,status,daily_cap,per_line_daily_cap,client_id&order=id');
    p('## SMS campaigns');
    for (const c of camps) {
        const base = `outbound_targets?campaign_id=eq.${c.id}`;
        const [sent, sentToday, sent7, replies, replies7, optout, dead, queuedReady, queuedNoBody, repliedWaiting, cbMade, cbMissed] = await Promise.all([
            count(`${base}&step1_sent_at=not.is.null`),
            count(`${base}&step1_sent_at=gte.${day(0)}`),
            count(`${base}&step1_sent_at=gte.${day(7)}`),
            count(`${base}&first_reply_at=not.is.null`),
            count(`${base}&first_reply_at=gte.${day(7)}`),
            count(`${base}&stage=eq.opted_out`),
            count(`${base}&stage=eq.dead`),
            count(`${base}&stage=eq.queued&step1_body=not.is.null`),
            count(`${base}&stage=eq.queued&step1_body=is.null`),
            count(`${base}&stage=eq.replied&step2_sent_at=is.null`),
            count(`${base}&first_reply_at=not.is.null&called_back_at=not.is.null`),
            count(`${base}&first_reply_at=not.is.null&called_back_at=is.null`),
        ]);
        p(`### Campaign ${c.id}: ${c.name} — ${String(c.status).toUpperCase()}${c.client_id ? ' (client: Blason)' : ' (STILO)'}`);
        p(`- Step-1 sends: ${sent} total, ${sent7} last 7d, ${sentToday} today (caps ${c.daily_cap}/day, ${c.per_line_daily_cap}/line)`);
        p(`- Replies: ${replies} (${pct(replies, sent)} of sends), ${replies7} in last 7d. Opt-outs: ${optout}. Dead: ${dead}.`);
        p(`- Queue: ${queuedReady} ready to send, ${queuedNoBody} awaiting copy. Replies awaiting step-2: ${repliedWaiting}.`);
        p(`- Reply follow-through: ${cbMade} called back, ${cbMissed} never called back.`);
        if (c.id === 4) {
            const ab = await rows(`outbound_targets?campaign_id=eq.4&step1_sent_at=gte.2026-09-14&select=variant,first_reply_at`);
            const a = ab.filter(x => x.variant === 'A'), b = ab.filter(x => x.variant === 'B');
            p(`- Copy test (curated bank, started 9/14): arm A ${a.length} sends / ${a.filter(x => x.first_reply_at).length} replies, arm B ${b.length} sends / ${b.filter(x => x.first_reply_at).length} replies. Read at 200 total.`);
        }
        p('');
    }

    // ---------------- Blason email ----------------
    p('## Blason email (client lane)');
    const BQ = `leads?client_id=eq.${BLASON}`;
    const [e1, e1_7, e1_today, e2, e2_7, ebounced, eunsub, ereplies7, lane1Left, lane2Left, step2Due] = await Promise.all([
        count(`${BQ}&email_1_sent_at=not.is.null`),
        count(`${BQ}&email_1_sent_at=gte.${day(7)}`),
        count(`${BQ}&email_1_sent_at=gte.${day(0)}`),
        count(`${BQ}&email_2_sent_at=not.is.null`),
        count(`${BQ}&email_2_sent_at=gte.${day(7)}`),
        count(`${BQ}&bounced_at=not.is.null`),
        count(`${BQ}&unsubscribed_at=not.is.null`),
        count(`lead_messages?direction=eq.inbound&channel=eq.email&sent_at=gte.${day(7)}&leads.client_id=eq.${BLASON}&select=id,leads!inner(client_id)`),
        count(`${BQ}&email_confidence=eq.medium&email_verify_status=eq.deliverable&email_1_sent_at=is.null&bounced_at=is.null&unsubscribed_at=is.null`),
        count(`${BQ}&email_verify_status=eq.role_inbox&email_1_sent_at=is.null&bounced_at=is.null&unsubscribed_at=is.null`),
        count(`${BQ}&email_1_sent_at=lt.${new Date(Date.now() - 3 * 864e5).toISOString()}&email_2_sent_at=is.null&reply_received_at=is.null&bounced_at=is.null&unsubscribed_at=is.null`),
    ]);
    // trailing 72h bounce (the 8% breaker input)
    const recent = await rows(`lead_messages?direction=eq.outbound&channel=eq.email&sent_at=gte.${new Date(Date.now() - 72 * 3600e3).toISOString()}&select=bounced_at,leads!inner(client_id)&leads.client_id=eq.${BLASON}&limit=1000`);
    const rSent = recent.length, rB = recent.filter(m => m.bounced_at).length;
    p(`- Email 1: ${e1} total, ${e1_7} last 7d, ${e1_today} today. Email 2: ${e2} total, ${e2_7} last 7d.`);
    p(`- Bounced (lifetime): ${ebounced} (${pct(ebounced, e1)}). Trailing 72h: ${rB}/${rSent} (${pct(rB, rSent)}) — breaker refuses at 8%.`);
    p(`- Replies last 7d: ${ereplies7}. Unsubscribed: ${eunsub}.`);
    p(`- Supply: lane 1 (medium+deliverable) ${lane1Left} left, lane 2 (role inboxes, MX-confirmed) ${lane2Left} left, step-2 follow-ups due ${step2Due}.`);
    p('');

    // ---------------- STILO cold email sequence ----------------
    p('## STILO cold email sequence');
    let seq = null;
    try {
        const r = await fetch('https://stiloaipartners.com/api/prospects/email-sequence?dry=1', { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
        seq = await r.json();
    } catch (e) { /* below */ }
    if (seq && seq.ok) {
        p(`- Sent today: ${seq.sent_today}/${seq.cap}. Due now: ${seq.due_now} (${JSON.stringify(seq.due_by_niche)}).`);
        p(`- Skips: ${JSON.stringify(seq.skipped)}`);
    } else p('- DRY RUN FAILED, check the endpoint.');
    const [sB7, sSent7] = await Promise.all([
        count(`lead_messages?direction=eq.outbound&channel=eq.email&bounced_at=not.is.null&sent_at=gte.${day(7)}&leads.client_id=is.null&select=id,leads!inner(client_id)`),
        count(`lead_messages?direction=eq.outbound&channel=eq.email&sent_at=gte.${day(7)}&leads.client_id=is.null&select=id,leads!inner(client_id)`),
    ]);
    p(`- STILO-pool email volume last 7d: ${sSent7} sends, ${sB7} bounced (${pct(sB7, sSent7)}).`);
    p('');

    // ---------------- Conversions ----------------
    p('## Conversions and pipeline');
    const [meet7, meet14, sales] = await Promise.all([
        count(`lead_meetings?occurred_at=gte.${day(7)}`),
        count(`lead_meetings?occurred_at=gte.${day(14)}`),
        rows(`client_sales?select=business_name,sale_amount,commission_amount,sold_at&order=sold_at.desc&limit=5`),
    ]);
    p(`- Meetings (occurred/logged): ${meet7} last 7d, ${meet14} last 14d.`);
    p(`- Client sales on record: ${sales.length ? sales.map(x => `${x.business_name} $${x.sale_amount} (comm $${x.commission_amount}, ${x.sold_at})`).join('; ') : 'none yet'}.`);
    p('');
    console.log(out.join('\n'));
})().catch(e => { console.error('REPORT FAILED:', e.message); process.exit(1); });
