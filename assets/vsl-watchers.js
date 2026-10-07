/**
 * assets/vsl-watchers.js
 *
 * "Video watchers" table, shared by /sdr/ and /admin/. Every Blason lead that
 * opened the video page, sorted hottest first (watched most, pressed play,
 * most recent), with the source, what they did, and their call status. Rows
 * open the lead drawer (script included) and dial in Quo. Mounts into every
 * `.vslWatchersHost`. Collapsible, remembers the state per browser.
 */
(function (global) {
  'use strict';
  var rows = null, timer = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function fetcher() { return global.fetchJSON || global.prospectFetchJSON || null; }
  function opener() { return global.openLeadDrawer || global.openProspectDrawer || null; }
  function hosts() { return Array.prototype.slice.call(document.querySelectorAll('.vslWatchersHost')); }
  function collapsed() { try { return localStorage.getItem('vslw_collapsed') === '1'; } catch (e) { return false; } }
  function setCollapsed(v) { try { localStorage.setItem('vslw_collapsed', v ? '1' : '0'); } catch (e) {} render(); }
  var CSS = '.vw{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(139,92,246,.45);border-left:3px solid #8b5cf6;border-radius:10px;background:rgba(139,92,246,.06)}'
    + '.vw-h{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}.vw-t{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#a78bfa}.vw-s{font-size:11px;color:var(--text-secondary,#9a9ab0)}'
    + '.vw table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}.vw th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted,#8a8aa0);padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}.vw td{padding:8px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top;color:var(--text-primary,#ecedf2)}'
    + '.vw-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700}.vw-hot{background:rgba(239,68,68,.18);color:#f87171}.vw-ok{background:rgba(34,197,94,.15);color:#4ade80}.vw-mid{background:rgba(139,92,246,.18);color:#c4b5fd}.vw-grey{background:rgba(255,255,255,.08);color:var(--text-secondary,#9a9ab0)}'
    + '.vw-btn{border:0;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB;margin-right:4px}.vw-btn.q{background:#ef4444}';
  function ensureCss() { if (document.getElementById('vslWatchersCss')) return; var st = document.createElement('style'); st.id = 'vslWatchersCss'; st.textContent = CSS; document.head.appendChild(st); }
  function did(r) {
    if (r.contact) return ['left their number', 'vw-ok'];
    if (r.quiz) return ['finished the quiz', 'vw-ok'];
    if (r.pct >= 75) return ['watched ' + r.pct + '%', 'vw-mid'];
    if (r.plays) return ['pressed play' + (r.pct ? ', ' + r.pct + '%' : ''), 'vw-mid'];
    return ['opened the page x' + r.views, 'vw-grey'];
  }
  function render() {
    ensureCss();
    hosts().forEach(function (h) {
      if (!rows) { h.innerHTML = ''; return; }
      var open = !collapsed();
      var hot = rows.filter(function (r) { return r.status === 'not called yet'; }).length;
      h.innerHTML = '<div class="vw"><div class="vw-h" onclick="VSL_WATCHERS.toggle()"><span class="vw-t">Video watchers · Blason · ' + rows.length + ' total, ' + hot + ' not called yet</span><span class="vw-s">' + (open ? 'hide' : 'show') + '</span></div>'
        + (open && rows.length ? '<table><thead><tr><th>Business</th><th>Did</th><th>From</th><th>Last seen</th><th>Status</th><th>Rep</th><th></th></tr></thead><tbody>'
          + rows.map(function (r) {
            var d = did(r);
            return '<tr data-id="' + r.id + '"><td><b>' + esc(r.business) + '</b>' + (r.owner ? '<br><span class="vw-s">' + esc(r.owner) + (r.city ? ' · ' + esc(r.city) : '') + (r.lang === 'es' ? ' · ES' : '') + '</span>' : (r.city ? '<br><span class="vw-s">' + esc(r.city) + '</span>' : ''))
              + (r.phone ? '<br><span class="vw-s">' + esc(r.phone) + '</span>' : '<br><span class="vw-s">no phone</span>') + '</td>'
              + '<td><span class="vw-pill ' + d[1] + '">' + esc(d[0]) + '</span>' + (r.mobile ? '<br><span class="vw-s">on their phone</span>' : '') + '</td>'
              + '<td>' + esc(r.sources || 'direct') + '</td>'
              + '<td>' + esc(when(r.last_seen)) + '</td>'
              + '<td><span class="vw-pill ' + (r.status === 'not called yet' ? 'vw-hot' : r.status === 'booked' ? 'vw-ok' : 'vw-grey') + '">' + esc(r.status) + '</span>' + (r.next_step ? '<br><span class="vw-s">' + esc(r.next_step.slice(0, 90)) + '</span>' : '') + '</td>'
              + '<td class="vw-s">' + esc((r.assigned_to || 'unassigned').split('@')[0]) + '</td>'
              + '<td style="white-space:nowrap">' + (r.phone ? '<button class="vw-btn q" data-act="call">Call</button>' : '') + '<button class="vw-btn" data-act="open">Open</button></td></tr>';
          }).join('') + '</tbody></table>' : (open ? '<div class="vw-s" style="margin-top:8px">Nobody has opened the video page yet.</div>' : ''))
        + '</div>';
      h.onclick = function (ev) {
        var b = ev.target.closest('button[data-act]'); if (!b) return;
        var id = parseInt(b.closest('tr').getAttribute('data-id'), 10);
        var r = rows.filter(function (x) { return x.id === id; })[0]; if (!r) return;
        if (b.getAttribute('data-act') === 'call') { if (global.HOT_LEADS) HOT_LEADS.callInQuo(r.phone); }
        else { var o = opener(); if (o) o(id); }
      };
    });
  }
  async function refresh() {
    var f = fetcher(); if (!f || !hosts().length) return;
    try { var j = await f('/api/prospects/vsl-watchers'); rows = (j && j.rows) || []; render(); } catch (e) {}
  }
  function start() { if (timer) return; refresh(); timer = setInterval(refresh, 120000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1800); }); else setTimeout(start, 1800);
  global.VSL_WATCHERS = { refresh: refresh, toggle: function () { setCollapsed(!collapsed()); } };
})(window);
