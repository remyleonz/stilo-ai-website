/**
 * Paginated pulls that do not run one page at a time.
 *
 * PostgREST caps a response at 1000 rows, so every analytics endpoint here
 * loops .range(from, from+999) until a short page comes back. That loop is
 * strictly sequential: 3,323 calls is four round trips waiting on each other,
 * and closer-analytics' full-table lead scan was twenty-eight of them (~7.8s)
 * before it had a single number to add up.
 *
 * pullAll asks for the exact count on the first page, then fetches every
 * remaining page at once. Four sequential trips become one trip plus three
 * parallel ones, so a pull costs about as long as its slowest single page
 * instead of the sum of all of them.
 */

const MAX_PARALLEL = 8; // don't open an unbounded number of sockets at Supabase

/**
 * @param {function(number, number): object} pageQuery  builds a fresh query for
 *        a given [from, to]. Must be a factory: a PostgREST query builder is
 *        single-use, so reusing one instance across pages silently returns the
 *        same rows.
 */
async function pullAll(pageQuery) {
    // First page also asks for the total, which is what makes the rest parallel.
    const first = await pageQuery(0, 999);
    if (first.error) throw first.error;
    const rows = first.data || [];
    if (rows.length < 1000) return rows;

    // count comes back as the total when the query was built with
    // { count: 'exact' }; if it is missing, fall back to sequential paging.
    const total = typeof first.count === 'number' ? first.count : null;
    if (total === null) return sequentialRest(pageQuery, rows);

    const offsets = [];
    for (let from = 1000; from < total; from += 1000) offsets.push(from);

    const out = rows.slice();
    for (let i = 0; i < offsets.length; i += MAX_PARALLEL) {
        const batch = offsets.slice(i, i + MAX_PARALLEL);
        const pages = await Promise.all(batch.map(function (from) { return pageQuery(from, from + 999); }));
        for (const p of pages) {
            if (p.error) throw p.error;
            out.push.apply(out, p.data || []);
        }
    }
    return out;
}

async function sequentialRest(pageQuery, first) {
    const out = first.slice();
    for (let from = 1000; ; from += 1000) {
        const r = await pageQuery(from, from + 999);
        if (r.error) throw r.error;
        const d = r.data || [];
        out.push.apply(out, d);
        if (d.length < 1000) break;
    }
    return out;
}

module.exports = { pullAll };
