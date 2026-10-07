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

    // Three groups, not eight (Remy, 2026-10-07: "so confusing, so long, you
    // are dividing them by way too much"). The API still returns the fine
    // buckets; we merge them here so nothing upstream changes.
    //   now    = hottest + overdue + due today   -> the call list, in order
    //   later  = booked meetings + upcoming       -> what is already on the calendar
    //   noplan = working + no_plan                -> a human answered, nobody dated it
    // Closed is a one-line footer. One line per lead, note cut at the edge.
    var SECTIONS = [
        { key: 'now',    title: 'Call today',  color: 'var(--s-accent, #2563eb)', note: 'Pinned first, then the ones you promised and missed, then today’s times.', dial: true, primary: true, defaultOpen: true, parts: ['hottest', 'overdue', 'today'] },
        { key: 'later',  title: 'Coming up',   color: 'var(--s-pos, #34d399)',    note: 'Booked meetings and next steps with a future date.', dial: false, defaultOpen: true, parts: ['booked', 'upcoming'] },
        { key: 'noplan', title: 'Needs a plan', color: 'var(--s-text-3, #6e7083)', note: 'A human answered and nobody wrote the next step. Date it or close it.', dial: true, defaultOpen: false, parts: ['working', 'no_plan'] },
        { key: 'closed', title: 'Closed',      color: 'var(--s-text-4, #4b4d5e)', note: 'Won and lost, for the record.', dial: false, defaultOpen: false, parts: ['closed'] }
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

    /* Merge the API buckets into one list per group. Each row remembers which
       bucket it came from (r.__b) so the "when" cell can still say late / today. */
    function merged(sec) {
        var out = [], seen = {};
        sec.parts.forEach(function (b) {
            ((data && data.sections && data.sections[b]) || []).forEach(function (r) {
                if (seen[r.id]) return; seen[r.id] = 1;
                out.push(Object.assign({ __b: b }, r));
            });
        });
        if (sec.key === 'now') {
            var rank = { hottest: 0, overdue: 1, today: 2 };
            out.sort(function (a, b) { return (rank[a.__b] - rank[b.__b]) || ((ms(a.due_at) || 9e15) - (ms(b.due_at) || 9e15)); });
        }
        if (sec.key === 'later') out.sort(function (a, b) { return (ms(a.meeting_at || a.due_at) || 9e15) - (ms(b.meeting_at || b.due_at) || 9e15); });
        return out;
    }

    /* Left cell: one short word about timing. */
    function whenCell(r) {
        var b = r.__b, now = Date.now();
        if (b === 'booked') return '<span class="cp-when cp-w-pos">' + esc(shortDate(r.meeting_at)) + ' ' + esc(timeOf(r.meeting_at)) + '</span>';
        if (b === 'hottest') {
            var t = ms(r.due_at);
            if (!t) return '<span class="cp-when cp-w-hot">★ pinned</span>';
            if (t < now) return '<span class="cp-when cp-w-neg">★ ' + daysAgo(r.due_at) + 'd late</span>';
            var same = et(t, { dateStyle: 'short' }) === et(now, { dateStyle: 'short' });
            return '<span class="cp-when cp-w-hot">★ ' + esc(same ? timeOf(r.due_at) : shortDate(r.due_at)) + '</span>';
        }
        if (b === 'overdue') { var d = daysAgo(r.due_at); return '<span class="cp-when cp-w-neg">' + (d != null ? d + 'd late' : 'late') + '</span>'; }
        if (b === 'today') return '<span class="cp-when cp-w-acc">' + esc(timeOf(r.due_at) || 'today') + '</span>';
        if (b === 'upcoming') return '<span class="cp-when cp-w-warn">' + esc(shortDate(r.due_at)) + '</span>';
        var a = daysAgo(r.last_called_at);
        return '<span class="cp-when cp-w-mute">' + (a != null ? a + 'd ago' : '—') + '</span>';
    }

    function row(r, key) {
        var phone = r.owner_phone || r.phone || '';
        var what = r.next_step
            ? r.next_step.replace(/^\[[^\]]*\]\s*/, '')
            : (r.reply ? 'They texted: “' + r.reply.body + '”'
                : ((r.notes || '').split('\n').filter(Boolean).slice(-1)[0] || ''));
        var who = [r.owner_name, r.city].filter(Boolean).join(' · ');
        return '<div class="cp-row" data-id="' + r.id + '" title="' + esc(what) + '">'
            + whenCell(r)
            + '<span class="cp-name">' + esc(r.name) + (r.lang === 'es' ? ' <b class="cp-es">ES</b>' : '') + (who ? '<small>' + esc(who) + '</small>' : '') + '</span>'
            + '<span class="cp-what">' + esc(what) + '</span>'
            + '<span class="cp-phone">' + esc(phone) + '</span>'
            + '<span class="cp-act">'
            +   (key !== 'closed' ? '<button class="cp-star' + (r.pinned ? ' on' : '') + '" data-pin="' + r.id + '" title="' + (r.pinned ? 'Unpin' : 'Pin to the top') + '">' + (r.pinned ? '★' : '☆') + '</button>' : '')
            +   ((key !== 'closed' && phone) ? '<button class="cp-callbtn" data-dial-from="' + key + ':' + r.id + '" title="Dial this list starting here">Call</button>' : '')
            + '</span>'
            + '</div>';
    }

    function section(sec) {
        var rows = merged(sec);
        if (!rows.length && sec.key !== 'now') return '';
        var expanded = isOpen(sec);
        var dialable = rows.filter(function (r) { return r.owner_phone || r.phone; }).length;
        var dialBtn = (sec.dial && dialable)
            ? '<button class="cp-dial' + (sec.primary ? ' cp-dial-primary' : '') + '" data-dial="' + sec.key + '">▶ Dial ' + dialable + '</button>'
            : '';
        var body = !rows.length
            ? '<div class="cp-empty">Nothing to call today. Open “Needs a plan” and date a few.</div>'
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
        var now = (c.hottest || 0) + (c.overdue || 0) + (c.today || 0);
        var later = (c.booked || 0) + (c.upcoming || 0);
        var noplan = (c.working || 0) + (c.no_plan || 0);
        var cells = [
            ['now', 'Call today', now, 'var(--s-accent-hi,#60a5fa)', (c.overdue ? c.overdue + ' late' : '') ],
            ['later', 'Coming up', later, 'var(--s-pos,#34d399)', (c.booked ? c.booked + ' booked' : '')],
            ['noplan', 'Needs a plan', noplan, 'var(--s-text-2,#a2a3b4)', ''],
            ['closed', 'Won', data.won || 0, 'var(--s-pos,#34d399)', '']
        ];
        return '<div class="cp-sum">' + cells.map(function (x) {
            return '<a class="cp-sumcell" data-jump="' + x[0] + '"><span class="cp-sumnum" style="color:' + x[3] + ';">' + x[2] + '</span><span class="cp-sumlbl">' + x[1] + (x[4] ? ' <i>· ' + x[4] + '</i>' : '') + '</span></a>';
        }).join('') + '</div>';
    }

    var CSS = ''
        + '.cp-wrap{font-size:13px;color:var(--s-text,#ecedf2)}'
        + '.cp-sum{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--s-line,rgba(255,255,255,.055));border:1px solid var(--s-line,rgba(255,255,255,.055));border-radius:14px;overflow:hidden;margin-bottom:22px}'
        + '.cp-sumcell{background:var(--s-surface,#0e0e14);padding:16px 16px 13px;display:flex;flex-direction:column;gap:3px;cursor:pointer;text-decoration:none}'
        + '.cp-sumcell:hover{background:var(--s-raised,#14141c)}'
        + '.cp-sumnum{font-size:28px;font-weight:700;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}'
        + '.cp-sumlbl{font-size:11px;color:var(--s-text-3,#6e7083);text-transform:uppercase;letter-spacing:.06em;font-weight:600}.cp-sumlbl i{font-style:normal;text-transform:none;letter-spacing:0;color:var(--s-text-4,#4b4d5e)}'
        + '.cp-sec{margin-bottom:14px}'
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
        + '.cp-rows{padding:2px 0 6px}'
        /* ONE line per lead: when | who | what | phone | actions. The note is cut
           at the cell edge; the full text is the row's tooltip and the lead
           drawer. No second line, no meta line. */
        + '.cp-row{display:grid;grid-template-columns:92px minmax(180px,26%) minmax(0,1fr) 128px 64px;gap:12px;align-items:center;height:46px;padding:0 6px;border-bottom:1px solid var(--s-line,rgba(255,255,255,.055));cursor:pointer}'
        + '.cp-row:hover{background:var(--s-raised,#14141c)}'
        + '.cp-when{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.cp-w-hot{color:#f59e0b}.cp-w-neg{color:var(--s-neg,#f87171)}.cp-w-acc{color:var(--s-accent-hi,#60a5fa)}.cp-w-pos{color:var(--s-pos,#34d399)}.cp-w-warn{color:var(--s-warn,#fbbf24)}.cp-w-mute{color:var(--s-text-3,#6e7083)}'
        + '.cp-name{font-size:13.5px;font-weight:700;color:var(--s-text,#ecedf2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'
        + '.cp-name small{display:block;font-size:11px;font-weight:500;color:var(--s-text-3,#6e7083);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}'
        + '.cp-es{font-size:10px;font-weight:800;letter-spacing:.06em;color:var(--s-warn,#fbbf24)}'
        + '.cp-what{font-size:12.5px;color:var(--s-text-2,#a2a3b4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'
        + '.cp-phone{font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:12px;color:var(--s-text-2,#a2a3b4);white-space:nowrap;text-align:right}'
        + '.cp-act{display:flex;align-items:center;justify-content:flex-end;gap:10px}'
        + '.cp-callbtn{border:none;background:transparent;color:var(--s-accent-hi,#60a5fa);font-size:12px;font-weight:700;cursor:pointer;padding:0}'
        + '.cp-star{border:none;background:transparent;color:var(--s-text-4,#4b4d5e);font-size:15px;line-height:1;cursor:pointer;padding:0}.cp-star:hover,.cp-star.on{color:#f59e0b}'
        + '.cp-empty{padding:18px 6px;color:var(--s-text-3,#6e7083)}'
        + '@media (max-width:860px){.cp-sum{grid-template-columns:repeat(2,minmax(0,1fr))}.cp-note{display:none}'
        +   '.cp-row{grid-template-columns:72px minmax(0,1fr) 56px;height:auto;padding:8px 6px}.cp-what,.cp-phone{display:none}}';

    function ensureCss() {
        if (document.getElementById('cpCss2')) return;
        var st = document.createElement('style'); st.id = 'cpCss2'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    function render() {
        var host = document.getElementById(cfg.host);
        if (!host || !data) return;
        host.innerHTML = '<div class="cp-wrap">' + summary() + SECTIONS.map(section).join('') + '</div>';
    }

    function rowsFor(key) { var sec = SECTIONS.filter(function (x) { return x.key === key; })[0]; return sec ? merged(sec) : ((data && data.sections && data.sections[key]) || []).slice(); }

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
