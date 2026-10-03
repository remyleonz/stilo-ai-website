#!/usr/bin/env node
/**
 * scripts/send_blason_vsl_email.js
 *
 * The Blason email in David's "pay twice" format, with the link to the VSL
 * landing page. This REPLACES send_client_sequence.js cold step 1 (and its
 * steps 2 to 3) once the page is live; the two scripts share the same
 * email_N_sent_at stamps, so a lead gets one sequence or the other, never both.
 *
 *   node scripts/send_blason_vsl_email.js --mode cold --limit 50            dry run
 *   node scripts/send_blason_vsl_email.js --mode cold --limit 50 --send
 *   node scripts/send_blason_vsl_email.js --mode warm --limit 30 --send     after a connected call
 *   node scripts/send_blason_vsl_email.js --mode followup --limit 50 --send steps 2 and 3
 *   --show   print full bodies in a dry run     --lane 1|3   cold lane (default 1)
 *
 * Refuses to run unless BLASON_VSL_URL is set (e.g. https://go.blasononline.com
 * or https://stiloaipartners.com/blason while the domain is pending). Every
 * link carries ?lid=<id>&t=<signed token> (api/public/_token.js) so the page
 * attributes views, quiz steps and the booking to the exact lead, plus
 * &lang=es for Spanish leads.
 *
 * Hard rules enforced by preSendCheck on every body before it leaves:
 *   no STILO, no price or "$", no FDA / certified, no Hialeah, no em dash,
 *   exactly ONE link and it must be the VSL host, body under 1,100 chars,
 *   a human opt-out line. Copy is Claude-authored and lives here as a template
 *   bank (no model calls in any copy path, Remy 2026-09-14).
 *
 * Audience and deliverability gates mirror send_client_sequence.js: Blason pool
 * only, verified address lanes, bounced / unsubscribed / suppressed out,
 * declines in ANY channel out, booked and closed out, one address per batch,
 * bounced domains out. Claim-before-send on lead_messages with a dedupe key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
(function loadEnv() {
    try {
        fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
            const m = line.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
        });
    } catch (_) { /* env already in process */ }
})();
const kit = require('../api/prospects/_email_kit');
const guard = require('../api/prospects/_email_guard');
const { signLead } = require('../api/public/_token');

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const MODE = arg('mode', 'cold');          // cold | warm | followup
const LANE = arg('lane', '1');             // cold only: 1 = medium confidence + MX clean, 2 = finder role inboxes (ramp slowly), 3 = site-published, 5 = rep-typed or imported address (any prefix)
const LIMIT = parseInt(arg('limit', '50'), 10);
const SEND = args.includes('--send');
const SHOW = args.includes('--show');
const GAP_MS = 2500;
const CLIENT_ID = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const VSL_URL = String(process.env.BLASON_VSL_URL || '').replace(/\/$/, '');
const LOCAL_ZIP3 = ['330', '331', '332', '333'];
const STEP_GAP_DAYS = { 2: 3, 3: 4 };
const MAX_STEP = 3;

if (!VSL_URL || !/^https:\/\//.test(VSL_URL)) { console.error('BLASON_VSL_URL is not set. Set it to the live landing page URL first.'); process.exit(1); }
const VSL_HOST = new URL(VSL_URL).host;

function sbLeads() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } }); }
function sbPublic() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }); }
function b64url(s) { return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unsubToken(email) {
    const secret = process.env.UNSUBSCRIBE_SIGNING_SECRET; if (!secret) return null;
    const e = String(email).trim().toLowerCase();
    return b64url(e) + '.' + crypto.createHmac('sha256', secret).update(e).digest('base64url').slice(0, 24);
}
function zip3(address) { const m = String(address || '').match(/\b(3[0-4]\d)\d{2}\b/); return m ? m[1] : null; }
function tsMs(v) { const n = v ? new Date(v).getTime() : 0; return isNaN(n) ? 0 : n; }
function firstName(lead) {
    const verified = ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status);
    return verified ? (kit.firstName(lead.owner_name) || null) : null;
}
function linkFor(lead) {
    return VSL_URL + '?lid=' + lead.id + '&t=' + signLead(lead.id) + (lead.primary_language === 'es' ? '&lang=es' : '');
}

