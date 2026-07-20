/**
 * GET /api/admin/health-alerts   (Vercel cron, hourly)
 *
 * The check that should have existed before 2026-07-20.
 *
 * That day two failures ran for hours with nothing watching:
 *   1. A broken idempotency stamp re-sent the same SMS to one prospect 40 times
 *      over three hours. It was found by a human happening to open a lead panel,
 *      45 minutes before that prospect's closing call. He no-showed.
 *   2. Two SDR lines had been silent for days while the dashboard still showed
 *      dial activity, because the dial stamp records a button click, not a call.
 *
 * Both were visible in the database the entire time. Nothing was looking. This
 * looks.
 *
 * Checks:
 *   A. RUNAWAY_MESSAGES  — any lead receiving more than N outbound messages in
 *      24h, or the same body/subject twice. Catches a send loop in ~1 hour
 *      instead of ~3, and catches it even if the _sms.js guardrail fails open.
 *   B. SILENT_REP        — an active SDR with zero outbound calls on a weekday
 *      past the cutoff hour. Reads lead_calls (the Quo record), NOT
 *      leads.last_called_at, because that column is stamped by the dashboard
 *      Dial button before the call is placed and so cannot distinguish dialing
 *      from clicking.
 *   C. CLICKED_NOT_DIALED — dial-button stamps with no matching call row for the
 *      same rep and day. This is the Jorge case specifically: 19 clicks, zero
 *      calls, invisible for two weeks.
 *
 * Emails Remy only. Never contacts a prospect, so a bug here cannot become the
 * thing it is watching for.
 *
 * IDEMPOTENCY: one alert per (check, subject, ET day), recorded in app_kv. The
 * write is error-checked and the send is skipped if it fails, because an alerter
 * that loops would be the stupidest possible outcome here.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin JWT. ?dry=1 previews.
 */
const { assertAdminOrSdr } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

const ALERT_TO = process.env.HEALTH_ALERT_TO || 'remyleon11@gmail.com';
const KV_KEY = 'health_alerts_fired';

// A lead legitimately gets 3 nurture texts plus a confirmation email in a busy
// day. 6 means something is wrong.
const MAX_MSGS_PER_LEAD_24H = Number(process.env.ALERT_MAX_MSGS || 6);
// Don't cry "silent rep" at 9am. By 2pm ET a working day has calls in it.
const SILENT_REP_AFTER_HOUR_ET = Number(process.env.ALERT_SILENT_AFTER_HOUR || 14);
const MIN_DIALS_WEEKDAY = Number(process.env.ALERT_MIN_DIALS || 1);

function etParts(d) {
    const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false, weekday: 'short'
    }).formatToParts(d);
    const g = function (t) { return (f.find(function (p) { return p.type === t; }) || {}).value; };
    return { day: g('year') + '-' + g('month') + '-' + g('day'), hour: parseInt(g('hour'), 10), weekday: g('weekday') };
}

