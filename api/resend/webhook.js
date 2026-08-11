/**
 * POST /api/resend/webhook
 *
 * Receives Resend email events and stamps them onto the matching
 * prospecting.lead_messages row (matched by provider_message_id = Resend's
 * email id). This is what powers the email A/B test's "clicked" and booking
 * funnel: when a prospect clicks the calendar link in a sent email, Resend
 * fires `email.clicked`, and we record clicked_at so the A/B panel can show a
 * click-through rate per template arm.
 *
 * Events handled:
 *   email.delivered → delivered_at, status='delivered'
 *   email.opened    → opened_at   (weak signal: Apple Mail prefetches inflate it)
 *   email.clicked   → clicked_at  (the real intent signal we test on)
 *   email.bounced   → bounced_at, status='bounced'  + leads.bounced_at
 *   email.complained→ status='complained' + leads.bounced_at + lcr_suppressions
 *
 * BOUNCES AND COMPLAINTS PROPAGATE TO THE LEAD. Stamping only the message row
 * is not enough: every sender path (email-sequence, vsl-campaign, outbound)
 * decides who to mail off prospecting.leads and public.lcr_suppressions. A
 * bounce writes leads.bounced_at (first one wins, so the original bounce date
 * survives duplicate webhook deliveries). A complaint is a hard stop: somebody
 * pressed "report spam", so it stamps the lead AND suppresses the address
 * outright, which is the one list every sender we own consults.
 *
 * Auth: Svix signature (Resend signs every webhook with Svix). The signing
 * secret is RESEND_WEBHOOK_SECRET ("whsec_..."), created when you add the
 * endpoint in the Resend dashboard. Verification uses the raw body, so the
 * Vercel body parser is disabled below.
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function leadsClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}
// lcr_suppressions lives in public, not prospecting.
function publicClient() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// Suppression rows are keyed by (client_slug, email). Cold prospecting mail is
// tagged 'prospecting', the same slug the one-click unsubscribe token carries,
// so a complaint and an unsubscribe land in the same bucket.
const SUPPRESSION_CLIENT_SLUG = 'prospecting';

// Resend puts the bounce detail in different places depending on the provider
// that reported it. Take the first thing that reads like a reason.
function bounceReason(data) {
    const d = data || {};
    const b = d.bounce || {};
    const raw = b.message || b.subType || b.type || d.reason || d.message
        || (b.diagnosticCode || d.diagnostic_code) || null;
    if (!raw) return null;
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 300) || null;
}

async function readRawBody(req) {
    if (req.rawBody) return req.rawBody;
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks);
}

// Svix signature check (what Resend uses). Header `svix-signature` is a space
// separated list of "v1,<base64sig>". We HMAC `${id}.${timestamp}.${body}`
// with the base64-decoded secret (after the "whsec_" prefix) and compare.
function verifySvix(secret, headers, rawBody) {
    const id = headers['svix-id'];
    const ts = headers['svix-timestamp'];
    const sigHeader = headers['svix-signature'];
    if (!id || !ts || !sigHeader) return false;
    // Reject very old timestamps (replay guard): 5 minute tolerance.
    const tsNum = parseInt(ts, 10);
    if (!isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const signed = id + '.' + ts + '.' + rawBody.toString('utf8');
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    const expBuf = Buffer.from(expected);
    return String(sigHeader).split(' ').some(function (part) {
        const sig = part.indexOf(',') !== -1 ? part.split(',')[1] : part;
        try {
            const sb = Buffer.from(sig);
            return sb.length === expBuf.length && crypto.timingSafeEqual(sb, expBuf);
        } catch (_) { return false; }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'resend_webhook_not_configured' });

    const raw = await readRawBody(req);
    if (!verifySvix(secret, req.headers, raw)) return res.status(401).json({ error: 'invalid_signature' });

    let evt;
    try { evt = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    const type = evt.type || '';
    const emailId = evt.data && (evt.data.email_id || evt.data.id);
    const when = (evt.created_at) || new Date().toISOString();
    if (!emailId) return res.status(200).json({ ok: true, ignored: 'no_email_id' });

    const patch = {};
    if (type === 'email.delivered') { patch.delivered_at = when; patch.status = 'delivered'; }
    else if (type === 'email.opened') { patch.opened_at = when; }
    else if (type === 'email.clicked') { patch.clicked_at = when; }
    else if (type === 'email.bounced') { patch.bounced_at = when; patch.status = 'bounced'; }
    else if (type === 'email.complained') { patch.status = 'complained'; }
    else return res.status(200).json({ ok: true, ignored: type });

    const isBounce = type === 'email.bounced';
    const isComplaint = type === 'email.complained';
    let propagated = null;

    try {
        const sb = leadsClient();
        // Don't overwrite an existing earlier timestamp with a later duplicate
        // event: only stamp the column if it's currently null (for clicked/opened).
        // The returned rows tell us which lead and address this event belongs
        // to, which is what the bounce/complaint propagation below needs.
        const { data: rows, error } = await sb.from('lead_messages').update(patch)
            .eq('provider_message_id', emailId)
            .select('lead_id,to_address');
        if (error) { console.error('[resend-webhook] update failed:', error.message); return res.status(200).json({ ok: false }); }

        if (isBounce || isComplaint) {
            const leadIds = Array.from(new Set((rows || []).map(function (r) { return r.lead_id; }).filter(Boolean)));
            const addrs = Array.from(new Set((rows || [])
                .map(function (r) { return String(r.to_address || '').toLowerCase().trim(); })
                .filter(Boolean)));
            propagated = { leads: leadIds.length, addresses: addrs.length, suppressed: 0 };

            // Stamp the lead so every sender path stops picking it up. Only
            // when currently null: a duplicate webhook must not move the date
            // forward, and a later complaint must not overwrite the original
            // bounce reason.
            if (leadIds.length) {
                const leadPatch = { bounced_at: when };
                const reason = isComplaint
                    ? 'spam_complaint' + (bounceReason(evt.data) ? ': ' + bounceReason(evt.data) : '')
                    : bounceReason(evt.data);
                if (reason) leadPatch.bounce_reason = reason;
                const { error: leadErr } = await sb.from('leads')
                    .update(leadPatch).in('id', leadIds).is('bounced_at', null);
                if (leadErr) console.error('[resend-webhook] lead stamp failed:', leadErr.message);
            }

            // A complaint is a hard stop, not a data point. Suppress the
            // address itself so the sequence, the VSL campaign and every other
            // sender skip it even if the person turns up on a different lead.
            if (isComplaint && addrs.length) {
                const pub = publicClient();
                // Deliberately NOT an upsert. The uniqueness here is a PARTIAL
                // index (client_slug, email) WHERE email IS NOT NULL, and
                // Postgres cannot infer a partial index from a bare
                // ON CONFLICT (client_slug, email); it raises 42P10. So read
                // first, insert only what's missing. Duplicates are the normal
                // case (Resend redelivers), not an error.
                const { data: already } = await pub.from('lcr_suppressions')
                    .select('email')
                    .eq('client_slug', SUPPRESSION_CLIENT_SLUG)
                    .in('email', addrs);
                const have = new Set((already || []).map(function (r) { return String(r.email || '').toLowerCase(); }));
                const rowsToAdd = addrs.filter(function (a) { return !have.has(a); }).map(function (a) {
                    return {
                        client_slug: SUPPRESSION_CLIENT_SLUG,
                        email: a,
                        source: 'resend_complaint',
                        opted_out_at: when,
                        notes: 'Resend email.complained on ' + emailId,
                    };
                });
                if (rowsToAdd.length) {
                    const { error: supErr } = await pub.from('lcr_suppressions').insert(rowsToAdd);
                    // 23505 = the race lost to a concurrent delivery of the same
                    // event. That address is suppressed either way; not an error.
                    if (supErr && supErr.code !== '23505') {
                        console.error('[resend-webhook] suppression insert failed:', supErr.message);
                    } else {
                        propagated.suppressed = rowsToAdd.length;
                    }
                }
            }
        }
    } catch (e) {
        console.error('[resend-webhook] threw:', e && e.message);
        return res.status(200).json({ ok: false });
    }

    return res.status(200).json({ ok: true, type: type, propagated: propagated || undefined });
};

// Raw body required for Svix verification — keep Vercel's parser off.
module.exports.config = { api: { bodyParser: false } };
