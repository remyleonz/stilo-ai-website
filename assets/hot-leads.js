/**
 * assets/hot-leads.js
 *
 * "Call now" strip + drawer banner, shared by /sdr/ and /admin/. Reads
 * /api/prospects/hot-leads (leads a human touched in the last 72h and nobody
 * called since) and renders one row per lead at the top of the page: how long
 * ago, who, what they did, a Call-in-Quo button, Open, Done. Polls every 45s.
 * Hidden when the queue is empty, so it costs nothing on a quiet day.
 *
 * The lead drawer gets a red banner with the same reason above the script, so
 * a rep who opens the lead from anywhere still sees why the call is urgent.
 */
(function (global) {
  'use strict';
  var POLL_MS = 45000, timer = null, lastRows = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(iso) { var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
  function fetcher() { return global.fetchJSON || global.prospectFetchJSON || null; }
  function opener() { return global.openLeadDrawer || global.openProspectDrawer || null; }
  function e164(p) { var d = String(p || '').replace(/[^\d+]/g, ''); if (!d) return ''; if (d[0] !== '+') d = (d.length === 10 ? '+1' : '+') + d; return d; }
  function callInQuo(phone) {
    var n = e164(phone); if (!n) return;
    if (global.DIALER_MODE && DIALER_MODE.openQuo && DIALER_MODE.openQuo(n)) return;
    global.location.href = 'quo://call?to=' + encodeURIComponent(n);
    setTimeout(function () { if (!document.hidden) global.open('https://my.openphone.com/calls/new?to=' + encodeURIComponent(n), '_blank'); }, 1600);
  }
  var CSS = '.hl{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(239,68,68,.45);border-left:3px solid #ef4444;border-radius:10px;background:rgba(239,68,68,.07);font-family:inherit}'
    + '.hl-h{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ef4444;margin-bottom:8px}'
    + '.hl-h i{width:8px;height:8px;border-radius:50%;background:#ef4444;animation:hlBlink 1.6s ease-in-out infinite}@keyframes hlBlink{50%{opacity:.2}}'
    + '.hl-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06);flex-wrap:wrap}.hl-row:first-of-type{border-top:0}'
    + '.hl-ago{min-width:70px;font-size:11px;font-weight:700;color:#f87171}.hl-who{flex:1;min-width:200px;font-size:13px;color:var(--text-primary,#ecedf2)}.hl-who b{font-weight:700}.hl-why{display:block;font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:2px}'
    + '.hl-btn{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB}.hl-btn.g{background:rgba(255,255,255,.1);color:var(--text-primary,#ecedf2)}.hl-btn.q{background:#ef4444}'
    + '.hl-tag{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:rgba(37,99,235,.15);color:#60a5fa;margin-left:6px}';
  function ensureCss() { if (document.getElementById('hotLeadsCss')) return; var st = document.createElement('style'); st.id = 'hotLeadsCss'; st.textContent = CSS; document.head.appendChild(st); }
  function hosts() { return Array.prototype.slice.call(document.querySelectorAll('.hotLeadsStrip, #hotLeadsStrip')); }
  function render(rows) {
    ensureCss();
    hosts().forEach(function (h) {
      if (!rows || !rows.length) { h.innerHTML = ''; return; }
      h.innerHTML = '<div class="hl"><div class="hl-h"><i></i>Call now · ' + rows.length + ' waiting</div>'
        + rows.map(function (r) {
          return '<div class="hl-row" data-id="' + r.id + '">'
            + '<span class="hl-ago">' + esc(ago(r.hot_at)) + '</span>'
            + '<span class="hl-who"><b>' + esc(r.business || 'lead ' + r.id) + '</b>' + (r.owner ? ' · ' + esc(r.owner) : '') + (r.city ? ' · ' + esc(r.city) : '') + (r.lang === 'es' ? '<span class="hl-tag">ES</span>' : '') + (r.client && r.client !== 'STILO' ? '<span class="hl-tag">' + esc(r.client) + '</span>' : '')
            + '<span class="hl-why">' + esc(r.reason) + (r.phone ? ' · ' + esc(r.phone) : ' · no phone on file') + '</span></span>'
            + (r.phone ? '<button class="hl-btn q" data-act="call">Call in Quo</button>' : '')
            + '<button class="hl-btn" data-act="open">Open + script</button>'
            + '<button class="hl-btn g" data-act="done" title="Remove from this list">Done</button>'
            + '</div>';
        }).join('') + '</div>';
      h.onclick = function (ev) {
        var b = ev.target.closest('button[data-act]'); if (!b) return;
        var row = b.closest('.hl-row'); var id = parseInt(row.getAttribute('data-id'), 10);
        var r = (lastRows || []).filter(function (x) { return x.id === id; })[0]; if (!r) return;
        if (b.getAttribute('data-act') === 'call') callInQuo(r.phone);
        else if (b.getAttribute('data-act') === 'open') { var o = opener(); if (o) o(id); }
        else if (b.getAttribute('data-act') === 'done') clear(id);
      };
    });
  }
  async function refresh() {
    var f = fetcher(); if (!f || !hosts().length) return;
    try { var j = await f('/api/prospects/hot-leads'); lastRows = (j && j.rows) || []; render(lastRows); } catch (e) { /* quiet: strip just stays as it was */ }
  }
  async function clear(id) {
    var f = fetcher(); if (!f) return;
    try { await f('/api/prospects/hot-leads', { method: 'POST', body: JSON.stringify({ lead_id: id, clear: true }) }); } catch (e) {}
    lastRows = (lastRows || []).filter(function (x) { return x.id !== id; }); render(lastRows);
    var bn = document.getElementById('hotLeadBanner'); if (bn && parseInt(bn.getAttribute('data-id'), 10) === id) bn.remove();
  }
  async function mark(id, reason) {
    var f = fetcher(); if (!f) return;
    try { await f('/api/prospects/hot-leads', { method: 'POST', body: JSON.stringify({ lead_id: id, reason: reason }) }); } catch (e) {}
    refresh();
  }
  function banner(lead, host) {
    if (!lead || !host || !lead.hot_at || lead.hot_cleared_at) return;
    if (Date.now() - new Date(lead.hot_at).getTime() > 72 * 3600 * 1000) return;
    ensureCss();
    var phone = lead.owner_phone_e164 || lead.owner_phone || lead.phone || '';
    var old = document.getElementById('hotLeadBanner'); if (old) old.remove();
    var el = document.createElement('div'); el.id = 'hotLeadBanner'; el.setAttribute('data-id', lead.id);
    el.innerHTML = '<div class="hl" style="margin-bottom:14px"><div class="hl-h"><i></i>Call now · ' + esc(ago(lead.hot_at)) + '</div>'
      + '<div class="hl-row"><span class="hl-who" style="font-size:14px">' + esc(lead.hot_reason || 'a human just reached out') + '<span class="hl-why">Open on what they did, never on the fact that you saw it. The script is below.</span></span>'
      + (phone ? '<button class="hl-btn q" data-act="call">Call in Quo</button>' : '') + '<button class="hl-btn g" data-act="done">Done</button></div></div>';
    el.onclick = function (ev) { var b = ev.target.closest('button[data-act]'); if (!b) return; if (b.getAttribute('data-act') === 'call') callInQuo(phone); else clear(lead.id); };
    host.insertAdjacentElement('afterbegin', el);
  }
  function start() { if (timer) return; refresh(); timer = setInterval(refresh, POLL_MS); document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1500); }); else setTimeout(start, 1500);
  global.HOT_LEADS = { refresh: refresh, banner: banner, mark: mark, clear: clear, callInQuo: callInQuo };
})(window);
