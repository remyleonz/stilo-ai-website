#!/usr/bin/env node
/**
 * scripts/enqueue_blason_vsl_sms.js
 *
 * Fill outbound campaign 5 ("Blason: the video") with connected-call leads and
 * PREFILLED bodies: David's "pay twice for the logo" angle plus the signed link
 * to the Blason video page. outbound-tick sends them inside the campaign's
 * window and caps (100/day, 50 per line, 120s drip).
 *
 *   node scripts/enqueue_blason_vsl_sms.js                 dry run, prints the audience + sample bodies
 *   node scripts/enqueue_blason_vsl_sms.js --limit 100 --write
 *
 * Who gets it (every rule the tick re-checks at send time, applied here too so
 * the queue is honest):
 *   - Blason pool, a connected outbound call of 20s+ on record (cold SMS is
 *     banned: Quo AUP + TCPA; prior_contact is stamped from the call log)
 *   - a phone on file, not do_not_call, stage not booked/closed, no decline
 *     outcome, not opted out / dead / blocked on any campaign
 *   - not human-owned (pinned or dated next step): the tick refuses those
 *   - not already in campaign 5
 * Leads already texted by campaign 4 ARE eligible: campaign 4 is paused for
 * the test week and the video is a new message, not a nudge.
 *
 * Bodies: EN/ES by primary_language, lowercase texting voice, rep's first name,
 * "blason" named, Miami never Hialeah, no price, human opt-out. Step 2 (one
 * nudge, 3 days later, no reply) is written at the same time.
 * Link: BLASON_VSL_URL?lid=<id>&t=<signed>&utm_source=sms&utm_campaign=vsl[&lang=es]
 * so the page attributes every view, play and quiz step to the lead and the
 * admin Funnel tab can split SMS from email.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ROOT = path.join(__dirname, '..');
(function loadEnv() {
    try {
        fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').forEach(function (line) {
            const m = line.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
        });
    } catch (_) {}
})();
const { signLead } = require('../api/public/_token');
const { copyGate } = require('../api/prospects/_shared');
const { firstName } = require('../api/prospects/_names');

const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; }
const LIMIT = parseInt(arg('limit', '100'), 10);
const WRITE = args.includes('--write');
const CAMPAIGN_ID = parseInt(arg('campaign', '5'), 10);
const CLIENT_ID = '2efae6bf-69d8-4c4d-ac25-6a693db50f8b';
const VSL_URL = String(process.env.BLASON_VSL_URL || '').replace(/\/$/, '');
if (!/^https:\/\//.test(VSL_URL)) { console.error('BLASON_VSL_URL not set'); process.exit(1); }
const REMY = { email: 'remyleon@stiloaipartners.com', line: '+17868376639', first: 'remy' };

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false }, db: { schema: 'prospecting' } });
const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function link(lead) {
    // Short form, resolved by middleware.js: /v/<lead>/<token>[/es]
    return VSL_URL + '/v/' + lead.id + '/' + signLead(lead.id) + (lead.primary_language === 'es' ? '/es' : '');
}
function e164(raw) { const d = String(raw || '').replace(/\D/g, ''); if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return null; }

/* ------------------------------- the copy -------------------------------- */
function step1(lead, rep) {
    const es = lead.primary_language === 'es';
    const verified = ['verified', 'rep_confirmed'].includes(lead.owner_name_verify_status);
    const fn = verified ? (firstName(lead.owner_name) || '') : '';
    const hi = es ? ('hola' + (fn ? ' ' + fn : '')) : ('hey' + (fn ? ' ' + fn : ''));
    if (es) return hi + ', ' + rep + ' de blason. video de 4 min sobre por qué un láser de marca cuesta el doble y cómo evitarlo: ' + link(lead) + '  responda stop si no le interesa';
    return hi + ', ' + rep + ' from blason. 4 min video on why you pay double for a brand-name laser and how to skip it: ' + link(lead) + '  reply stop if it\'s not for you';
}
function step2(lead, rep) {
    const es = lead.primary_language === 'es';
    if (es) return 'hola, ' + rep + ' de blason otra vez. ¿le cargó el video? ' + link(lead) + '  ¿qué máquina agregaría si no tuviera que pagar el logo?';
    return 'hey, ' + rep + ' from blason again. did the video load? ' + link(lead) + '  which machine would you add if the logo wasn\'t in the way?';
}
function check(body) {
    const fails = [];
    if (/hialeah/i.test(body)) fails.push('Hialeah');
    if (/\$|\bprice\b|\bprecio\b|\bcost\b|\bcosto\b/i.test(body)) fails.push('price');
    // The link host is blasononline.stiloaipartners.com, so test the prose only.
    if (/stilo/i.test(body.replace(/https?:\/\/\S+/g, ''))) fails.push('STILO');
    if (/[—–]/.test(body)) fails.push('dash');
    if (!/blason/i.test(body)) fails.push('client not named');
    if ((body.match(/https?:\/\//g) || []).length !== 1) fails.push('link count');
    if (body.length > 230) fails.push('too long ' + body.length);   // one or two segments, like a person
    const g = copyGate(body); if (g) fails.push('copyGate ' + g);
    return fails;
}

async function main() {
    const { data: campaign } = await sb.from('outbound_campaigns').select('*').eq('id', CAMPAIGN_ID).maybeSingle();
    if (!campaign) { console.error('campaign ' + CAMPAIGN_ID + ' not found'); process.exit(1); }
    console.log('campaign ' + campaign.id + ' "' + campaign.name + '" status ' + campaign.status + ' caps ' + campaign.daily_cap + '/day ' + campaign.per_line_daily_cap + '/line · link host ' + new URL(VSL_URL).host);

    // reps with lines (for "one voice per prospect": the line that last dialed them)
    const { data: reps } = await pub.from('sdr_users').select('email,display_name,openphone_number,active').eq('active', true);
    const repByEmail = {}; (reps || []).forEach(function (r) { if (r.openphone_number) repByEmail[r.email] = { line: r.openphone_number, first: String(r.display_name || '').split(/\s+/)[0].toLowerCase() || 'remy' }; });

    // connected calls: lead -> last connected call (for prior_call_at + the line)
    const connected = {};
    for (let from = 0; ; from += 1000) {
        const { data } = await sb.from('lead_calls').select('lead_id,called_at,duration_seconds,logged_by,leads!inner(client_id)')
            .eq('leads.client_id', CLIENT_ID).eq('direction', 'outbound').gte('duration_seconds', 20).order('called_at', { ascending: false }).range(from, from + 999);
        (data || []).forEach(function (c) { if (!connected[c.lead_id]) connected[c.lead_id] = c; });
        if (!data || data.length < 1000) break;
    }
    const { data: existing } = await sb.from('outbound_targets').select('lead_id,stage,campaign_id').in('stage', ['opted_out', 'dead', 'blocked']);
    const dead = new Set((existing || []).map(function (t) { return t.lead_id; }));
    const { data: inThis } = await sb.from('outbound_targets').select('lead_id').eq('campaign_id', CAMPAIGN_ID);
    const already = new Set((inThis || []).map(function (t) { return t.lead_id; }));
    // Anyone texted in the last 48h (campaign 4 nudges went out this morning
    // before it was paused) waits a day: two texts in one day reads as a blitz.
    const { data: recentSms } = await sb.from('lead_messages').select('lead_id').eq('channel', 'sms').eq('direction', 'outbound')
        .gte('sent_at', new Date(Date.now() - 48 * 3600e3).toISOString()).limit(5000);
    const textedRecently = new Set((recentSms || []).map(function (m) { return m.lead_id; }));

    const ids = Object.keys(connected).map(Number);
    const leads = [];
    for (let i = 0; i < ids.length; i += 300) {
        const { data } = await sb.from('leads')
            .select('id,name,owner_name,owner_name_verify_status,owner_phone,owner_phone_e164,phone,primary_language,address,stage,last_called_outcome,do_not_call,pinned_at,next_step,assigned_to,category,niche,scrub_status')
            .in('id', ids.slice(i, i + 300)).eq('client_id', CLIENT_ID);
        leads.push.apply(leads, data || []);
    }
    const held = {}; const hold = function (k) { held[k] = (held[k] || 0) + 1; return false; };
    const SOUTH = ['330', '331', '332', '333', '334'];
    const zip3 = function (a) { const m = String(a || '').match(/\b(3[0-4]\d)\d{2}\b/); return m ? m[1] : null; };
    const eligible = leads.filter(function (l) {
        if (already.has(l.id)) return hold('already_in_campaign');
        if (textedRecently.has(l.id)) return hold('texted_in_last_48h');
        if (dead.has(l.id)) return hold('opted_out_dead_blocked');
        if (l.do_not_call) return hold('do_not_call');
        if (['CLOSED_WON', 'CLOSED_LOST', 'MEETING_BOOKED'].includes(l.stage)) return hold('closed_or_booked');
        if (['owner_uninterested', 'not_interested', 'meeting_cancelled'].includes(String(l.last_called_outcome || ''))) return hold('declined');
        if (l.pinned_at || String(l.next_step || '').trim()) return hold('human_owned');
        if (l.scrub_status === 'blocked') return hold('scrub_blocked');
        if (!e164(l.owner_phone_e164 || l.owner_phone || l.phone)) return hold('no_phone');
        if (campaign.icp_pattern && !new RegExp(campaign.icp_pattern, 'i').test(String(l.niche || l.category || ''))) return hold('out_of_icp');
        return true;
    });
    // South Florida and laser-legal first (the September read: that is where the sales were)
    eligible.sort(function (a, b) {
        const r = function (l) { return (SOUTH.includes(zip3(l.address)) ? 0 : 2) + (/medical spa|med spa|dermatolog|plastic|laser|medical clinic/i.test(String(l.category || '')) ? 0 : 1); };
        return (r(a) - r(b)) || (new Date(connected[b.id].called_at) - new Date(connected[a.id].called_at));
    });
    const batch = eligible.slice(0, LIMIT);
    console.log('connected leads ' + leads.length + ' · eligible ' + eligible.length + ' · this run ' + batch.length);
    Object.keys(held).forEach(function (k) { console.log('  held ' + String(held[k]).padStart(5) + '  ' + k); });

    const rows = []; const byLine = {}; let bad = 0;
    for (const l of batch) {
        const c = connected[l.id];
        const rep = repByEmail[c.logged_by] || repByEmail[l.assigned_to] || REMY;
        const b1 = step1(l, rep.first), b2 = step2(l, rep.first);
        const f = check(b1).concat(check(b2)); if (!/\bstop\b/i.test(b1)) f.push('no opt-out on step 1');
        if (f.length) { bad++; console.log('BAD  #' + l.id + ' ' + f.join('; ')); continue; }
        byLine[rep.line] = (byLine[rep.line] || 0) + 1;
        rows.push({
            campaign_id: CAMPAIGN_ID, lead_id: l.id, assigned_to: c.logged_by || l.assigned_to || REMY.email, from_line: rep.line,
            to_phone: e164(l.owner_phone_e164 || l.owner_phone || l.phone), stage: 'queued', step: 0,
            prior_contact: true, prior_call_at: c.called_at, variant: 'vsl',
            step1_body: b1, step2_body: b2, body_generated_at: new Date().toISOString(),
        });
    }
    console.log('bodies ok ' + rows.length + ', rejected ' + bad + ' · by line ' + JSON.stringify(byLine));
    rows.slice(0, 3).forEach(function (r) { console.log('\n--- #' + r.lead_id + ' from ' + r.from_line + ' to ' + r.to_phone + '\n' + r.step1_body + '\n   step2: ' + r.step2_body); });
    if (!WRITE) { console.log('\nDRY RUN. Re-run with --write to queue them.'); return; }
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const { data, error } = await sb.from('outbound_targets').upsert(rows.slice(i, i + 200), { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true }).select('id');
        if (error) { console.error('insert failed: ' + error.message); process.exit(1); }
        inserted += (data || []).length;
    }
    console.log('queued ' + inserted + ' targets on campaign ' + CAMPAIGN_ID + '. outbound-tick sends them in the 9am to 7pm ET window, ' + campaign.daily_cap + '/day.');
}
main().catch(function (e) { console.error(e); process.exit(1); });
