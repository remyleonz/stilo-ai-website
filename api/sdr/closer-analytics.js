/**
 * GET /api/sdr/closer-analytics
 *
 * Closer stats for Remy and David. They are NOT SDRs: they do not live on dial
 * count, they live on what happens once a meeting is on the calendar.
 *
 * COUNTS MEETINGS, NOT ARTIFACTS. This reads prospecting.meeting_occurrences,
 * not lead_meetings. lead_meetings holds one row per ARTIFACT (the booking, the
 * phone call, the Meet transcript, the Granola note), averaging 2.5 rows per
 * real meeting, and 23 of those rows are `openphone` CALLS averaging 3 minutes.
 * Counting rows is what produced "87 meetings" against a real 35, and a
 * 3-minute average meeting against a real ~34. The view clusters artifacts per
 * lead on a 7-day gap, drops phone-only occurrences, and only trusts
 * transcript-backed sources for duration.
 *
 * EVERY NUMBER IS PER RANGE. The response carries today/week/month/last_week/
 * last_month/all so the Team tab's range buttons switch without a refetch.
 * Previously this endpoint had no concept of a period at all, so the closer
 * cards showed all-time numbers no matter which range was selected.
 *
 * ATTRIBUTION, and its honest limits. There is still no closer_id on a meeting.
 * A meeting is attributed when a closer's name or email appears in created_by
 * or attendees; anything else is reported in `unattributed` rather than split,
 * because a guessed split invents a close rate. Fix the root cause by stamping
 * a closer at booking time.
 *
 * Auth: admin only. These are owner numbers, not rep numbers.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');
const R = require('./_ranges');
const M = require('./_metrics');
const ID = require('./_identity');

// Terminal outcomes. EXACT matches only, and LOST is tested first. A previous
// version had 'closed' in WON and used startsWith, so 'closed_lost' matched as
// a WIN and the card reported 100% close rate against zero closes. Never
// prefix-match outcome strings whose vocabulary shares a stem.
const WON = ['closed_won', 'won'];
const LOST = ['closed_lost', 'lost', 'not_interested', 'no'];
const NOSHOW = ['no_show', 'noshow'];

function pro() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }, db: { schema: 'prospecting' }
    });
}
function pub() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
}

// Parallel pagination (see _pull.js). Callers pass a FACTORY, not a builder:
// PostgREST query builders are single-use.
const { pullAll: pullPages } = require('./_pull');
function pullAll(build) {
    return pullPages(function (from, to) { return build().range(from, to); });
}

// Does this occurrence belong to this closer? Conservative: no match means
// unattributed, never a guess.
function belongsTo(occ, closer, aliases) {
    const email = String(closer.email || '').toLowerCase();
    const blobAll = (String(occ.created_by_all || '') + '|' + String(occ.attendees_blob || '')).toLowerCase();
    if (aliases) { for (const a of aliases) { if (a && blobAll.includes(a)) return true; } }
    const name = String(closer.display_name || '').toLowerCase();
    const blob = (String(occ.created_by_all || '') + '|' + String(occ.attendees_blob || '')).toLowerCase();
    if (email && blob.includes(email)) return true;
    // Full name only. A bare first name would match a prospect who shares it.
    if (name && name.length > 3 && blob.includes(name)) return true;
    return false;
}

function bucket() {
    return {
        // Meetings
        meetings_held: R.emptyRange(),
        no_shows: R.emptyRange(),
        upcoming: R.emptyRange(),
        outcome_unknown: R.emptyRange(),
        won: R.emptyRange(),
        lost: R.emptyRange(),
        open: R.emptyRange(),
        meeting_sec: R.emptyRange(),
        meetings_with_duration: R.emptyRange(),
        // Their own outbound effort
        dials: R.emptyRange(),
        connects: R.emptyRange(),
        conversations: R.emptyRange(),
        talk_sec: R.emptyRange(),
        dial_sec: R.emptyRange(),
        emails_sent: R.emptyRange(),
        booked_by_them: R.emptyRange(),
        // Money
        deals: R.emptyRange(),
        revenue_cents: R.emptyRange()
    };
}

function rates(b) {
    const K = R.RANGE_KEYS;
    const out = {
        show_rate_pct: {}, close_rate_pct: {}, close_rate_of_held_pct: {},
        avg_meeting_min: {}, connect_rate_pct: {}, conversation_rate_pct: {},
        dials_per_meeting: {}, talk_min: {}, meeting_min: {}, avg_deal_cents: {},
        dial_time_min: {}, avg_call_sec: {}
    };
    for (const k of K) {
        // A meeting only counts as HELD when we have evidence it happened. A
        // past meeting with no outcome and no transcript is outcome_unknown,
        // not held: folding those into held is what pushed show rate to ~100%.
        const held = b.meetings_held[k];
        const resolved = held + b.no_shows[k];
        const decided = b.won[k] + b.lost[k];
        out.show_rate_pct[k] = resolved ? Math.round((held / resolved) * 100) : 0;
        out.close_rate_pct[k] = decided ? Math.round((b.won[k] / decided) * 100) : 0;
        out.close_rate_of_held_pct[k] = held ? Math.round((b.won[k] / held) * 100) : 0;
        // Averaged over meetings that actually carry a trustworthy duration, not
        // over every meeting, or untranscribed ones drag it toward zero.
        const wd = b.meetings_with_duration[k];
        out.avg_meeting_min[k] = wd ? Math.round(b.meeting_sec[k] / wd / 60) : 0;
        out.meeting_min[k] = Math.round(b.meeting_sec[k] / 60);
        out.connect_rate_pct[k] = b.dials[k] ? Math.round((b.connects[k] / b.dials[k]) * 100) : 0;
        out.conversation_rate_pct[k] = b.dials[k] ? Math.round((b.conversations[k] / b.dials[k]) * 100) : 0;
        out.dials_per_meeting[k] = b.booked_by_them[k] ? Math.round(b.dials[k] / b.booked_by_them[k]) : 0;
        out.talk_min[k] = Math.round(b.talk_sec[k] / 60);
        out.dial_time_min[k] = Math.round(b.dial_sec[k] / 60);
        out.avg_call_sec[k] = b.connects[k] ? Math.round(b.talk_sec[k] / b.connects[k]) : 0;
        out.avg_deal_cents[k] = b.deals[k] ? Math.round(b.revenue_cents[k] / b.deals[k]) : 0;
    }
    return out;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate || gate.ok === false) return;

    try {
        const sb = pub(), p = pro();
        const B = R.bounds();
        const now = Date.now();

        // Closers = active roster entries on 0% commission, which is already how
        // the owners are modelled in sdr_users.
        const { data: roster, error: rErr } = await sb.from('sdr_users')
            .select('id,email,display_name,initials,avatar_color,commission_pct,active,auth_user_id')
            .eq('active', true).eq('commission_pct', 0);
        if (rErr) throw new Error(rErr.message);
        const closers = roster || [];

        // These four are independent, so they run together. They used to be four
        // sequential awaits, and the second one pulled the ENTIRE leads table —
        // 27,054 rows over 28 sequential pages, ~7.8s — to derive exactly two
        // things: a business name for the recent-meetings list, and a per-closer
        // count of meetings they booked themselves. Both are now scoped: names
        // come from the ~42 leads that actually have a meeting occurrence, and
        // the count is a filtered HEAD query per closer.
        const [occs, calls, msgs, dealsRes] = await Promise.all([
            pullAll(function () {
                return p.from('meeting_occurrences')
                    .select('lead_id,occurrence_key,occurred_at,duration_seconds,outcome,' +
                        'created_by_all,attendees_blob,is_meeting,has_transcript,artifact_count,sources', { count: 'exact' });
            }),
            pullAll(function () {
                return p.from('lead_calls')
                    .select('logged_by,direction,outcome,duration_seconds,called_at,transcript,recording_url', { count: 'exact' })
                    .in('direction', ['outbound', 'outgoing']);
            }),
            pullAll(function () {
                return p.from('lead_messages')
                    .select('sent_by,direction,channel,sent_at', { count: 'exact' })
                    .eq('channel', 'email');
            }),
            sb.from('deals').select('id,closed_by,stage,upfront_fee_cents,monthly_retainer_cents,closed_at,paid_at,business_name')
        ]);
        const deals = dealsRes.data;

        // Names only for the leads referenced by a meeting occurrence.
        const occLeadIds = Array.from(new Set(occs.map(o => o.lead_id).filter(Boolean)));
        const leadById = {};
        const nameChunks = [];
        for (let i = 0; i < occLeadIds.length; i += 500) nameChunks.push(occLeadIds.slice(i, i + 500));
        const nameRes = await Promise.all(nameChunks.map(ch =>
            p.from('leads').select('id,name,niche,category').in('id', ch)));
        nameRes.forEach(r => (r.data || []).forEach(l => { leadById[l.id] = l; }));

        // Meetings each closer booked off their own line: one filtered count per
        // closer, run in parallel, instead of scanning every lead in the table.
        // Counted against every alias that resolves to them (see _identity).
        const idres = ID.makeResolver(roster);
        const aliasesFor = {};
        closers.forEach(c => {
            const canon = ID.lower(c.email);
            const list = [canon];
            Object.keys(ID.ALIASES).forEach(a => { if (ID.ALIASES[a] === canon) list.push(a); });
            aliasesFor[canon] = list;
        });
        const ownBookedCounts = {};
        await Promise.all(closers.map(async c => {
            const canon = ID.lower(c.email);
            const { count } = await p.from('leads')
                .select('id', { count: 'exact', head: true })
                .not('meeting_scheduled_at', 'is', null)
                .in('meeting_booked_by_sdr', aliasesFor[canon]);
            ownBookedCounts[canon] = count || 0;
        }));

        const out = [];
        const claimed = new Set();

        for (const c of closers) {
            const b = bucket();
            const recent = [];

            for (const m of occs) {
                if (!m.is_meeting) continue;              // phone-only, not a meeting
                if (!belongsTo(m, c, aliasesFor[ID.lower(c.email)])) continue;
                claimed.add(m.occurrence_key);

                const bk = R.buckets(m.occurred_at, B);
                // classifyOutcome reads the free-text recaps reps typed into
                // this column. Three of them are whole paragraphs; the old
                // indexOf test scored a written-up OWNER NO-SHOW as a meeting
                // that went fine, and the literal value 'held' matched nothing.
                const oc = M.classifyOutcome(m.outcome);
                const when = m.occurred_at ? new Date(m.occurred_at).getTime() : null;

                if (when && when > now) { R.addRange(b.upcoming, bk); continue; }

                if (oc === 'no_show') {
                    R.addRange(b.no_shows, bk);
                } else if (!oc && !m.has_transcript && !m.duration_seconds) {
                    // Past, but nothing says it happened. Surfaced, not assumed.
                    R.addRange(b.outcome_unknown, bk);
                } else {
                    R.addRange(b.meetings_held, bk);
                    if (m.duration_seconds) {
                        R.addRange(b.meeting_sec, bk, m.duration_seconds);
                        R.addRange(b.meetings_with_duration, bk);
                    }
                    if (oc === 'closed_lost') R.addRange(b.lost, bk);
                    else if (oc === 'closed_won') R.addRange(b.won, bk);
                    else if (oc) R.addRange(b.open, bk);
                }

                if (when) {
                    const l = leadById[m.lead_id] || {};
                    recent.push({
                        lead_id: m.lead_id,
                        business: l.name || 'Unknown',
                        niche: l.niche || l.category || null,
                        occurred_at: m.occurred_at,
                        outcome: m.outcome || null,
                        duration_min: m.duration_seconds ? Math.round(m.duration_seconds / 60) : null,
                        has_transcript: !!m.has_transcript,
                        artifact_count: m.artifact_count,
                        sources: m.sources || []
                    });
                }
            }

            // Meetings THEY booked off their own line, separate from meetings an
            // SDR handed them. No timestamp on the flag, so it is all-time only.
            const email = ID.lower(c.email);
            const ownBooked = ownBookedCounts[email] || 0;
            for (const k of R.RANGE_KEYS) b.booked_by_them[k] = ownBooked;

            // Identity is resolved through _identity, so a row stamped with a
            // closer's alias (Remy's personal Gmail) counts for them instead of
            // vanishing. Connect uses the SAME rule as team-analytics: this file
            // used to call any call with duration > 0 a connect, including
            // voicemails, so the funnel row and the card beneath it disagreed.
            for (const k of calls) {
                if (idres.canonical(k.logged_by) !== email) continue;
                const bk = R.buckets(k.called_at, B);
                R.addRange(b.dials, bk);
                const d = k.duration_seconds || 0;
                if (M.isContact(k)) { R.addRange(b.connects, bk); R.addRange(b.talk_sec, bk, d); }
                if (M.isConversation(k)) R.addRange(b.conversations, bk);
                R.addRange(b.dial_sec, bk, d);
            }

            for (const m of msgs) {
                if (String(m.direction || '') !== 'outbound') continue;
                if (idres.canonical(m.sent_by) !== email) continue;
                R.addRange(b.emails_sent, R.buckets(m.sent_at, B));
            }

            for (const d of (deals || [])) {
                // deals.closed_by is an AUTH uuid (FK to auth.users). Match on
                // the roster row's auth_user_id; also accept the roster id
                // itself so any hand-written legacy row still attributes.
                if (!d.closed_by) continue;
                const cb = String(d.closed_by);
                if (cb !== String(c.auth_user_id) && cb !== String(c.id)) continue;
                // Paid stages only — same rule as team-analytics. A proposal
                // that went out is not revenue, and counting it would let the
                // closer card claim money the client never sent.
                if (d.stage !== 'PAID' && d.stage !== 'ONBOARDING' && d.stage !== 'LIVE') continue;
                // Same fallback as team-analytics: a paid deal with no
                // closed_at still belongs in the all-time bucket.
                const when = d.closed_at || d.paid_at;
                const bk = when ? R.buckets(when, B)
                    : { today: false, week: false, month: false, last_week: false, last_month: false, all: true };
                R.addRange(b.deals, bk);
                R.addRange(b.revenue_cents, bk,
                    (d.upfront_fee_cents || 0) + (d.monthly_retainer_cents || 0));
            }

            recent.sort((x, y) => new Date(y.occurred_at) - new Date(x.occurred_at));
            out.push({ closer: c, stats: b, rates: rates(b), recent: recent.slice(0, 25) });
        }

        const meetingOccs = occs.filter(m => m.is_meeting);
        const unattributed = meetingOccs.filter(m => !claimed.has(m.occurrence_key)).length;

        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({
            closers: out,
            unattributed_meetings: unattributed,
            total_meetings: meetingOccs.length,
            total_artifacts: occs.reduce((s, m) => s + (m.artifact_count || 0), 0),
            attribution_note: unattributed
                ? unattributed + ' of ' + meetingOccs.length + ' meetings have no closer on the record '
                  + 'and are not counted against anyone. Stamp a closer at booking time to fix this.'
                : 'Every meeting is attributed to a closer.',
            data_note: meetingOccs.length + ' meetings reconstructed from '
                + occs.reduce((s, m) => s + (m.artifact_count || 0), 0)
                + ' records (booking, call, transcript and notes rows are merged per meeting).'
        });
    } catch (e) {
        console.error('[closer-analytics]', e);
        return res.status(500).json({ error: 'query_failed', detail: e.message });
    }
};
