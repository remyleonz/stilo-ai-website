/**
 * GET /api/prospects/list-exhausted?limit=200
 *
 * "Operator-dead" leads — anything we should not call again. Two paths in:
 *   - last_called_outcome IN ('do_not_call','dnc_request','wrong_number',
 *     'disconnected') — explicit terminal outcomes from a logged call.
 *   - call_attempts >= 3 AND last_called_outcome IS NULL — auto-decay
 *     after 3 dial attempts with no logged outcome.
 *
 * Distinct from David's `/api/prospects/dead` which returns leads whose
 * prospect_tier='dead' (his auto-archive of low-fit / unreachable leads
 * that were never called by us). Per Remy 2026-05-05: those should not
 * appear in the operator's Dead Pool.
 *
 * Service-role server-side query (sidesteps schema exposure issues on
 * supabase-js for non-admin contexts).
 */
const { assertAdmin, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

const SELECT_COLS = [
    'id', 'name', 'owner_name', 'owner_phone', 'phone', 'owner_email', 'email',
    'category', 'prospect_tier', 'prospect_score', 'score',
    'last_called_at', 'last_called_outcome', 'call_attempts', 'do_not_call'
].join(',');

const TERMINAL_OUTCOMES = ['do_not_call', 'dnc_request', 'wrong_number', 'disconnected'];

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(500).json({ error: 'supabase_not_configured' });
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '400', 10), 1), 1000);
    // ?assigned_to=remy|david scopes the Dead Pool table to the SDR who
    // logged the terminal call. Source of truth: lead_calls.logged_by.
    // Without this, both SDRs see each other's dead leads (Remy's "Do Not
    // Call" entry appears in David's Dead Pool).
    const SDR_EMAIL_BY_KEY = {
        remy:  'remyleon@stiloaipartners.com',
        david: 'davidcoira@stiloaipartners.com'
    };
    const sdrEmail = SDR_EMAIL_BY_KEY[String((req.query && req.query.assigned_to) || '').toLowerCase()] || null;

    try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
            auth: { persistSession: false },
            db: { schema: 'prospecting' }
        });
        // OR: terminal outcome from a logged call, OR exhausted dialing
        // pattern (3+ attempts no outcome). PostgREST nested AND inside OR
        // uses the `and(...)` syntax.
        const filter = 'last_called_outcome.in.(' + TERMINAL_OUTCOMES.join(',') + ')'
            + ',and(call_attempts.gte.3,last_called_outcome.is.null)';
        // Scope by assigned_to (parity-based, always populated) rather than
        // lead_calls.logged_by, which is sparse for calls logged before the
        // lead_calls INSERT path was deployed.
        let q = sb.from('leads').select(SELECT_COLS).or(filter);
        if (sdrEmail) q = q.eq('assigned_to', sdrEmail);
        const resp = await q
            .order('last_called_at', { ascending: false, nullsFirst: false })
            .limit(limit);
        if (resp.error) throw resp.error;
        // Tag rows with a synthetic reason so the UI can show why a lead
        // landed here without re-deriving the rule client-side.
        const rows = (resp.data || []).map(function (r) {
            const reason = TERMINAL_OUTCOMES.indexOf(r.last_called_outcome) >= 0
                ? r.last_called_outcome
                : 'exhausted_3_attempts';
            return Object.assign({}, r, { _dead_reason: reason });
        });
        return res.status(200).json({ results: rows });
    } catch (e) {
        console.error('[list-exhausted]', e);
        return res.status(500).json({ error: 'list_exhausted_failed', detail: String(e.message || e) });
    }
};
