/**
 * GET /api/prospects/vsl-nurture?dry=1&cap=N   (Vercel cron, every 15 min)
 *
 * Follow-up for the INTERESTED-LEAD VSL email: the one a rep sends by hand from
 * the lead drawer after a real phone conversation ("thanks for taking the call,
 * here is a short video").
 *
 * Until now that email had no follow-up at all. send-vsl-followup.js only covers
 * flow='confirm', which is the POST-BOOKING nurture. So a prospect who got the
 * video and did nothing was never chased, and a prospect who WATCHED it was
 * never handed back to the rep. Raul Pena watched the whole thing four hours
 * after Alejandro's email on 2026-08-17 and nothing happened.
 *
 * ---------------------------------------------------------------------------
 * THE ANCHOR
 *
 * The sequence is keyed to leads.vsl_nurture_anchor_at, which is the send time
 * of the rep's VSL email. It is NOT keyed to the lead. That distinction has bitten
 * this codebase three times (nurture stamps, meeting reminders, rebooking): a
 * stamp that lives on the entity makes the SECOND occurrence silently skip the
 * whole sequence. Here, if a rep sends a new VSL email later, the anchor moves
 * and steps 1-3 reset, so the prospect gets a fresh sequence.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, and why the gates differ per step
 *
 *   step 1  anchor +1d   EMAIL  only if they never LANDED on the page
 *   step 2  anchor +3d   SMS    only if they have never PLAYED it
 *   step 3  anchor +5d   EMAIL  only if they have never PLAYED it
 *
 * Step 1 gates on a view because its whole premise is "the link got buried."
 * Sending that to someone who visibly opened the page reads as not paying
 * attention. Steps 2 and 3 gate on a play, because landing on the page and not
 * pressing play is exactly the person this sequence is for.
 *
 * A view is NOT a play. Most views are link scanners hitting the URL seconds
 * after our own send from a datacentre browser, so gating anything on views
 * alone would drop real prospects out of the sequence. Only `play` is treated as
 * "they watched."
 *
 * ---------------------------------------------------------------------------
 * EXITS. Permanent, recorded in leads.vsl_nurture_exit_reason:
 *   played        they pressed play. Sequence stops and the rep calls them.
 *                 A robot must not keep texting someone who is ready to talk.
 *   replied       any inbound message after the anchor. A human took over.
 *   booked        meeting_booked_at set.
 *   do_not_call / suppressed / bounced
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - VSL_NURTURE_ENABLED must be exactly 'true' or nothing sends. Same
 *     default-closed contract as OUTBOUND_SEND_ENABLED and EMAIL_SEQUENCE_ENABLED.
 *   - ?dry=1 returns the full plan and the rendered copy, and sends nothing.
 *   - The sent_at stamp is written BEFORE the send is attempted and is
 *     conditional on the column still being null, so a failed send can never
 *     loop and two overlapping ticks can never both send the same step.
 *   - Every rendered body runs through _vsl_nurture_copy.validate() and a send
 *     is REFUSED on any failure. A brief is not a guarantee.
 *   - guardOutbound() from _sms.js is the backstop against runaway duplicates.
 *   - Weekday 09:00-18:00 ET window. Outside it the cron is a no-op, but a dry
 *     run still reports the full plan.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin/SDR JWT for manual runs.
 */
const { assertAdminOrSdr } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');
const { sendSms, guardOutbound } = require('./_sms');
const { nicheForLead, baseUrl } = require('./_vsl');
const { firstName } = require('./_names');
const kit = require('./_email_kit');
const copy = require('./_vsl_nurture_copy');
const { signLead } = require('../public/_token');

const SEND_ENABLED = String(process.env.VSL_NURTURE_ENABLED || '').toLowerCase() === 'true';
const SENDER_EMAIL = process.env.VSL_SENDER_EMAIL || 'remyleon@stiloaipartners.com';

const OFFSET_DAYS = { 1: 1, 2: 3, 3: 5 };
const WINDOW = { tz: 'America/New_York', startMin: 9 * 60, endMin: 18 * 60 };