async function sendAlert(subject, html) {
    if (!process.env.RESEND_API_KEY) return { skip: 'no_key' };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: 'STILO Health <remyleon@stiloaipartners.com>',
            to: [ALERT_TO], subject: subject, html: html
        })
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, err: r.ok ? null : (j.message || 'fail') };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const pro = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const now = new Date();
    const et = etParts(now);
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(et.weekday) >= 0;
    const since24 = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const alerts = [];
    const warnings = [];

    // ---- A. runaway messages to a single lead -------------------------------
    try {
        const { data, error } = await pro.from('lead_messages')
            .select('lead_id,channel,subject,body_preview,sent_at')
            .eq('direction', 'outbound').gte('sent_at', since24).limit(5000);
        if (error) throw error;
        const byLead = {};
        (data || []).forEach(function (m) {
            if (m.lead_id == null) return;
            byLead[m.lead_id] = byLead[m.lead_id] || { n: 0, bodies: {} };
            byLead[m.lead_id].n++;
            const k = (m.channel || '') + '|' + (m.channel === 'email' ? (m.subject || '') : (m.body_preview || ''));
            byLead[m.lead_id].bodies[k] = (byLead[m.lead_id].bodies[k] || 0) + 1;
        });
        const bad = Object.keys(byLead).filter(function (id) {
            const x = byLead[id];
            const maxRepeat = Math.max.apply(null, Object.keys(x.bodies).map(function (k) { return x.bodies[k]; }).concat([0]));
            return x.n > MAX_MSGS_PER_LEAD_24H || maxRepeat > 1;
        });
        if (bad.length) {
            const ids = bad.map(Number);
            const { data: leads } = await pro.from('leads').select('id,name,owner_name').in('id', ids);
            const nameOf = {};
            (leads || []).forEach(function (l) { nameOf[l.id] = l.name || ('Lead ' + l.id); });
            bad.forEach(function (id) {
                const x = byLead[id];
                const maxRepeat = Math.max.apply(null, Object.keys(x.bodies).map(function (k) { return x.bodies[k]; }));
                alerts.push({
                    check: 'RUNAWAY_MESSAGES', subject_key: 'lead:' + id,
                    title: (nameOf[id] || ('Lead ' + id)) + ' got ' + x.n + ' outbound messages in 24h'
                        + (maxRepeat > 1 ? ' (same message ×' + maxRepeat + ')' : ''),
                    detail: 'Lead ' + id + ' · https://stiloaipartners.com/admin/#leads · '
                        + 'A repeat of the SAME message is always a bug. Check the idempotency stamp on whichever cron sent it.'
                });
            });
        }
    } catch (e) { warnings.push('runaway check failed: ' + (e.message || e)); }

    // ---- B + C. rep activity -------------------------------------------------
    if (isWeekday && et.hour >= SILENT_REP_AFTER_HOUR_ET) {
        try {
            const { data: reps, error: rErr } = await pub.from('sdr_users')
                .select('email,display_name').eq('active', true);
            if (rErr) throw rErr;

            // Start of the ET day, expressed as UTC.
            const dayStartUtc = new Date(new Date(et.day + 'T00:00:00-04:00').toISOString()).toISOString();

            const { data: calls, error: cErr } = await pro.from('lead_calls')
                .select('logged_by,direction').eq('direction', 'outbound').gte('called_at', dayStartUtc).limit(5000);
            if (cErr) throw cErr;
            const dialsBy = {};
            (calls || []).forEach(function (c) {
                const k = String(c.logged_by || '').toLowerCase();
                if (k) dialsBy[k] = (dialsBy[k] || 0) + 1;
            });

            // Dial-BUTTON stamps for the same window. leads.last_called_at is
            // written by log-dial.js when the rep clicks Dial, which happens
            // BEFORE the call is placed -- Quo has no programmatic dial, so the
            // rep still has to tap Call in the app. Clicks far above calls means
            // the rep is working the queue without actually phoning anyone.
            const { data: stamped } = await pro.from('leads')
                .select('assigned_to,last_called_at').gte('last_called_at', dayStartUtc).limit(5000);
            const clicksBy = {};
            (stamped || []).forEach(function (l) {
                const k = String(l.assigned_to || '').toLowerCase();
                if (k) clicksBy[k] = (clicksBy[k] || 0) + 1;
            });

            // Only hold someone to a dialing standard if they actually dial.
            // sdr_users includes people who never cold call (David writes the
            // briefs and holds an owner line for attribution only). Alerting on
            // them every single day is how an alert gets ignored, which is worse
            // than not having one. Self-calibrating: a rep counts as a dialer if
            // they placed a call on any of the last 14 days.
            const since14 = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString();
            const dialers = new Set();
            try {
                const { data: recent } = await pro.from('lead_calls')
                    .select('logged_by').eq('direction', 'outbound').gte('called_at', since14).limit(10000);
                (recent || []).forEach(function (c) {
                    const k = String(c.logged_by || '').toLowerCase();
                    if (k) dialers.add(k);
                });
            } catch (e) { warnings.push('dialer-set read failed: ' + (e.message || e)); }

            (reps || []).forEach(function (r) {
                const k = String(r.email || '').toLowerCase();
                if (!dialers.has(k)) return;   // not a dialing role
                const dials = dialsBy[k] || 0;
                const clicks = clicksBy[k] || 0;
                const who = r.display_name || r.email;
                if (dials < MIN_DIALS_WEEKDAY) {
                    alerts.push({
                        check: 'SILENT_REP', subject_key: 'rep:' + k,
                        title: who + ' has made 0 calls today',
                        detail: 'Zero outbound rows in lead_calls since midnight ET'
                            + (clicks ? ' — but ' + clicks + ' Dial-button clicks. Queue worked, phone not used.' : '.')
                            + ' Verified against the Quo call record, not the dial stamp.'
                    });
                } else if (clicks >= 5 && dials > 0 && clicks > dials * 3) {
                    alerts.push({
                        check: 'CLICKED_NOT_DIALED', subject_key: 'rep:' + k,
                        title: who + ': ' + clicks + ' Dial clicks but only ' + dials + ' actual calls',
                        detail: 'The dashboard will show activity that the phone system has no record of.'
                    });
                }
            });
        } catch (e) { warnings.push('rep activity check failed: ' + (e.message || e)); }
    }

    // ---- dedupe: one alert per check+subject+ET day ---------------------------
    let fired = [];
    try {
        const { data } = await pub.from('app_kv').select('value').eq('key', KV_KEY).maybeSingle();
        fired = ((data && data.value && data.value.fired) || []).filter(function (k) {
            return String(k).indexOf(et.day + '|') === 0;   // today's only; yesterday's roll off
        });
    } catch (e) { warnings.push('kv read failed: ' + (e.message || e)); }

    const firedSet = new Set(fired);
    const fresh = alerts.filter(function (a) { return !firedSet.has(et.day + '|' + a.check + '|' + a.subject_key); });

    if (!fresh.length || dry) {
        return res.status(200).json({ ok: true, dry: dry, et: et, found: alerts.length, fresh: fresh.length, alerts: dry ? alerts : undefined, warnings: warnings });
    }

    // Record BEFORE sending. If the KV write fails we send nothing, because an
    // alerter that repeats itself every hour is the exact failure mode this
    // endpoint exists to catch.
    const nextFired = fired.concat(fresh.map(function (a) { return et.day + '|' + a.check + '|' + a.subject_key; }));
    const { error: kvErr } = await pub.from('app_kv')
        .upsert({ key: KV_KEY, value: { fired: nextFired }, updated_at: new Date().toISOString() });
    if (kvErr) {
        console.error('[health-alerts] KV write failed, suppressing send to avoid an alert loop:', kvErr.message);
        return res.status(500).json({ error: 'kv_write_failed', detail: kvErr.message, would_have_sent: fresh.length });
    }

    const html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:620px;color:#111;font-size:15px;line-height:1.5">'
        + '<p style="font-weight:700;font-size:17px;margin:0 0 14px">STILO health check — ' + fresh.length + ' issue' + (fresh.length > 1 ? 's' : '') + '</p>'
        + fresh.map(function (a) {
            return '<div style="border-left:3px solid #ef4444;padding:8px 0 8px 12px;margin-bottom:14px">'
                + '<div style="font-size:11px;letter-spacing:.05em;color:#6b7280;text-transform:uppercase">' + a.check + '</div>'
                + '<div style="font-weight:600;margin:2px 0 4px">' + a.title + '</div>'
                + '<div style="color:#374151;font-size:13px">' + a.detail + '</div></div>';
        }).join('')
        + '<p style="color:#6b7280;font-size:12px">Checked ' + et.day + ' ' + et.hour + ':00 ET. One alert per issue per day.</p></div>';

    const sent = await sendAlert('STILO health: ' + fresh.map(function (a) { return a.check; }).join(', '), html);
    return res.status(200).json({ ok: true, et: et, sent: sent, alerts: fresh, warnings: warnings });
};
