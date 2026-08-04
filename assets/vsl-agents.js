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
        if (/staff|recruit|employment|temp agency|talent|nursing agency/.test(s)) return 'staffing';
        if (/freight|truck|logistic|carrier|3pl|shipping/.test(s)) return 'freight';
        if (/equipment|forklift|industrial|suppl|material handling|crane/.test(s)) return 'industrial-supplies';
        return null;
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
        selectHtml: selectHtml,
        readSelect: readSelect
    };
    global.VSL_AGENT_PICKER = api;
    global.VSL_NICHE_PICKER = api;
})(typeof window !== 'undefined' ? window : this);
