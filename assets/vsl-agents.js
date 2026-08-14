/**
 * Shared VSL NICHE picker for the booking flow — /admin/ AND /sdr/.
 *
 * ONE renderer for both dashboards, same rule as assets/cold-call-script.js:
 * the booking markup is otherwise hand-duplicated in each file, which is how
 * the two dashboards drift apart. Do NOT re-inline this.
 *
 * 2026-08 PIVOT: this used to pick which AGENT we were pitching (receptionist,
 * lead-reply, reactivation, ...). We sell one offer now, booked qualified
 * meetings, so there is no per-lead product choice left to make. What the rep
 * picks instead is the prospect's INDUSTRY, which decides which of the five
 * niche VSLs the confirmation email and landing page use.
 *
 * The default is derived from the lead itself (leads.niche, then category), so
 * the rep normally changes nothing. The dropdown exists for when David's niche
 * value is missing or wrong.
 *
 * SLUGS MUST MATCH api/prospects/_vsl.js AGENTS and sites/stilo-ai/vsl/*.html.
 * _vsl.js normalizes anything it receives through agentKey(), and since the
 * pivot an unrecognized value resolves to NULL rather than silently falling back
 * to a product page. A drift here means no VSL is sent, not the wrong one.
 *
 * The global stays named VSL_AGENT_PICKER so both dashboards keep working
 * without a coordinated edit; VSL_NICHE_PICKER is an alias.
 */