/* ------------------------------- the copy -------------------------------- */
// Step 1. David's structure (2026-09-30): nice speaking / same factories, pay
// twice for the logo / skip the markup, afford the best machine / before you
// buy or replace, watch this / link. Cold opener swaps "nice speaking with your
// office" for a one-line who-I-am. Two subject arms, A/B by lead id.
function step1(lead, sender) {
    const es = lead.primary_language === 'es', fn = firstName(lead), local = LOCAL_ZIP3.includes(zip3(lead.address));
    const link = linkFor(lead), arm = (Math.abs(Number(lead.id) || 0) % 2 === 0) ? 'A' : 'B';
    const warm = MODE === 'warm';
    if (es) {
        const hi = fn ? 'Hola ' + fn + ',' : 'Hola,';
        const intro = warm ? 'Un gusto hablar con su oficina el otro día.' : 'Soy ' + sender + ', de Blason Spa Equipment aquí en Miami. Importamos máquinas de estética directo de fábrica.';
        const body = [hi, '', intro, '',
            'Algo que casi ningún vendedor le va a decir: las máquinas de marca y las nuestras salen de las mismas fábricas. Cuando la máquina trae un logo grande, usted paga dos veces: una por la máquina y otra por el nombre. Si se salta ese recargo, el mismo presupuesto le alcanza para la máquina que realmente quiere, en vez de conformarse con una más barata.', '',
            'Antes de comprar o cambiar cualquier equipo, vea este video corto. Muestra exactamente cómo funciona y qué significa para su cabina:', link, '',
            local ? 'Las máquinas están encendidas en nuestro showroom de Miami, así que puede probarlas antes de decidir nada.' : 'Enviamos a toda la Florida y Manuel, el dueño, le explica todo en diez minutos por teléfono.', '',
            'Y si prefiere que no le escriba, respóndame "no gracias" y no le escribo más.'].join('\n');
        const subject = arm === 'A' ? (warm ? 'después de nuestra llamada' : 'pagar dos veces por la misma máquina') : (warm ? 'lo que le mencioné en la llamada' : 'antes de comprar su próxima máquina');
        return { subject, body, arm };
    }
    const hi = fn ? 'Hi ' + fn + ',' : 'Hi,';
    const intro = warm ? 'It was nice speaking with your office the other day.' : "I'm " + sender + ' with Blason Spa Equipment here in Miami. We import aesthetic machines direct from the factory.';
    const body = [hi, '', intro, '',
        "Something most sales reps won't tell you: the brand-name machines and ours come out of the same factories. When a machine carries a big logo you pay twice, once for the machine and once for the name. Skip that markup and the same budget buys the machine you actually wanted instead of the one you settled for.", '',
        'Before you buy or replace anything, watch this short video. It shows exactly how that works and what it means for your room:', link, '',
        local ? 'The machines are set up and running at our Miami showroom, so you can try one before deciding anything.' : 'We ship anywhere in Florida and Manuel, the owner, walks you through it in ten minutes on the phone.', '',
        "And if you'd rather I not email, just reply no thanks and I'll leave you alone."].join('\n');
    const subject = arm === 'A' ? (warm ? 'after our call' : 'paying twice for the same machine') : (warm ? 'what I mentioned on the call' : 'before you buy your next machine');
    return { subject, body, arm };
}
// Steps 2 and 3: a bump and a one-question close, each with the link again.
function followup(lead, step) {
    const es = lead.primary_language === 'es', fn = firstName(lead), link = linkFor(lead), local = LOCAL_ZIP3.includes(zip3(lead.address));
    const hi = es ? (fn ? 'Hola ' + fn + ',' : 'Hola,') : (fn ? 'Hi ' + fn + ',' : 'Hi,');
    if (step === 2) {
        return es
            ? { arm: 'step2', subject: 're: pagar dos veces por la misma máquina', body: [hi, '', '¿Alcanzó a ver el video? Son unos minutos y explica por qué el logo es lo que encarece la máquina, no la tecnología.', link, '', 'Si ya lo vio, dígame qué máquina tiene más vieja en cabina y Manuel le dice de frente si conviene arreglarla o cambiarla.', '', 'Si prefiere que no le escriba, respóndame "no gracias".'].join('\n') }
            : { arm: 'step2', subject: 're: paying twice for the same machine', body: [hi, '', 'Did you get a chance to watch the video? It is a few minutes and it explains why the logo is what makes the machine expensive, not the technology.', link, '', "If you already watched it, tell me the oldest machine in your room and Manuel will tell you straight whether to fix it or replace it.", '', "If you'd rather I not email, just reply no thanks."].join('\n') };
    }
    const askEs = local ? 'Venga 20 minutos al showroom de Manuel en Miami y pruebe las máquinas encendidas.' : 'Diez minutos por teléfono con Manuel y sabe si le conviene o no.';
    const askEn = local ? "Come by Manuel's Miami showroom for 20 minutes and try the machines running." : 'Ten minutes on the phone with Manuel and you know whether it makes sense or not.';
    return es
        ? { arm: 'step3', subject: 'una pregunta', body: [hi, '', '¿Viene algo nuevo para ustedes este año? Un servicio nuevo, otra cabina, o una máquina que ya está cansada. Si me dice cuál, Manuel, el dueño, le dice qué le conviene sin recargo de marca.', '', 'El video por si no lo vio: ' + link, '', askEs + ' Elija la hora al final del video.', '', 'Y si no es el momento, respóndame "no gracias" y aquí termina.'].join('\n') }
        : { arm: 'step3', subject: 'one question', body: [hi, '', "Anything new coming up for you this year? A new service, another room, or a machine that is getting tired. Tell me which and Manuel, the owner, tells you what makes sense without the brand markup.", '', 'The video in case you missed it: ' + link, '', askEn + ' Pick the time at the end of the video.', '', "And if it's not the moment, just reply no thanks and that's the end of it."].join('\n') };
}

