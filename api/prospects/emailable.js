/**
 * GET /api/prospects/emailable
 *
 * Cold email queue: leads we could actually send a cold email to today.
 * Same query params as callable (limit, niche, tier, min_score, q,
 * assigned_to) and the same SDR scoping.
 *
 * Reads Supabase directly, exactly like api/prospects/callable.js. It used to
 * forward to David's Cloud Run service, which broke this tab twice over:
 * that backend ignores ?niche= entirely (checked 2026-08-14: byte-identical
 * response with and without it), so the five-niche dropdown did nothing here,
 * and it rejects limit>1000 with a 422 while the shared query builder asks for
 * more, so the tab failed to load at all.
 */
const {
    assertAdminOrSdr, resolveAssignedTo, methodNotAllowed, normalizeLead,
    LEAD_LIST_COLUMNS, ROLE_INBOX_PREFIXES, isRoleInbox
} = require('./_shared');
const { applyNicheFilter } = require('./callable');
const { createClient } = require('@supabase/supabase-js');

// PostgREST truncates any single response at 1000 rows no matter what .limit()
// asks for, so promising more than that would be a lie. The whole emailable
// pool is ~760, well inside it.
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 1000;

// ---- "emailable" ------------------------------------------------------------
//
// A lead is emailable when all of these hold:
//
//   1. It has a usable address. owner_email is the found personal address and
//      wins; `email` is the older scraped business address and is the fallback.
//      Both need a not-null AND a not-empty check: `email` is the empty string
//      on ~21k rows, so a plain "is not null" counts them all as contactable.
//   2. archived_batch IS NULL. Bulk-retired leads never come back into a queue
//      on their own (same rule as the dial board).
//   3. Never bounced: bounced_at IS NULL on the lead, and no lead_messages row
//      for that address carries a bounced_at.
//   4. Never unsubscribed: unsubscribed_at IS NULL, and the address is not in
//      public.lcr_suppressions.
//   5. Not a role inbox. See ROLE_INBOX_PREFIXES in _shared.js.
//
// Steps 1-3 (lead-level) and 5 run in Postgres. The address-level bounce and
// suppression checks run here in JS because both sets are tiny (91 bounced
// message rows, 2 suppressions) and neither is a column on leads.

function present(col) { return 'and(' + col + '.not.is.null,' + col + '.neq.)'; }
function absent(col) { return 'or(' + col + '.is.null,' + col + '.eq.)'; }
function notRole(col) {
    return ROLE_INBOX_PREFIXES.map(p => col + '.not.ilike.' + p + '@*').join(',');
}

// "the address this lead would actually be mailed at is not a role inbox".
// Written against the effective address, not both columns independently: a lead
// with a real owner_email and an info@ business `email` is still emailable,
// because owner_email is the one the sender picks.
const ADDRESS_PRESENT = present('owner_email') + ',' + present('email');
const NOT_ROLE_INBOX =
    'and(' + present('owner_email') + ',' + notRole('owner_email') + '),' +
    'and(' + absent('owner_email') + ',' + present('email') + ',' + notRole('email') + ')';

async function emailableFromSupabase(opts) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false },
        db: { schema: 'prospecting' }
    });
    const pub = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });

    // Explicit column list, never select('*'). prospecting.leads has ~150
    // columns and deep_research_json alone is 44% of an average row; see
    // LEAD_LIST_COLUMNS in _shared.js for why that matters.
    let q = sb.from('leads')
        .select(LEAD_LIST_COLUMNS)
        .or(ADDRESS_PRESENT)
        .is('archived_batch', null)
        .is('bounced_at', null)
        .is('unsubscribed_at', null)
        .or(NOT_ROLE_INBOX);

    if (opts.assignedTo) q = q.eq('assigned_to', opts.assignedTo);

    // Tier filter matches what the dashboard DISPLAYS: brief_tier first
    // (1=hot, 2=warm, 3=cool), falling back to the legacy prospect_tier.
    // Same derivation as normalizeLead() and as the dial board.
    if (opts.tier) {
        const briefN = { hot: 1, warm: 2, cool: 3 }[String(opts.tier).toLowerCase()];
        if (briefN) {
            q = q.or('brief_tier.eq.' + briefN + ',and(brief_tier.is.null,prospect_tier.eq.' + opts.tier + ')');
        } else {
            q = q.eq('prospect_tier', opts.tier);
        }
    }
    // Group slug ('staffing', 'other', ...) or, for back-compat, a raw category.
    // Imported from callable.js on purpose: one niche table, so the Cold Call
    // and Cold Email tabs can never classify the same lead differently.
    if (opts.niche)    q = applyNicheFilter(q, opts.niche);
    if (opts.minScore) q = q.gte('prospect_score', opts.minScore);
    if (opts.search)   q = q.ilike('name', `%${opts.search}%`);

    const { data, error } = await q
        // Cluster by niche so a rep writes all the same-pitch emails in one
        // headspace, then hottest brief tier, then score. Mirrors the dial
        // board's ordering minus the last-called leg.
        .order('category', { ascending: true, nullsFirst: false })
        .order('brief_tier', { ascending: true, nullsFirst: false })
        .order('prospect_score', { ascending: false, nullsFirst: false })
        .limit(opts.limit);

    if (error) return { error };
    const rows = data || [];

    // Address-level exits. Both tables are small enough to pull whole.
    const [bounced, suppressed] = await Promise.all([
        sb.from('lead_messages').select('to_address').not('bounced_at', 'is', null).limit(10000),
        pub.from('lcr_suppressions').select('email').limit(10000)
    ]);
    const bouncedAddrs = new Set((bounced.data || [])
        .map(r => String(r.to_address || '').trim().toLowerCase()).filter(Boolean));
    const suppressedAddrs = new Set((suppressed.data || [])
        .map(r => String(r.email || '').trim().toLowerCase()).filter(Boolean));

    const skipped = { bounced_address: 0, suppressed: 0, role_inbox: 0 };
    const results = [];
    for (const r of rows) {
        const addr = (String(r.owner_email || '').trim() || String(r.email || '').trim()).toLowerCase();
        if (!addr) continue;
        // The SQL filter above covers `info@`; this catches the separator
        // variants ILIKE cannot (info.miami@, contact_us@). 3 rows pool-wide.
        if (isRoleInbox(addr)) { skipped.role_inbox++; continue; }
        if (bouncedAddrs.has(addr)) { skipped.bounced_address++; continue; }
        if (suppressedAddrs.has(addr)) { skipped.suppressed++; continue; }
        results.push(normalizeLead(r));
    }
    return { results, skipped };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdminOrSdr(req, res);
    if (!gate.ok) return;
    const q = req.query || {};

    // Same scoping rule as callable:
    //   SDR caller             -> forced to their own email, cannot widen it
    //   Admin (+impersonation) -> ?assigned_to=<sdr_key|email>, else the whole pool
    let assignedTo;
    if (gate.isSdr && !gate.isAdmin) {
        assignedTo = gate.email;
    } else {
        assignedTo = q.assigned_to ? await resolveAssignedTo(q.assigned_to) : null;
    }

    const asked = q.limit ? parseInt(q.limit, 10) : DEFAULT_LIMIT;
    const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_LIMIT, MAX_LIMIT);

    const result = await emailableFromSupabase({
        assignedTo: assignedTo,
        tier: q.tier,
        niche: q.niche,
        minScore: q.min_score,
        search: q.q,
        limit: limit
    });
    if (result.error) return res.status(500).json({ error: result.error.message });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(result);
};