(function (global) {
    'use strict';

    var VSL_NICHES = [
        { slug: 'commercial-cleaning', name: 'Commercial Cleaning' },
        { slug: 'commercial-roofing', name: 'Commercial Roofing' },
        { slug: 'staffing', name: 'Staffing' },
        { slug: 'freight', name: 'Freight' },
        { slug: 'industrial-supplies', name: 'Industrial Supplies & Equipment' }
    ];

    // David's leads.niche / category strings, lowercased, to a niche slug.
    // Mirrors ALIASES in api/prospects/_vsl.js. Keep them in sync.
    var ALIASES = {
        'janitorial service': 'commercial-cleaning', 'cleaning service': 'commercial-cleaning',
        'house cleaning service': 'commercial-cleaning', 'janitorial equipment supplier': 'commercial-cleaning',
        'commercial cleaning': 'commercial-cleaning', 'cleaning': 'commercial-cleaning',
        'roofing contractor': 'commercial-roofing', 'roofing supply store': 'commercial-roofing',
        'commercial roofing': 'commercial-roofing', 'roofing': 'commercial-roofing', 'roofer': 'commercial-roofing',
        'employment agency': 'staffing', 'temp agency': 'staffing', 'recruiter': 'staffing',
        'executive search firm': 'staffing', 'staffing agency': 'staffing',
        'trucking company': 'freight', 'freight forwarding service': 'freight',
        'logistics service': 'freight', 'logistics': 'freight', 'carrier': 'freight',
        'forklift dealer': 'industrial-supplies', 'industrial equipment supplier': 'industrial-supplies',
        'construction equipment supplier': 'industrial-supplies', 'equipment supplier': 'industrial-supplies',
        'material handling equipment supplier': 'industrial-supplies', 'crane service': 'industrial-supplies',
        'forklift rental service': 'industrial-supplies', 'industrial equipment': 'industrial-supplies',
        'supplies': 'industrial-supplies', 'equipment': 'industrial-supplies'
    };

    function nicheSlug(raw) {
        var s = String(raw || '').toLowerCase().trim();
        if (!s) return null;
        for (var i = 0; i < VSL_NICHES.length; i++) if (VSL_NICHES[i].slug === s) return s;
        if (ALIASES[s]) return ALIASES[s];
        // Loose match, because David words some niches slightly differently.
        if (/clean|janitor/.test(s)) return 'commercial-cleaning';
        if (/roof/.test(s)) return 'commercial-roofing';
        // Must stay identical to agentKey() in api/prospects/_vsl.js.
        if (/staff|recruit|employment|temp agency|talent|nursing agency|executive search|headhunt/.test(s)) return 'staffing';
        if (/freight|truck|logistic|carrier|3pl|shipping/.test(s)) return 'freight';
        if (/equipment|forklift|industrial|suppl|material handling|crane/.test(s)) return 'industrial-supplies';
        return null;
    }

    // ---- Leads FILTER groups ------------------------------------------------
    //
    // The admin Leads niche dropdown used to list every distinct value of
    // leads.category, which is a raw Google Maps category: hundreds of options
    // like "Crane service", "Playground equipment supplier", "Nursing agency".
    // These collapse that long tail into the five niches we actually sell to,
    // plus Other for the whole pre-pivot book (dentists, insurance, auto).
    //
    // Same include terms, in the same precedence order, as nicheSlug() above.
    // What this adds is the EXCLUSION list, lifted from the campaign ICP regex
    // in prospecting.outbound_campaigns.icp_pattern: a pool service, a dry
    // cleaner and a carpet cleaner all contain "clean" but none of them is a
    // commercial cleaning company, and letting them through is the specific
    // mistake that has put the wrong leads on a rep's board twice. Anything
    // matching an exclusion drops to Other before any include term is tried.
    //
    // The regex writes some terms with an optional space ("house ?clean"). The
    // server matches with ILIKE, not a regex, so both spellings are spelled out.
    //
    // MUST stay identical to NICHE_GROUP_EXCLUDE / NICHE_GROUPS in
    // api/prospects/callable.js, which turns these same terms into the
    // server-side PostgREST filter. Drift means the count shown next to an
    // option disagrees with the rows that option actually returns.
    var NICHE_GROUP_EXCLUDE = [
        'pool', 'maid', 'house clean', 'houseclean', 'carpet',
        'pressure wash', 'pressurewash', 'car wash', 'carwash',
        'laundry', 'dry clean', 'dryclean', 'alteration'
    ];

    // PRECEDENCE order, not display order. "Janitorial equipment supplier"
    // matches both 'janitor' and 'equipment'; cleaning comes first, so it lands
    // in cleaning, exactly as nicheSlug() resolves it. Reordering this array
    // silently reclassifies leads. Display order is NICHE_FILTER_ORDER below.
    var NICHE_GROUPS = [
        { slug: 'commercial-cleaning', label: 'Commercial cleaning', terms: ['clean', 'janitor'] },
        { slug: 'commercial-roofing', label: 'Commercial roofing', terms: ['roof'] },
        { slug: 'staffing', label: 'Staffing', terms: ['staff', 'recruit', 'employment', 'temp agency', 'talent', 'nursing agency', 'executive search', 'headhunt'] },
        { slug: 'freight', label: 'Freight and logistics', terms: ['freight', 'truck', 'logistic', 'carrier', '3pl', 'shipping'] },
        { slug: 'industrial-supplies', label: 'Industrial supplies and equipment', terms: ['equipment', 'forklift', 'industrial', 'suppl', 'material handling', 'crane'] }
    ];

    // Order the dropdown renders in. Cleaning, roofing and staffing are the
    // three niches with a live campaign, so they sit at the top.
    var NICHE_FILTER_ORDER = [
        'commercial-cleaning', 'commercial-roofing', 'staffing',
        'industrial-supplies', 'freight', 'other'
    ];

    var OTHER_GROUP = { slug: 'other', label: 'Other', terms: [] };

    function groupBySlug(slug) {
        if (slug === 'other') return OTHER_GROUP;
        for (var i = 0; i < NICHE_GROUPS.length; i++) if (NICHE_GROUPS[i].slug === slug) return NICHE_GROUPS[i];
        return null;
    }

    // Raw category string to a group slug. Never returns null: everything we do
    // not sell to is 'other', which is what makes the six options a partition.
    function nicheGroup(raw) {
        var s = String(raw || '').toLowerCase().trim();
        if (!s) return 'other';
        for (var e = 0; e < NICHE_GROUP_EXCLUDE.length; e++) {
            if (s.indexOf(NICHE_GROUP_EXCLUDE[e]) !== -1) return 'other';
        }
        for (var i = 0; i < NICHE_GROUPS.length; i++) {
            var terms = NICHE_GROUPS[i].terms;
            for (var j = 0; j < terms.length; j++) {
                if (s.indexOf(terms[j]) !== -1) return NICHE_GROUPS[i].slug;
            }
        }
        return 'other';
    }

    // Same niche-then-category resolution defaultSlugFor() uses.
    function nicheGroupForLead(lead) {
        var d = lead || {};
        var n = String(d.niche || '').trim();
        return nicheGroup(n || d.category);
    }

    // Pre-selected option, read straight off the lead. niche is David's field and
    // is the source of truth; category is the older Google-Places string.
    function defaultSlugFor(lead) {
        var d = lead || {};
        return nicheSlug(d.niche) || nicheSlug(d.category) || null;
    }

    /**
     * Markup for the picker. Drop it directly after the prospect-email input in
     * the booking panel so the rep sets both facts about the booking together.
     */
    function selectHtml(selectId, lead, opts) {
        var o = opts || {};
        var current = defaultSlugFor(lead);
        var labelColor = o.helperColor || 'var(--text-muted)';
        // Explicit blank option so a rep can SEE when we could not work the niche
        // out, rather than a wrong one sitting there pre-selected.
        var options = '<option value=""' + (current ? '' : ' selected') + '>'
            + (current ? 'Do not send a video' : 'Select the industry...') + '</option>';
        options += VSL_NICHES.map(function (a) {
            return '<option value="' + a.slug + '"' + (a.slug === current ? ' selected' : '') + '>' + a.name + '</option>';
        }).join('');
        // onChange lets the caller refresh anything that depends on the niche
        // (the confirmation-email preview embeds the niche VSL link).
        var onChange = o.onChange ? ' onchange="' + o.onChange + '"' : '';
        return '<label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;'
            + 'letter-spacing:0.06em;color:var(--text-secondary);margin:12px 0 5px;">Their industry</label>'
            + '<select id="' + selectId + '"' + onChange + ' style="width:100%;padding:9px 11px;background:var(--bg-input);'
            + 'border:1px solid var(--border-medium);border-radius:8px;color:var(--text-primary);font-size:13px;cursor:pointer;">'
            + options + '</select>'
            + '<div style="font-size:11px;color:' + labelColor + ';margin-top:4px;">'
            + 'Picks which of the five videos they get. Set from the lead automatically, '
            + 'only change it if that is wrong.</div>';
    }

    // Read the picker. Returns null when absent or blank so callers omit the
    // field and the server keeps its own resolution rather than a wrong one.
    function readSelect(selectId) {
        var el = (typeof document !== 'undefined') && document.getElementById(selectId);
        var v = el && el.value;
        return nicheSlug(v) || null;
    }

    var api = {
        AGENTS: VSL_NICHES,     // legacy key; both dashboards still read it
        NICHES: VSL_NICHES,
        agentSlug: nicheSlug,   // legacy name
        nicheSlug: nicheSlug,
        defaultSlugFor: defaultSlugFor,
        // Leads filter groups (see the block above defaultSlugFor).
        NICHE_GROUPS: NICHE_GROUPS,
        NICHE_GROUP_EXCLUDE: NICHE_GROUP_EXCLUDE,
        NICHE_FILTER_ORDER: NICHE_FILTER_ORDER,
        groupBySlug: groupBySlug,
        nicheGroup: nicheGroup,
        nicheGroupForLead: nicheGroupForLead,
        selectHtml: selectHtml,
        readSelect: readSelect
    };
    global.VSL_AGENT_PICKER = api;
    global.VSL_NICHE_PICKER = api;
})(typeof window !== 'undefined' ? window : this);
