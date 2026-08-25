/**
 * Shared metric vocabulary for every Team-tab endpoint.
 *
 * This file exists because "connect" meant two different things in two files
 * that render side by side on the same screen. team-analytics counted a connect
 * as outcome === 'answered'; closer-analytics counted it as duration_seconds > 0.
 * The SDR funnel row and the SDR card underneath it therefore printed different
 * connect rates for the same rep in the same period, and both were wrong.
 *
 * ── What counts as reaching a human ──────────────────────────────────────────
 * 'answered' is not the only outcome where somebody picked up. Measured over the
 * 3,323 outbound calls on the books (2026-08-24):
 *
 *   answered            1886 calls   34.5h talk
 *   callback_requested   375 calls   10.9h talk   <- a human asked us to call back
 *   do_not_call          378 calls    5.5h talk   <- a human told us to stop
 *   owner_uninterested    38 calls    0.8h talk   <- a human said no
 *   booked_meeting        37 calls    1.5h talk   <- a human BOOKED A MEETING
 *   voicemail            389 calls    3.6h        <- nobody picked up
 *   no_answer            210 calls    0.1h        <- nobody picked up
 *
 * Counting only 'answered' threw away 535 evidence-backed conversations and
 * 18.7 hours of talk time, and meant the single best outcome a cold call can
 * have — booking a meeting — did not register as having connected. Connect rate
 * read 56.8% against a real, evidence-backed 72.9%.
 */

// A human picked up. Rejection is still contact: 'do_not_call' and
// 'owner_uninterested' average 74s and 101s respectively, which is a
// conversation, not a dial tone.
const CONTACT_OUTCOMES = ['answered', 'callback_requested', 'booked_meeting', 'owner_uninterested', 'do_not_call'];

// Nobody picked up. Voicemail carries a duration (the message we left), so it
// must be excluded by name and not by "has a duration".
const NO_CONTACT_OUTCOMES = ['voicemail', 'no_answer', 'busy', 'failed', 'duplicate'];

function norm(v) { return String(v === null || v === undefined ? '' : v).toLowerCase().trim(); }

/**
 * Did a human pick up?
 *
 * The outcome alone is not enough. 111 'do_not_call' rows and 26
 * 'booked_meeting' rows carry no duration, no transcript and no recording:
 * those are a rep marking a lead in the list, not a call that connected.
 * Trusting the label alone reported an 81.7% contact rate; requiring evidence
 * that the call actually happened reports 72.9%, and that is the number that
 * survives someone pulling the call log to check.
 *
 * Evidence = line time, a transcript, or a recording.
 */
function hasEvidence(call) {
    return (call.duration_seconds || 0) > 0 || !!call.transcript || !!call.recording_url;
}

function isContact(call) {
    return CONTACT_OUTCOMES.indexOf(norm(call.outcome)) !== -1 && hasEvidence(call);
}

/**
 * Did we get past the gatekeeper to a real conversation? 120s is the threshold
 * the dashboard has always used; it stays, but it now applies to every contact
 * outcome rather than to 'answered' alone.
 */
function isConversation(call) {
    return isContact(call) && (call.duration_seconds || 0) > 120;
}

/* ── Meeting outcome vocabulary ───────────────────────────────────────────────
 * meeting_occurrences.outcome is a free-text column, and reps have written
 * whole paragraphs into it ("OWNER NO-SHOW — partner/assistant attended…").
 * Every consumer tested it with indexOf against a six-word list, so a
 * paragraph describing a no-show was classified as a meeting that went fine,
 * and the literal value 'held' matched nothing at all.
 *
 * classifyOutcome maps any string onto the canonical vocabulary, reading prose
 * when it has to, and returns null when it genuinely cannot tell. Never
 * prefix-match these: 'closed_lost' starts with 'closed'.
 */
const WON = ['closed_won', 'won', 'closed won'];
const LOST = ['closed_lost', 'lost', 'closed lost', 'not_interested', 'not interested', 'no'];
const NOSHOW = ['no_show', 'noshow', 'no show', 'did_not_attend'];
const HELD_OPEN = ['held', 'interested', 'needs_time', 'needs time', 'follow_up', 'rescheduled'];

function classifyOutcome(raw) {
    const s = norm(raw);
    if (!s) return null;
    if (WON.indexOf(s) !== -1) return 'closed_won';
    if (LOST.indexOf(s) !== -1) return 'closed_lost';
    if (NOSHOW.indexOf(s) !== -1) return 'no_show';
    if (HELD_OPEN.indexOf(s) !== -1) return s === 'rescheduled' ? 'rescheduled' : (s === 'held' ? 'held' : s.replace(' ', '_'));

    // Free-text fallback. Only fires on strings long enough to be prose, and
    // reads the strongest signal first so "no-show, will reschedule" is a
    // no-show rather than a reschedule.
    if (s.length > 20) {
        if (/no[-\s]?show/.test(s)) return 'no_show';
        if (/closed[-\s]?won|signed|paid|deposit/.test(s)) return 'closed_won';
        if (/not interested|closed[-\s]?lost|passed|dead/.test(s)) return 'closed_lost';
        if (/interested/.test(s)) return 'interested';
        if (/reschedul/.test(s)) return 'rescheduled';
        return 'held'; // a written recap means somebody sat through a meeting
    }
    return null;
}

/** A meeting the prospect actually turned up to. */
function isHeldOutcome(c) {
    return c !== null && c !== 'no_show' && c !== 'rescheduled';
}

module.exports = {
    CONTACT_OUTCOMES, NO_CONTACT_OUTCOMES,
    isContact, isConversation, hasEvidence, norm,
    classifyOutcome, isHeldOutcome
};
