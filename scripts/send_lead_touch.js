/**
 * scripts/send_lead_touch.js
 *
 * Sends ONE email and/or ONE SMS to ONE lead from the command line, reusing the
 * exact modules the dashboard uses. For a hand-written follow-up to a named
 * prospect, where send_client_sequence.js (fixed copy, whole lane) is the wrong
 * shape.
 *
 * Reused, not reimplemented:
 *   _email_guard.canSend   dead domain / malformed / disposable
 *   _email_kit             client-branded HTML + footer (footer carries
 *                          clients.website, so the client's own site appears
 *                          under every message)
 *   _sms.sendSms           OpenPhone call + the 24h duplicate and rate guards
 *
 * Both channels log to lead_messages at send time, because _sms.js reads that
 * table to count sends and a message the guard cannot see is a message it
 * cannot count.
 *
 * Usage:
 *   node scripts/send_lead_touch.js --lead 31737 --email-subject "..." --email-file body.txt
 *   node scripts/send_lead_touch.js --lead 31737 --sms "..."
 *   ... add --send to actually send. Without it, always a dry run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
try {
    fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    });
} catch (e) { /* env may already be set */ }

const { createClient } = require('@supabase/supabase-js');
const guard = require(path.join(ROOT, 'api/prospects/_email_guard.js'));
const kit = require(path.join(ROOT, 'api/prospects/_email_kit.js'));
const { sendSms, guardOutbound, smsDedupeKey } = require(path.join(ROOT, 'api/prospects/_sms.js'));
const { normalizePhone } = require(path.join(ROOT, 'api/openphone/_shared.js'));

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const LEAD_ID = parseInt(arg('lead', '0'), 10);
const SUBJECT = arg('email-subject', null);
const BODY_FILE = arg('email-file', null);
const SMS_TEXT = arg('sms', null);
const SEND = args.includes('--send');

function sbLeads() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' },
    });
}
function sbPublic() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET;
    if (!secret) return null;
    const payload = b64url(JSON.stringify({ c: 'prospecting', e: String(email).toLowerCase(), ts: Date.now() }));
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return payload + '.' + sig;
}
/** Same correctness gate as the sequence script. A link is allowed here only in
 *  the footer, which the kit builds, never in the body we author. */
function preSendCheck(text) {
    const fails = [];
    if (/stilo/i.test(text)) fails.push('mentions STILO in client copy');
    if (/\$|\bprice\b|\bprecio\b|\bcost\b|starting at/i.test(text)) fails.push('mentions price');
    if (/[—–]/.test(text)) fails.push('contains an em or en dash');
    if (/hialeah/i.test(text)) fails.push('mentions Hialeah (say Miami; standing rule 2026-09-03)');
    if (/\bundefined\b|\bnull\b/.test(text)) fails.push('broken merge field');
    return fails;
}

