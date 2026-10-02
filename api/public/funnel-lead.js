/**
 * POST /api/public/funnel-lead
 *
 * The contact form on a client VSL page. Upserts the person into the client's
 * lead pool (prospecting.leads, client_id set) and records the raw answers in
 * public.funnel_submissions, then alerts Remy so the callback happens while they
 * are still on the page.
 *
 * Body: { site, session_id, visitor_id, lid?, t?, name, business?, phone, email?,
 *         lang?, answers: { segment, interest, medical, timeline, path_pref } }
 *
 * Lead resolution (api/public/_funnel.js findLead): verified token -> phone
 * (both stored shapes) -> email, all scoped to the client's pool. No match =
 * a new lead row with lead_source 'blason_vsl'.
 *
 * What the form is allowed to change on an EXISTING lead: the person typed
 * their own name, cell and email, which beats anything we scraped. So:
 *   owner_phone / owner_phone_e164  set when blank or different (old value kept in rep_notes)
 *   owner_email                     same rule
 *   owner_name                      set when blank or not already verified
 *   next_step / next_step_due       always: "Call back: finished the VSL quiz" due now
 *   stage                           NEVER touched (a booked or closed lead stays what it is)
 *
 * Returns { ok, lead_id, t } where t is the signed lead token, so the booking
 * step that follows is attributed to this exact lead without re-matching.
 */
const F = require('./_funnel');

