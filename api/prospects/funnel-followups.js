/**
 * GET /api/prospects/funnel-followups?dry=1
 *
 * Automatic follow-ups off the Blason video page (Remy, 2026-10-05). Runs every
 * 5 minutes from vercel.json. Two paths, each fires ONCE per lead:
 *
 *   VIEW path. A KNOWN lead (signed ?lid&t on the link) opened the page at
 *   least 10 minutes ago, has not left contact details or booked, and nobody
 *   has followed up. They get a short text (only if a rep reached them on the
 *   phone before: the connected-call rule, no exceptions) and an email (if an
 *   address is on file). Stamp: prospecting.leads.vsl_view_followup_sent_at.
 *
 *   QUIZ path. Someone finished the quiz and left their cell, but did not pick
 *   a time within 10 minutes. They asked to be contacted, so the text needs no
 *   prior call. Email too. The link drops them straight into the calendar
 *   (?book=call|showroom). Stamp: public.funnel_submissions.followup_sent_at.
 *
 * Scanner safety on the VIEW path: the page view must come from a human user
 * agent, and must NOT sit inside 60 seconds of one of our own sends to that
 * lead (that is the mail scanner opening the link, see vsl-watch-alerts.js).
 *
 * The copy never says "I saw you watched". It reads as a person checking in.
 * No price, no FDA, Miami never Hialeah, human opt-out, EN or ES by the lead.
 *
 * Auth: Vercel cron Bearer CRON_SECRET, or an admin/SDR JWT for a manual run.
 */
const { createClient } = require('@supabase/supabase-js');
const { assertAdminOrSdr } = require('./_shared');
const { sendSms, REMY_LINE } = require('./_sms');
const { signLead } = require('../public/_token');
const F = require('../public/_funnel');
const kit = require('./_email_kit');

const SITE = 'blason';
const CLIENT_ID = F.SITES.blason.client_id;
const DELAY_MIN = 10;
const SCANNER_WINDOW_SEC = 60;
const LOOKBACK_HOURS = 48;
const MAX_PER_RUN = 40;

function pageUrl(leadId, lang, extra) {
    const base = String(process.env.BLASON_VSL_URL || 'https://blasononline.stiloaipartners.com').replace(/\/$/, '');
    return base + '?lid=' + leadId + '&t=' + signLead(leadId) + '&utm_source=followup&utm_campaign=vsl' + (lang === 'es' ? '&lang=es' : '') + (extra || '');
}
function first(lead) { return ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status) ? (require('./_names').firstName(lead.owner_name) || '') : ''; }

