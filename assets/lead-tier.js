/**
 * assets/lead-tier.js
 *
 * Two things every lead drawer needs once leads have a temperature
 * (shared by /sdr/ and /admin/):
 *
 *   LEAD_TIER.render(lead)  -> the Cold / Warm / Hot switch, the reason the
 *                              lead is warm, and who on the team dialed it
 *                              last (any rep) so nobody double-calls.
 *   LEAD_TIER.script(lead)  -> the WARM script: what to say to someone who
 *                              already did something (watched the video,
 *                              texted back, answered a DM, missed a call,
 *                              replied to an email). Rendered above the cold
 *                              script; empty string for a cold lead.
 *
 * Writes go to POST /api/prospects/pipeline. The lead object is the
 * /api/prospects/detail row (engagement_tier, hot_reason, call_history...).
 */
(function (global) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(iso) { if (!iso) return ''; var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
  function rep(email) { var e = String(email || '').toLowerCase(); if (!e) return ''; if (e.indexOf('remyleon') === 0) return 'Remy'; if (e.indexOf('davidcoira') === 0) return 'David'; if (e.indexOf('aleb') === 0) return 'Ale'; if (e.indexOf('georgegutierrez') === 0) return 'George'; if (e.indexOf('ayesjorge') === 0) return 'Jorge'; return e.split('@')[0]; }
  function fetcher() { return global.fetchJSON || global.prospectFetchJSON || null; }
  var CSS = '.lt{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.02)}.lt-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}'
    + '.lt-sw{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:rgba(255,255,255,.06)}.lt-sw button{border:0;background:transparent;color:var(--text-secondary,#9a9ab0);font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:6px 14px;border-radius:999px;cursor:pointer;font-family:inherit}.lt-sw button.on.hot{background:rgba(239,68,68,.25);color:#f87171}.lt-sw button.on.warm{background:rgba(251,191,36,.22);color:#fbbf24}.lt-sw button.on.cold{background:rgba(96,165,250,.2);color:#60a5fa}'
    + '.lt-clock{display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;border-radius:8px;font-size:13px;color:var(--text-primary,#ecedf2)}.lt-clock b{font-weight:800}.lt-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}'
    + '.lt-clock.wait{background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.4)}.lt-clock.wait .lt-dot{background:#fbbf24;animation:ltBlink 1.4s ease-in-out infinite}'
    + '.lt-clock.late{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.45)}.lt-clock.late .lt-dot{background:#ef4444;animation:ltBlink 1s ease-in-out infinite}'
    + '.lt-clock.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.45)}.lt-clock.ok .lt-dot{background:#22c55e}@keyframes ltBlink{50%{opacity:.25}}'
    + '.lt-why{font-size:12px;color:var(--text-secondary,#9a9ab0);line-height:1.5}.lt-dial{font-size:12px;color:var(--text-primary,#ecedf2);margin-top:6px}.lt-dial b{color:#fbbf24}'
    + '.ws{margin:0 0 16px;padding:14px 16px;border:1px solid rgba(251,191,36,.4);border-left:3px solid #fbbf24;border-radius:10px;background:rgba(251,191,36,.06)}.ws-h{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#fbbf24;margin-bottom:8px}.ws p{margin:0 0 8px;font-size:14px;line-height:1.6;color:var(--text-primary,#ecedf2)}.ws .say{display:block;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,.05);margin:4px 0 10px}.ws .lbl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);display:block;margin-bottom:2px}';
  function ensureCss() { if (document.getElementById('leadTierCss')) return; var st = document.createElement('style'); st.id = 'leadTierCss'; st.textContent = CSS; document.head.appendChild(st); }
  function lastCall(lead) {
    var calls = (lead.call_history || []).filter(function (c) { return c.direction !== 'inbound'; });
    calls.sort(function (a, b) { return String(b.called_at) > String(a.called_at) ? 1 : -1; });
    return calls[0] || null;
  }
  /**
   * The alert clock. Starts when the warm-lead text went out (hot_alert_sent_at,
   * or hot_at when no text was needed), counts the minutes nobody has called,
   * and turns green with who called and how long after. Ticks every 30s.
   *   timerHtml({ alert_at, hot_at, cleared, firstCallAfter: {by, at} })
   */
  function minsBetween(a, b) { return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)); }
  function fmtMin(m) { if (m < 90) return m + ' min'; var h = Math.round(m / 60); if (h < 36) return h + 'h'; return Math.round(h / 24) + 'd'; }
  function timerHtml(o) {
    var at = o.alert_at || o.hot_at; if (!at || o.cleared) return '';
    if (Date.now() - new Date(at).getTime() > 72 * 3600 * 1000 && !o.firstCallAfter) return '';
    if (o.firstCallAfter) {
      var m = minsBetween(at, o.firstCallAfter.at);
      return '<div class="lt-clock ok"><span class="lt-dot"></span><b>Called</b> by ' + esc(rep(o.firstCallAfter.by) || 'the team') + ' ' + (m < 1 ? 'under a minute' : fmtMin(m)) + ' after the alert' + (o.firstCallAfter.outcome ? ' · ' + esc(String(o.firstCallAfter.outcome).replace(/_/g, ' ')) : '') + '</div>';
    }
    var m0 = minsBetween(at, Date.now());
    return '<div class="lt-clock ' + (m0 >= 5 ? 'late' : 'wait') + '" data-since="' + esc(at) + '"><span class="lt-dot"></span><b class="lt-min">' + fmtMin(m0) + '</b> since the alert, nobody has called yet' + (o.escalated_at ? ' · second text sent' : '') + '</div>';
  }
  function tick() {
    document.querySelectorAll('.lt-clock[data-since]').forEach(function (el) {
      var m = minsBetween(el.getAttribute('data-since'), Date.now());
      var b = el.querySelector('.lt-min'); if (b) b.textContent = fmtMin(m);
      el.classList.toggle('late', m >= 5); el.classList.toggle('wait', m < 5);
    });
  }
  setInterval(tick, 30000);
  function firstCallAfter(lead, at) {
    var calls = (lead.call_history || []).filter(function (c) { return c.direction !== 'inbound' && c.called_at && at && c.called_at > at; });
    calls.sort(function (a, b) { return String(a.called_at) > String(b.called_at) ? 1 : -1; });
    return calls[0] ? { by: calls[0].logged_by, at: calls[0].called_at, outcome: calls[0].outcome } : null;
  }
  function render(lead) {
    ensureCss();
    var tier = lead.engagement_tier || 'cold';
    var lc = lastCall(lead);
    var alertAt = lead.hot_alert_sent_at || lead.hot_at;
    var clock = timerHtml({ alert_at: lead.hot_alert_sent_at, hot_at: lead.hot_at, cleared: !!lead.hot_cleared_at, escalated_at: lead.hot_escalated_at, firstCallAfter: firstCallAfter(lead, alertAt) });
    var dial = lc ? '<b>' + esc(rep(lc.logged_by) || 'Someone on the team') + '</b> dialed this lead ' + esc(ago(lc.called_at)) + (lc.outcome ? ' · ' + esc(String(lc.outcome).replace(/_/g, ' ')) : '') + '. Read their notes before you call again.' : 'Nobody on the team has dialed this lead yet.';
    var why = tier !== 'cold' ? (lead.hot_reason && lead.hot_at && !lead.hot_cleared_at ? lead.hot_reason : (lead.engagement_tier_reason || '')) : '';
    return '<div class="lt" id="leadTierBox" data-id="' + lead.id + '"><div class="lt-row">'
      + '<span class="lt-sw">' + ['cold', 'warm', 'hot'].map(function (t) { return '<button type="button" data-tier="' + t + '" class="' + t + (tier === t ? ' on' : '') + '" onclick="LEAD_TIER.set(' + lead.id + ',\'' + t + '\')">' + t + '</button>'; }).join('') + '</span>'
      + '<span class="lt-why">' + (why ? esc(why) + (lead.engagement_tier_at ? ' · ' + esc(ago(lead.engagement_tier_at)) : '') : (tier === 'cold' ? 'Cold: nobody has heard back from them yet. Flip it the moment the conversation is real.' : '')) + '</span>'
      + '</div>' + clock + '<div class="lt-dial">' + dial + '</div></div>';
  }
  async function set(id, tier) {
    var f = fetcher(); if (!f) return;
    try { await f('/api/prospects/pipeline', { method: 'POST', body: JSON.stringify({ lead_id: id, tier: tier }) }); } catch (e) { alert('Could not change the tier: ' + (e.message || e)); return; }
    sync(id, tier);
    if (global.PIPELINE_TAB) PIPELINE_TAB.refresh();
    if (global.HOT_LEADS && tier === 'cold') HOT_LEADS.refresh();
  }
  function sync(id, tier) {
    var box = document.getElementById('leadTierBox'); if (!box || parseInt(box.getAttribute('data-id'), 10) !== id) return;
    box.querySelectorAll('.lt-sw button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tier') === tier); });
    if (global.CURRENT && CURRENT.lead && CURRENT.lead.id === id) CURRENT.lead.engagement_tier = tier;
    if (global.__lastProspectData && __lastProspectData.id === id) __lastProspectData.engagement_tier = tier;
  }
  /** Which signal is it? Drives the opener. */
  function kind(reason) {
    var r = String(reason || '').toLowerCase();
    if (/instagram|dm\b/.test(r)) return 'ig';
    if (/watched|video|play|opened the video|quiz/.test(r)) return 'video';
    if (/texted|text back|sms|replied.*text/.test(r)) return 'sms';
    if (/missed|called you/.test(r)) return 'missed';
    if (/email/.test(r)) return 'email';
    if (/decision maker/.test(r)) return 'dm_reached';
    if (/call back|booked/.test(r)) return 'callback';
    return 'other';
  }
  function script(lead) {
    var tier = lead.engagement_tier || 'cold';
    if (tier === 'cold') return '';
    ensureCss();
    var es = (lead.primary_language === 'es');
    var reason = (lead.hot_at && !lead.hot_cleared_at && lead.hot_reason) ? lead.hot_reason : (lead.engagement_tier_reason || '');
    var k = kind(reason);
    var first = String(lead.owner_name || '').trim().split(/\s+/)[0];
    var hi = es ? (first ? 'Hola ' + first + ', ' : 'Hola, ') : (first ? 'Hey ' + first + ', ' : 'Hey, ');
    var open = {
      video: es ? hi + 'habla {rep} de Blason. Vio el video de pagar dos veces por la máquina, ¿qué fue lo que más le llamó la atención?' : hi + "it's {rep} with Blason. You watched the pay-twice video, what jumped out at you?",
      ig: es ? hi + 'habla {rep} de Blason, nos escribimos por Instagram. ¿Tiene dos minutos?' : hi + "it's {rep} with Blason, we were texting on Instagram. Got two minutes?",
      sms: es ? hi + 'habla {rep} de Blason, me respondió el mensaje. ¿Tiene dos minutos?' : hi + "it's {rep} with Blason, you texted me back. Got two minutes?",
      missed: es ? hi + 'habla {rep} de Blason, me llamó hace un momento. ¿En qué le ayudo?' : hi + "it's {rep} with Blason, you called me a little while ago. What can I help with?",
      email: es ? hi + 'habla {rep} de Blason, me respondió el correo. ¿Tiene dos minutos?' : hi + "it's {rep} with Blason, you replied to my email. Got two minutes?",
      dm_reached: es ? hi + 'habla {rep} de Blason, hablamos hace unos días. Le prometí llamarlo.' : hi + "it's {rep} with Blason, we spoke a few days ago. I said I'd call you back.",
      callback: es ? hi + 'habla {rep} de Blason, me pidió que lo llamara hoy.' : hi + "it's {rep} with Blason, you asked me to call you today.",
      other: es ? hi + 'habla {rep} de Blason. ¿Tiene dos minutos?' : hi + "it's {rep} with Blason. Got two minutes?"
    }[k];
    var repName = (global.CURRENT && CURRENT.sdr && CURRENT.sdr.display_name) ? CURRENT.sdr.display_name.split(/\s+/)[0] : (global.ADMIN_FIRST_NAME || 'Remy');
    open = open.replace('{rep}', repName);
    var why = reason ? '<p class="lt-why">' + esc(reason) + '</p>' : '';
    var S = es ? {
      t: 'Lead caliente: cómo abrir y cerrar', q: 'La pregunta', qs: 'Si el logo no fuera un problema, ¿qué máquina agregaría primero? ¿Y cuáles son los clientes más difíciles de tratar con la que tiene ahora?',
      n: 'Su número', ns: 'Dos cosas: ¿cuántos clientes al mes trataría con esa máquina? ¿Y qué vale uno de esos clientes para usted en un año?',
      c: 'El cierre', cs: 'Manuel, el dueño, hace llamadas de 10 minutos y le dice de frente qué le conviene. ¿Martes a las 11 o jueves a las 2?',
      sf: 'Si está en el sur de la Florida: "Tenemos las máquinas encendidas en el showroom en Miami, venga a probarla. ¿Martes o jueves?"',
      r: 'Nunca un precio. Si pregunta cuánto cuesta: "depende de cuántos clientes al mes y de lo que vale uno para usted en un año, ¿cuál es el segundo número?"'
    } : {
      t: 'Warm lead: how to open and close', q: 'The question', qs: "If the logo wasn't in the way, which machine would you add first? And which clients are the hardest to treat with the one you have now?",
      n: 'Their number', ns: 'Two things: how many clients a month would that machine treat? And what is one of those clients worth to you in a year?',
      c: 'The close', cs: "Manuel, the owner, does 10-minute calls and tells you straight what fits. Tuesday at 11 or Thursday at 2?",
      sf: 'South Florida instead: "The machines are running at the showroom in Miami, come try it. Tuesday or Thursday?"',
      r: 'Never a price. If they ask what it costs: "depends on how many clients a month and what one is worth to you in a year, what is the second number?"'
    };
    return '<div class="ws"><div class="ws-h">' + S.t + '</div>' + why
      + '<span class="lbl">' + (es ? 'Abrir con lo que hicieron, nunca con que usted lo vio' : 'Open on what they did, never on the fact that you saw it') + '</span><span class="say">' + esc(open) + '</span>'
      + '<span class="lbl">' + S.q + '</span><span class="say">' + esc(S.qs) + '</span>'
      + '<span class="lbl">' + S.n + '</span><span class="say">' + esc(S.ns) + '</span>'
      + '<span class="lbl">' + S.c + '</span><span class="say">' + esc(S.cs) + '</span>'
      + '<p class="lt-why">' + esc(S.sf) + '</p><p class="lt-why">' + esc(S.r) + '</p></div>';
  }
  global.LEAD_TIER = { render: render, set: set, sync: sync, script: script, kind: kind, timerHtml: timerHtml, tick: tick };
})(window);
