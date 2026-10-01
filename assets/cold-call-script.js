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
     * 2026-10-01 (v3): desk-only. Its separate owner pitch ("invitarla al
     * showroom", "treinta segundos") is gone so the drawer shows ONE owner
     * script: the per-lead v3 file below the box.
     *
     * Block boundaries: starts at the H2 matching /front desk answers/i and
     * runs while the following H2s still match /manufacturing standing/i.
     * Scripts without the block (STILO scripts, older vintages) render as
     * before, with no box.
     */
    var GATEKEEPER_MD = [
        '**Your goal with the desk: the owner\'s name, when they\'re actually free, and a cell or WhatsApp. The desk routes, it doesn\'t decide. Never pitch the desk. A desk "not interested" is logged NOT PITCHED, never as lost.**',
        '',
        '### 1. Open: company spelled, then one question',
        '> "Hola, le habla [SU NOMBRE] de Blasón. B-L-A-S-O-N. Somos los importadores de láser con el showroom en Miami."',
        '> EN: "Hi, it\'s [your name] with Blason. B-L-A-S-O-N. We\'re the laser importer with the showroom in Miami."',
        '*(pausa · pause)*',
        '> "¿Quién decide lo de los láseres ahí, el doctor o la gerente?"',
        '> EN: "Who decides on the lasers there, the doctor or a practice manager?"',
        '',
        '### 2. Get the time, the cell and the desk\'s name',
        '> "Perfecto. ¿Y a qué hora consigo a [NOMBRE] entre pacientes? ¿Temprano en la mañana o al final del día?"',
        '> EN: "Perfect. And when is [name] actually between patients? First thing in the morning, or end of day?"',
        '> "¿Tiene un celular o WhatsApp que sí mire? Yo sé que esta línea siempre está sonando."',
        '> EN: "Is there a cell or a WhatsApp [name] actually checks? I know this line\'s always slammed."',
        '> "¿Y con quién tengo el gusto? ... Gracias, [NOMBRE]."',
        '> EN: "And who am I speaking with? ... Thanks, [desk name]."',
        '',
        '### 3. Leave a question, not a message',
        '> "¿Me le pregunta una cosa a [NOMBRE]? ¿Cuántos años tiene el láser de depilación? Le llamo mañana a las 9 y 5."',
        '> EN: "Would you ask [name] one thing for me? How old is the hair removal laser? I\'ll call at 9:05 tomorrow."',
        '',
        '### 4. When the desk screens you: one line each, never the pitch',
        '**"¿Es paciente?" / "Are you a patient?"**',
        '> "No soy paciente. Es una llamada de proveedor sobre los equipos de láser, para el dueño."',
        '> EN: "I\'m not a patient. It\'s a vendor call about the laser equipment, for the owner."',
        '',
        '**"¿De qué se trata?" / "What is this regarding?"**',
        '> "Del láser de depilación. Es una decisión del dueño, así que no le quiero quitar su tiempo. ¿A qué hora le consigo?"',
        '> EN: "The hair removal laser. It\'s an owner decision, so I\'d rather not take up your time with it. When\'s the best time to catch [name]?"',
        '',
        '**"Mándelo al correo de info" / "Send it to info@"**',
        '> "Con gusto. Pero el correo de info se llena y eso se pierde. ¿Hay un correo directo?"',
        '> EN: "Happy to. Info inboxes get buried, though. Is there a direct email for [name]?"',
        '> "Perfecto. Se lo mando en diez minutos, y le llamo el jueves a las 9 para que no se quede ahí. ¿Le parece?"',
        '> EN: "Great. I\'ll send it in the next ten minutes, and I\'ll call [name] Thursday at 9 so it doesn\'t sit there. Does that work?"',
        '',
        '*Send it before you say you sent it. Subject: "Remy from Blason, re: the hair removal laser."*',
        '',
        '**"Si le interesa, le llama" / "If they\'re interested, they\'ll call you"**',
        '> "Me parece bien. Entonces pregúntele una sola cosa: ¿cuántos años tiene el láser? Si me dice que es nuevecito, no llamo más. Se lo prometo."',
        '> EN: "Totally fair. Then just ask one thing: how old is the laser? If the answer is brand new, tell me and I\'ll stop calling. Promise."',
        '',
        '**"No le interesa" (the desk, for the owner)**',
        '> "Entendido, y por eso mismo no le quiero hacer el cuento a usted. ¿A qué hora mira su propio teléfono, temprano o cuando cierran?"',
        '> EN: "Understood, and that\'s exactly why I don\'t want to pitch you. When do they look at their own phone, first thing or after close?"',
        '',
        '**"No coge llamadas" / "They\'re never here"**',
        '> "No hay problema. Cuando está en un procedimiento, ¿quién se encarga de las compras? ¿La gerente?"',
        '> EN: "No problem. When they\'re in a procedure, who handles purchasing? The office manager?"',
        '',
        '**Phone menu:** press the vendor, sales, manager or operator option. Never hang up without pressing something.',
        '',
        '### 5. Second call, same desk',
        '> "Hola [NOMBRE], es Remy de Blasón otra vez. Usted me dijo que [DUEÑO] estaba libre como a las 9. ¿Ahora es buen momento?"',
        '> EN: "Hi [desk name], it\'s Remy from Blason again. You told me [name] is free around 9. Is now good?"',
        '',
        '### Never with the desk',
        '- The product list, "thirty seconds", "it\'s nothing urgent", "just give me a callback", or "I sent the email" before you did. In Spanish, never "equipaje": say "máquinas".',
        '- The owner conversation is in the script below this box. When the owner picks up, close this and go to Step 2.'
    ].join('\n');
    /**
     * Single-language pass over bilingual script markdown. David's Blason
     * scripts write the spoken line in Spanish and follow it with an
     * `EN: "..."` translation, so the raw render shows both and the rep
     * can't read one clean language (Remy, 2026-09-14).
     *
     *   lang 'es' -> drop every EN: line (pure Spanish read)
     *   lang 'en' -> the EN: line REPLACES the nearest preceding spoken
     *                line (its Spanish original); prefix stripped.
     *   anything else -> untouched (drawer callers keep today's behavior)
     *
     * Pairing walks back over blanks and (stage directions) but stops at
     * headings, tables and rules — an EN: line with no spoken line above
     * it just loses its prefix. Spanish lines with NO translation stay in
     * both modes: showing an untranslated line beats hiding a spoken line.
     */
    function langFilter(md, lang) {
        if (lang !== 'en' && lang !== 'es') return md;
        var lines = String(md).split('\n');
        var out = [];
        var EN_RE = /^(\s*>?\s*)\**\s*EN\s*:\s*\**\s*/i;
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (EN_RE.test(l)) {
                if (lang === 'es') continue;
                var cleaned = l.replace(EN_RE, '$1'), placed = false;
                for (var j = out.length - 1; j >= 0; j--) {
                    var p = out[j], pt = p.trim();
                    if (!pt) continue;
                    // Stage directions may be emphasis-wrapped: *(let them respond)*
                    if (/^>?\s*[*_]*\(.*\)[*_]*$/.test(pt)) continue;
                    if (/^#{1,6}\s/.test(pt) || /^\|/.test(pt) || /^([-*_])\1{2,}$/.test(pt)) break;
                    out[j] = cleaned;   // the EN line takes its original's exact slot
                    placed = true;
                    break;
                }
                if (!placed) out.push(cleaned);
                continue;
            }
            out.push(l);
        }
        return out.join('\n');
    }

    function render(md, lang) {
        // David's generator ships CRLF line endings, and in JS regex `.` and
        // `$` refuse to cross a bare \r, so every heading match fails on the
        // raw text. Normalize first; renderBody strips trailing whitespace
        // per-line anyway, so this changes nothing downstream.
        var src = langFilter(String(md || '').replace(/\r\n?/g, '\n'), lang);
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
            + '<span style="font-family:var(--font-display);font-weight:800;color:#fff;font-size:15px;line-height:1.3;">Front desk answered? Tap here.<span style="display:block;font-size:11px;font-weight:600;color:var(--text-tertiary);margin-top:2px;">Open \u00B7 time, cell, name \u00B7 leave a question \u00B7 the screens \u00B7 call two.</span></span>'
            + '<span class="stilo-gk-hint" style="margin-left:auto;flex:none;font-size:11px;font-weight:700;color:rgba(245,158,11,0.9);">OPEN \u25BE</span>'
            + '</summary>'
            + '<div style="padding:2px 14px 14px;border-top:1px solid rgba(245,158,11,0.25);">' + renderBody(langFilter(GATEKEEPER_MD, lang)) + '</div>'
            + '</details>';
        return box + renderBody(rest);
    }

    global.STILO_SCRIPT = { render: render, escape: esc };
})(window);
