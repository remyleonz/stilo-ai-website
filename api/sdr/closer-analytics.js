/**
 * GET /api/sdr/closer-analytics
 *
 * Closer stats for Remy and David. They are NOT SDRs: they do not live on dial
 * count, they live on what happens once a meeting is on the calendar. The SDR
 * cards answer "did you make the calls"; this answers "did you close the room".
 *
 * ATTRIBUTION, and its honest limits.
 * There is no closer_id on prospecting.lead_meetings. The only signals are:
 *   1. lead_meetings.attendees — inconsistent by source. sync-meetings writes
 *      [{name,role,email}], sync-meet-transcripts writes bare name strings
 *      (["Carlos Link","David Coira"]).
 *   2. lead_meetings.created_by — an email when a human logged it, otherwise a
 *      cron/system tag.
 *   3. deals.closed_by — a uuid, currently null on the only deal.
 * So a meeting is attributed when a closer's name OR email appears in either
 * field, and everything else lands in `unattributed`, which the UI shows. It is
 * NOT split between them, because a guessed split would silently invent a close
 * rate. Fix the root cause by stamping a closer on the meeting at booking time.
 *
 * Auth: admin only. These are owner numbers, not rep numbers.
 */
const { assertAdmin, methodNotAllowed } = require('../prospects/_shared');
const { createClient } = require('@supabase/supabase-js');

// Terminal outcomes: a meeting that reached a decision, so it belongs in the
// close-rate denominator. `needs_time` deliberately counts as still open.
// EXACT matches only, and LOST is tested first. A previous version had 'closed'
// in WON and used startsWith, so 'closed_lost' matched as a WIN and the card
// reported a 100% close rate against zero actual closes. Never prefix-match
// outcome strings whose vocabulary shares a stem.
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

async function pullAll(q) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await q.range(from, from + 999);
        if (error) throw new Error(error.message);
        if (!data || !data.length) break;
        out.push(...data);
        if (data.length < 1000) break;
    }
    return out;
}

// Does this meeting belong to this closer? Checks attendees in both shapes plus
// created_by. Deliberately conservative: no match means unattributed, not a guess.
function belongsTo(meeting, closer) {
    const email = String(closer.email || '').toLowerCase();
    const name = String(closer.display_name || '').toLowerCase();
    const first = name.split(/\s+/)[0];
    const cb = String(meeting.created_by || '').toLowerCase();
    if (email && cb === email) return true;

    const att = meeting.attendees;
    if (!att) return false;
    const blob = (typeof att === 'string' ? att : JSON.stringify(att)).toLowerCase();
    if (email && blob.includes(email)) return true;
    // Full name only. A bare first name would match a prospect who shares it.
    if (name && name.length > 3 && blob.includes(name)) return true;
    return false;
}

function bucket() {
    return {
        meetings_held: 0, no_shows: 0, upcoming: 0,
        won: 0, lost: 0, open: 0, awaiting_outcome: 0,
        talk_sec: 0, dials: 0, connects: 0,
        booked_by_them: 0, revenue_cents: 0, deals: 0
    };
}