/** Correctness checks that must hold for every body. */
function preSendCheck(subject, body) {
    const t = subject + '\n' + body, fails = [];
    if (/stilo/i.test(t)) fails.push('mentions STILO');
    if (/\$|\bprice\b|\bprecio\b|\bcost\b|\bcosto\b|starting at|desde \$/i.test(t)) fails.push('mentions price');
    if (/[—–]/.test(t)) fails.push('em or en dash');
    if (/hialeah/i.test(t)) fails.push('Hialeah');
    if (/\bfda\b|certif/i.test(t)) fails.push('FDA or certified claim');
    if (/\bundefined\b|\bnull\b|Hi ,|Hola ,/.test(t)) fails.push('broken merge');
    const links = t.match(/https?:\/\/[^\s)]+/g) || [];
    if (links.length !== 1) fails.push('expected exactly one link, found ' + links.length);
    if (links.length && new URL(links[0]).host !== VSL_HOST) fails.push('link is not the VSL host');
    if (links.length && !/[?&]t=[A-Za-z0-9_-]{10,}/.test(links[0])) fails.push('link has no signed token');
    if (!/no thanks|no gracias/i.test(body)) fails.push('no human opt-out line');
    if (body.length > 1100) fails.push('body too long (' + body.length + ')');
    return fails;
}
function nextStepFor(lead) {
    for (let n = 2; n <= MAX_STEP; n++) {
        if (lead['email_' + n + '_sent_at']) continue;
        const prev = lead['email_' + (n - 1) + '_sent_at']; if (!prev) return null;
        return ((Date.now() - new Date(prev).getTime()) / 86400000 >= STEP_GAP_DAYS[n]) ? n : null;
    }
    return null;
}

