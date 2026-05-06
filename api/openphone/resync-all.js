/**
 * POST /api/openphone/resync-all
 *
 * One-shot admin tool: re-pushes every currently-eligible HOT lead through
 * the same path the Postgres trigger uses (sync-from-supabase). Lets us
 * roll out buildContactBody changes without waiting for each lead's next
 * lifecycle event to fire the trigger.
 *
 * Eligibility (matches sync-from-supabase): tier=hot, owner_phone present,
 * owner_name present, do_not_call != true, last_called_outcome !=
 * 'booked_meeting'.
 *
 * Auth: standard admin JWT. Will refuse if SUPABASE_TRIGGER_SECRET isn't
 * set (because that's how it forwards into the receiver).
 *
 * Returns a per-lead result so the user can see which contacts updated,
 * which got deleted (eligibility changed), and which failed.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

const RESYNC_BATCH_SIZE = 50;  // safety: don't slam Quo's rate limit in one tick
const TIMEOUT_MS_PER_LEAD = 4000;

async function pushOne(originUrl, secret, lead) {
    // Forward through our own /api/openphone/sync-from-supabase so we get
    // identical behavior to the Postgres trigger path. The trigger sends
    // type='UPDATE' + record + old_record; we synthesize that shape.
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS_PER_LEAD);
    try {
        const r = await fetch(originUrl + '/api/openphone/sync-from-supabase', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + secret
            },
            body: JSON.stringify({
                type: 'UPDATE',
                table: 'leads',
                record: lead,
                old_record: lead,
                eligible_now: true,
                was_eligible: true
            }),
            signal: ctrl.signal
        });
        const text = await r.text();
        let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        return { lead_id: lead.id, name: lead.name, status: r.status, action: json && json.action, note: json && json.note };
    } catch (e) {
        return { lead_id: lead.id, name: lead.name, error: String(e.message || e) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;
    if (!process.env.SUPABASE_TRIGGER_SECRET) {
        return res.status(503).json({ error: 'trigger_secret_not_configured', detail: 'Set SUPABASE_TRIGGER_SECRET in Vercel env so this can call the receiver.' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const originUrl = proto + '://' + host;
    const secret = process.env.SUPABASE_TRIGGER_SECRET;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    const { data: leads, error } = await sb.from('leads')
        .select('*')
        .eq('prospect_tier', 'hot')
        .not('owner_name', 'is', null).neq('owner_name', '')
        .not('owner_phone', 'is', null).neq('owner_phone', '')
        .not('do_not_call', 'eq', true)
        .or('last_called_outcome.is.null,last_called_outcome.neq.booked_meeting')
        .limit(RESYNC_BATCH_SIZE);
    if (error) return res.status(500).json({ error: 'lead_query_failed', detail: error.message });

    const results = [];
    for (const lead of (leads || [])) {
        // Sequential so we don't trip Quo's rate limit. 50 leads * ~1s each
        // ≈ 50s, well under Vercel's 60s function timeout.
        results.push(await pushOne(originUrl, secret, lead));
    }
    const summary = {
        total: results.length,
        ok: results.filter(function (r) { return r.status >= 200 && r.status < 300; }).length,
        errored: results.filter(function (r) { return r.error || (r.status >= 400); }).length
    };
    return res.status(200).json({ summary, results });
};
