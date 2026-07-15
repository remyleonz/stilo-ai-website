/**
 * Canonical cold-call script renderer. Loaded by BOTH /admin/ and /sdr/.
 *
 * It used to be copy-pasted into each dashboard, and the two copies had already
 * drifted. One file, one behavior.
 *
 * WHY THE PROSE PASS EXISTS
 * -------------------------
 * David ships two markdown shapes into gs://stilo-cold-call-scripts, and the
 * dashboard renders whatever his newest file for that lead happens to be:
 *
 *   STEPPED (2026-07-06 batch, ~32% of leads): numbered steps and `>` blockquotes
 *     for every spoken line. Renders with highlighted say-this blocks.
 *
 *   PROSE (every earlier vintage, ~68% of leads): the same call, written as bare
 *     paragraphs with stage directions in (parentheses) and NO blockquotes. The
 *     renderer had nothing to key off, so every line came out as flat body text.
 *
 * That is the whole reason two leads looked like different products. It was never
 * a UI bug -- David simply has not regenerated the older ~1,870 leads.
 *
 * So when a script has no blockquotes we infer them from the structure David
 * already writes consistently:
 *   - a paragraph wholly wrapped in ( ... )  -> stage direction (muted, italic)
 *   - a **Label:** line                      -> meta, left alone
 *   - anything else inside a spoken section  -> a line the rep SAYS -> highlight
 *
 * Scripts that already use `>` are passed through untouched: if the author marked
 * the spoken lines, we trust the author and never second-guess them.
 */
