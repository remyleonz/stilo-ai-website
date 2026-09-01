/**
 * GET/POST /api/prospects/team-rituals?job=invite|morning|evening
 *
 * The three recurring team touches Remy was doing by hand (2026-08-24):
 *
 *   invite   Mon + Wed + Thu evening - email the whole active roster the invite for
 *            tomorrow's cold-call session (Tue/Thu/Fri 9am-5pm ET, hosted by
 *            Remy & David) with the standing Meet link.
 *   morning  Tue + Thu + Fri 9am ET - SMS each SDR from their own Quo line to
 *            their personal phone: join the session, dial today.
 *   evening  Mon-Fri 6pm ET — per SDR: if they dialled today, SMS asking them
 *            to drop their stats in the STILO groupchat; if they made zero
 *            dials, SMS a nudge to call tomorrow with their week so far.
 *
 * SDR-only for the SMS jobs: closers (commission_pct = 0) are never texted.
 * The invite email goes to everyone active, closers included — they host it.
 *
 * Schedules live in vercel.json as fixed UTC hours (Vercel crons are UTC-only):
 * they encode the EDT offset and drift one hour when DST ends in November.
 * If the 9am text starts arriving at 8am in winter, move each cron 1 hour
 * later; that is expected, not a bug.
 *
 * Personal numbers are a hardcoded map, not a DB column, on purpose: adding a
 * column is a manual migration step here, and a wrong personal number texts a
 * stranger. A new SDR is added by editing PERSONAL below.
 */
const { createClient } = require('@supabase/supabase-js');
const { openphoneFetch, normalizePhone } = require('../openphone/_shared');

// The personal-number map lives in _team_numbers.js now — one list feeds the
// alerts here AND the allowlist that exempts these numbers from every
// prospect guard. Add a rep in one place.
const { PERSONAL } = require('./_team_numbers');

const DIAL_TARGET = 200; // Remy's stated daily quota for the call blocks

function pub() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function pro() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }

function etDateStr(d) { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function etWeekday(d) { return (d || new Date()).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' }); }
function startOfTodayET() { return new Date(etDateStr() + 'T00:00:00-04:00'); }
function startOfWeekET() {
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const wd = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const d = startOfTodayET();
    d.setUTCDate(d.getUTCDate() - ((WD[wd] + 6) % 7));
    return d;
}

async function activeRoster() {
    const { data, error } = await pub().from('sdr_users')
        .select('email, display_name, commission_pct, openphone_number, active')
        .eq('active', true);
    if (error) throw new Error('roster read failed: ' + error.message);
    return data || [];
}
function firstName(r) { return String(r.display_name || '').trim().split(/\s+/)[0] || 'there'; }
function isSdr(r) { return Number(r.commission_pct) !== 0; }

async function sendTeamSms(fromLine, to, text) {
    // Deliberately NOT _sms.js/sendSms: that path carries the prospect
    // guardrails (per-lead caps, opt-out suppression) which do not apply to a
    // rep's own phone, and its fallback would misfire a team text from Remy's
    // line when a rep's line hiccups — better to fail loudly here.
    const r = await openphoneFetch({
        path: '/messages', method: 'POST',
        body: { from: fromLine, to: [to], content: text }
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, detail: r.json && r.json.message };
}

/** Per-rep dial + meeting counts for today and this ET week. */
async function repActivity(emails) {
    const p = pro();
    const twk = startOfWeekET().toISOString();
    const out = {};
    emails.forEach(function (e) { out[e] = { today: 0, week: 0, week_talk_sec: 0, week_meetings: 0 }; });
    let from = 0;
    for (;;) {
        const { data, error } = await p.from('lead_calls')
            .select('logged_by, called_at, duration_seconds, direction')
            .in('direction', ['outbound', 'outgoing'])
            .gte('called_at', twk)
            .range(from, from + 999);
        if (error) throw new Error('lead_calls read failed: ' + error.message);
        if (!data || !data.length) break;
        const today = etDateStr();
        for (const c of data) {
            const e = String(c.logged_by || '').toLowerCase();
            if (!out[e]) continue;
            out[e].week += 1;
            out[e].week_talk_sec += c.duration_seconds || 0;
            if (etDateStr(new Date(c.called_at)) === today) out[e].today += 1;
        }
        if (data.length < 1000) break;
        from += 1000;
    }
    const { data: booked } = await p.from('leads')
        .select('meeting_booked_by_sdr, meeting_booked_at')
        .gte('meeting_booked_at', twk);
    (booked || []).forEach(function (l) {
        const e = String(l.meeting_booked_by_sdr || '').toLowerCase();
        if (out[e]) out[e].week_meetings += 1;
    });
    return out;
}

async function jobInvite(dry) {
    const roster = await activeRoster();
    const meet = process.env.TEAM_CALL_BLOCK_MEET_LINK || '';
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const day = etWeekday(tomorrow);
    const results = [];
    for (const r of roster) {
        const html = ''
            + '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6;max-width:520px;">'
            + '<p>Hey ' + firstName(r) + ',</p>'
            + '<p>Team cold-call session tomorrow (<strong>' + day + '</strong>), <strong>9am to 5pm ET</strong>. Hosted by Remy and David.</p>'
            + (meet ? '<p>Join here: <a href="' + meet + '">' + meet + '</a></p>' : '')
            + '<p>Have your list and your script open before 9. See you on the call.</p>'
            + '<p>STILO</p></div>';
        if (dry) { results.push({ to: r.email, dry: true }); continue; }
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'STILO AI Partners <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>',
                to: [r.email],
                subject: 'Call session tomorrow · 9am-5pm',
                html: html
            })
        });
        results.push({ to: r.email, status: resp.status });
    }
    return { day: day, sent: results };
}