/* ------------------------------- copy ---------------------------------- */
function viewCopy(lead, es) {
    const fn = first(lead), url = pageUrl(lead.id, es ? 'es' : 'en');
    if (es) {
        return {
            sms: 'hola' + (fn ? ' ' + fn : '') + ', remy de blason. por si el video no le cargó bien, aquí está otra vez: ' + url + '  y si tiene una máquina en mente, dígame cuál y le consigo diez minutos con manuel, el dueño. responda stop y no le escribo más',
            subject: 'el video, por si no cargó',
            body: ['Hola' + (fn ? ' ' + fn : '') + ',', '', 'Soy Remy, de Blason Spa Equipment en Miami. Por si el video no le cargó bien, aquí está otra vez:', url, '',
                'Son cuatro minutos: por qué las máquinas de marca y las nuestras salen de las mismas fábricas, y qué significa eso para su cabina. Si tiene una máquina en mente, dígame cuál y le consigo diez minutos por teléfono con Manuel, el dueño. Si está en Miami, mejor pase por el showroom y la ve encendida.', '',
                'Y si prefiere que no le escriba, respóndame "no gracias" y no le escribo más.'].join('\n'),
        };
    }
    return {
        sms: 'hey' + (fn ? ' ' + fn : '') + ', remy with blason. in case the video didn\'t load right, here it is again: ' + url + '  and if there\'s a machine on your mind, tell me which and i\'ll get you ten minutes with manuel, the owner. reply stop and i\'ll leave you alone',
        subject: 'the video, in case it did not load',
        body: ['Hi' + (fn ? ' ' + fn : '') + ',', '', "I'm Remy with Blason Spa Equipment in Miami. In case the video didn't load right, here it is again:", url, '',
            "It's four minutes: why the brand-name machines and ours come out of the same factories, and what that means for your room. If there's a machine on your mind, tell me which one and I'll get you ten minutes on the phone with Manuel, the owner. If you're in Miami, come see it running at the showroom instead.", '',
            "And if you'd rather I not email, just reply no thanks and I'll leave you alone."].join('\n'),
    };
}
function quizCopy(sub, lead, es) {
    const fn = (sub.name || '').trim().split(/\s+/)[0] || first(lead);
    const mode = sub.path_pref === 'showroom' ? 'showroom' : 'call';
    const url = pageUrl(lead.id, es ? 'es' : 'en', '&book=' + mode);
    const want = F.label('interest', sub.interest);
    if (es) {
        return {
            sms: 'hola' + (fn ? ' ' + fn : '') + ', remy de blason. recibí sus respuestas' + (want && sub.interest !== 'notsure' ? ' (' + want.toLowerCase() + ')' : '') + '. ' + (mode === 'showroom' ? 'elija la hora para el showroom aquí' : 'elija la hora para los diez minutos con manuel aquí') + ': ' + url + '  o respóndame con un día y hora y yo lo agendo',
            subject: 'sus respuestas, y la hora con Manuel',
            body: ['Hola' + (fn ? ' ' + fn : '') + ',', '', 'Recibí sus respuestas del video' + (want && sub.interest !== 'notsure' ? ': ' + want.toLowerCase() : '') + '. Solo falta la hora.', '',
                (mode === 'showroom' ? 'Elija la hora para pasar por el showroom en Miami y ver la máquina encendida:' : 'Elija la hora para los diez minutos por teléfono con Manuel, el dueño:'), url, '',
                'O respóndame con un día y una hora y yo lo agendo. Nada de precios por correo; Manuel le da el número real para su cabina en la llamada.', '', 'Remy, Blason Spa Equipment, Miami'].join('\n'),
        };
    }
    return {
        sms: 'hey' + (fn ? ' ' + fn : '') + ', remy with blason. got your answers' + (want && sub.interest !== 'notsure' ? ' (' + want.toLowerCase() + ')' : '') + '. ' + (mode === 'showroom' ? 'grab a time for the showroom here' : 'grab a time for the ten minutes with manuel here') + ': ' + url + '  or just reply with a day and time and i\'ll set it',
        subject: 'your answers, and the time with Manuel',
        body: ['Hi' + (fn ? ' ' + fn : '') + ',', '', 'Got your answers from the video page' + (want && sub.interest !== 'notsure' ? ': ' + want.toLowerCase() : '') + '. The only thing missing is the time.', '',
            (mode === 'showroom' ? 'Pick a time to come by the Miami showroom and see the machine running:' : 'Pick a time for the ten minutes on the phone with Manuel, the owner:'), url, '',
            "Or just reply with a day and time and I'll set it. No numbers by email; Manuel gives you the real number for your room on the call.", '', 'Remy, Blason Spa Equipment, Miami'].join('\n'),
    };
}
function copyOk(text) {
    const t = String(text).replace(/https?:\/\/\S+/g, '');
    return !(/stilo|hialeah|\$|\bprice\b|\bprecio\b|\bfda\b|certif|[—–]/i.test(t));
}

async function sendEmail(to, subject, body, es) {
    if (!process.env.RESEND_API_KEY || !to) return { skipped: 'no_email' };
    const sender = await kit.getSenderIdentity(process.env.STILO_SENDER_EMAIL);
    const fromEmail = process.env.BLASON_SENDER_EMAIL || sender.fromEmail;
    const html = kit.buildClientEmailHtml({ bodyText: body, sender: sender, clientName: 'Blason Spa Equipment', es: es, website: 'blasononline.com' });
    const plain = kit.sanitizeCopy(body) + '\n\n' + kit.clientFooterText(sender, 'Blason Spa Equipment', es, 'blasononline.com');
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '"' + sender.name.replace(/"/g, '') + ' · Blason Spa Equipment" <' + fromEmail + '>', to: [to], reply_to: process.env.STILO_REPLY_TO || fromEmail, subject: subject, html: html, text: plain }),
    });
    const j = await r.json().catch(function () { return {}; });
    return { status: r.status, id: j.id, error: r.ok ? null : (j.message || 'send_failed') };
}

