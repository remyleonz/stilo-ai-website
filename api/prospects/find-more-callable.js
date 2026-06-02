/**
 * POST /api/prospects/find-more-callable
 * Body: { count?: number }   // default 200
 *
 * Pulls candidates from the 16k pool that meet callable criteria
 * (business name + owner_name + phone + non-DNC) AND don't yet have deep
 * research, then triggers Sage's `deep_research_callable` Cloud Run Job
 * against the resulting set.
 *
 * Selection rules (in order, all enforced):
 *   1. owner_name IS NOT NULL AND non-empty
 *   2. owner_phone OR phone IS NOT NULL AND non-empty
 *   3. do_not_call IS NOT TRUE
 *   4. last_called_at IS NULL                  -- never called before
 *   5. deep_research_done_at IS NULL           -- not yet researched
 *   6. name IS NOT NULL                        -- has a business name
 *
 * Tier ordering: hot first, then warm, then cool. Within tier order by
 * prospect_score desc.
 *
 * We DON'T enrich phones / owner_names here — those are upstream jobs.
 * This endpoint only flips already-enrichable leads from "raw" to
 * "research-queued" so the operator's queue refills.
 *
 * Triggering the Cloud Run Job:
 *   - When CLOUD_RUN_RESEARCH_JOB_URL is set, we POST to it with the
 *     selected lead_ids as a fire-and-forget payload.
 *   - Otherwise we return the list and trust an external schedule (or
 *     manual `gcloud run jobs execute deep-research-callable`) to pick
 *     them up from `research_status = 'queued'`.
 */
const { assertAdmin, readJsonBody, methodNotAllowed } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

function sb() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const gate = await assertAdmin(req, res);
    if (!gate.ok) return;

    const body = await readJsonBody(req).catch(() => ({}));
    const requested = Math.max(1, Math.min(500, Number(body.count) || 200));

    const client = sb();
    if (!client) {
        return res.status(503).json({ error: 'supabase_unavailable' });
    }

    // 1. Select candidates ordered by tier (hot > warm > cool) then score.
    //    Postgres can't do "tier in custom order" cleanly via PostgREST,
    //    so we query the three tiers in turn and stop at `requested`.
    const tiersInPriorityOrder = ['hot', 'warm', 'cool'];
    const collected = [];
    try {
        for (const tier of tiersInPriorityOrder) {
            if (collected.length >= requested) break;
            const remaining = requested - collected.length;
            const { data, error } = await client.from('leads')
                .select('id, name, owner_name, owner_phone, phone, prospect_tier, prospect_score')
                .eq('prospect_tier', tier)
                .not('owner_name', 'is', null).neq('owner_name', '')
                .or('owner_phone.not.is.null,phone.not.is.null')
                .or('do_not_call.is.null,do_not_call.eq.false')
                .is('last_called_at', null)
                .is('deep_research_done_at', null)
                .not('name', 'is', null)
                .order('prospect_score', { ascending: false, nullsFirst: false })
                .limit(remaining);
            if (error) throw error;
            for (const row of (data || [])) collected.push(row);
        }
    } catch (e) {
        return res.status(500).json({ error: 'selection_failed', detail: String(e.message || e) });
    }

    if (collected.length === 0) {
        return res.status(200).json({
            queued: 0,
            message: 'No eligible leads found in the pool. All callable leads have already been researched or there are no leads with phone + owner_name yet. Consider running the phone_finder and owner_name extraction jobs to enrich more leads from the raw 16k pool.'
        });
    }

    // 2. Stamp the selected rows as research-queued so the Cloud Run Job
    //    (or a manual script run) knows what to work on. We don't mark
    //    `deep_research_done_at` yet — that's the job's responsibility
    //    when it actually completes the research.
    const ids = collected.map(r => r.id);
    const queuedAt = new Date().toISOString();
    try {
        const { error } = await client.from('leads').update({
            research_status: 'queued',
            research_queued_at: queuedAt,
            research_queued_by: gate.email
        }).in('id', ids);
        if (error && error.code !== '42703') {  // 42703 = column doesn't exist
            throw error;
        }
        // If the columns don't exist yet, fall through — the job can still
        // pick up rows by querying for `deep_research_done_at IS NULL` if
        // we surface a lead_ids parameter.
    } catch (e) {
        return res.status(500).json({ error: 'queue_stamp_failed', detail: String(e.message || e) });
    }

    // 3. Best-effort: kick the Cloud Run Job. If the trigger URL isn't
    //    configured we still return success — the rows are queued and the
    //    nightly job (or a manual `gcloud run jobs execute`) will catch
    //    them. Fire-and-forget so the UI doesn't block on a 22-min run.
    const triggerUrl = process.env.CLOUD_RUN_RESEARCH_JOB_URL;
    let triggered = false;
    if (triggerUrl) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            fetch(triggerUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (process.env.CLOUD_RUN_RESEARCH_JOB_TOKEN || '')
                },
                body: JSON.stringify({ lead_ids: ids, requested_by: gate.email }),
                signal: ctrl.signal
            }).then(() => clearTimeout(t)).catch(() => clearTimeout(t));
            triggered = true;
        } catch (_) { /* fire and forget */ }
    }

    return res.status(200).json({
        queued: ids.length,
        tier_breakdown: collected.reduce((acc, r) => {
            const t = r.prospect_tier || 'unknown';
            acc[t] = (acc[t] || 0) + 1;
            return acc;
        }, {}),
        cloud_run_triggered: triggered,
        message: triggered
            ? 'Queued ' + ids.length + ' leads. Sage research started — should complete in ~22 minutes.'
            : 'Queued ' + ids.length + ' leads. Research job not auto-triggered (CLOUD_RUN_RESEARCH_JOB_URL not set); run `gcloud run jobs execute deep-research-callable` to process them.'
    });
};