async function jobMorning(dry) {
    const roster = await activeRoster();
    const results = [];
    for (const r of roster) {
        if (!isSdr(r)) continue;                        // closers never get these
        const to = PERSONAL[String(r.email).toLowerCase()];
        if (!to) { results.push({ rep: r.email, skip: 'no_personal_number' }); continue; }
        const line = normalizePhone(r.openphone_number);
        if (!line) { results.push({ rep: r.email, skip: 'no_quo_line' }); continue; }
        const text = 'Call block today 10-2. Hop on the Meet and let\u2019s get you some meetings booked. See you at 10.';
        if (dry) { results.push({ rep: r.email, from: line, to: to, dry: true, text: text }); continue; }
        results.push(Object.assign({ rep: r.email }, await sendTeamSms(line, to, text)));
    }
    return { sent: results };
}

async function jobEvening(dry) {
    const roster = await activeRoster();
    const sdrs = roster.filter(isSdr);
    const act = await repActivity(sdrs.map(function (r) { return String(r.email).toLowerCase(); }));
    const results = [];
    for (const r of sdrs) {
        const email = String(r.email).toLowerCase();
        const to = PERSONAL[email];
        if (!to) { results.push({ rep: r.email, skip: 'no_personal_number' }); continue; }
        const line = normalizePhone(r.openphone_number);
        if (!line) { results.push({ rep: r.email, skip: 'no_quo_line' }); continue; }
        const a = act[email];
        let text;
        if (a.today > 0) {
            text = 'Nice work today, ' + a.today + (a.today === 1 ? ' dial' : ' dials') + ' in. Drop your stats in the STILO groupchat before you log off.';
        } else {
            const mins = Math.round(a.week_talk_sec / 60);
            text = 'No dials logged today. This week so far: ' + a.week + ' dials, ' + mins + ' min on the phone'
                + (a.week_meetings ? ', ' + a.week_meetings + ' meeting' + (a.week_meetings === 1 ? '' : 's') + ' booked' : '')
                + '. Target is ' + DIAL_TARGET + ' a day. Tomorrow we go again.';
        }
        if (dry) { results.push({ rep: r.email, from: line, to: to, dials_today: a.today, dry: true, text: text }); continue; }
        results.push(Object.assign({ rep: r.email, dials_today: a.today }, await sendTeamSms(line, to, text)));
    }
    return { sent: results };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const ok = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!ok) return res.status(401).json({ error: 'unauthorized' });

    const job = (req.query && req.query.job) || '';
    // ?dry=1 computes and returns exactly what WOULD go out, sending nothing.
    const dry = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));
    try {
        let out;
        if (job === 'invite') out = await jobInvite(dry);
        else if (job === 'morning') out = await jobMorning(dry);
        else if (job === 'evening') out = await jobEvening(dry);
        else return res.status(400).json({ error: 'unknown_job', valid: ['invite', 'morning', 'evening'] });
        return res.status(200).json(Object.assign({ ok: true, job: job }, out));
    } catch (e) {
        console.error('[team-rituals:' + job + ']', e);
        return res.status(500).json({ error: 'job_failed', detail: e.message });
    }
};
