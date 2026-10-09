/**
 * assets/lead-socials.js
 * The link buttons in the lead panel header: Instagram, Facebook, Website.
 * Shared by /sdr/ and /admin/ so both drawers show the same buttons.
 * Reads the lead row from /api/prospects/detail (select *):
 *   instagram_url | instagram_handle, facebook_url, website.
 * Only http(s) URLs are ever rendered as links.
 */
(function () {
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function safeUrl(u) {
        u = String(u || '').trim();
        if (!u) return '';
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
        return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
    }
    function igUrl(r) {
        if (r.instagram_url) return safeUrl(r.instagram_url);
        var h = String(r.instagram_handle || '').trim().replace(/^@/, '');
        return /^[A-Za-z0-9._]{1,30}$/.test(h) ? 'https://www.instagram.com/' + h + '/' : '';
    }
    var ICON = {
        ig: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
        fb: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M14 8h3V4h-3c-2.8 0-4.5 1.8-4.5 4.6V11H7v4h2.5v9h4v-9H17l.5-4h-4V8.8c0-.5.3-.8.5-.8z"/></svg>',
        web: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>'
    };
    function pill(href, icon, label) {
        return '<a href="' + esc(href) + '" target="_blank" rel="noopener" class="lead-social-pill"'
            + ' style="display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--border-medium, rgba(255,255,255,0.16));'
            + 'border-radius:999px;font-size:12px;font-weight:600;color:var(--text-primary, #fff);text-decoration:none;white-space:nowrap;">'
            + icon + label + ' ↗</a>';
    }
    // Returns the right-aligned button group, or '' when the lead has none.
    function render(r) {
        r = r || {};
        var out = [];
        var ig = igUrl(r), fb = safeUrl(r.facebook_url), web = safeUrl(r.website);
        if (ig) out.push(pill(ig, ICON.ig, 'Instagram'));
        if (fb) out.push(pill(fb, ICON.fb, 'Facebook'));
        if (web) out.push(pill(web, ICON.web, 'Website'));
        if (!out.length) return '';
        return '<span class="lead-socials" style="margin-left:auto;display:inline-flex;gap:6px;flex-wrap:wrap;">' + out.join('') + '</span>';
    }
    window.LEAD_SOCIALS = { render: render };
})();