// How far back to look for an anchor. A VSL email from two months ago is not a
// sequence worth starting today; the conversation is cold and the rep should
// just call. Also bounds the query.
const ANCHOR_LOOKBACK_DAYS = 21;

function windowState() {
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: WINDOW.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    const weekday = !['Sat', 'Sun'].includes(p.weekday);
    const minutes = Number(p.hour) * 60 + Number(p.minute);
    return {
        open: weekday && minutes >= WINDOW.startMin && minutes < WINDOW.endMin,
        weekday: p.weekday, local: p.hour + ':' + p.minute + ' ET',
    };
}

module.exports = async function handler(req, res) {
    const authHeader = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }

    const dry = String((req.query && req.query.dry) || '') === '1';
    const cap = Math.min(Number((req.query && req.query.cap) || 40), 150);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
    });

    const now = Date.now();
    const win = windowState();
    const skipped = {
        no_niche: 0, no_email: 0, not_due: 0, already_sent: 0, window_closed: 0,
        exit_played: 0, exit_replied: 0, exit_booked: 0, exit_dnc: 0,
        no_sms_number: 0, copy_rejected: 0, guard_blocked: 0,
    };

    // ── 1. Find every anchor: rep-sent VSL emails in the lookback window.
    // Excludes the cold sequence (variant seq_%) and meeting confirmations,
    // which carry the same /vsl/ substring but are not this flow.
    const anchorSince = new Date(now - ANCHOR_LOOKBACK_DAYS * 864e5).toISOString();
    const { data: anchorRows, error: aErr } = await sb.from('lead_messages')
        .select('lead_id, sent_at, sent_by, variant')
        .eq('direction', 'outbound').eq('channel', 'email')
        .gte('sent_at', anchorSince)
        .like('body', '%/vsl/%')
        .order('sent_at', { ascending: false })
        .limit(2000);
    if (aErr) return res.status(500).json({ error: 'anchor_read_failed', detail: aErr.message });

    const anchors = new Map();   // lead_id -> { at, by }
    for (const r of (anchorRows || [])) {
        if (!r.lead_id) continue;
        const v = String(r.variant || '');
        if (v.startsWith('seq_') || v === 'meeting_confirm') continue;
        if (!anchors.has(r.lead_id)) anchors.set(r.lead_id, { at: r.sent_at, by: r.sent_by || null });
    }
    if (!anchors.size) {
        return res.status(200).json({ ok: true, dry, window: win, due_now: 0, sent: 0, skipped, note: 'no VSL emails in lookback' });
    }
    const ids = [...anchors.keys()];

    // ── 2. Load the leads and everything that could exit them.
    const { data: leads, error: lErr } = await sb.from('leads')
        .select('id,name,owner_name,niche,category,address,assigned_to,owner_email,email,'
            + 'owner_phone_e164,owner_phone,phone,do_not_call,meeting_booked_at,'
            + 'vsl_nurture_anchor_at,vsl_nurture_1_sent_at,vsl_nurture_2_sent_at,vsl_nurture_3_sent_at')
        .in('id', ids);
    if (lErr) return res.status(500).json({ error: 'leads_read_failed', detail: lErr.message });

    const { data: plays } = await pub.from('vsl_events')
        .select('lead_id, created_at').eq('event', 'play').in('lead_id', ids);
    const { data: views } = await pub.from('vsl_events')
        .select('lead_id, created_at').eq('event', 'view').in('lead_id', ids);
    const { data: inbound } = await sb.from('lead_messages')
        .select('lead_id, sent_at').eq('direction', 'inbound').in('lead_id', ids);
    const { data: bounced } = await sb.from('lead_messages')
        .select('lead_id').eq('direction', 'outbound').not('bounced_at', 'is', null).in('lead_id', ids);

    const latest = (rows) => {
        const m = new Map();
        for (const r of (rows || [])) {
            if (!r.lead_id) continue;
            const t = new Date(r.created_at || r.sent_at).getTime();
            if (!m.has(r.lead_id) || t > m.get(r.lead_id)) m.set(r.lead_id, t);
        }
        return m;
    };
    const playAt = latest(plays), viewAt = latest(views), replyAt = latest(inbound);
    const bouncedSet = new Set((bounced || []).map(r => r.lead_id));

    const { data: sup } = await pub.from('lcr_suppressions').select('email');
    const suppressed = new Set((sup || []).map(r => String(r.email || '').toLowerCase()));

    const { data: sdrs } = await pub.from('sdr_users').select('email,display_name,openphone_number,active');
    const repBy = {};
    for (const s of (sdrs || [])) repBy[s.email] = s;

    // ── 3. Decide the due step for each lead.
    const plan = [];
    for (const l of (leads || [])) {
        const anc = anchors.get(l.id);
        if (!anc) continue;
        const ancMs = new Date(anc.at).getTime();

        // Anchor moved (rep re-sent the video) -> reset the ladder.
        const storedMs = l.vsl_nurture_anchor_at ? new Date(l.vsl_nurture_anchor_at).getTime() : 0;
        const isNewAnchor = ancMs > storedMs + 1000;
        const sent = isNewAnchor
            ? { 1: null, 2: null, 3: null }
            : { 1: l.vsl_nurture_1_sent_at, 2: l.vsl_nurture_2_sent_at, 3: l.vsl_nurture_3_sent_at };

        if (l.do_not_call) { skipped.exit_dnc++; continue; }
        if (l.meeting_booked_at) { skipped.exit_booked++; continue; }
        if ((playAt.get(l.id) || 0) > ancMs) { skipped.exit_played++; continue; }
        if ((replyAt.get(l.id) || 0) > ancMs) { skipped.exit_replied++; continue; }
        if (bouncedSet.has(l.id)) { skipped.exit_dnc++; continue; }

        const niche = nicheForLead(l);
        if (!niche || !copy.NICHE[niche]) { skipped.no_niche++; continue; }

        // First unsent step whose offset has elapsed.
        let step = null;
        for (const s of [1, 2, 3]) {
            if (sent[s]) continue;
            if (now < ancMs + OFFSET_DAYS[s] * 864e5) { skipped.not_due++; break; }
            step = s; break;
        }
        if (!step) { if (sent[3]) skipped.already_sent++; continue; }

        // Step 1's premise is "the link got buried". Do not send it to someone
        // who demonstrably landed on the page.
        if (step === 1 && (viewAt.get(l.id) || 0) > ancMs) {
            plan.push({ id: l.id, skip_to: 2, reason: 'already_viewed_page' });
            continue;
        }

        const rep = repBy[anc.by] || repBy[l.assigned_to] || null;
        const to = String(l.owner_email || l.email || '').trim();
        const slug = niche;
        const link = baseUrl() + '/vsl/' + slug + '?lid=' + l.id + '&t=' + signLead(l.id);

        const ctx = {
            first: firstName(l.owner_name, { business: l.name, address: l.address }) || 'there',
            company: l.name,
            niche: niche,
            link: link,
            repFirstLower: String((rep && rep.display_name) || 'remy').split(' ')[0].toLowerCase(),
        };
        ctx.firstLower = String(ctx.first).toLowerCase();

        if (step === 2) {
            const toPhone = l.owner_phone_e164 || l.owner_phone || l.phone;
            if (!toPhone) { skipped.no_sms_number++; continue; }
            const rendered = copy.step2(ctx);
            const bad = copy.validate(2, rendered);
            if (bad.length) { skipped.copy_rejected++; continue; }
            plan.push({ id: l.id, step: 2, channel: 'sms', to: toPhone, niche,
                from: (rep && rep.active && rep.openphone_number) || null, body: rendered.body, anchor_at: anc.at });
        } else {
            if (!to || suppressed.has(to.toLowerCase())) { skipped.no_email++; continue; }
            const rendered = step === 1 ? copy.step1(ctx) : copy.step3(ctx);
            const bad = copy.validate(step, rendered);
            if (bad.length) { skipped.copy_rejected++; continue; }
            plan.push({ id: l.id, step, channel: 'email', to, niche,
                subject: rendered.subject, body: rendered.body, anchor_at: anc.at });
        }
        if (plan.length >= cap) break;
    }

    const sendable = plan.filter(p => p.step);
    if (dry) {
        return res.status(200).json({
            ok: true, dry: true, window: win, send_enabled_env: SEND_ENABLED,
            due_now: sendable.length, by_step: sendable.reduce((a, p) => (a['step' + p.step] = (a['step' + p.step] || 0) + 1, a), {}),
            skipped, plan: sendable.slice(0, 25),
        });
    }
    if (!SEND_ENABLED) return res.status(200).json({ ok: true, sent: 0, due_now: sendable.length, skipped, note: 'VSL_NURTURE_ENABLED is not true' });
    if (!win.open) { skipped.window_closed = sendable.length; return res.status(200).json({ ok: true, sent: 0, window: win, skipped }); }

    // ── 4. Send. Stamp FIRST, conditionally, so a failure can never loop.
    const senderIdentity = await kit.getSenderIdentity(SENDER_EMAIL);
    let sent = 0;
    const errors = [];
    for (const p of sendable) {
        const col = 'vsl_nurture_' + p.step + '_sent_at';
        const patch = { [col]: new Date().toISOString(), vsl_nurture_anchor_at: p.anchor_at };
        const { data: claimed, error: cErr } = await sb.from('leads')
            .update(patch).eq('id', p.id).is(col, null).select('id');
        if (cErr) { errors.push({ id: p.id, error: 'claim_failed: ' + cErr.message }); continue; }
        if (!claimed || !claimed.length) { skipped.already_sent++; continue; }   // another tick won

        try {
            if (p.channel === 'sms') {
                // sendSms is positional and runs guardOutbound('sms') itself, so
                // do not double-guard here: two calls would count the first as a
                // prior send and block the real one.
                const r = await sendSms(p.from || undefined, p.to, p.body, { leadId: p.id });
                if (r && r.skip) { skipped.guard_blocked++; continue; }
                if (!r || r.status < 200 || r.status >= 300) {
                    errors.push({ id: p.id, error: 'sms_' + ((r && r.status) || '?') + ': ' + ((r && r.err) || '') });
                    continue;
                }
            } else {
                // Email is not covered by sendSms's internal guard, so it needs
                // the explicit one.
                const g = await guardOutbound(p.id, 'email', p.body, p.subject);
                if (!g.ok) { skipped.guard_blocked++; continue; }
                const html = kit.buildEmailHtml({ bodyText: p.body, sender: senderIdentity });
                const resp = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from: 'Remy Leon <' + SENDER_EMAIL + '>',
                        to: [p.to], subject: p.subject, text: p.body, html,
                        headers: { 'List-Unsubscribe': '<mailto:' + SENDER_EMAIL + '?subject=unsubscribe>' },
                    }),
                });
                const j = await resp.json().catch(() => ({}));
                if (!resp.ok) { errors.push({ id: p.id, error: 'resend_' + resp.status + ': ' + (j.message || '') }); continue; }
                await sb.from('lead_messages').insert({
                    lead_id: p.id, direction: 'outbound', channel: 'email',
                    subject: p.subject, body: p.body, body_preview: p.body.slice(0, 280),
                    sent_at: new Date().toISOString(), to_address: p.to, from_address: SENDER_EMAIL,
                    provider: 'resend', provider_message_id: j.id || null,
                    variant: 'vslnur_' + p.niche + '_s' + p.step, status: 'sent',
                });
            }
            sent++;
        } catch (e) {
            errors.push({ id: p.id, error: (e && e.message) || String(e) });
        }
    }

    return res.status(200).json({ ok: true, window: win, sent, due_now: sendable.length, skipped, errors });
};

module.exports.maxDuration = 60;
