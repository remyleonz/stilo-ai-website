/**
 * POST /api/prospects/book-meeting
 * Body: { lead_id, when_iso, duration_min? (default 30) }
 *
 * Single endpoint that does the full booking flow:
 *   1. Look up the lead (need owner_email + business_name)
 *   2. Create a Google Calendar event with a Google Meet link auto-attached
 *   3. Send the prospect a STILO-branded confirmation email via Resend
 *   4. Write the outcome through David's /api/prospects/{id}/log-call so
 *      the lead lands in the Booked Meeting tab and last_called_outcome
 *      reflects 'booked_meeting'
 *
 * If GOOGLE_OAUTH_* aren't configured, returns 503 — frontend shows a
 * "Configure Google Calendar" prompt instead of a broken flow.
 */
const { assertAdminOrSdr, methodNotAllowed, readJsonBody, safeNumberId } = require('./_shared');
const { getCalendarRefreshToken, accessTokenFromRefresh, isReauthError, REAUTH_URL } = require('./_google_calendar');
const { createClient } = require('@supabase/supabase-js');
const { sendConfirmEmail: sendVslConfirmEmail, agentKey, AGENTS } = require('./_vsl');
const {
    getMeetRefreshToken, accessTokenFromRefresh: meetAccessToken,
    meetingCodeFromLink: meetMeetingCode, enableAutoTranscription
} = require('./_google_meet');

function buildEmailHtml(opts) {
    // STILO-branded confirmation. No em dashes, no AI buzzwords (humanizer rules).
    // Inline CSS only — every email client murders <style> blocks.
    const fmt = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        timeZone: 'America/New_York'
    });
    const whenStr = fmt.format(new Date(opts.whenIso));
    const senderName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    return [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;font-size:15px;line-height:1.55;">',
        '<p>Hi ' + escapeHtml(opts.firstName || 'there') + ',</p>',
        '<p>Quick confirmation. Our call is locked in for <strong>' + escapeHtml(whenStr) + '</strong>.</p>',
        '<p>Google Meet link: <a href="' + escapeHtml(opts.meetLink) + '" style="color:#2563EB;">' + escapeHtml(opts.meetLink) + '</a></p>',
        '<p>What we will cover in 15 minutes:</p>',
        '<ul style="padding-left:20px;margin:8px 0 16px;">',
        '<li>What ' + escapeHtml(opts.businessName || 'your business') + ' is doing today vs where the AI agents fit</li>',
        '<li>The two or three highest-ROI use cases for your specific setup</li>',
        '<li>What a 30 day pilot looks like, with numbers</li>',
        '</ul>',
        '<p>If anything comes up before then, just reply to this email and we will reschedule.</p>',
        '<p>Talk soon,<br/>' + escapeHtml(senderName) + '</p>',
        '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;" />',
        '<table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;color:#374151;">',
        '<tr><td style="padding-right:12px;"><strong style="color:#111;">' + escapeHtml(senderName) + '</strong><br/>STILO AI Partners<br/><a href="https://stiloaipartners.com" style="color:#2563EB;text-decoration:none;">stiloaipartners.com</a> · +1 786 876 8677</td></tr>',
        '</table>',
        '</div>'
    ].join('');
}
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

async function sendConfirmationEmail(opts) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    if (!opts.toEmail) return { skipped: 'no_lead_email' };
    const fromName = process.env.STILO_SENDER_NAME || 'Remy Leon';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const replyTo = process.env.STILO_REPLY_TO || fromEmail;
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: [opts.toEmail],
            reply_to: replyTo,
            subject: 'Confirmed: ' + (opts.businessName || 'STILO discovery call'),
            html: buildEmailHtml(opts)
        })
    });
    const json = await r.json().catch(function () { return {}; });
    return { status: r.status, id: json.id, error: r.ok ? null : (json.message || 'send_failed') };
}

