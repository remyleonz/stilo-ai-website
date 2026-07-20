/**
 * Shared VSL agent picker for the booking flow — /admin/ AND /sdr/.
 *
 * ONE renderer for both dashboards, same rule as assets/cold-call-script.js:
 * the booking markup is otherwise hand-duplicated in each file, which is how
 * the two dashboards drift apart. Do NOT re-inline this.
 *
 * WHY THIS EXISTS: the rep picks which agent they actually sold on the call.
 * Before this, that choice did not exist — book-meeting.js defaulted every
 * booking to 'receptionist' via agentKey(undefined), and send-confirmations.js
 * separately re-derived a slug from the stale matched_product_name column. So
 * the confirmation email could pitch a different agent than the rep sold.
 *
 * SLUGS MUST MATCH api/prospects/_vsl.js AGENTS. That file is the server-side
 * source of truth and normalizes anything it receives through agentKey(), so a
 * drift here cannot produce an invalid value — it would just silently fall back
 * to receptionist, which is exactly the bug this replaces. Keep them in sync.
 *
 * Deliberately NOT the 8-key list used by the email composer's #ecAgent
 * dropdown (receptionist / lead_response / lead_gen / seo / growth / custom).
 * Those keys are a different vocabulary, and three of them have no VSL page at
 * all — seo and growth were retired 2026-07-15. Offering an agent whose VSL
 * redirects to the homepage would send a prospect to a dead link.
 */
(function (global) {
    'use strict';

    var VSL_AGENTS = [
        { slug: 'receptionist', name: 'Receptionist' },
        { slug: 'lead-reply', name: 'Outbound Lead Reply' },
        { slug: 'reactivation', name: 'Lost Customer Reactivation' },
        { slug: 'b2bleadgen', name: 'B2B Lead Generator' },
        { slug: 'website', name: 'Website' },
        { slug: 'sales-agent', name: 'Sales Coach' }
    ];

    // Free text on the lead (pitch_agent from David's script parse, or
    // matched_product_name) into a canonical slug. Mirrors _vsl.js ALIASES plus
    // the prose forms David actually writes.
    var ALIASES = {
        echo: 'receptionist', ignite: 'lead-reply', revive: 'reactivation',
        lcr: 'reactivation', scout: 'b2bleadgen', prospecting: 'b2bleadgen',
        forge: 'website', pitch: 'sales-agent', sales: 'sales-agent', web: 'website',
        lead_response: 'lead-reply', lead_gen: 'b2bleadgen'
    };

    function agentSlug(raw) {
        var s = String(raw || '').toLowerCase().trim();
        if (!s) return null;
        for (var i = 0; i < VSL_AGENTS.length; i++) if (VSL_AGENTS[i].slug === s) return s;
        if (ALIASES[s]) return ALIASES[s];
        // Prose match, because pitch_agent holds things like "AI Receptionist",
        // "Website Builder", "Outbound Agent", "Lead Generator", "LCR".
        if (/recept/.test(s)) return 'receptionist';
        if (/reactiv|lost customer|lcr/.test(s)) return 'reactivation';
        if (/lead reply|lead response|outbound/.test(s)) return 'lead-reply';
        if (/lead gen|b2b|prospect/.test(s)) return 'b2bleadgen';
        if (/website|web build/.test(s)) return 'website';
        if (/sales coach|sales agent|coach/.test(s)) return 'sales-agent';
        return null;
    }

    // Best guess for the pre-selected option. pitch_agent first — it is the
    // single source of truth for which agent a lead pitches.
    function defaultSlugFor(lead) {
        var d = lead || {};
        return agentSlug(d.pitch_agent) || agentSlug(d.matched_product_name) || 'receptionist';
    }

    /**
     * Markup for the picker. Drop it directly after the prospect-email input in
     * the booking panel so the rep sets both facts about the booking together.
     */
    function selectHtml(selectId, lead, opts) {
        var o = opts || {};
        var current = defaultSlugFor(lead);
        var labelColor = o.helperColor || 'var(--text-muted)';
        var options = VSL_AGENTS.map(function (a) {
            return '<option value="' + a.slug + '"' + (a.slug === current ? ' selected' : '') + '>' + a.name + '</option>';
        }).join('');
        // onChange lets the caller refresh anything that depends on the agent
        // (the confirmation-email preview embeds an agent-specific VSL link).
        var onChange = o.onChange ? ' onchange="' + o.onChange + '"' : '';
        return '<label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;'
            + 'letter-spacing:0.06em;color:var(--text-secondary);margin:12px 0 5px;">Agent we\'re pitching</label>'
            + '<select id="' + selectId + '"' + onChange + ' style="width:100%;padding:9px 11px;background:var(--bg-input);'
            + 'border:1px solid var(--border-medium);border-radius:8px;color:var(--text-primary);font-size:13px;cursor:pointer;">'
            + options + '</select>'
            + '<div style="font-size:11px;color:' + labelColor + ';margin-top:4px;">'
            + 'Sets the VSL in the confirmation email and what the prospect sees on the landing page.</div>';
    }

    // Read the picker. Returns null when absent so callers can omit the field
    // and let the server keep its own default rather than sending a wrong one.
    function readSelect(selectId) {
        var el = (typeof document !== 'undefined') && document.getElementById(selectId);
        var v = el && el.value;
        return agentSlug(v) || null;
    }

    global.VSL_AGENT_PICKER = {
        AGENTS: VSL_AGENTS,
        agentSlug: agentSlug,
        defaultSlugFor: defaultSlugFor,
        selectHtml: selectHtml,
        readSelect: readSelect
    };
})(typeof window !== 'undefined' ? window : this);
