/**
 * GET /api/prospects/callbacks
 *
 * Leads that need a follow-up call: an explicit callback scheduled
 * (next_action_type='callback') or a call outcome that asks for follow-up
 * (callback_requested / interested_followup), excluding DNC.
 *
 * Reads Supabase prospecting.leads directly (service-role key). We dropped
 * the forward to David's Cloud Run /api/prospects/callbacks because that
 * endpoint hangs under load and left the Callbacks subtab stuck on "Loading…".
 *
 * SDR scoping: SDR callers are force-scoped to their own email; admins may
 * pass ?assigned_to=<sdr_key|email>.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead, gateToCurrentOffer, resolveClientScope, LEAD_LIST_COLUMNS } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return res.status(200).json({ results: [] });
    }

    let sdrEmail = null;
    if (gate.isSdr && !gate.isAdmin) {
        sdrEmail = gate.email;
    } else if (req.query && req.query.assigned_to) {
        sdrEmail = await resolveAssignedTo(req.query.assigned_to);
    }

    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '200', 10), 1), 500);

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    // NOTE: booked meetings are deliberately NOT merged into this query. The
    // callbacks calendar already plots them as a separate layer sourced from
    // /api/prospects/list-booked (STATE.cbMeetings in the dashboard). Adding them
    // here would draw every meeting twice on the calendar.
    // A scheduled callback only counts when a HUMAN put it there. Machine
    // outcomes (voicemail / no_answer / missed_inbound from the Quo webhook or
    // David's backend) must never surface here even if something re-stamps
    // next_action_type — that was the bug where every unanswered dial showed up
    // as a due-today callback. Keep in sync with list-callbacks.js.
    // List columns only. The callback calendar renders a chip per lead
    // (time, business, owner, phone) and nothing else off the row.
    // callback_dismissed_at: the rep (or Remy) took this one off the list from
    // the Callbacks tab. It is a dismissal, not a delete — call history,
    // outcomes and commissions are untouched, and set-callback.js clears the
    // stamp the moment anyone reschedules or re-adds the lead. It has to live
    // here rather than in a next_action_type reset because the OR above puts a
    // lead on this list via last_called_outcome alone. Keep in sync with
    // list-callbacks.js.
    let q = sb.from('leads')
        .select(LEAD_LIST_COLUMNS)
        .or('last_called_outcome.in.(callback_requested,interested_followup),and(next_action_type.eq.callback,or(last_called_outcome.is.null,last_called_outcome.not.in.(voicemail,no_answer,missed_inbound)))')
        .is('callback_dismissed_at', null)
        .or('do_not_call.is.null,do_not_call.eq.false');
    // All 128 callbacks on the boards at the pivot were legacy agent pitches and
    // every one was overdue (Jun 3 - Jul 29), so none was a live promise to a
    // prospect. Dialing one would have opened a script for a retired product.
    // Hidden, not deleted: history, call logs and commissions are untouched, and
    // they return the moment David re-briefs them under the current offer.
    // Client-account reps get their client's callbacks instead (same gate as
    // the dial board, so the two can never drift).
    q = gateToCurrentOffer(q, await resolveClientScope(sdrEmail));
    if (sdrEmail) q = q.eq('assigned_to', sdrEmail);

    const { data, error } = await q
        .order('next_action_due_at', { ascending: true, nullsFirst: false })
        .limit(limit);

    if (error) {
        console.error('[callbacks]', error);
        return res.status(500).json({ error: 'query_failed', detail: error.message });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ results: (data || []).map(normalizeLead) });
};