// Internal heads-up to the STILO inbox on every booking. Google never emails the
// organizer their own event, so without this the team never gets a confirmation.
// Sends to STILO_NOTIFY_EMAIL (falls back to the sender address).
async function sendInternalNotification(opts) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    // Send the booking heads-up to Remy, David, AND the SDR who booked it.
    var recips = [process.env.STILO_NOTIFY_EMAIL || 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];
    if (opts.sdrEmail) recips.push(opts.sdrEmail);
    var toList = recips.map(function (e) { return String(e || '').toLowerCase().trim(); })
        .filter(function (e) { return e && /.+@.+\..+/.test(e); })
        .filter(function (e, i, a) { return a.indexOf(e) === i; });
    const toEmail = toList[0];
    const fromName = process.env.STILO_SENDER_NAME || 'STILO AI Partners';
    const fromEmail = process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com';
    const whenStr = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short', timeZone: 'America/New_York'
    }).format(new Date(opts.whenIso));
    const html = [
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;font-size:15px;line-height:1.55;">',
        '<p><strong>New meeting booked.</strong></p>',
        '<ul style="padding-left:20px;margin:8px 0 16px;">',
        '<li>Business: <strong>' + escapeHtml(opts.businessName || '') + '</strong></li>',
        '<li>When: <strong>' + escapeHtml(whenStr) + '</strong></li>',
        '<li>Booked by: ' + escapeHtml(opts.bookedBy || 'STILO') + '</li>',
        '<li>Contact: ' + escapeHtml(opts.contact || 'n/a') + (opts.phone ? ' &middot; ' + escapeHtml(opts.phone) : '') + (opts.email ? ' &middot; ' + escapeHtml(opts.email) : '') + '</li>',
        opts.meetLink ? '<li>Google Meet: <a href="' + escapeHtml(opts.meetLink) + '" style="color:#2563EB;">' + escapeHtml(opts.meetLink) + '</a></li>' : '',
        '</ul>',
        '<p style="color:#374151;font-size:13px;">It is on your calendar and the prospect has the invite.</p>',
        '</div>'
    ].join('');
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: fromName + ' <' + fromEmail + '>',
            to: toList,
            subject: 'New meeting booked: ' + (opts.businessName || 'STILO') + ' (' + whenStr + ')',
            html: html
        })
    });
    const json = await r.json().catch(function () { return {}; });
    return { status: r.status, id: json.id, error: r.ok ? null : (json.message || 'send_failed') };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req);
    const leadId = safeNumberId(body.lead_id);
    const whenIso = body.when_iso;
    const durationMin = Math.min(Math.max(Number(body.duration_min) || 15, 15), 120);
    if (leadId == null) return res.status(400).json({ error: 'missing_lead_id' });
    if (!whenIso) return res.status(400).json({ error: 'missing_when_iso' });

    const refreshToken = await getCalendarRefreshToken();
    if (!refreshToken) {
        return res.status(503).json({
            error: 'google_calendar_not_configured',
            detail: 'The STILO booking calendar is not connected. Open /api/oauth?provider=google-calendar&action=start signed in as remyleon@stiloaipartners.com to link it.'
        });
    }

    // Look up lead
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
    const { data: lead, error: leadErr } = await sb.from('leads')
        // meeting_event_id is load-bearing: the reschedule path needs it to
        // cancel the previous calendar event. It was missing here, so a
        // reschedule left the old event orphaned on the calendar.
        .select('id,name,owner_name,owner_email,email,owner_phone,phone,call_attempts,meeting_scheduled_at,meeting_meet_link,meeting_event_link,meeting_event_id')
        .eq('id', leadId).maybeSingle();
    if (leadErr) return res.status(500).json({ error: 'lead_read_failed', detail: leadErr.message });
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // Follow-up booking (a client wants a 2nd/3rd meeting): unlike a reschedule,
    // which MOVES the current meeting, a follow-up must KEEP the prior one. Snapshot
    // the lead's current meeting into lead_meetings history BEFORE we overwrite the
    // meeting_* columns below, so re-opening the lead shows every meeting. A plain
    // reschedule (is_followup falsy) skips this and just rewrites the time.
    const isFollowup = body.is_followup === true || body.is_followup === 'true';
    if (isFollowup && lead.meeting_scheduled_at) {
        try {
            const priorWhen = new Date(lead.meeting_scheduled_at);
            await sb.from('lead_meetings').insert({
                lead_id: leadId,
                source: 'booked',
                title: 'Earlier meeting (' + priorWhen.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET)',
                occurred_at: priorWhen.toISOString(),
                summary: 'Scheduled meeting that a follow-up was booked after. Moved into history so both meetings are tracked.',
                meet_url: lead.meeting_meet_link || lead.meeting_event_link || null,
                created_by: gate.email || null
            });
        } catch (_) { /* history snapshot is best-effort; never block the booking */ }
    }

    // Email the rep typed/confirmed in the booking form wins, then the lead's
    // stored address. The SDR UI requires a valid email before booking.
    const typedEmail = (body.email && String(body.email).trim()) || null;
    const ownerEmail = typedEmail || lead.owner_email || lead.email || null;
    const ownerPhone = lead.owner_phone || lead.phone || null;
    const businessName = lead.name || 'Discovery call';
    const ownerName = (lead.owner_name || '').trim() || null;
    const ownerFirstName = (lead.owner_name || '').trim().split(/\s+/)[0] || null;
    const startIso = new Date(whenIso).toISOString();
    const endIso = new Date(new Date(whenIso).getTime() + durationMin * 60000).toISOString();

    let accessToken;
    try {
        accessToken = await accessTokenFromRefresh(refreshToken);
    } catch (e) {
        // Dead refresh token: surface a clean reconnect signal so the booking
        // button shows "reconnect the calendar" instead of a generic failure.
        if (isReauthError(e)) {
            return res.status(409).json({
                error: 'calendar_reauth_required',
                reauth_url: REAUTH_URL,
                detail: 'The booking calendar connection expired and needs to be reconnected before meetings can be booked.'
            });
        }
        return res.status(502).json({ error: 'calendar_auth_failed', detail: String(e.message || e) });
    }

    try {
        // Pull the contact (name / email / phone) onto the event so Remy's
        // calendar shows who he's meeting — the same fields Google's booking
        // form would have collected, but auto-filled from our lead data so the
        // SDR never types them.
        const contactLines = [
            'Contact: ' + (ownerName || 'Owner (verify on call)'),
            ownerPhone ? 'Phone: ' + ownerPhone : null,
            ownerEmail ? 'Email: ' + ownerEmail : null,
            '',
            'Discovery call to walk through the AI agent fit for ' + businessName + '. Booked from the STILO SDR dashboard.'
        ].filter(function (l) { return l !== null; });
        const eventBody = {
            summary: 'STILO AI Partners discovery · ' + businessName,
            description: contactLines.join('\n'),
            start: { dateTime: startIso, timeZone: 'America/New_York' },
            end: { dateTime: endIso, timeZone: 'America/New_York' },
            // David Coira (cofounder) rides every booked meeting so it lands on
            // his calendar and he can join, without sharing the whole calendar.
            // Pre-accepted so it shows confirmed on his side, not "needs response".
            attendees: [{ email: 'davidcoira@stiloaipartners.com', displayName: 'David Coira (STILO)', responseStatus: 'accepted' }]
                .concat(ownerEmail ? [{ email: ownerEmail, displayName: ownerName || businessName }] : []),
            conferenceData: { createRequest: { requestId: 'stilo-' + leadId + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
            reminders: { useDefault: true }
        };
        // CANCEL THE PREVIOUS EVENT BEFORE CREATING THE NEW ONE.
        //
        // Rescheduling created a second calendar event and orphaned the first.
        // Remy's calendar showed JSE Insurance at both Mon 5pm and Thu 5pm on
        // 2026-07-20, and the prospect kept a live invite to a meeting nobody
        // was attending. Only meeting_event_id gets overwritten, so the old
        // event was unreachable afterwards and had to be deleted by hand.
        //
        // sendUpdates=all so the prospect's calendar actually clears; they get
        // one cancellation and then one new invite, which reads correctly as a
        // reschedule. Best effort: never block a booking on cleanup of an old
        // event that may already be gone.
        if (lead.meeting_event_id) {
            try {
                const del = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/'
                    + encodeURIComponent(lead.meeting_event_id) + '?sendUpdates=all', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + accessToken }
                });
                // 410 = already deleted, 404 = never existed. Both are fine.
                if (!del.ok && del.status !== 404 && del.status !== 410) {
                    console.error('[book-meeting] could not cancel previous event ' + lead.meeting_event_id + ': HTTP ' + del.status);
                }
            } catch (e) {
                console.error('[book-meeting] cancel of previous event threw:', (e && e.message) || e);
            }
        }

        const ev = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify(eventBody)
        });
        if (!ev.ok) {
            const text = await ev.text();
            return res.status(502).json({ error: 'calendar_create_failed', detail: text.slice(0, 400) });
        }
        const evJson = await ev.json();
        const meetLink = (evJson.conferenceData && evJson.conferenceData.entryPoints
            && (evJson.conferenceData.entryPoints.find(function (p) { return p.entryPointType === 'video'; }) || {}).uri)
            || evJson.hangoutLink || null;

        // Turn AUTO-TRANSCRIPTION on for this Meet space.
        //
        // Meet does not transcribe by default; the host has to click Start in
        // the call, every call. That lost Hugo Garcia's 33-minute meeting on
        // 2026-07-20 — the conference record existed with both participants and
        // zero transcripts. The org-wide Admin console default needs Business
        // Plus; we're on Standard, so this per-space call is the only route.
        // The Calendar API cannot do it (no meeting-records field exists).
        //
        // Best-effort: a booking must NEVER fail because transcription config
        // failed. Worst case we lose a transcript, not a meeting.
        let autoTranscript = null;
        try {
            const code = meetMeetingCode(meetLink);
            if (code) {
                const meetRefresh = await getMeetRefreshToken();
                if (meetRefresh) {
                    const meetToken = await meetAccessToken(meetRefresh);
                    const r = await enableAutoTranscription(meetToken, code);
                    autoTranscript = r.autoTranscription || 'unknown';
                } else {
                    autoTranscript = 'not_authorized';
                }
            }
        } catch (e) {
            autoTranscript = 'failed: ' + ((e && e.message) || e);
            console.error('[book-meeting] auto-transcription setup failed for lead=' + leadId + ':', (e && e.message) || e);
        }

        // Branded confirmation email (best-effort; don't fail booking if email fails)
        let emailResult = null;
        try {
            emailResult = await sendConfirmationEmail({
                toEmail: ownerEmail, firstName: ownerFirstName, businessName: businessName,
                whenIso: startIso, meetLink: meetLink || ''
            });
        } catch (e) { emailResult = { error: String(e.message || e) }; }

        // Second, STILO-branded "confirm your meeting" email with the VSL button.
        // No-op unless VSL_FLOW_ENABLED === 'true' (guarded inside sendVslConfirmEmail),
        // so this stays dark until the VSL videos are filmed and the flow is flipped on.
        // Agent defaults to 'echo' when the SDR hasn't set which one we're selling.
        try {
            await sendVslConfirmEmail({
                leadId: leadId, toEmail: ownerEmail, firstName: ownerFirstName,
                businessName: businessName, whenIso: startIso, agent: body.agent
            });
        } catch (e) { /* never block booking on the VSL email */ }

        // Internal heads-up so the STILO team gets an email on every booking too
        // (Google only emails the guest, never the organizer). Best-effort.
        // Resolve the SDR's real name from sdr_users so the email reads
        // "Booked by: Alejandro Barrios" instead of a raw login email.
        let bookedByName = gate.email || null;
        try {
            const pubSb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
            const { data: sdrRow } = await pubSb.from('sdr_users').select('display_name').eq('email', gate.email).maybeSingle();
            if (sdrRow && sdrRow.display_name) bookedByName = sdrRow.display_name;
        } catch (_) { /* fall back to the email */ }
        try {
            await sendInternalNotification({
                businessName: businessName, whenIso: startIso, meetLink: meetLink || '',
                bookedBy: bookedByName, sdrEmail: gate.email || null, contact: ownerName, email: ownerEmail, phone: ownerPhone
            });
        } catch (e) { /* never block the booking on the internal notification */ }

        // Persist Calendar/Meet metadata AND flip the lead lifecycle to
        // booked_meeting in one Supabase write. This is the source of truth
        // for the Booked Meeting tab (list-booked reads last_called_outcome
        // straight from prospecting.leads). We no longer round-trip David's
        // Cloud Run /log-call here — that call hangs under load and would
        // leave a created Calendar event with the lead stuck in Cold Call.
        let persistError = null;
        try {
            const updateRow = {
                meeting_event_id:      evJson.id || null,
                meeting_event_link:    evJson.htmlLink || null,
                meeting_meet_link:     meetLink || null,
                meeting_scheduled_at:  startIso,
                meeting_duration_min:  durationMin,
                meeting_booked_by_sdr: gate.email || null,
                meeting_booked_at:     new Date().toISOString(), // when the rep booked it (drives Team-tab productivity, not the meeting date)
                last_called_outcome:   'booked_meeting',
                last_called_at:        new Date().toISOString(),
                call_attempts:         (Number(lead.call_attempts) || 0) + 1,
                call_notes:            'Booked ' + new Date(startIso).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET · ' + (meetLink || 'no Meet link')
            };
            // Save the email the rep captured on the call so the lead has it going forward.
            if (typedEmail && !lead.owner_email) updateRow.owner_email = typedEmail;

            // The booking modal previews the confirmation email and lets the rep
            // edit it. Persist an edit so send-confirmations.js sends THEIR words
            // rather than the template. Sending the template after showing them
            // an editable box would make the preview a lie.
            //
            // Only store a real change: if the text still matches the generated
            // default, keep the columns NULL so future edits to the template
            // still reach this lead instead of being frozen at today's wording.
            if (typeof body.confirmation_subject === 'string' || typeof body.confirmation_body === 'string') {
                const { buildConfirmation } = require('./_confirmation_email');
                const def = buildConfirmation({
                    lead: lead, agent: body.agent || null, whenIso: startIso,
                    repName: (bookedByName || 'Remy').split(/\s+/)[0],
                });
                const subj = typeof body.confirmation_subject === 'string' ? body.confirmation_subject.trim() : null;
                const bod = typeof body.confirmation_body === 'string' ? body.confirmation_body.trim() : null;
                updateRow.confirmation_email_subject = (subj && subj !== def.subject) ? subj.slice(0, 500) : null;
                updateRow.confirmation_email_body = (bod && bod !== def.body) ? bod.slice(0, 20000) : null;
            }

            // RESET THE PER-MEETING NURTURE STAMPS WHEN THE MEETING MOVES.
            //
            // Every nurture cron is idempotent on a stamp and eligible only when
            // that stamp IS NULL. Those stamps describe a MEETING, but they live
            // on the LEAD — so a second meeting inherits the first one's stamps
            // and the whole sequence silently skips it.
            //
            // Found live on Hugo Garcia (lead 16050): rebooked for Friday, but
            // meeting_confirmation_sent_at and meeting_reminder_sent_at still
            // held values from the previous meeting. He would have received no
            // confirmation email, no VSL link, and no T-15 reminder, with nothing
            // logging a reason. Every rebooked lead has had this.
            //
            // meeting_confirmed_at clears too: a confirmation of the OLD meeting
            // is not a confirmation of the new one, and leaving it makes the
            // callback calendar show a meeting as confirmed that nobody agreed to.
            const movedTo = new Date(startIso).getTime();
            const movedFrom = lead.meeting_scheduled_at ? new Date(lead.meeting_scheduled_at).getTime() : null;
            if (movedFrom === null || movedFrom !== movedTo) {
                updateRow.meeting_confirmation_sent_at = null;
                updateRow.meeting_confirmed_at = null;
                updateRow.meeting_reminder_sent_at = null;
                updateRow.vsl_followup_sms_sent_at = null;
                updateRow.day_before_sms_sent_at = null;
                updateRow.nurture_stage = 'booked';
            }
            // PERSIST THE REP'S AGENT PICK. Without this the choice only reached
            // the immediate confirmation email and was then lost: the
            // send-confirmations cron re-derives a slug from matched_product_name,
            // so a rep who sold the receptionist could have the follow-up pitch
            // something else entirely. pitch_agent is the single source of truth
            // for which agent a lead pitches, so the rep's pick — made on the
            // call, with the prospect — overrides David's script parse.
            if (body.agent) {
                const picked = agentKey(body.agent);
                if (picked) {
                    updateRow.pitch_agent = (AGENTS[picked] && AGENTS[picked].name) || picked;
                    updateRow.matched_product_name = updateRow.pitch_agent;
                }
            }
            const upd = await sb.from('leads').update(updateRow).eq('id', leadId);
            if (upd.error) persistError = upd.error.message;
        } catch (e) { persistError = String(e.message || e); }

        // Mirror the call into prospecting.lead_calls so it shows in call
        // history + "Calls Today". Best-effort; never block the booking.
        try {
            await sb.from('lead_calls').insert({
                lead_id: leadId, direction: 'outbound', outcome: 'booked_meeting',
                called_at: new Date().toISOString(), logged_by: gate.email || null,
                transcript_summary: 'Meeting booked for ' + new Date(startIso).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET'
            });
        } catch (_) { /* lead_calls is a nice-to-have here */ }

        return res.status(200).json({
            ok: true, lead_id: leadId,
            event_id: evJson.id, event_link: evJson.htmlLink, meet_link: meetLink,
            email: emailResult,
            persisted: !persistError, persist_error: persistError
        });
    } catch (e) {
        console.error('[book-meeting]', e);
        return res.status(500).json({ error: 'booking_failed', detail: String(e.message || e) });
    }
};