async function main() {
    const sb = sbLeads(), pub = sbPublic();
    const { data: clientRow } = await pub.from('clients').select('business_name,website').eq('id', CLIENT_ID).single();
    const clientName = (clientRow && clientRow.business_name) || 'Blason Spa Equipment';
    const clientSite = (clientRow && clientRow.website) || 'blasononline.com';

    let q = sb.from('leads').select('id,name,owner_name,owner_name_verify_status,owner_email,email,email_verify_address,email_verify_status,email_confidence,'
        + 'primary_language,address,category,stage,last_called_outcome,bounced_at,unsubscribed_at,reply_received_at,'
        + 'email_1_sent_at,email_2_sent_at,email_3_sent_at,last_called_at,all_emails_json,email_search_status')
        .eq('client_id', CLIENT_ID).is('bounced_at', null).is('unsubscribed_at', null);
    if (MODE === 'followup') q = q.not('email_1_sent_at', 'is', null).is('reply_received_at', null).is('email_3_sent_at', null);
    else if (MODE === 'warm') q = q.is('email_1_sent_at', null).not('last_called_at', 'is', null);
    else if (LANE === '5') q = q.is('email_1_sent_at', null).neq('email_verify_status', 'dead_domain');
    else if (LANE === '2') q = q.is('email_1_sent_at', null).eq('email_verify_status', 'role_inbox');
    else q = q.is('email_1_sent_at', null).eq('email_verify_status', LANE === '3' ? 'site_published' : 'deliverable');
    if (MODE === 'cold' && LANE === '1') q = q.eq('email_confidence', 'medium');
    const { data: leads, error } = await q.limit(3000);
    if (error) { console.error(error); process.exit(1); }

    // Followup: only VSL-sequence leads (their step-1 message carries our variant).
    let vslIds = null;
    if (MODE === 'followup') {
        vslIds = new Set();
        const { data: msgs } = await sb.from('lead_messages').select('lead_id').like('variant', 'blason_vsl_1_%').limit(5000);
        (msgs || []).forEach(function (m) { vslIds.add(m.lead_id); });
    }

    // Bounced domains, declines in any channel, closed stages, SMS queue.
    const bounceDomains = new Set();
    {
        const { data: rows } = await sb.from('lead_messages').select('to_address').eq('channel', 'email').not('bounced_at', 'is', null).limit(5000);
        (rows || []).forEach(function (r) { const d = String(r.to_address || '').split('@')[1]; if (d) bounceDomains.add(d.toLowerCase()); });
    }
    const declined = new Set(['owner_uninterested', 'do_not_call']);
    const CLOSED = ['CLOSED_LOST', 'CLOSED_WON', 'MEETING_BOOKED'];
    const { data: targets } = await sb.from('outbound_targets').select('lead_id,stage').in('stage', ['dead', 'opted_out', 'queued']);
    const killedIds = new Set((targets || []).filter(function (t) { return t.stage !== 'queued'; }).map(function (t) { return t.lead_id; }));
    const queuedIds = new Set((targets || []).filter(function (t) { return t.stage === 'queued'; }).map(function (t) { return t.lead_id; }));

    // Connected 20s+ call on record for warm mode
    let connectedIds = null;
    if (MODE === 'warm') {
        connectedIds = new Set();
        const { data: calls } = await sb.from('lead_calls').select('lead_id,duration_seconds,leads!inner(client_id)').eq('leads.client_id', CLIENT_ID).gte('duration_seconds', 20).limit(5000);
        (calls || []).forEach(function (c) { connectedIds.add(c.lead_id); });
    }

    // Lane 5: a human emailed the lead from the drawer, or the address has no
    // finder trace (typed by a rep or came with the import). Same rule as
    // send_client_sequence.js lane 5.
    let humanEmailedIds = null;
    if (MODE === 'cold' && LANE === '5') {
        humanEmailedIds = new Set();
        const { data: hm } = await sb.from('lead_messages').select('lead_id').eq('channel', 'email').eq('direction', 'outbound')
            .in('variant', ['ask', 'ctx', 'desk', 'manual_followup', 'manual']).limit(5000);
        (hm || []).forEach(function (m) { humanEmailedIds.add(m.lead_id); });
    }
    const isRepAddress = function (l) {
        if (humanEmailedIds && humanEmailedIds.has(l.id)) return true;
        const addr = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!addr || l.email_search_status === 'found') return false;
        return JSON.stringify(l.all_emails_json || '').toLowerCase().indexOf(addr) === -1;
    };
    const skipWhy = {};
    const skip = function (w) { skipWhy[w] = (skipWhy[w] || 0) + 1; return false; };
    const seenAddr = new Set();
    const eligible = (leads || []).filter(function (l) {
        const to = String(l.email_verify_address || l.owner_email || l.email || '').trim().toLowerCase();
        if (!to) return skip('no address');
        if (humanEmailedIds && !isRepAddress(l)) return skip('finder address, not lane 5');
        if (declined.has(l.last_called_outcome)) return skip('declined on a call');
        if (CLOSED.includes(l.stage)) return skip('closed or booked');
        if (killedIds.has(l.id)) return skip('dead or opted out by SMS');
        if (queuedIds.has(l.id) && MODE !== 'followup') return skip('in the SMS queue today');
        if (bounceDomains.has(to.split('@')[1])) return skip('bounced domain');
        if (seenAddr.has(to)) return skip('duplicate address in batch');
        if (MODE === 'warm' && !connectedIds.has(l.id)) return skip('no connected call');
        if (MODE === 'followup') { if (!vslIds.has(l.id)) return skip('not on the VSL sequence'); l.__step = nextStepFor(l); if (!l.__step) return skip('next step not due'); }
        seenAddr.add(to); l.__to = to; return true;
    });
    if (MODE === 'cold') {
        const SOUTH = ['330', '331', '332', '333', '334'];
        const rank = function (l) {
            const south = SOUTH.includes(zip3(l.address)) ? 0 : 2;
            const seg = /medical spa|med spa|dermatolog|plastic surg|cosmetic surg|laser|medical clinic/i.test(String(l.category || '')) ? 0 : /beauty salon|hair salon|nail|barber|massage/i.test(String(l.category || '')) ? 3 : 1;
            return south + seg;
        };
        eligible.sort(function (a, b) { return (rank(a) - rank(b)) || (a.id - b.id); });
    }
    const batch = eligible.slice(0, LIMIT);

    console.log('Blason VSL email · mode ' + MODE + (MODE === 'cold' ? ' lane ' + LANE : '') + ' · link host ' + VSL_HOST);
    console.log('pool ' + (leads || []).length + ' · eligible ' + eligible.length + ' · this run ' + batch.length + ' · ' + (SEND ? 'SENDING' : 'DRY RUN'));
    Object.keys(skipWhy).forEach(function (k) { console.log('  skip ' + String(skipWhy[k]).padStart(5) + '  ' + k); });
    console.log('');

    const sender = await kit.getSenderIdentity(process.env.STILO_SENDER_EMAIL);
    const fromEmail = process.env.BLASON_SENDER_EMAIL || sender.fromEmail;
    const fromName = '"' + sender.name.replace(/"/g, '') + ' · ' + clientName + '"';
    const senderFirst = (sender.name || 'Remy').split(/\s+/)[0];
    const stats = { sent: 0, skipped: 0, failed: 0, dup: 0 };

    for (const lead of batch) {
        const to = lead.__to, tag = '#' + lead.id + ' ' + String(lead.name).slice(0, 40);
        const { data: sup } = await pub.from('lcr_suppressions').select('email').ilike('email', to).limit(1);
        if (sup && sup.length) { console.log('SKIP  ' + tag + '  suppressed'); stats.skipped++; continue; }
        const ok = await guard.canSend({ email: to });
        if (!ok.ok) { console.log('SKIP  ' + tag + '  guard: ' + ok.reason); stats.skipped++; continue; }

        const stepNo = MODE === 'followup' ? lead.__step : 1;
        const c = stepNo === 1 ? step1(lead, senderFirst) : followup(lead, stepNo);
        const fails = preSendCheck(c.subject, c.body);
        if (fails.length) { console.log('SKIP  ' + tag + '  copy: ' + fails.join('; ')); stats.skipped++; continue; }

        if (!SEND) {
            console.log('DRY   ' + tag + '  -> ' + to + '  step ' + stepNo + ' ' + c.arm + ' | ' + c.subject);
            if (SHOW) console.log(c.body.replace(/^/gm, '        ') + '\n');
            stats.sent++; continue;
        }
        const dedupeKey = crypto.createHash('sha1').update(['blason_vsl', lead.id, stepNo].join('|')).digest('hex');
        const claim = await sb.from('lead_messages').insert({
            lead_id: lead.id, direction: 'outbound', channel: 'email', subject: c.subject, sent_at: new Date().toISOString(),
            sent_by: process.env.STILO_SENDER_EMAIL || null, to_address: to, provider: 'resend', status: 'sending',
            dedupe_key: dedupeKey, variant: 'blason_vsl_' + stepNo + '_' + c.arm,
        }).select('id').single();
        if (claim.error) { if (String(claim.error.code) === '23505') { console.log('DUP   ' + tag); stats.dup++; } else { console.log('FAIL  ' + tag + ' claim: ' + claim.error.message); stats.failed++; } continue; }

        const html = kit.buildClientEmailHtml({ bodyText: c.body, sender: sender, clientName: clientName, es: lead.primary_language === 'es', website: clientSite });
        const plain = kit.sanitizeCopy(c.body) + '\n\n' + kit.clientFooterText(sender, clientName, lead.primary_language === 'es', clientSite);
        const ut = unsubToken(to);
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from: fromName + ' <' + fromEmail + '>', to: [to], reply_to: process.env.STILO_REPLY_TO || fromEmail,
                    subject: c.subject, html: html, text: plain,
                    headers: ut ? { 'List-Unsubscribe': '<https://stiloaipartners.com/api/unsubscribe?t=' + ut + '>, <mailto:' + (process.env.STILO_REPLY_TO || fromEmail) + '?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
                }),
            });
            const j = await r.json().catch(function () { return {}; });
            if (!r.ok) { await sb.from('lead_messages').delete().eq('id', claim.data.id); console.log('FAIL  ' + tag + '  resend: ' + (j.message || 'http_' + r.status)); stats.failed++; continue; }
            await sb.from('lead_messages').update({ body: plain, body_preview: plain.slice(0, 280), from_address: fromEmail, provider_message_id: j.id || null, status: 'sent' }).eq('id', claim.data.id);
            const stamp = {}; stamp['email_' + stepNo + '_sent_at'] = new Date().toISOString(); stamp['email_' + stepNo + '_status'] = 'sent';
            await sb.from('leads').update(stamp).eq('id', lead.id);
            console.log('SENT  ' + tag + '  -> ' + to + '  step ' + stepNo);
            stats.sent++;
        } catch (e) {
            await sb.from('lead_messages').delete().eq('id', claim.data.id);
            console.log('FAIL  ' + tag + '  ' + String(e.message || e)); stats.failed++; continue;
        }
        await new Promise(function (r) { setTimeout(r, GAP_MS); });
    }
    console.log('\n' + JSON.stringify(stats));
    if (!SEND) console.log('Dry run. Nothing was sent. Re-run with --send.');
}
main().catch(function (e) { console.error(e); process.exit(1); });