(function (global) {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function inline(s) {
        return esc(s)
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#fff;">$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--blue);">$1</a>');
    }

    var P = 'font-size:14px;line-height:1.6;color:var(--text-primary);';

    function openerBox(innerHtml) {
        return '<div style="border-left:3px solid #10b981;background:rgba(16,185,129,0.09);padding:10px 13px;margin:8px 0 12px;border-radius:0 6px 6px 0;color:#fff;font-size:14px;line-height:1.6;">' + innerHtml + '</div>';
    }
    function dmBox(value) {
        return '<div style="background:rgba(37,99,235,0.10);border:1px solid rgba(37,99,235,0.35);border-radius:8px;padding:8px 11px;margin:8px 0;font-size:13px;color:#fff;"><span style="color:var(--text-muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em;">Decision maker</span><br>' + value + '</div>';
    }
    // A line the rep says out loud.
    function sayBox(innerHtml) {
        return '<div style="border-left:3px solid var(--blue);padding:8px 12px;margin:7px 0;color:#fff;font-size:14px;line-height:1.6;background:rgba(37,99,235,0.08);border-radius:0 6px 6px 0;">' + innerHtml + '</div>';
    }
    // A stage direction: what to DO, not what to say. Deliberately quiet -- on a
    // live dial the rep's eye needs to skip these to find the next spoken line.
    function stageBox(innerHtml) {
        return '<div style="margin:7px 0;padding:5px 11px;border-left:2px solid var(--border-medium);color:var(--text-tertiary);font-size:13px;line-height:1.55;font-style:italic;">' + innerHtml + '</div>';
    }
    // eslint-disable-next-line no-unused-vars
    function stepChip(n, label) {
        return '<div style="display:flex;align-items:center;gap:8px;margin:16px 0 7px;">'
            + '<span style="flex:none;width:20px;height:20px;border-radius:50%;background:var(--blue);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">' + n + '</span>'
            + '<span style="font-family:var(--font-display);font-weight:700;color:#fff;font-size:15px;">' + label + '</span></div>';
    }

    // Sections that are operator notes, not dialogue. Plain paragraphs here stay
    // plain -- highlighting "Drop volume on Hey" as a spoken line would be a lie.
    var NOT_SPOKEN = /^(voice direction|do not pitch|already in place|footer|the hook|notes?|a\/b axis|vertical|built|brief)\b/i;

    function plainOf(l) { return l.replace(/^[>#\s*]+/, '').replace(/\*\*/g, '').trim(); }

    function render(md) {
        var src = String(md || '');
        var lines = src.split('\n');

        // If the author marked spoken lines with `>`, trust them completely.
        var authored = (src.match(/^>/gm) || []).length > 2;

        // Pre-extract "Suggested opener" -> green box at the "Open:" spot.
        var suggested = [];
        (function () {
            var cap = false;
            for (var i = 0; i < lines.length; i++) {
                var ln = lines[i], pl = plainOf(ln);
                if (/^#{1,6}\s/.test(ln) && /^suggested opener/i.test(pl)) { cap = true; continue; }
                if (cap) {
                    if (/^#{1,6}\s/.test(ln) || /^rep\s+[a-z]\b.*extension/i.test(pl)) break;
                    if (ln.trim()) suggested.push(pl);
                }
            }
        })();
        var openerHtml = suggested.length ? suggested.map(esc).join('<br><br>') : null;

        var html = '', inList = false, expectOpener = false, skipSection = false;
        var spokenSection = false, stepN = 0;
        var closeList = function () { if (inList) { html += '</ul>'; inList = false; } };

        for (var k = 0; k < lines.length; k++) {
            var line = lines[k].replace(/\s+$/, '');
            var plain = plainOf(line);

            if (/^rep\s+[a-z]\b.*extension/i.test(plain)) break;
            if (/^#{1,6}\s/.test(line) && /^suggested opener/i.test(plain)) { skipSection = true; continue; }
            if (skipSection) { if (/^#{1,6}\s/.test(line)) skipSection = false; else continue; }
            if (!line.trim()) { closeList(); continue; }
            if (/^the hook$/i.test(plain) || /^(observable|source|diagnosis|archetype|current tool)\b/i.test(plain)) continue;

            // Horizontal rule. Must be caught before the prose pass, which would
            // otherwise render a bare "---" as a line the rep says out loud.
            if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
                closeList(); expectOpener = false;
                html += '<hr style="border:none;border-top:1px solid var(--border-subtle);margin:16px 0;">';
                continue;
            }

            if (/^decision[-\s]?maker\s*:/i.test(plain)) {
                closeList(); expectOpener = false;
                html += dmBox(esc(plain.replace(/^decision[-\s]?maker\s*:\s*/i, '')));
                continue;
            }

            var m;
            var openMatch = plain.match(/^open\s*:?\s*(.*)$/i);
            if (openMatch && /^open\b/i.test(plain)) {
                closeList();
                var rest = openMatch[1].replace(/^>\s*/, '').trim();
                if (openerHtml) html += openerBox(openerHtml);
                else if (rest) html += openerBox(inline(rest));
                else expectOpener = true;
                continue;
            }

            // Headings.
            if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
                closeList(); expectOpener = false;
                var lvl = Math.min(m[1].length, 4);
                spokenSection = lvl >= 2 && !NOT_SPOKEN.test(plain);
                if (spokenSection) stepN = 0;
                var size = lvl <= 1 ? 17 : lvl === 2 ? 15 : 14;
                html += '<div style="font-family:var(--font-display);font-weight:700;color:#fff;font-size:' + size + 'px;margin:16px 0 7px;">' + inline(m[2]) + '</div>';
                continue;
            }

            // Lists.
            if ((m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/))) {
                if (!inList) { html += '<ul style="margin:6px 0 12px;padding-left:20px;">'; inList = true; }
                html += '<li style="' + P + 'margin:5px 0;">' + inline(m[1]) + '</li>';
                continue;
            }

            // Authored blockquote = spoken.
            if ((m = line.match(/^>\s?(.*)$/))) {
                closeList();
                if (expectOpener && !openerHtml) { html += openerBox(inline(m[1])); expectOpener = false; }
                else html += sayBox(inline(m[1]));
                continue;
            }

            closeList(); expectOpener = false;

            // --- prose pass: infer what the stepped scripts state explicitly ---
            if (!authored && spokenSection) {
                // Wholly parenthetical -> stage direction.
                if (/^\(.*\)$/.test(line.trim())) { html += stageBox(inline(line.trim())); continue; }
                // **Label:** ... -> meta, leave plain.
                if (/^\*\*[^*]+:\*\*/.test(line.trim())) {
                    html += '<p style="' + P + 'margin:7px 0;">' + inline(line) + '</p>';
                    continue;
                }
                // Anything else in a spoken section is a line the rep says.
                // No step chip: the stepped scripts get their numbers from labels
                // David writes ("Hi + who you are"). The prose ones have no labels,
                // and a bare "Say this 1..8" ladder is noise on a live dial. The
                // highlight alone is what the rep's eye actually needs.
                html += sayBox(inline(line));
                continue;
            }

            html += '<p style="' + P + 'margin:7px 0;">' + inline(line) + '</p>';
        }
        closeList();
        return html;
    }

    global.STILO_SCRIPT = { render: render, escape: esc };
})(window);
