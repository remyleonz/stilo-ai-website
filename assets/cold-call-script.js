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

    var P = 'font-size:15px;line-height:1.65;color:var(--text-primary);';

    // ------------------------------------------------------------------
    // Markdown tables. Two treatments:
    //   - A key-value table (2 data columns, blank header "| | |") renders as
    //     a fact grid: uppercase label, big white value. This is the "The
    //     lead" block on campaign scripts — the rep reads it pre-dial, so the
    //     phone and name must be glanceable, not markdown soup.
    //   - Any other table renders as a real styled table (e.g. the
    //     machine-to-commission map).
    // ------------------------------------------------------------------
    function parseRow(line) {
        var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return t.split('|').map(function (c) { return c.trim(); });
    }
    function isSepRow(line) { return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line); }
    function renderTable(rows) {
        if (!rows.length) return '';
        var header = rows[0], body = rows.slice(1);
        var headerBlank = header.every(function (c) { return !c; });
        // Key-value fact grid.
        if (headerBlank && body.every(function (r) { return r.length >= 2; })) {
            var cells = body.map(function (r) {
                var label = plainOf(r[0] || '');
                var val = inline((r.slice(1).join(' ')).trim());
                var big = /phone|tel[eé]fono/i.test(label);
                return '<div style="padding:9px 12px;background:var(--bg-input,rgba(255,255,255,0.03));border:1px solid var(--border-subtle);border-radius:8px;">'
                    + '<div style="font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:3px;">' + esc(label) + '</div>'
                    + '<div style="font-size:' + (big ? 20 : 14) + 'px;font-weight:' + (big ? 800 : 600) + ';color:#fff;line-height:1.4;">' + val + '</div>'
                    + '</div>';
            }).join('');
            return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin:10px 0 14px;">' + cells + '</div>';
        }
        // Real table.
        var th = header.map(function (c) {
            return '<th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-medium);">' + inline(c) + '</th>';
        }).join('');
        var trs = body.map(function (r, i) {
            return '<tr>' + r.map(function (c) {
                return '<td style="padding:9px 10px;font-size:14px;line-height:1.5;color:var(--text-primary);border-bottom:1px solid var(--border-subtle);vertical-align:top;">' + inline(c) + '</td>';
            }).join('') + '</tr>';
        }).join('');
        return '<div style="overflow-x:auto;margin:10px 0 14px;border:1px solid var(--border-subtle);border-radius:8px;">'
            + '<table style="width:100%;border-collapse:collapse;"><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table></div>';
    }

    function openerBox(innerHtml) {
        return '<div style="border-left:3px solid #10b981;background:rgba(16,185,129,0.09);padding:10px 13px;margin:8px 0 12px;border-radius:0 6px 6px 0;color:#fff;font-size:14px;line-height:1.6;">' + innerHtml + '</div>';
    }
    function dmBox(value) {
        return '<div style="background:rgba(37,99,235,0.10);border:1px solid rgba(37,99,235,0.35);border-radius:8px;padding:8px 11px;margin:8px 0;font-size:13px;color:#fff;"><span style="color:var(--text-muted);text-transform:uppercase;font-size:10px;letter-spacing:.06em;">Decision maker</span><br>' + value + '</div>';
    }
    // A line the rep says out loud. This is the text read ALOUD mid-call, so
    // it gets the biggest type on the page.
    function sayBox(innerHtml) {
        return '<div style="border-left:3px solid var(--blue);padding:10px 14px;margin:8px 0;color:#fff;font-size:16px;line-height:1.65;background:rgba(37,99,235,0.08);border-radius:0 8px 8px 0;">' + innerHtml + '</div>';
    }
    // A stage direction: what to DO, not what to say. Deliberately quiet -- on a
    // live dial the rep's eye needs to skip these to find the next spoken line.
    function stageBox(innerHtml) {
        return '<div style="margin:7px 0;padding:5px 11px;border-left:2px solid var(--border-medium);color:var(--text-tertiary);font-size:13px;line-height:1.55;font-style:italic;">' + innerHtml + '</div>';
    }
    function stepChip(n, label) {
        return '<div style="display:flex;align-items:center;gap:9px;margin:20px 0 8px;">'
            + '<span style="flex:none;width:22px;height:22px;border-radius:50%;background:var(--blue);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;">' + n + '</span>'
            + '<span style="font-family:var(--font-display);font-weight:700;color:#fff;font-size:16px;">' + label + '</span></div>';
    }

    // Sections that are operator notes, not dialogue. Plain paragraphs here stay
    // plain -- highlighting "Drop volume on Hey" as a spoken line would be a lie.
    var NOT_SPOKEN = /^(voice direction|do not pitch|already in place|footer|the hook|notes?|a\/b axis|vertical|built|brief)\b/i;

    function plainOf(l) { return l.replace(/^[>#\s*]+/, '').replace(/\*\*/g, '').trim(); }

    function renderBody(md) {
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

            // Markdown table block: consume every consecutive |-row.
            if (/^\s*\|/.test(line)) {
                closeList(); expectOpener = false;
                var tRows = [];
                while (k < lines.length && /^\s*\|/.test(lines[k])) {
                    if (!isSepRow(lines[k])) tRows.push(parseRow(lines[k]));
                    k++;
                }
                k--; // for-loop increments past the last table line otherwise
                html += renderTable(tRows);
                continue;
            }

            // Consecutive `>` lines merge into ONE spoken box — a multi-line
            // quote is one thing the rep says, not five separate fragments.
            if (/^>/.test(line)) {
                closeList();
                var qParts = [];
                while (k < lines.length && /^>/.test(lines[k].trim() === '' ? '' : lines[k])) {
                    var ql = lines[k].replace(/^>\s?/, '');
                    qParts.push(ql.trim() === '' ? '' : inline(ql));
                    k++;
                }
                k--;
                var qHtml = qParts.join('<br>').replace(/(<br>){2,}/g, '<br><br>').replace(/^(<br>)+|(<br>)+$/g, '');
                if (expectOpener && !openerHtml) { html += openerBox(qHtml); expectOpener = false; }
                else html += sayBox(qHtml);
                continue;
            }

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

            // Headings. A "## 4. The discovery question" heading renders as a
            // numbered step chip so the rep can track where they are mid-call.
            if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
                closeList(); expectOpener = false;
                var lvl = Math.min(m[1].length, 4);
                spokenSection = lvl >= 2 && !NOT_SPOKEN.test(plain);
                if (spokenSection) stepN = 0;
                var stepM = m[2].match(/^(\d+)[.)]\s+(.*)$/);
                if (lvl >= 2 && stepM) {
                    html += stepChip(stepM[1], inline(stepM[2]));
                    continue;
                }
                var size = lvl <= 1 ? 18 : lvl === 2 ? 16 : 15;
                html += '<div style="font-family:var(--font-display);font-weight:700;color:#fff;font-size:' + size + 'px;margin:18px 0 8px;">' + inline(m[2]) + '</div>';
                continue;
            }

            // Lists.
            if ((m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/))) {
                if (!inList) { html += '<ul style="margin:6px 0 12px;padding-left:20px;">'; inList = true; }
                html += '<li style="' + P + 'margin:5px 0;">' + inline(m[1]) + '</li>';
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

    /**
     * The gatekeeper playbook ships INSIDE David's Blason scripts, at the
     * bottom, ~160 lines. On a live dial the rep only needs it the moment a
     * receptionist picks up, so render it as a collapsed drop-down pinned to
     * the TOP of the script (Remy, 2026-09-01). Pure render-time move.
     *
     * 2026-09-14: the file-shipped text is REPLACED at render time by the
     * canonical GATEKEEPER_MD below (same trick as the appended Reference:
     * one edit updates every script and survives David's regenerations).
     * Remy's review of the first live week: the old block was too long to
     * use mid-call, reps pitched the desk (which gets "she's not interested"
     * declines FOR the owner), left numbers that never come back, and hung
     * up on live owners without asking for the visit. This rewrite is the
     * step-by-step distilled from the 2026-09 call transcripts.
     *
     * Block boundaries: starts at the H2 matching /front desk answers/i and
     * runs while the following H2s still match /manufacturing standing/i.
     * Scripts without the block (STILO scripts, older vintages) render as
     * before, with no box.
     */
    var GATEKEEPER_MD = [
        '**The data so far: 63% of dials hit a front desk and almost none survive it. Messages left with the desk never come back. Pitches given to the desk get declined FOR the owner. She is a ROUTER, not a decider: route past her, or leave with the three assets. Never pitch her.**',
        '',
        '### 1. Open with the owner\'s NAME — a statement, not a question',
        '> "Hola, con **[NOMBRE DE LA DUEÑA]**, por favor. Le habla [SU NOMBRE]."',
        '> EN: "Hi — **[owner\'s name]**, please. It\'s [your name]."',
        '',
        'Then STOP TALKING. The silence is the ask. Opening by name is our strongest single move. No name on file: "con la dueña, por favor" — never guess a name, and never "¿puedo hablar con...?" (a question hands her a decision).',
        '',
        '### 2. "¿De parte de quién?" — the hinge',
        '> "Soy [SU NOMBRE]. ¿Le puede decir que [SU NOMBRE] está en la línea, por favor?"',
        '',
        'Company asked? Answer straight and keep it small: **"[SU NOMBRE], de Blasón."** First mention only, anchor it: "Blasón — B, L, A, S, O, N." Never dodge a direct question; evasion is what gets screened.',
        '',
        '### 3. She screens you — one line each, NEVER the pitch',
        '| She says | You say |',
        '|---|---|',
        '| "¿De qué se trata?" | "Es para invitar a [DUEÑA] al showroom de Blasón en Miami — las máquinas están funcionando para que las pruebe. ¿Me la pasa un segundo para coordinarlo?" |',
        '| Pressed again | "Honestamente, es una llamada de venta. Treinta segundos y ella me dice sí o no. ¿Me la pasa?" |',
        '| "No está." | "¿A qué hora está de verdad en su escritorio? ... Usted que la conoce mejor que nadie: ¿a qué hora llamaría usted?" **Win = a TIME. A message is a loss.** |',
        '| "Mándele un correo." | "Con gusto — ¿cuál es el mejor correo para ella? ... Si no me contesta, ¿la llamo el jueves?" |',
        '| "¿La está esperando?" | "No — primera vez que la llamo. Por eso son treinta segundos." |',
        '| Vacation / back on [date] | "¿Cuándo vuelve? ... Perfecto, la llamo el [date + 2 days]." Log it as a dated callback. |',
        '',
        '**The wishlist question and the full pitch are OWNER-ONLY.** Every pitch delivered to a receptionist in the transcripts ended as "she\'s not interested" — the desk declining for the owner. And **never leave your number as the plan**: they never call back. YOU call back, at the time SHE names.',
        '',
        '### 4. Before you hang up — the three assets, every first call',
        'Most first calls will not reach the owner. The call is still a WIN if you leave with all three. Type them into the dialer before the next dial:',
        '- **Owner\'s name** — "¿Y cómo se llama la dueña?"',
        '- **Best email** — "¿Cuál es el mejor correo para ella?" (send the five-liner the SAME day)',
        '- **The desk\'s name** — "¿Con quién tengo el gusto? ... Gracias, [NOMBRE]."',
        '',
        'Call 2 is a different call — warm, expected, and every word true:',
        '> "Hola [NOMBRE DEL DESK], soy [SU NOMBRE] otra vez — le mandé el correo a [DUEÑA] el martes. ¿Se lo pudo pasar?"',
        '',
        '### 5. The owner picks up — one sentence, one question, then ASK',
        'No preamble. The "we work with spas all over Florida..." ramble confuses them into a no (it did, on tape).',
        '> "[DUEÑA], le habla [SU NOMBRE], de Blasón en Miami. La llamo para invitarla al showroom — las máquinas están puestas y funcionando para que las pruebe antes de comprar. ¿Le viene mejor esta semana o la que viene?"',
        '',
        '- "Mándeme el catálogo" is the new "not interested". Send it AND keep the meeting: "Se lo mando hoy. Y aparte — ¿cuándo le viene bien pasar por el showroom, martes o jueves?"',
        '- She names a brand or spec you\'re not sure of: "Puede ser — Manuel tiene el catálogo completo. Venga a verlo funcionando: ¿martes o jueves?" Never guess specs.',
        '- **Do not hang up without asking for the visit.** The transcripts are full of owner conversations that end politely with no ask. Thirty seconds earned = ask, with two options.',
        '',
        '### Never — these burn the number, not just the call',
        '- Never claim she\'s expecting you, that you\'ve spoken before, or that she asked you to call.',
        '- Never open with "vendemos equipos" to the desk — but never deny it\'s a sales call when asked straight.',
        '- Never pitch the desk. Never end a call with "call me back" as the plan.'
    ].join('\n');
    function render(md) {
        // David's generator ships CRLF line endings, and in JS regex `.` and
        // `$` refuse to cross a bare \r, so every heading match fails on the
        // raw text. Normalize first; renderBody strips trailing whitespace
        // per-line anyway, so this changes nothing downstream.
        var src = String(md || '').replace(/\r\n?/g, '\n');
        var lines = src.split('\n');
        var start = -1, end = lines.length;
        for (var i = 0; i < lines.length; i++) {
            var h = lines[i].match(/^##\s+(.*)$/);
            if (!h) continue;
            if (start === -1) {
                if (/front desk answers/i.test(h[1])) start = i;
            } else if (!/manufacturing standing/i.test(h[1])) { end = i; break; }
        }
        if (start === -1) return renderBody(src);

        // The file-shipped block is dropped entirely; the canonical rewrite
        // renders in its place.
        var rest = lines.slice(0, start).concat(lines.slice(end)).join('\n');

        var box = '<style>.stilo-gk>summary::-webkit-details-marker{display:none}.stilo-gk>summary::marker{content:""}.stilo-gk[open] .stilo-gk-hint{display:none}</style>'
            + '<details class="stilo-gk" style="margin:0 0 16px;border:1px solid rgba(245,158,11,0.5);border-radius:10px;background:rgba(245,158,11,0.07);">'
            + '<summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;padding:12px 14px;">'
            + '<span style="flex:none;font-size:16px;">\uD83D\uDECE\uFE0F</span>'
            + '<span style="font-family:var(--font-display);font-weight:800;color:#fff;font-size:15px;line-height:1.3;">Front desk answered? Tap here.<span style="display:block;font-size:11px;font-weight:600;color:var(--text-tertiary);margin-top:2px;">5 steps: name open \u00B7 the hinge \u00B7 the screens \u00B7 the three assets \u00B7 the owner ask.</span></span>'
            + '<span class="stilo-gk-hint" style="margin-left:auto;flex:none;font-size:11px;font-weight:700;color:rgba(245,158,11,0.9);">OPEN \u25BE</span>'
            + '</summary>'
            + '<div style="padding:2px 14px 14px;border-top:1px solid rgba(245,158,11,0.25);">' + renderBody(GATEKEEPER_MD) + '</div>'
            + '</details>';
        return box + renderBody(rest);
    }

    global.STILO_SCRIPT = { render: render, escape: esc };
})(window);
