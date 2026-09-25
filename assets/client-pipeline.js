/**
 * assets/client-pipeline.js
 *
 * The client-account pipeline (Blason CRM view), shared by admin and SDR.
 * Reads /api/prospects/client-pipeline and answers, in order, the questions
 * a rep has at 8am: what's booked, who do I call today, what did I promise
 * and miss, what's coming, and which "hot" leads have no plan at all.
 *
 * Every section carries its own Dial button that opens Dialer Mode on exactly
 * that list (2026-09-25: the dialer only existed on the Cold Call tab, so the
 * pipeline could be read but not worked).
 *
 * Usage:
 *   CLIENT_PIPELINE.mount({
 *     host: 'elementId',
 *     fetchJson: fn(path) -> Promise<json>,
 *     escape: fn(str) -> html-safe str,
 *     openLead: fn(id),
 *     dial: fn(rows),              // opens Dialer Mode on these rows
 *     onCounts: fn(counts)         // optional, for a nav badge
 *   });
 */
(function () {
    var cfg = null;
    var data = null;
    var open = {};   // section key -> expanded (persists across reloads)
    try { open = JSON.parse(localStorage.getItem('cp_open') || '{}') || {}; } catch (e) { open = {}; }

    var SECTIONS = [
        { key: 'hottest',  title: 'Hottest',   color: '#f59e0b', note: 'Named a machine or a real plan. These first, always. Star a row to pin it here.', dial: true, primary: true, defaultOpen: true },
        { key: 'booked',   title: 'Booked',    color: 'var(--s-pos, #34d399)',    note: 'On the calendar. Confirm the morning of, brief Manuel, show up.', dial: false, defaultOpen: true },
        { key: 'today',    title: 'Due today', color: 'var(--s-accent, #2563eb)', note: 'Everyone else due today, in the order of the windows the desks gave you.', dial: true, defaultOpen: true },
        { key: 'overdue',  title: 'Overdue',   color: 'var(--s-neg, #f87171)',    note: 'Promised and missed. Call it or give it a new date.', dial: true, defaultOpen: true },
        { key: 'upcoming', title: 'Upcoming',  color: 'var(--s-warn, #fbbf24)',   note: 'A real next step with a future date.', dial: false, defaultOpen: false },
        { key: 'no_plan',  title: 'No plan',   color: 'var(--s-text-3, #6e7083)', note: 'Had a pulse, nobody wrote the next step. Date it or close it.', dial: true, defaultOpen: false },
        { key: 'working',  title: 'Working',   color: 'var(--s-text-3, #6e7083)', note: 'Reached a human, nothing resolved.', dial: true, defaultOpen: false },
        { key: 'closed',   title: 'Closed',    color: 'var(--s-text-4, #4b4d5e)', note: 'Won and lost, for the record.', dial: false, defaultOpen: false }
    ];

    function esc(s) { return cfg && cfg.escape ? cfg.escape(s == null ? '' : String(s)) : String(s == null ? '' : s); }
    function ms(iso) {
        if (!iso) return null;
        var s = String(iso);
        var t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime();
        return isNaN(t) ? null : t;
    }
    function et(t, o) { return new Date(t).toLocaleString('en-US', Object.assign({ timeZone: 'America/New_York' }, o)); }
    function shortDate(iso) { var t = ms(iso); return t ? et(t, { month: 'short', day: 'numeric' }) : ''; }
    function timeOf(iso) { var t = ms(iso); return t ? et(t, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase() : ''; }
    function daysAgo(iso) { var t = ms(iso); return t ? Math.floor((Date.now() - t) / 864e5) : null; }

    function isOpen(sec) { return Object.prototype.hasOwnProperty.call(open, sec.key) ? !!open[sec.key] : sec.defaultOpen; }
    function setOpen(key, v) { open[key] = v; try { localStorage.setItem('cp_open', JSON.stringify(open)); } catch (e) {} }

    /* Left column answers "when": a time today, how late, or a date. */
    function whenCell(r, key) {
        if (key === 'booked') return '<div class="cp-when" style="color:var(--s-pos,#34d399);">' + esc(shortDate(r.meeting_at)) + '<small>' + esc(timeOf(r.meeting_at)) + '</small></div>';
        if (key === 'hottest') {
            var t = ms(r.due_at), now = Date.now();
            var sameDay = t && et(t, { dateStyle: 'short' }) === et(now, { dateStyle: 'short' });
            if (!t) return '<div class="cp-when" style="color:#f59e0b;">\u2605</div>';
            if (sameDay) return '<div class="cp-when" style="color:#f59e0b;">' + esc(timeOf(r.due_at)) + '<small>today</small></div>';
            if (t < now) { var dl = daysAgo(r.due_at); return '<div class="cp-when" style="color:var(--s-neg,#f87171);">' + dl + 'd<small>late</small></div>'; }
            return '<div class="cp-when" style="color:#f59e0b;">' + esc(shortDate(r.due_at)) + '</div>';
        }
        if (key === 'today') return '<div class="cp-when" style="color:var(--s-accent-hi,#60a5fa);">' + esc(timeOf(r.due_at) || 'today') + '</div>';
        if (key === 'overdue') { var d = daysAgo(r.due_at); return '<div class="cp-when" style="color:var(--s-neg,#f87171);">' + (d != null ? d + 'd' : '') + '<small>late</small></div>'; }
        if (key === 'upcoming') return '<div class="cp-when" style="color:var(--s-warn,#fbbf24);">' + esc(shortDate(r.due_at)) + '</div>';
        var a = daysAgo(r.last_called_at);
        return '<div class="cp-when" style="color:var(--s-text-3,#6e7083);">' + (a != null ? a + 'd' : '—') + '<small>' + (a != null ? 'since call' : '') + '</small></div>';
    }

    function row(r, key) {
        var phone = r.owner_phone || r.phone || '';
        var what = r.next_step
            ? esc(r.next_step.replace(/^\[[^\]]*\]\s*/, ''))
            : (r.reply ? 'They texted: “' + esc(r.reply.body) + '”'
                : esc((r.notes || '').split('\n').filter(Boolean).slice(-1)[0] || ''));
        var meta = [];
        if (r.last_called_at) meta.push('last call ' + esc(shortDate(r.last_called_at)));
        if (r.attempts) meta.push(r.attempts + (r.attempts === 1 ? ' dial' : ' dials'));
        if (r.niche) meta.push(esc(r.niche));
        if (r.rep) meta.push(esc(r.rep));
        return '<div class="cp-row" data-id="' + r.id + '">'
            + whenCell(r, key)
            + '<div class="cp-main">'
            +   '<div class="cp-line1"><span class="cp-name">' + esc(r.name) + '</span>'
            +     (r.owner_name ? '<span class="cp-owner">' + esc(r.owner_name) + '</span>' : '')
            +     (r.city ? '<span class="cp-city">' + esc(r.city) + '</span>' : '')
            +     (r.lang === 'es' ? '<span class="cp-es">ES</span>' : '')
            +   '</div>'
            +   (what ? '<div class="cp-what">' + what + '</div>' : '')
            +   '<div class="cp-meta">' + meta.join(' · ') + '</div>'
            + '</div>'
            + '<div class="cp-right"><span class="cp-phone">' + esc(phone) + '</span>'
            +   (key !== 'closed' ? '<button class="cp-star' + (r.pinned ? ' on' : '') + '" data-pin="' + r.id + '" title="' + (r.pinned ? 'Unpin from Hottest' : 'Pin to Hottest') + '">' + (r.pinned ? '\u2605' : '\u2606') + '</button>' : '')
            +   ((key !== 'closed' && phone) ? '<button class="cp-callbtn" data-dial-from="' + key + ':' + r.id + '" title="Dial this list starting here">Call</button>' : '')
            + '</div>'
            + '</div>';
    }

    function section(sec) {
        var rows = (data.sections && data.sections[sec.key]) || [];
        if (!rows.length && sec.key !== 'today') return '';
        var expanded = isOpen(sec);
        var dialable = rows.filter(function (r) { return r.owner_phone || r.phone; }).length;
        var dialBtn = (sec.dial && dialable)
            ? '<button class="cp-dial' + (sec.primary ? ' cp-dial-primary' : '') + '" data-dial="' + sec.key + '">▶ Dial ' + dialable + '</button>'
            : '';
        var body = !rows.length
            ? '<div class="cp-empty">Nothing due today. Work Overdue, then No plan.</div>'
            : rows.map(function (r) { return row(r, sec.key); }).join('');
        return '<section class="cp-sec" id="cp-sec-' + sec.key + '">'
            + '<header class="cp-sechead" data-toggle="' + sec.key + '">'
            +   '<span class="cp-dot" style="background:' + sec.color + ';"></span>'
            +   '<h3>' + sec.title + '</h3><span class="cp-count">' + rows.length + '</span>'
            +   '<span class="cp-note">' + sec.note + '</span>'
            +   '<span class="cp-headright">' + dialBtn + '<span class="cp-chev">' + (expanded ? '−' : '+') + '</span></span>'
            + '</header>'
            + (expanded ? '<div class="cp-rows">' + body + '</div>' : '')
            + '</section>';
    }

    function summary() {
        var c = data.counts || {};
        var cells = [
            ['hottest', 'Hottest', c.hottest || 0, '#f59e0b'],
            ['booked', 'Booked', c.booked || 0, 'var(--s-pos,#34d399)'],
            ['today', 'Due today', c.today || 0, 'var(--s-accent-hi,#60a5fa)'],
            ['overdue', 'Overdue', c.overdue || 0, (c.overdue ? 'var(--s-neg,#f87171)' : 'var(--s-text-3,#6e7083)')],
            ['upcoming', 'Upcoming', c.upcoming || 0, 'var(--s-text,#ecedf2)'],
            ['no_plan', 'No plan', c.no_plan || 0, 'var(--s-text,#ecedf2)'],
            ['working', 'Working', c.working || 0, 'var(--s-text-2,#a2a3b4)'],
            ['closed', 'Won', data.won || 0, 'var(--s-pos,#34d399)']
        ];
        return '<div class="cp-sum">' + cells.map(function (x) {
            return '<a class="cp-sumcell" data-jump="' + x[0] + '"><span class="cp-sumnum" style="color:' + x[3] + ';">' + x[2] + '</span><span class="cp-sumlbl">' + x[1] + '</span></a>';
        }).join('') + '</div>';
    }

    var CSS = ''
        + '.cp-wrap{font-size:13px;color:var(--s-text,#ecedf2)}'
        + '.cp-sum{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:1px;background:var(--s-line,rgba(255,255,255,.055));border:1px solid var(--s-line,rgba(255,255,255,.055));border-radius:14px;overflow:hidden;margin-bottom:22px}'
        + '.cp-sumcell{background:var(--s-surface,#0e0e14);padding:16px 14px 13px;display:flex;flex-direction:column;gap:3px;cursor:pointer;text-decoration:none}'
        + '.cp-sumcell:hover{background:var(--s-raised,#14141c)}'
        + '.cp-sumnum{font-size:26px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}'
        + '.cp-sumlbl{font-size:11px;color:var(--s-text-3,#6e7083);text-transform:uppercase;letter-spacing:.06em;font-weight:600}'
        + '.cp-sec{margin-bottom:10px}'
        + '.cp-sechead{display:flex;align-items:center;gap:10px;padding:12px 4px;cursor:pointer;user-select:none;border-bottom:1px solid var(--s-line,rgba(255,255,255,.055))}'
        + '.cp-sechead h3{margin:0;font-size:15px;font-weight:700;letter-spacing:-.01em;color:var(--s-text,#ecedf2)}'
        + '.cp-dot{width:8px;height:8px;border-radius:50%;flex:none}'
        + '.cp-count{font-size:13px;color:var(--s-text-2,#a2a3b4);font-variant-numeric:tabular-nums}'
        + '.cp-note{font-size:12px;color:var(--s-text-3,#6e7083);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}'
        + '.cp-headright{margin-left:auto;display:flex;align-items:center;gap:12px;flex:none}'
        + '.cp-chev{width:18px;text-align:center;color:var(--s-text-3,#6e7083);font-size:16px}'
        + '.cp-dial{border:1px solid var(--s-line-strong,rgba(255,255,255,.1));background:transparent;color:var(--s-text,#ecedf2);border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer}'
        + '.cp-dial:hover{border-color:var(--s-accent-line,rgba(37,99,235,.34))}'
        + '.cp-dial-primary{background:var(--s-accent,#2563eb);border-color:var(--s-accent,#2563eb);color:#fff}'
        + '.cp-rows{padding:2px 0 10px}'
        + '.cp-row{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:14px;align-items:start;padding:12px 4px;border-bottom:1px solid var(--s-line,rgba(255,255,255,.055));cursor:pointer}'
        + '.cp-row:hover{background:var(--s-raised,#14141c)}'
        + '.cp-when{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2;padding-top:1px}'
        + '.cp-when small{display:block;font-size:10px;font-weight:600;color:var(--s-text-4,#4b4d5e);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}'
        + '.cp-line1{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}'
        + '.cp-name{font-size:14px;font-weight:700;color:var(--s-text,#ecedf2)}'
        + '.cp-owner{font-size:12.5px;color:var(--s-text-2,#a2a3b4)}'
        + '.cp-city{font-size:12px;color:var(--s-text-3,#6e7083)}'
        + '.cp-es{font-size:10px;font-weight:800;letter-spacing:.06em;color:var(--s-warn,#fbbf24)}'
        + '.cp-what{font-size:12.5px;color:var(--s-text-2,#a2a3b4);line-height:1.5;margin-top:3px}'
        + '.cp-meta{font-size:11px;color:var(--s-text-4,#4b4d5e);margin-top:4px}'
        + '.cp-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px}'
        + '.cp-phone{font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:12px;color:var(--s-text-2,#a2a3b4);white-space:nowrap}'
        + '.cp-callbtn{border:none;background:transparent;color:var(--s-accent-hi,#60a5fa);font-size:12px;font-weight:700;cursor:pointer;padding:0}'
        + '.cp-star{border:none;background:transparent;color:var(--s-text-4,#4b4d5e);font-size:16px;line-height:1;cursor:pointer;padding:0}.cp-star:hover,.cp-star.on{color:#f59e0b}'
        + '.cp-empty{padding:18px 4px;color:var(--s-text-3,#6e7083)}'
        + '@media (max-width:760px){.cp-sum{grid-template-columns:repeat(4,minmax(0,1fr))}.cp-sumcell:nth-child(n+5){display:none}.cp-note{display:none}'
        +   '.cp-row{grid-template-columns:48px minmax(0,1fr)}.cp-right{grid-column:2;flex-direction:row;align-items:center;gap:14px}.cp-dial{padding:8px 14px}}';

    function ensureCss() {
        if (document.getElementById('cpCss')) return;
        var st = document.createElement('style'); st.id = 'cpCss'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    function render() {
        var host = document.getElementById(cfg.host);
        if (!host || !data) return;
        host.innerHTML = '<div class="cp-wrap">' + summary() + SECTIONS.map(section).join('') + '</div>';
    }

    function rowsFor(key) { return ((data && data.sections && data.sections[key]) || []).slice(); }

    function onClick(ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        var b = t.closest('[data-dial]');
        if (b) { ev.stopPropagation(); if (cfg.dial) cfg.dial(rowsFor(b.getAttribute('data-dial'))); return; }
        var c = t.closest('[data-dial-from]');
        if (c) {
            ev.stopPropagation();
            var parts = c.getAttribute('data-dial-from').split(':');
            var list = rowsFor(parts[0]);
            var i = list.findIndex(function (r) { return String(r.id) === parts[1]; });
            if (cfg.dial) cfg.dial(i > 0 ? list.slice(i) : list);
            return;
        }
        var p = t.closest('[data-pin]');
        if (p) {
            ev.stopPropagation();
            var pid = Number(p.getAttribute('data-pin'));
            var nowPinned = !p.classList.contains('on');
            p.textContent = nowPinned ? '\u2605' : '\u2606'; p.classList.toggle('on', nowPinned);
            Promise.resolve(cfg.fetchJson('/api/prospects/client-pipeline', { method: 'POST', body: JSON.stringify({ id: pid, pinned: nowPinned }) }))
                .then(function () { return mount(cfg); })
                .catch(function (e) { alert('Could not pin: ' + ((e && e.message) || 'unknown')); mount(cfg); });
            return;
        }
        var j = t.closest('[data-jump]');
        if (j) {
            var key = j.getAttribute('data-jump');
            var sec = SECTIONS.filter(function (s) { return s.key === key; })[0];
            if (sec && !isOpen(sec)) { setOpen(key, true); render(); }
            var el = document.getElementById('cp-sec-' + key);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        var h = t.closest('[data-toggle]');
        if (h) {
            var k = h.getAttribute('data-toggle');
            var s2 = SECTIONS.filter(function (s) { return s.key === k; })[0];
            setOpen(k, !isOpen(s2)); render(); return;
        }
        var r = t.closest('.cp-row');
        if (r && cfg.openLead) cfg.openLead(Number(r.getAttribute('data-id')));
    }

    function mount(opts) {
        cfg = opts || {};
        ensureCss();
        var host = document.getElementById(cfg.host);
        if (!host) return;
        if (!host.__cpBound) { host.addEventListener('click', onClick); host.__cpBound = true; }
        host.innerHTML = '<div style="padding:32px;text-align:center;color:var(--s-text-3,#6e7083);">Loading the pipeline...</div>';
        return Promise.resolve(cfg.fetchJson('/api/prospects/client-pipeline')).then(function (d) {
            data = d || {};
            if (cfg.onCounts) try { cfg.onCounts(data.counts || {}); } catch (e) {}
            render();
        }).catch(function (e) {
            host.innerHTML = '<div style="padding:32px;text-align:center;color:var(--s-neg,#f87171);">Could not load the pipeline: ' + esc((e && e.message) || 'unknown') + '</div>';
        });
    }

    window.CLIENT_PIPELINE = { mount: mount, rows: rowsFor };
})();