async function main() {
    if (!LEAD_ID) { console.error('--lead is required'); process.exit(1); }
    const sb = sbLeads();
    const pub = sbPublic();

    const { data: lead, error } = await sb.from('leads')
        .select('id,name,owner_name,owner_email,phone,address,primary_language,client_id,do_not_call')
        .eq('id', LEAD_ID).maybeSingle();
    if (error || !lead) { console.error('lead not found', error); process.exit(1); }
    if (lead.do_not_call) { console.error('lead is do_not_call. nothing sent.'); process.exit(1); }

    let clientName = null, clientSite = '';
    if (lead.client_id) {
        const { data: c } = await pub.from('clients').select('business_name, website').eq('id', lead.client_id).maybeSingle();
        clientName = (c && c.business_name) || null;
        clientSite = (c && c.website) || '';
    }
    const sender = await kit.getSenderIdentity(process.env.STILO_SENDER_EMAIL);
    console.log('lead:   #' + lead.id + '  ' + lead.name);
    console.log('client: ' + (clientName || 'STILO') + (clientSite ? '  (' + clientSite + ')' : ''));
    console.log('mode:   ' + (SEND ? 'SENDING' : 'DRY RUN') + '\n');

    // ---------- EMAIL ----------
    if (SUBJECT && BODY_FILE) {
        const body = fs.readFileSync(BODY_FILE, 'utf8').trim();
        const to = String(lead.owner_email || '').trim();
        const fails = preSendCheck(SUBJECT + '\n' + body);
        const ok = await guard.canSend({ email: to });
        const dupe = await guardOutbound(lead.id, 'email', body, SUBJECT);
        const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', to).limit(1);

        const plain = kit.sanitizeCopy(body) + '\n\n' +
            (clientName
                ? kit.clientFooterText(sender, clientName, lead.primary_language === 'es', clientSite)
                : kit.footerText(sender));

        console.log('--- EMAIL -> ' + to + ' ---');
        console.log('subject: ' + SUBJECT);
        console.log(plain);
        console.log('--- checks: guard=' + (ok.ok ? 'pass' : ok.reason)
            + '  copy=' + (fails.length ? fails.join('; ') : 'pass')
            + '  dupe24h=' + (dupe.ok ? 'pass' : dupe.reason)
            + '  suppressed=' + (sup && sup.length ? 'YES' : 'no') + ' ---\n');

        if (SEND) {
            if (!ok.ok || fails.length || !dupe.ok || (sup && sup.length)) {
                console.log('EMAIL BLOCKED by a check above. Nothing sent.\n');
            } else {
                const fromEmail = (clientName && process.env.BLASON_SENDER_EMAIL) || sender.fromEmail;
                const fromName = '"' + sender.name.replace(/"/g, '') + ' · ' + (clientName || 'STILO AI Partners') + '"';
                const dedupeKey = crypto.createHash('sha1')
                    .update([lead.id, 'email', to, SUBJECT, Math.floor(Date.now() / 300000)].join('|')).digest('hex');
                const claim = await sb.from('lead_messages').insert({
                    lead_id: lead.id, direction: 'outbound', channel: 'email', subject: SUBJECT,
                    sent_at: new Date().toISOString(), sent_by: process.env.STILO_SENDER_EMAIL || null,
                    to_address: to, provider: 'resend', status: 'sending', dedupe_key: dedupeKey,
                    variant: 'manual_followup',
                }).select('id').single();
                if (claim.error) {
                    console.log('EMAIL claim failed: ' + claim.error.message + '\n');
                } else {
                    const html = clientName
                        ? kit.buildClientEmailHtml({ bodyText: body, sender: sender, clientName: clientName, es: lead.primary_language === 'es', website: clientSite })
                        : kit.buildEmailHtml({ bodyText: body, sender: sender });
                    const t = unsubToken(to);
                    const r = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            from: fromName + ' <' + fromEmail + '>', to: [to],
                            reply_to: process.env.STILO_REPLY_TO || fromEmail,
                            subject: SUBJECT, html: html, text: plain,
                            headers: t ? {
                                'List-Unsubscribe': '<https://stiloaipartners.com/api/unsubscribe?t=' + t + '>, <mailto:' + (process.env.STILO_REPLY_TO || fromEmail) + '?subject=unsubscribe>',
                                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                            } : undefined,
                        }),
                    });
                    const j = await r.json().catch(function () { return {}; });
                    if (!r.ok) {
                        await sb.from('lead_messages').delete().eq('id', claim.data.id);
                        console.log('EMAIL FAILED: ' + (j.message || ('http_' + r.status)) + '\n');
                    } else {
                        await sb.from('lead_messages').update({
                            body: plain, body_preview: plain.slice(0, 280), from_address: fromEmail,
                            provider_message_id: j.id || null, status: 'sent',
                        }).eq('id', claim.data.id);
                        console.log('EMAIL SENT  resend_id=' + j.id + '\n');
                    }
                }
            }
        }
    }

    // ---------- SMS ----------
    if (SMS_TEXT) {
        const fails = preSendCheck(SMS_TEXT);
        // Reply on whichever of our lines already has a thread with them, so the
        // message lands in the conversation they already know.
        const { data: prior } = await sb.from('lead_messages')
            .select('from_address,to_address,direction')
            .eq('lead_id', lead.id).eq('channel', 'sms')
            .order('sent_at', { ascending: false }).limit(1);
        const line = prior && prior.length
            ? (prior[0].direction === 'outbound' ? prior[0].from_address : prior[0].to_address)
            : null;

        console.log('--- SMS -> ' + lead.phone + '  from ' + (line || '(no prior thread)') + ' ---');
        console.log(SMS_TEXT);
        console.log('--- checks: copy=' + (fails.length ? fails.join('; ') : 'pass')
            + '  chars=' + SMS_TEXT.length + '  prior_thread=' + (line ? 'yes' : 'NO') + ' ---\n');

        if (SEND) {
            if (fails.length || !line) {
                console.log('SMS BLOCKED: ' + (fails.length ? fails.join('; ') : 'no prior SMS thread on any of our lines') + '\n');
            } else {
                const r = await sendSms(line, lead.phone, SMS_TEXT, { leadId: lead.id });
                if (r.skip || r.err) {
                    console.log('SMS FAILED: ' + (r.err || r.skip) + '\n');
                } else {
                    // Both this insert and the OpenPhone webhook write the same
                    // deterministic dedupe_key, and lead_messages_dedupe_key_uidx
                    // makes whichever loses the race collide instead of creating a
                    // second row. Either order is fine, which matters: on the
                    // 2026-08-31 send the webhook won by a second.
                    const ins = await sb.from('lead_messages').insert({
                        lead_id: lead.id, direction: 'outbound', channel: 'sms',
                        subject: 'Manual reply', body: SMS_TEXT, body_preview: SMS_TEXT.slice(0, 300),
                        to_address: normalizePhone(lead.phone) || lead.phone,
                        from_address: r.from || line, provider: 'openphone',
                        provider_message_id: r.messageId || null, status: 'sent',
                        sent_by: process.env.STILO_SENDER_EMAIL || null,
                        variant: 'manual_reply', sent_at: new Date().toISOString(),
                        dedupe_key: smsDedupeKey(lead.id, lead.phone, SMS_TEXT),
                    });
                    if (ins.error && String(ins.error.code) === '23505') {
                        console.log('SMS SENT  from=' + (r.from || line) + '  (webhook logged it first, no duplicate written)\n');
                    } else if (ins.error) {
                        console.log('SMS SENT but LOG FAILED: ' + ins.error.message + '\n');
                    } else {
                        console.log('SMS SENT  from=' + (r.from || line) + (r.fellBack ? ' (fell back)' : '') + '\n');
                    }
                }
            }
        }
    }

    if (!SEND) console.log('Dry run. Nothing sent. Re-run with --send.');
}

main().catch(function (e) { console.error(e); process.exit(1); });
