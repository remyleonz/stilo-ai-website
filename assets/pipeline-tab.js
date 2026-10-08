/**
 * assets/pipeline-tab.js
 *
 * The Pipeline sub-tab on the Leads page (shared by /sdr/ and /admin/):
 * three groups by engagement tier. Hot and Warm are listed one line per lead
 * (what they did, when, who on the team dialed them last, Call in Quo, Open,
 * tier switch); Cold is a count that points at the Cold Call tab.
 *
 * Replaces the red "Call now" strip and the purple "Video watchers" table
 * that used to sit at the top of My Leads (Remy, 2026-10-08: "they should all
 * be one category, the warm leads"). A live call-now signal still shows as a
 * red dot + "call now" pill on its row and floats to the top of its group.
 *
 * Data: GET /api/prospects/pipeline (rep-scoped server-side). Tier changes:
 * POST the same endpoint. Mount with
 *   PIPELINE_TAB.mount({ host, fetchJson, openLead, onColdClick })
 */
(function (global) {
  'use strict';
  var state = { host: null, fetchJson: null, openLead: null, onColdClick: null, data: null, timer: null };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(iso) { if (!iso) return ''; var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
  function rep(email) { var e = String(email || '').toLowerCase(); if (!e) return ''; if (e.indexOf('remyleon') === 0) return 'Remy'; if (e.indexOf('davidcoira') === 0) return 'David'; if (e.indexOf('aleb') === 0) return 'Ale'; if (e.indexOf('georgegutierrez') === 0) return 'George'; if (e.indexOf('ayesjorge') === 0) return 'Jorge'; return e.split('@')[0]; }
  var CSS = '.pt-g{margin:0 0 22px}.pt-h{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}.pt-h .n{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--text-secondary,#9a9ab0)}'
    + '.pt-hot .pt-h{color:#f87171}.pt-warm .pt-h{color:#fbbf24}.pt-cold .pt-h{color:#60a5fa}'
    + '.pt-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:6px;background:rgba(255,255,255,.02);flex-wrap:wrap}.pt-row.now{border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.06)}'
    + '.pt-ago{min-width:72px;font-size:11px;font-weight:700;color:var(--text-secondary,#9a9ab0)}.pt-row.now .pt-ago{color:#f87171}'
    + '.pt-who{flex:1;min-width:220px;font-size:13px;color:var(--text-primary,#ecedf2)}.pt-who b{font-weight:700}.pt-why{display:block;font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:2px}.pt-dial{display:block;font-size:11px;color:var(--text-tertiary,#7a7a90);margin-top:2px}'
    + '.pt-pill{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:999px;margin-left:6px;background:rgba(37,99,235,.15);color:#60a5fa}.pt-pill.now{background:rgba(239,68,68,.18);color:#f87171}.pt-pill.es{background:rgba(255,255,255,.08);color:var(--text-secondary,#9a9ab0)}'
    + '.pt-btn{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB}.pt-btn.g{background:rgba(255,255,255,.1);color:var(--text-primary,#ecedf2)}.pt-btn.q{background:#ef4444}'
    + '.pt-tier{display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:rgba(255,255,255,.06)}.pt-tier button{border:0;background:transparent;color:var(--text-secondary,#9a9ab0);font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;cursor:pointer;font-family:inherit}.pt-tier button.on.hot{background:rgba(239,68,68,.25);color:#f87171}.pt-tier button.on.warm{background:rgba(251,191,36,.22);color:#fbbf24}.pt-tier button.on.cold{background:rgba(96,165,250,.2);color:#60a5fa}'
    + '.pt-empty{font-size:12px;color:var(--text-secondary,#9a9ab0);padding:10px 12px;border:1px dashed rgba(255,255,255,.1);border-radius:10px}'
    + '.pt-cold .pt-row{cursor:pointer}';
  function ensureCss() { if (document.getElementById('pipelineTabCss')) return; var st = document.createElement('style'); st.id = 'pipelineTabCss'; st.textContent = CSS; document.head.appendChild(st); }
  function tierSwitch(id, cur) {
    return '<span class="pt-tier" data-id="' + id + '">' + ['hot', 'warm', 'cold'].map(function (t) { return '<button data-tier="' + t + '" class="' + t + (cur === t ? ' on' : '') + '">' + t + '</button>'; }).join('') + '</span>';
  }
  function row(r) {
    var lc = r.last_call;
    var dial = lc ? 'Last dialed by ' + esc(rep(lc.by) || 'us') + ' ' + esc(ago(lc.at)) + (lc.outcome ? ' · ' + esc(String(lc.outcome).replace(/_/g, ' ')) : '') + (lc.decision_maker ? ' · reached the decision maker' : '') : 'Nobody has dialed them yet';
    var why = r.call_now ? r.hot_reason : (r.tier_reason || r.hot_reason || '');
    return '<div class="pt-row' + (r.call_now ? ' now' : '') + '" data-id="' + r.id + '">'
      + '<span class="pt-ago">' + esc(ago(r.call_now ? r.hot_at : r.tier_at)) + '</span>'
      + '<span class="pt-who"><b>' + esc(r.business || 'lead ' + r.id) + '</b>' + (r.owner ? ' · ' + esc(r.owner) : '') + (r.city ? ' · ' + esc(r.city) : '')
      + (r.call_now ? '<span class="pt-pill now">call now</span>' : '') + (r.lang === 'es' ? '<span class="pt-pill es">ES</span>' : '') + (r.instagram ? '<span class="pt-pill es">IG</span>' : '')
      + '<span class="pt-why">' + esc(why || 'warm') + (r.phone ? ' · ' + esc(r.phone) : ' · no phone on file') + (r.next_step ? ' · next: ' + esc(r.next_step.slice(0, 80)) : '') + '</span>'
      + '<span class="pt-dial">' + dial + (r.assigned_to ? ' · ' + esc(rep(r.assigned_to)) + "'s lead" : '') + '</span></span>'
      + tierSwitch(r.id, r.tier)
      + (r.phone ? '<button class="pt-btn q" data-act="call">Call in Quo</button>' : '')
      + '<button class="pt-btn" data-act="open">Open + script</button>'
      + '</div>';
  }
  function render() {
    ensureCss();
    var h = document.getElementById(state.host); if (!h) return;
    var d = state.data;
    if (!d) { h.innerHTML = '<div class="pt-empty">Loading pipeline…</div>'; return; }
    h.innerHTML = '<div class="pt-g pt-hot"><div class="pt-h">Hot <span class="n">' + d.counts.hot + '</span><span style="font-weight:500;letter-spacing:0;text-transform:none;font-size:11px;color:var(--text-secondary)">you set these by hand: a real conversation, a number, a visit on the calendar</span></div>'
      + (d.hot.length ? d.hot.map(row).join('') : '<div class="pt-empty">Nobody hot yet. Open a warm lead and flip it when the conversation is real.</div>') + '</div>'
      + '<div class="pt-g pt-warm"><div class="pt-h">Warm <span class="n">' + d.counts.warm + '</span><span style="font-weight:500;letter-spacing:0;text-transform:none;font-size:11px;color:var(--text-secondary)">they did something: watched the video, texted back, answered a DM, called and missed, put a decision maker on the phone</span></div>'
      + (d.warm.length ? d.warm.map(row).join('') : '<div class="pt-empty">No warm leads yet. Every reply, video play and DM answer lands here on its own.</div>') + '</div>'
      + '<div class="pt-g pt-cold"><div class="pt-h">Cold <span class="n">' + d.counts.cold + '</span></div><div class="pt-row" data-act="cold"><span class="pt-who">' + d.counts.cold + ' leads nobody has reached yet. They live on the Cold Call tab and in the dialer.</span><button class="pt-btn g" data-act="cold">Open Cold Call</button></div></div>';
    h.onclick = function (ev) {
      var tb = ev.target.closest('.pt-tier button');
      if (tb) { setTier(parseInt(tb.closest('.pt-tier').getAttribute('data-id'), 10), tb.getAttribute('data-tier')); return; }
      var b = ev.target.closest('[data-act]'); if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'cold') { if (state.onColdClick) state.onColdClick(); return; }
      var rowEl = b.closest('.pt-row'); var id = parseInt(rowEl.getAttribute('data-id'), 10);
      var r = (d.hot.concat(d.warm)).filter(function (x) { return x.id === id; })[0]; if (!r) return;
      if (act === 'call') { if (global.HOT_LEADS) HOT_LEADS.callInQuo(r.phone); }
      else if (act === 'open') { if (state.openLead) state.openLead(id); }
    };
  }
  async function refresh() {
    if (!state.fetchJson || !document.getElementById(state.host)) return;
    try { state.data = await state.fetchJson('/api/prospects/pipeline'); render(); }
    catch (e) { var h = document.getElementById(state.host); if (h && !state.data) h.innerHTML = '<div class="pt-empty">Could not load the pipeline: ' + esc(e.message || e) + '</div>'; }
  }
  async function setTier(id, tier) {
    if (!state.fetchJson) return;
    try { await state.fetchJson('/api/prospects/pipeline', { method: 'POST', body: JSON.stringify({ lead_id: id, tier: tier }) }); } catch (e) { alert('Could not change the tier: ' + (e.message || e)); return; }
    if (global.LEAD_TIER && LEAD_TIER.sync) LEAD_TIER.sync(id, tier);
    refresh();
  }
  function mount(o) {
    state.host = o.host; state.fetchJson = o.fetchJson; state.openLead = o.openLead; state.onColdClick = o.onColdClick;
    render(); refresh();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { if (!document.hidden && document.getElementById(state.host) && document.getElementById(state.host).offsetParent) refresh(); }, 60000);
  }
  global.PIPELINE_TAB = { mount: mount, refresh: refresh, setTier: setTier, rows: function () { return state.data ? state.data.hot.concat(state.data.warm) : []; } };
})(window);