const RL_PER_IP_PER_HOUR = 6;
const _rl = { ipHits: new Map() };
function rateLimited(req) {
    const now = Date.now();
    const ip = F.ipOf(req) || 'unknown';
    const hits = (_rl.ipHits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
    if (hits.length >= RL_PER_IP_PER_HOUR) { _rl.ipHits.set(ip, hits); return true; }
    hits.push(now); _rl.ipHits.set(ip, hits);
    if (_rl.ipHits.size > 5000) _rl.ipHits.clear();
    return false;
}

// Category for a brand-new lead row. The quiz no longer asks business type
// (2026-10-02 reorder); a provider on staff is the closest signal we have.
function categoryFor(answers) {
    if (answers.medical === 'yes') return 'Medical spa';
    if (answers.medical === 'planning') return 'Medical spa';
    return 'Spa';
}

function nowIso() { return new Date().toISOString(); }
function noteLine(s) { return '[' + nowIso().slice(0, 16).replace('T', ' ') + ' VSL form] ' + s; }

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const body = await F.readJsonBody(req);
    if (body && body.error === 'body_too_large') return res.status(413).json({ error: 'body_too_large' });
    const site = F.SITES[String(body.site || '')];
    if (!site) return res.status(400).json({ error: 'unknown_site' });
    if (!F.configured()) return res.status(503).json({ error: 'not_configured' });

    const name = F.str(body.name, 120);
    const business = F.str(body.business, 160);
    const e164 = F.normalizePhone(body.phone);
    const email = F.str(body.email, 320);
    const lang = /^es/i.test(String(body.lang || '')) ? 'es' : 'en';
    const a = (body.answers && typeof body.answers === 'object') ? body.answers : {};
    const answers = {
        interest: F.str(a.interest, 40), quoted: F.str(a.quoted, 40), medical: F.str(a.medical, 40),
        motive: F.str(a.motive, 40), path_pref: F.str(a.path_pref, 40),
        // older page versions still send these two; keep them if present
        segment: F.str(a.segment, 40), timeline: F.str(a.timeline, 40),
    };

    if (!name) return res.status(400).json({ error: 'missing_name' });
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });
    if (email && !F.isEmail(email)) return res.status(400).json({ error: 'invalid_email' });
    if (rateLimited(req)) return res.status(429).json({ error: 'rate_limited' });

    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const pros = F.sbProspecting();
    const pub = F.sbPublic();
    const phoneFmt = F.phoneDisplay(e164);

    // --- find or create the lead -------------------------------------------
    let found = null;
    try { found = await F.findLead(pros, site, Object.assign({}, body, { phone: e164, email: email })); }
    catch (e) { console.warn('[funnel-lead] findLead failed:', e && e.message); }

    let leadId = null, created = false, how = found ? found.how : 'new';
    const summary = F.QUIZ_KEYS
        .filter(function (k) { return answers[k]; })
        .map(function (k) { return F.label(k, answers[k]); }).join(' / ');
    const nextStep = (lang === 'es' ? 'Llamar: llenó el quiz del video' : 'Call back: finished the VSL quiz')
        + (answers.interest ? ' (' + F.label('interest', answers.interest) + ')' : '')
        + (answers.path_pref ? ', wants ' + (answers.path_pref === 'showroom' ? 'the showroom' : 'the 10-min call') : '');

    try {
        if (found) {
            const L = found.lead;
            leadId = L.id;
            const upd = { next_step: nextStep, next_step_due: nowIso(), updated_at: nowIso() };
            const notes = [];
            const oldPhone = L.owner_phone_e164 || F.normalizePhone(L.owner_phone) || null;
            if (oldPhone !== e164) {
                upd.owner_phone = phoneFmt; upd.owner_phone_e164 = e164;
                upd.owner_phone_source = 'vsl_form'; upd.owner_phone_confidence = 'high';
                if (L.owner_phone) notes.push('cell from form ' + phoneFmt + ' (was ' + L.owner_phone + ')');
            }
            if (email && String(L.owner_email || '').toLowerCase() !== email.toLowerCase()) {
                upd.owner_email = email;
                if (L.owner_email) notes.push('email from form ' + email + ' (was ' + L.owner_email + ')');
            }
            if (!L.owner_name || !['verified', 'rep_confirmed'].includes(L.owner_name_verify_status)) {
                upd.owner_name = name; upd.owner_name_verify_status = 'verified';
                upd.owner_name_verify_source = 'vsl_form'; upd.owner_name_last_verified = nowIso();
                if (L.owner_name && L.owner_name !== name) upd.owner_name_previous = L.owner_name;
            }
            if (!L.primary_language) upd.primary_language = lang;
            notes.unshift('quiz: ' + (summary || 'no answers') + (business && business !== L.name ? ' · typed business "' + business + '"' : ''));
            upd.rep_notes = (L.rep_notes ? L.rep_notes + '\n' : '') + noteLine(notes.join('; '));
            const r = await pros.from('leads').update(upd).eq('id', leadId);
            if (r.error) console.warn('[funnel-lead] update failed:', r.error.message);
        } else {
            const seed = {
                name: business || name, owner_name: name, owner_phone: phoneFmt, owner_phone_e164: e164,
                owner_phone_source: 'vsl_form', owner_phone_confidence: 'high',
                owner_email: email || null, client_id: site.client_id, stage: 'NEW',
                lead_source: site.lead_source, lead_source_detail: 'landing page quiz',
                primary_language: lang, category: categoryFor(answers),
                owner_name_verify_status: 'verified', owner_name_verify_source: 'vsl_form', owner_name_last_verified: nowIso(),
                next_step: nextStep, next_step_due: nowIso(),
                rep_notes: noteLine('new lead from the VSL page. quiz: ' + (summary || 'no answers')),
            };
            const { data: ins, error } = await pros.from('leads').insert(seed).select('id').single();
            if (error) { console.error('[funnel-lead] insert failed:', error.message); return res.status(500).json({ error: 'lead_insert_failed' }); }
            leadId = ins.id; created = true;
        }
    } catch (e) {
        console.error('[funnel-lead] lead write threw:', e && e.message);
        return res.status(500).json({ error: 'lead_write_failed' });
    }

    // --- raw submission + event -------------------------------------------
    const sessionId = F.str(body.session_id, 64), visitorId = F.str(body.visitor_id, 64);
    let submissionId = null;
    try {
        const { data: sub } = await pub.from('funnel_submissions').insert({
            site: body.site, session_id: sessionId, visitor_id: visitorId, lead_id: leadId, lead_created: created,
            name: name, business: business, phone: phoneFmt, phone_e164: e164, email: email, lang: lang,
            segment: answers.segment, interest: answers.interest, medical: answers.medical, timeline: answers.timeline,
            quoted: answers.quoted, motive: answers.motive, path_pref: answers.path_pref, answers: answers, ua: ua, ip_hash: F.ipHash(req),
        }).select('id').single();
        submissionId = sub && sub.id;
        await pub.from('funnel_events').insert({
            site: body.site, event: 'contact_submitted', session_id: sessionId, visitor_id: visitorId,
            lead_id: leadId, lead_claimed: true, meta: { how: how, created: created, submission_id: submissionId },
            path: F.str(body.path, 300), lang: lang, ua: ua, ip_hash: F.ipHash(req),
        });
    } catch (e) { console.warn('[funnel-lead] submission log failed:', e && e.message); }

    // --- alert Remy ----------------------------------------------------------
    try {
        const lines = F.QUIZ_KEYS
            .filter(function (k) { return answers[k]; })
            .map(function (k) { return '<li>' + F.esc(k.replace('_pref', '')) + ': <strong>' + F.esc(F.label(k, answers[k])) + '</strong></li>'; }).join('');
        await F.notify(
            'Blason VSL lead: ' + (business || name) + (answers.path_pref ? ' wants ' + (answers.path_pref === 'showroom' ? 'the showroom' : 'a call') : ''),
            '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:22px;color:#111;font-size:15px;line-height:1.55">'
            + '<p><strong>' + F.esc(name) + '</strong>' + (business ? ' at <strong>' + F.esc(business) + '</strong>' : '') + ' left their details on the Blason page' + (lang === 'es' ? ' (Spanish)' : '') + '.</p>'
            + '<p style="font-size:18px"><a href="tel:' + F.esc(e164) + '">' + F.esc(phoneFmt) + '</a>' + (email ? '<br><a href="mailto:' + F.esc(email) + '">' + F.esc(email) + '</a>' : '') + '</p>'
            + '<ul style="padding-left:18px">' + lines + '</ul>'
            + '<p>Lead #' + leadId + ' (' + (created ? 'new' : 'matched by ' + F.esc(how)) + '). They are now choosing a time; if nothing books in 10 minutes, call anyway.</p>'
            + '<p style="color:#555">Open with their answer, not the page: "You mentioned you are looking at ' + F.esc((F.label('interest', answers.interest) || 'a machine').toLowerCase()) + '. What are you running in that room today?"</p>'
            + '<p><a href="https://admin.stiloaipartners.com/#prospecting?lead=' + leadId + '">Open lead #' + leadId + '</a></p></div>'
        );
    } catch (_) { /* best-effort */ }

    return res.status(200).json({ ok: true, lead_id: leadId, t: F.signLead(leadId), created: created, submission_id: submissionId });
};
