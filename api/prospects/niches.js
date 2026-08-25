/**
 * GET /api/prospects/niches
 *
 * Category counts across the whole callable pool, as
 * [{ niche, count }] sorted by count desc.
 *
 * Exists because the admin Leads niche dropdown used to be built from whatever
 * rows the list happened to load. callable.js orders by category, and PostgREST
 * hard-caps a response at 1000 rows, so once the pool passed 1000 the last
 * categories alphabetically (Trucking company, Temp agency) fell off the end of
 * the response and became unselectable: you could not filter to a niche you
 * could not see, and you could not see it without filtering. Selecting one
 * narrow column keeps this cheap enough to call on every list load.
 *
 * Mirrors the callable.js predicate exactly. If that filter changes, change it
 * here too, or the dropdown starts offering niches the list cannot return.
 */
const { assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, gateToCurrentOffer } = require('./_shared');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;

    const q = req.query || {};
    // Same scoping rule as callable.js: an SDR only ever sees their own pool,
    // an admin sees everything unless they asked for one rep.
    let assignedTo;
    if (gate.isSdr && !gate.isAdmin) assignedTo = gate.email;
    else assignedTo = q.assigned_to ? await resolveAssignedTo(q.assigned_to) : null;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });

    let sel = sb.from('leads')
        .select('category')
        .or('owner_phone.not.is.null,phone.not.is.null')
        .or('do_not_call.is.null,do_not_call.eq.false')
        .is('archived_batch', null);
    // Mirror callable.js exactly: STILO mode gates on per-lead script + pitch,
    // client-account mode swaps both for the client_id filter so the dropdown
    // counts the same rows the board returns.
    const clientId = await require('./_shared').resolveClientScope(assignedTo);
    if (!clientId) sel = sel.eq('has_cold_call_script', true).not('pitch_agent', 'is', null);
    sel = gateToCurrentOffer(sel, clientId);
    if (assignedTo) sel = sel.eq('assigned_to', assignedTo);

    // One narrow column, so the 1000-row cap that broke the dropdown does not
    // apply the same way: page through until the pool is exhausted.
    const counts = new Map();
    let total = 0;
    let blank = 0;
    for (let from = 0; ; from += 1000) {
        const { data, error } = await sel.range(from, from + 999);
        if (error) return res.status(500).json({ error: error.message });
        for (const r of data) {
            const n = (r.category || '').trim();
            // Leads with no category at all are still leads. They used to be
            // dropped silently, which was harmless while the dropdown listed raw
            // categories. Now the dashboard rolls these facets up into the six
            // niche groups, and an uncategorized lead belongs to Other, so it has
            // to be counted somewhere or the option label undercounts the rows
            // the filter returns. Reported separately rather than as a nameless
            // niche entry so nothing renders a blank option.
            if (!n) { blank++; continue; }
            counts.set(n, (counts.get(n) || 0) + 1);
        }
        total += data.length;
        if (data.length < 1000) break;
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
        total,
        blank,
        niches: [...counts.entries()]
            .map(([niche, count]) => ({ niche, count }))
            .sort((a, b) => b.count - a.count || a.niche.localeCompare(b.niche))
    });
};