module.exports = async function handler(req, res) {
    const auth = req.headers.authorization || '';
    const cronOk = !!process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET;
    if (!cronOk) { const gate = await assertAdminOrSdr(req, res); if (!gate.ok) return; }
    const dry = String((req.query && req.query.dry) || '') === '1';
    if (!F.configured()) return res.status(503).json({ error: 'not_configured' });
    const pub = F.sbPublic(), pros = F.sbProspecting();
    const now = Date.now();
    const since = new Date(now - LOOKBACK_HOURS * 3600e3).toISOString();
    const cutoff = new Date(now - DELAY_MIN * 60e3).toISOString();
    const out = { dry: dry, view: [], quiz: [], skipped: {} };
    const skip = function (k) { out.skipped[k] = (out.skipped[k] || 0) + 1; };
    const leadCols = 'id,name,owner_name,owner_name_verify_status,owner_phone,owner_phone_e164,phone,owner_email,email,primary_language,stage,last_called_outcome,do_not_call,client_id,vsl_view_followup_sent_at,meeting_scheduled_at';

    // ---------------- VIEW path ----------------
    const { data: views } = await pub.from('funnel_events')
        .select('lead_id,created_at,ua,session_id').eq('site', SITE).eq('event', 'page_view').eq('lead_claimed', true)
        .gte('created_at', since).lte('created_at', cutoff).order('created_at', { ascending: true }).limit(2000);
    const firstView = {};
    (views || []).forEach(function (v) { if (!F.botReason(v.ua) && !firstView[v.lead_id]) firstView[v.lead_id] = v; });
    const viewIds = Object.keys(firstView).map(Number);
    if (viewIds.length) {
        const { data: leads } = await pros.from('leads').select(leadCols).in('id', viewIds);
        const { data: sends } = await pros.from('lead_messages').select('lead_id,sent_at').in('lead_id', viewIds).eq('direction', 'outbound').not('sent_at', 'is', null);
        const { data: later } = await pub.from('funnel_events').select('lead_id,event').in('lead_id', viewIds).in('event', ['contact_submitted', 'booking_confirmed']);
        const converted = new Set((later || []).map(function (e) { return e.lead_id; }));
        const { data: calls } = await pros.from('lead_calls').select('lead_id').in('lead_id', viewIds).gte('duration_seconds', 20);
        const connected = new Set((calls || []).map(function (c) { return c.lead_id; }));
        let n = 0;
        for (const lead of (leads || [])) {
            if (n >= MAX_PER_RUN) break;
            const v = firstView[lead.id];
            if (lead.client_id !== CLIENT_ID) { skip('view_wrong_pool'); continue; }
            if (lead.vsl_view_followup_sent_at) { skip('view_already_sent'); continue; }
            if (converted.has(lead.id)) { skip('view_converted'); continue; }
            if (lead.do_not_call || ['CLOSED_WON', 'CLOSED_LOST', 'MEETING_BOOKED'].includes(lead.stage) || ['owner_uninterested', 'not_interested'].includes(String(lead.last_called_outcome || ''))) { skip('view_lead_closed_or_declined'); continue; }
            const at = new Date(v.created_at).getTime();
            const scanner = (sends || []).some(function (m) { if (m.lead_id !== lead.id) return false; const d = at - new Date(m.sent_at).getTime(); return d >= 0 && d <= SCANNER_WINDOW_SEC * 1000; });
            if (scanner) { skip('view_scanner_window'); continue; }
            const es = lead.primary_language === 'es';
            const c = viewCopy(lead, es);
            if (!copyOk(c.sms) || !copyOk(c.body)) { skip('view_copy_rule'); continue; }
            const phone = lead.owner_phone_e164 || lead.owner_phone || lead.phone || null;
            const email = lead.owner_email || lead.email || null;
            const row = { lead_id: lead.id, business: lead.name, viewed_at: v.created_at, sms: connected.has(lead.id) && phone ? 'yes' : 'no (no connected call or no phone)', email: email ? 'yes' : 'no' };
            if (!dry) {
                let any = false;
                if (connected.has(lead.id) && phone) {
                    try { const r = await sendSms(REMY_LINE, phone, c.sms, { leadId: lead.id }); row.sms_result = r; if (r && !r.err && !r.skip) { any = true; await pros.from('lead_messages').insert({ lead_id: lead.id, direction: 'outbound', channel: 'sms', to_address: phone, from_address: r.from || REMY_LINE, body: c.sms, body_preview: c.sms.slice(0, 280), status: 'sent', provider: 'openphone', sent_at: new Date().toISOString(), dedupe_key: 'vsl-view-followup-sms-' + lead.id, variant: 'vsl_view_followup' }); } } catch (e) { row.sms_result = { err: String(e.message || e) }; }
                }
                if (email) {
                    const r = await sendEmail(email, c.subject, c.body, es); row.email_result = r;
                    if (r && !r.error && !r.skipped) { any = true; await pros.from('lead_messages').insert({ lead_id: lead.id, direction: 'outbound', channel: 'email', to_address: email, subject: c.subject, body: c.body, body_preview: c.body.slice(0, 280), status: 'sent', provider: 'resend', provider_message_id: r.id || null, sent_at: new Date().toISOString(), dedupe_key: 'vsl-view-followup-email-' + lead.id, variant: 'vsl_view_followup' }); }
                }
                // Stamp even when nothing could be sent, so the cron does not
                // re-evaluate the same lead every 5 minutes forever.
                await pros.from('leads').update({ vsl_view_followup_sent_at: new Date().toISOString() }).eq('id', lead.id).is('vsl_view_followup_sent_at', null);
                row.sent = any;
            }
            out.view.push(row); n++;
        }
    }

    // ---------------- QUIZ path ----------------
    const { data: subs } = await pub.from('funnel_submissions')
        .select('id,lead_id,name,phone_e164,email,lang,interest,path_pref,created_at,booked_at,followup_sent_at')
        .eq('site', SITE).is('booked_at', null).is('followup_sent_at', null).gte('created_at', since).lte('created_at', cutoff).order('created_at', { ascending: true }).limit(200);
    const subIds = Array.from(new Set((subs || []).map(function (s) { return s.lead_id; }).filter(function (x) { return x != null; })));
    const subLeads = {};
    if (subIds.length) { const { data } = await pros.from('leads').select(leadCols).in('id', subIds); (data || []).forEach(function (l) { subLeads[l.id] = l; }); }
    let q = 0;
    for (const sub of (subs || [])) {
        if (q >= MAX_PER_RUN) break;
        const lead = subLeads[sub.lead_id];
        if (!lead) { skip('quiz_no_lead'); continue; }
        if (lead.meeting_scheduled_at && new Date(lead.meeting_scheduled_at).getTime() > now) { skip('quiz_already_booked'); continue; }
        if (lead.do_not_call) { skip('quiz_dnc'); continue; }
        const es = (sub.lang || lead.primary_language) === 'es';
        const c = quizCopy(sub, lead, es);
        if (!copyOk(c.sms) || !copyOk(c.body)) { skip('quiz_copy_rule'); continue; }
        const phone = sub.phone_e164 || lead.owner_phone_e164 || lead.owner_phone || null;
        const email = sub.email || lead.owner_email || null;
        const row = { submission: sub.id, lead_id: lead.id, business: lead.name, sms: phone ? 'yes' : 'no', email: email ? 'yes' : 'no' };
        if (!dry) {
            let any = false;
            if (phone) { try { const r = await sendSms(REMY_LINE, phone, c.sms, { leadId: lead.id }); row.sms_result = r; if (r && !r.err && !r.skip) { any = true; await pros.from('lead_messages').insert({ lead_id: lead.id, direction: 'outbound', channel: 'sms', to_address: phone, from_address: r.from || REMY_LINE, body: c.sms, body_preview: c.sms.slice(0, 280), status: 'sent', provider: 'openphone', sent_at: new Date().toISOString(), dedupe_key: 'vsl-quiz-followup-sms-' + sub.id, variant: 'vsl_quiz_followup' }); } } catch (e) { row.sms_result = { err: String(e.message || e) }; } }
            if (email) { const r = await sendEmail(email, c.subject, c.body, es); row.email_result = r; if (r && !r.error && !r.skipped) { any = true; await pros.from('lead_messages').insert({ lead_id: lead.id, direction: 'outbound', channel: 'email', to_address: email, subject: c.subject, body: c.body, body_preview: c.body.slice(0, 280), status: 'sent', provider: 'resend', provider_message_id: r.id || null, sent_at: new Date().toISOString(), dedupe_key: 'vsl-quiz-followup-email-' + sub.id, variant: 'vsl_quiz_followup' }); } }
            await pub.from('funnel_submissions').update({ followup_sent_at: new Date().toISOString() }).eq('id', sub.id).is('followup_sent_at', null);
            row.sent = any;
        }
        out.quiz.push(row); q++;
    }
    return res.status(200).json(Object.assign({ ok: true }, out));
};