function rates(b) {
    const attended = b.meetings_held;
    const scheduled = attended + b.no_shows;
    const decided = b.won + b.lost;
    return {
        show_rate_pct: scheduled ? Math.round((attended / scheduled) * 100) : 0,
        close_rate_pct: decided ? Math.round((b.won / decided) * 100) : 0,
        // Against every meeting they actually sat in, not just decided ones. This
        // is the number that tells you if meetings are being wasted.
        close_rate_of_held_pct: attended ? Math.round((b.won / attended) * 100) : 0,
        avg_meeting_min: attended ? Math.round(b.talk_sec / attended / 60) : 0,
        avg_deal_cents: b.deals ? Math.round(b.revenue_cents / b.deals) : 0
    };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const gate = await assertAdmin(req, res);
    if (!gate || gate.ok === false) return;

    try {
        const sb = pub(), p = pro();

        // Closers = the roster entries on 0% commission. That is already how the
        // owners are modelled (see sdr_users.notes), so there is no new flag.
        const { data: roster, error: rErr } = await sb.from('sdr_users')
            .select('id,email,display_name,initials,avatar_color,commission_pct,active')
            .eq('active', true).eq('commission_pct', 0);
        if (rErr) throw new Error(rErr.message);
        const closers = (roster || []);

        const meetings = await pullAll(p.from('lead_meetings')
            .select('id,lead_id,occurred_at,duration_seconds,attendees,created_by,outcome,title'));
        const leads = await pullAll(p.from('leads')
            .select('id,name,niche,meeting_scheduled_at,meeting_booked_by_sdr,meeting_confirmed_at'));
        const leadById = {};
        leads.forEach(l => { leadById[l.id] = l; });

        const calls = await pullAll(p.from('lead_calls')
            .select('logged_by,direction,outcome,duration_seconds,called_at')
            .in('direction', ['outbound', 'outgoing']));

        const { data: deals } = await sb.from('deals')
            .select('id,closed_by,stage,upfront_fee_cents,monthly_retainer_cents,closed_at,business_name');

        const now = Date.now();
        const out = [];
        const claimed = new Set();

        for (const c of closers) {
            const b = bucket();
            const recent = [];

            for (const m of meetings) {
                if (!belongsTo(m, c)) continue;
                claimed.add(m.id);
                const oc = String(m.outcome || '').toLowerCase().trim();
                const when = m.occurred_at ? new Date(m.occurred_at).getTime() : null;

                if (when && when > now) { b.upcoming++; continue; }

                if (NOSHOW.indexOf(oc) !== -1) { b.no_shows++; }
                else {
                    b.meetings_held++;
                    b.talk_sec += m.duration_seconds || 0;
                    if (LOST.indexOf(oc) !== -1) b.lost++;
                    else if (WON.indexOf(oc) !== -1) b.won++;
                    else if (!oc) b.awaiting_outcome++;
                    else b.open++;   // interested / needs_time / free-text notes
                }
                if (recent.length < 8 && when) {
                    const l = leadById[m.lead_id] || {};
                    recent.push({
                        lead_id: m.lead_id, business: l.name || m.title || 'Unknown',
                        niche: l.niche || null, occurred_at: m.occurred_at,
                        outcome: m.outcome || null
                    });
                }
            }

            // Meetings THEY booked themselves (owner line), separate from meetings
            // an SDR handed them.
            b.booked_by_them = leads.filter(l => l.meeting_booked_by_sdr === c.email).length;

            for (const k of calls) {
                if (String(k.logged_by || '').toLowerCase() !== String(c.email).toLowerCase()) continue;
                b.dials++;
                if ((k.duration_seconds || 0) > 0) b.connects++;
            }

            for (const d of (deals || [])) {
                if (!d.closed_by || String(d.closed_by) !== String(c.id)) continue;
                b.deals++;
                b.revenue_cents += (d.upfront_fee_cents || 0) + (d.monthly_retainer_cents || 0);
            }

            recent.sort((x, y) => new Date(y.occurred_at) - new Date(x.occurred_at));
            out.push({ closer: c, stats: b, rates: rates(b), recent: recent });
        }

        const unattributed = meetings.filter(m => !claimed.has(m.id)).length;

        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            closers: out,
            unattributed_meetings: unattributed,
            total_meetings: meetings.length,
            // Surfaced so the UI can be honest rather than implying the split is exact.
            attribution_note: 'Meetings are matched by closer name or email on the meeting record. '
                + unattributed + ' of ' + meetings.length + ' could not be matched and are excluded.'
        });
    } catch (e) {
        console.error('[closer-analytics]', e);
        return res.status(500).json({ error: 'query_failed', detail: e.message });
    }
};
