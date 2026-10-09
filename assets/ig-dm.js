/**
 * assets/ig-dm.js
 *
 * The Instagram DM worklist, shared by /sdr/ (Instagram tab) and /admin/
 * (Outbound tab). It is the spreadsheet we used to email every week, in the
 * dashboard, with tracking: one row per handle, the message to send, Copy,
 * Open profile, Sent, then the follow-ups, Replied (with what they said),
 * Booked, Not interested, Bot. A reply flips the lead to Warm on the
 * Pipeline tab through the API.
 *
 * Click a row to see the whole sequence and the objection answers for that
 * lead (the IG DM Playbook, 2026-10-08). Data: /api/prospects/ig-dm.
 *
 *   IG_DM.mount({ host, fetchJson, openLead, admin })
 */
(function (global) {
  'use strict';
  function create() {
  var S = { host: null, fetchJson: null, openLead: null, admin: false, tab: 'queued', data: null, open: null, rep: '', channel: 'instagram' };
  function isFb() { return S.channel === 'facebook'; }
  function openLabel() { return isFb() ? 'Open page ↗' : 'Open profile ↗'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(iso) { if (!iso) return ''; var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
  function rep(email) { var e = String(email || '').toLowerCase(); if (!e || e === 'unassigned') return 'unassigned'; if (e.indexOf('remyleon') === 0) return 'Remy'; if (e.indexOf('davidcoira') === 0) return 'David'; if (e.indexOf('aleb') === 0) return 'Ale'; if (e.indexOf('georgegutierrez') === 0) return 'George'; if (e.indexOf('ayesjorge') === 0) return 'Jorge'; return e.split('@')[0]; }
  var CSS = '.ig-top{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px}.ig-stat{flex:1;min-width:120px;padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)}.ig-stat .l{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0)}.ig-stat .v{font-size:24px;font-weight:800;margin-top:4px}'
    + '.ig-tabs{display:flex;gap:4px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:12px}.ig-tabs button{padding:9px 14px;background:none;border:0;border-bottom:3px solid transparent;color:var(--text-primary,#ecedf2);font-size:13px;font-weight:600;cursor:pointer;opacity:.55;font-family:inherit}.ig-tabs button.on{opacity:1;border-bottom-color:#2563EB}'
    + '.ig-row{border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:6px;background:rgba(255,255,255,.02)}.ig-row.open{border-color:rgba(37,99,235,.5)}.ig-main{display:flex;align-items:center;gap:12px;padding:10px 12px;flex-wrap:wrap;cursor:pointer}'
    + '.ig-n{min-width:26px;font-size:11px;font-weight:700;color:var(--text-tertiary,#7a7a90)}.ig-who{flex:1;min-width:200px;font-size:13px}.ig-who b{font-weight:700}.ig-sub{display:block;font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:2px;white-space:pre-wrap}'
    + '.ig-pill{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:999px;margin-left:6px;background:rgba(255,255,255,.08);color:var(--text-secondary,#9a9ab0)}.ig-pill.a{background:rgba(37,99,235,.15);color:#60a5fa}.ig-pill.b{background:rgba(139,92,246,.18);color:#c4b5fd}.ig-pill.r{background:rgba(251,191,36,.2);color:#fbbf24}.ig-pill.ok{background:rgba(34,197,94,.15);color:#4ade80}'
    + '.ig-btn{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB;white-space:nowrap}.ig-btn.g{background:rgba(255,255,255,.1);color:var(--text-primary,#ecedf2)}.ig-btn.ok{background:#16a34a}.ig-btn.w{background:#b45309}.ig-btn.r{background:#b91c1c}'
    + '.ig-det{padding:4px 14px 14px;border-top:1px solid rgba(255,255,255,.06)}.ig-det .lbl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);margin:12px 0 4px}.ig-say{display:flex;gap:10px;align-items:flex-start}.ig-say pre{flex:1;margin:0;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.05);font:inherit;font-size:13px;line-height:1.5;white-space:pre-wrap;color:var(--text-primary,#ecedf2)}'
    + '.ig-obj{font-size:12px;line-height:1.55;color:var(--text-secondary,#9a9ab0)}.ig-obj b{color:var(--text-primary,#ecedf2);font-weight:700}.ig-obj div{margin:0 0 6px}'
    + '.ig-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}.ig-form input,.ig-form select{padding:8px 10px;background:var(--bg-input,#0f1117);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:inherit;font:inherit;font-size:13px}.ig-form input{flex:1;min-width:220px}'
    + '.ig-empty{font-size:12px;color:var(--text-secondary,#9a9ab0);padding:12px;border:1px dashed rgba(255,255,255,.1);border-radius:10px}'
    + '.ig-reps table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px}.ig-reps th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}.ig-reps td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05)}';
  function ensureCss() { if (document.getElementById('igDmCss')) return; var st = document.createElement('style'); st.id = 'igDmCss'; st.textContent = CSS; document.head.appendChild(st); }
  function copy(text, btn) {
    var done = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    else { fallback(text); done(); }
  }
  function fallback(text) { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); }

  /** The sequence after message one, per language. {link} is the row's tracked video link. */
  function seq(r) {
    var es = r.lang === 'es', link = r.vsl_link || 'https://blasononline.stiloaipartners.com?utm_source=instagram';
    var m2 = r.message_2 || (es
      ? 'una rápida, la mayoría de las clínicas en Miami pagaron dos veces por su láser, una por la máquina y otra por el logo, yo le digo el error de $80,000. 4 min de cómo evitarlo: ' + link
      : 'quick one, most clinics in Miami paid twice for their laser, once for the machine and once for the logo, I call it the $80,000 mistake. 4 min on how to skip it: ' + link);
    var m3 = es ? 'si el logo no fuera un problema, ¿qué máquina agregaría primero?' : "if the logo wasn't in the way, which machine would you add next?";
    var close = es ? 'Manuel, el dueño, hace llamadas de 10 minutos con clínicas y le dice de frente qué le conviene. ¿Martes a las 11 o jueves a las 2?' : 'Manuel, the owner, does 10-minute calls with clinics and tells you straight what fits and what doesn\'t. Tuesday 11 or Thursday 2?';
    var sfl = es ? 'tenemos las máquinas encendidas en el showroom en Miami, venga a probarla. ¿martes o jueves?' : 'we have the machines running in the showroom in Miami, come try it. Tuesday or Thursday?';
    var bump1 = es ? '¿le cargó el video?' : 'did the video load for you?';
    var bump2 = es ? 'la última de mi parte, ¿cuál es la máquina más vieja que tienen ahora?' : "last one from me, what's the oldest machine in the clinic right now?";
    var obj = es ? [
      ['"Estamos contentos con lo que tenemos"', 'la mayoría de las clínicas que nos compran también estaban contentas. ¿cuál es el tratamiento que las clientas le piden y manda a otro lado?'],
      ['"Solo usamos Candela / Cynosure"', 'ese es el impuesto del logo del que hablo. si viera la misma máquina sin el logo lado a lado, ¿le daría 4 minutos? ' + link],
      ['"No me interesa"', 'no hay problema. ¿es el momento o el presupuesto? si es el presupuesto, de eso trata el video.'],
      ['"Mándeme info por correo"', 'claro, ¿cuál es el mejor correo? ¿y quién decide los equipos ahí, usted o el doctor?'],
      ['"¿Cuánto cuesta?"', 'depende de dos cosas, ¿cuántos clientes al mes lo usarían y qué vale uno de esos clientes para usted en un año? ¿cuál es el segundo número?'],
      ['"Lo decide el doctor" / recepción', 'perfecto, ¿cómo se llama el doctor? le mando el video de 4 minutos para que lo vea en el carro. ' + link],
      ['Respuesta automática / bot', 'no busco una cita, vendo los equipos. ¿quién decide las compras de equipos y cuál es su línea directa?'],
      ['"Acabamos de comprar una nueva"', 'felicidades, ¿cuál? ¿y cuál es la siguiente en la lista? siempre hay una siguiente.']
    ] : [
      ['"We\'re happy with our devices" / "we have everything"', 'most clinics we sell to were happy too. what\'s the one treatment clients ask for that you send somewhere else?'],
      ['"We only use Cynosure / Candela / InMode"', 'that\'s the logo tax I\'m talking about. if you saw the same machine without the logo side by side, would you look for 4 minutes? ' + link],
      ['"Not interested"', 'no problem. is it the timing or the budget? if it\'s the budget, that\'s exactly what the video is about.'],
      ['"Send me info" / "email it"', 'sure, what\'s the best email? and who makes the equipment calls there, you or the doctor?'],
      ['"What does it cost?"', 'depends on two things, how many clients a month would it treat, and what\'s one of those clients worth to you in a year? what\'s the second number?'],
      ['"The doctor decides" / front desk', 'perfect, what\'s the doctor\'s name? I\'ll send the 4-minute video so they can watch it in the car. ' + link],
      ['Auto-reply / bot', 'I\'m not booking a treatment, I sell the equipment. who handles equipment decisions, and what\'s their direct line?'],
      ['"We just bought a new one"', 'congrats, which one? and what\'s the next one on the list, there\'s always a next one.']
    ];
    return { m2: m2, m3: m3, close: close, sfl: sfl, bump1: bump1, bump2: bump2, obj: obj };
  }
  function say(label, text, key) { return '<div class="lbl">' + esc(label) + '</div><div class="ig-say"><pre>' + esc(text) + '</pre><button class="ig-btn g" data-copy="' + esc(key) + '">Copy</button></div>'; }
  function detail(r) {
    var q = seq(r);
    var html = '<div class="ig-det">';
    html += '<div class="lbl" style="display:flex;align-items:center;gap:10px">' + (r.lang === 'es' ? 'Idioma de este lead' : 'Language for this lead')
      + '<span class="pt-tier" style="display:inline-flex;gap:2px;padding:2px;border-radius:999px;background:rgba(255,255,255,.06)">'
      + '<button class="ig-btn g" style="padding:3px 10px;font-size:11px;' + (r.lang !== 'es' ? 'background:#2563EB;color:#fff' : '') + '" data-lang="en">English</button>'
      + '<button class="ig-btn g" style="padding:3px 10px;font-size:11px;' + (r.lang === 'es' ? 'background:#2563EB;color:#fff' : '') + '" data-lang="es">Español</button></span></div>';
    html += say(r.lang === 'es' ? 'Mensaje 1 (sin link)' : 'Message 1 (no link in the first DM)', r.message_1, 'm1');
    html += say(r.lang === 'es' ? 'Mensaje 2, cuando contesten (lleva el video)' : 'Message 2, when they answer anything (carries the video)', q.m2, 'm2');
    html += say(r.lang === 'es' ? 'Mensaje 3, después del video o 24h de silencio' : 'Message 3, after the video or 24h of silence', q.m3, 'm3');
    html += say(r.lang === 'es' ? 'El cierre (10 min por teléfono con Manuel, nunca video)' : 'The close (10-minute phone call with Manuel, never video)', q.close, 'close');
    html += say(r.lang === 'es' ? 'Si está en el sur de la Florida: showroom' : 'South Florida: showroom instead', q.sfl, 'sfl');
    html += say(r.lang === 'es' ? 'Silencio 24h' : 'Silence, 24h later', q.bump1, 'bump1');
    html += say(r.lang === 'es' ? 'Silencio 48h más' : 'Silence, 48h after that', q.bump2, 'bump2');
    html += '<div class="lbl">' + (r.lang === 'es' ? 'Objeciones: tres palabras y UNA pregunta. Nunca "ok gracias".' : 'Objections: three words, then ONE question back. Never "okay, thank you".') + '</div><div class="ig-obj">'
      + q.obj.map(function (o, i) { return '<div><b>' + esc(o[0]) + '</b><br>' + esc(o[1]) + ' <button class="ig-btn g" style="padding:3px 8px;font-size:11px" data-copy="obj' + i + '">Copy</button></div>'; }).join('') + '</div>';
    if (r.reply_text) html += '<div class="lbl">' + (r.lang === 'es' ? 'Lo que respondieron' : 'What they said') + '</div><div class="ig-obj">' + esc(r.reply_text) + (r.reply_kind ? ' <span class="ig-pill r">' + esc(r.reply_kind.replace(/_/g, ' ')) + '</span>' : '') + '</div>';
    html += '<div class="lbl">' + (r.lang === 'es' ? 'Registrar' : 'Log it') + '</div>'
      + '<div class="ig-form"><input data-f="reply" placeholder="' + (r.lang === 'es' ? 'qué respondieron, o una nota' : 'what they replied, or a note') + '">'
      + '<select data-f="kind"><option value="named_laser">named their laser</option><option value="wants_info">wants info / email</option><option value="wants_call">wants a call</option><option value="wants_visit">wants to visit</option><option value="bot_or_desk">bot or front desk</option><option value="not_interested">not interested</option><option value="other" selected>other</option></select>'
      + '<button class="ig-btn g" data-act="note" title="Saves to this lead\'s notes without changing the status">Save note</button><button class="ig-btn w" data-act="replied">Replied</button><button class="ig-btn ok" data-act="booked">Booked</button><button class="ig-btn g" data-act="bot">Bot / desk</button><button class="ig-btn r" data-act="not_interested">Not interested (2 hard no\'s)</button>'
      + '<button class="ig-btn g" data-act="bad_account" title="The profile does not exist, or it is not this business">' + (isFb() ? 'No page / wrong page' : 'No account / wrong account') + '</button>'
      + (r.status !== 'queued' ? '<button class="ig-btn g" data-act="requeue">Back to queue</button>' : '<button class="ig-btn g" data-act="skip">Skip</button>')
      + (r.lead_id && S.openLead ? '<button class="ig-btn g" data-act="openlead">Open lead</button>' : '') + '</div>';
    return html + '</div>';
  }
  function row(r, i) {
    var isOpen = S.open === r.id;
    var st = r.status === 'queued' ? '' : '<span class="ig-pill ' + (r.status === 'replied' || r.status === 'booked' ? 'ok' : '') + '">' + esc(r.status === 'sent' ? 'step ' + (r.step || 1) + ' sent ' + ago(r.last_step_at || r.sent_at) : r.status.replace(/_/g, ' ') + (r.replied_at ? ' ' + ago(r.replied_at) : '')) + '</span>';
    var next = r.status === 'queued' ? r.message_1 : (r.status === 'sent' ? ((r.step || 1) < 2 ? seq(r).m2 : seq(r).m3) : (r.status === 'replied' ? seq(r).m2 : ''));
    var btns = '';
    if (r.status === 'queued') btns = '<button class="ig-btn g" data-copy="m1">Copy message</button><a class="ig-btn" href="' + esc(r.instagram_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + openLabel() + '</a><button class="ig-btn ok" data-act="sent">Sent</button>';
    else if (r.status === 'sent') btns = '<button class="ig-btn g" data-copy="next">Copy next</button><a class="ig-btn" href="' + esc(r.instagram_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a>' + ((r.step || 1) < 3 ? '<button class="ig-btn ok" data-act="step">Next sent</button>' : '') + '<button class="ig-btn w" data-act="toggle">Replied…</button>';
    else if (r.status === 'replied') btns = '<button class="ig-btn g" data-copy="m2">Copy video msg</button><a class="ig-btn" href="' + esc(r.instagram_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a><button class="ig-btn ok" data-act="toggle">Log…</button>';
    else btns = '<a class="ig-btn g" href="' + esc(r.instagram_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open ↗</a>';
    return '<div class="ig-row' + (isOpen ? ' open' : '') + '" data-id="' + r.id + '"><div class="ig-main" data-act="toggle">'
      + '<span class="ig-n">' + (i + 1) + '</span>'
      + '<span class="ig-who"><b>' + esc(r.business || r.handle) + '</b> · ' + esc(r.handle) + (r.city ? ' · ' + esc(r.city) : '') + (r.first_name ? ' · ' + esc(r.first_name) : '')
      + '<span class="ig-pill ' + (r.arm === 'B' ? 'b' : 'a') + '">arm ' + esc(r.arm || 'A') + '</span>' + (r.lang === 'es' ? '<span class="ig-pill">ES</span>' : '') + (S.admin && r.assigned_to ? '<span class="ig-pill">' + esc(rep(r.assigned_to)) + '</span>' : '') + st
      + '<span class="ig-sub">' + esc(r.status === 'replied' || r.status === 'booked' ? (r.reply_text || '') : next) + '</span></span>'
      + btns + '</div>' + (isOpen ? detail(r) : '') + '</div>';
  }
  // The search box lives OUTSIDE the re-rendered body so typing keeps focus.
  function shell() {
    var root = document.getElementById(S.host); if (!root) return null;
    var body = root.querySelector(':scope > .ig-body');
    if (!body) {
      root.innerHTML = '<div class="ig-search" style="display:flex;gap:8px;align-items:center;margin:0 0 12px">'
        + '<input type="search" class="ig-q" placeholder="Search ' + (isFb() ? 'Facebook' : 'Instagram') + ' leads: business, @handle, owner, city" autocomplete="off" style="flex:1;min-width:0;padding:10px 14px;background:var(--bg-input,#0f1117);border:1px solid rgba(255,255,255,.15);border-radius:999px;color:inherit;font:inherit;font-size:14px">'
        + '<span class="ig-q-hint" style="font-size:12px;color:var(--text-secondary,#9a9ab0);white-space:nowrap"></span></div><div class="ig-body"></div>';
      body = root.querySelector(':scope > .ig-body');
      var inp = root.querySelector('.ig-q'); var tmr = null;
      inp.value = S.q || '';
      inp.addEventListener('input', function () { clearTimeout(tmr); tmr = setTimeout(function () { S.q = inp.value.trim(); S.open = null; refresh(); }, 300); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; S.q = ''; refresh(); } });
    }
    var hint = root.querySelector('.ig-q-hint'); if (hint) hint.textContent = S.q ? 'searching every status' : '';
    return body;
  }
  function render() {
    ensureCss();
    var h = shell(); if (!h) return;
    var d = S.data;
    if (!d) { h.innerHTML = '<div class="ig-empty">Loading the Instagram list…</div>'; return; }
    var c = d.counts || {};
    var html = '<div class="ig-top">'
      + '<div class="ig-stat"><div class="l">To send</div><div class="v">' + (c.queued || 0) + '</div></div>'
      + '<div class="ig-stat"><div class="l">Sent today</div><div class="v">' + (c.sent_today || 0) + '<span style="font-size:12px;color:var(--text-secondary);font-weight:600"> / 50</span></div></div>'
      + '<div class="ig-stat"><div class="l">Replies</div><div class="v">' + (c.replied || 0) + (c.replied_today ? '<span style="font-size:12px;color:#4ade80;font-weight:600"> +' + c.replied_today + ' today</span>' : '') + '</div></div>'
      + '<div class="ig-stat"><div class="l">Booked</div><div class="v">' + (c.booked || 0) + '</div></div>'
      + '<div class="ig-stat"><div class="l">Reply rate</div><div class="v">' + (c.sent_total ? Math.round(100 * (c.replied || 0) / c.sent_total) + '%' : '—') + '</div></div></div>';
    if (S.admin && d.reps) {
      html += '<div class="ig-reps"><table><thead><tr><th>Rep</th><th>To send</th><th>Sent today</th><th>Replies</th><th>Booked</th><th></th></tr></thead><tbody>'
        + d.reps.map(function (r) { return '<tr><td><b>' + esc(rep(r.email)) + '</b></td><td>' + r.queued + '</td><td>' + r.sent_today + '</td><td>' + r.replied + '</td><td>' + r.booked + '</td><td>' + (r.email !== 'unassigned' ? '<button class="ig-btn g" style="padding:4px 9px;font-size:11px" data-assign="' + esc(r.email) + '">+50 from the pool</button>' : '') + '</td></tr>'; }).join('')
        + '</tbody></table></div>';
    }
    html += '<div class="ig-tabs">' + [['queued', 'To send'], ['sent', 'Sent, waiting'], ['replied', 'Replied'], ['done', 'Done']].map(function (t) { return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>';
    html += d.rows.length ? d.rows.map(row).join('') : '<div class="ig-empty">' + (S.q ? 'No ' + (isFb() ? 'Facebook' : 'Instagram') + ' lead matches "' + esc(S.q) + '".' : S.tab === 'queued' ? 'Nothing left to send. Tell Remy and the list refills.' : 'Nothing here yet.') + '</div>';
    h.innerHTML = html;
    h.onclick = onClick;
  }
  function rowById(id) { return (S.data.rows || []).filter(function (x) { return x.id === id; })[0]; }
  async function onClick(ev) {
    var tb = ev.target.closest('.ig-tabs button'); if (tb) { S.tab = tb.getAttribute('data-tab'); S.open = null; refresh(); return; }
    var ab = ev.target.closest('[data-assign]'); if (ab) { await act({ action: 'assign', assigned_to: ab.getAttribute('data-assign'), n: 50, channel: S.channel }); refresh(); return; }
    var lb = ev.target.closest('[data-lang]'); if (lb) { ev.stopPropagation(); var lrow = ev.target.closest('.ig-row'); var lid = parseInt(lrow.getAttribute('data-id'), 10); lb.disabled = true; await act({ id: lid, action: 'lang', lang: lb.getAttribute('data-lang') }); S.open = lid; refresh(); return; }
    var rowEl = ev.target.closest('.ig-row'); if (!rowEl) return;
    var id = parseInt(rowEl.getAttribute('data-id'), 10); var r = rowById(id); if (!r) return;
    var cp = ev.target.closest('[data-copy]');
    if (cp) {
      ev.stopPropagation();
      var k = cp.getAttribute('data-copy'), q = seq(r), text = '';
      if (k === 'm1') text = r.message_1; else if (k === 'next') text = (r.step || 1) < 2 ? q.m2 : q.m3; else if (k.indexOf('obj') === 0) text = q.obj[parseInt(k.slice(3), 10)][1]; else text = q[k] || '';
      copy(text, cp); return;
    }
    var b = ev.target.closest('[data-act]'); if (!b) return;
    var a = b.getAttribute('data-act');
    if (a === 'toggle') { S.open = (S.open === id) ? null : id; render(); return; }
    if (a === 'openlead') { if (S.openLead && r.lead_id) S.openLead(r.lead_id); return; }
    if (a === 'bad_account') {
      ev.stopPropagation();
      var fixed = prompt((isFb() ? 'Wrong page? Paste the right Facebook page link.' : 'Wrong account? Paste the right Instagram handle or profile link.') + '\nLeave it empty if they have no account.', '');
      if (fixed === null) return;
      b.disabled = true;
      try {
        if (String(fixed).trim()) await S.fetchJson('/api/prospects/ig-dm', { method: 'POST', body: JSON.stringify({ id: id, action: 'fix_handle', handle: fixed }) });
        else await S.fetchJson('/api/prospects/ig-dm', { method: 'POST', body: JSON.stringify({ id: id, action: 'no_account' }) });
      } catch (e2) {
        var m2 = String((e2 && e2.message) || e2);
        alert(/handle_already_in_list/.test(m2) ? 'That account is already on the list (another row). This one stays as it is.' : /bad_handle/.test(m2) ? 'That does not look like an Instagram handle.' : 'Could not save: ' + m2);
        b.disabled = false; return;
      }
      S.open = null; refresh(); return;
    }
    ev.stopPropagation();
    var body = { id: id, action: a };
    if (a === 'note') {
      var detN = rowEl.querySelector('.ig-det');
      var nt = detN ? String((detN.querySelector('[data-f=reply]') || {}).value || '').trim() : '';
      if (!nt) { nt = String(prompt('Note for this lead. It goes into the lead\'s notes.') || '').trim(); if (!nt) return; }
      b.disabled = true;
      await act({ id: id, action: 'note', notes: nt });
      S.open = null; refresh(); return;
    }
    if (a === 'replied' || a === 'booked' || a === 'bot' || a === 'not_interested') {
      var det = rowEl.querySelector('.ig-det');
      var txt = det ? (det.querySelector('[data-f=reply]') || {}).value : '';
      var kind = det ? (det.querySelector('[data-f=kind]') || {}).value : '';
      if (a === 'replied' && !txt) { txt = prompt('What did they reply? One line.') || ''; if (!txt) return; }
      body.reply_text = txt; body.reply_kind = a === 'replied' ? kind : undefined; if (a === 'booked') body.notes = txt;
    }
    b.disabled = true;
    await act(body);
    S.open = null; refresh();
  }
  async function act(body) {
    try { return await S.fetchJson('/api/prospects/ig-dm', { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { alert('Could not save: ' + (e.message || e)); }
  }
  async function refresh() {
    if (!S.fetchJson || !document.getElementById(S.host)) return;
    try { S.data = await S.fetchJson('/api/prospects/ig-dm?status=' + S.tab + '&channel=' + S.channel + '&limit=200' + (S.rep ? '&assigned_to=' + encodeURIComponent(S.rep) : '') + (S.q ? '&q=' + encodeURIComponent(S.q) : '')); render(); }
    catch (e) { var h = document.getElementById(S.host); if (h) h.innerHTML = '<div class="ig-empty">Could not load: ' + esc(e.message || e) + '</div>'; }
  }
  function mount(o) { S.host = o.host; S.fetchJson = o.fetchJson; S.openLead = o.openLead || null; S.admin = !!o.admin; S.rep = o.rep || ''; S.channel = o.channel === 'facebook' ? 'facebook' : 'instagram'; S.tab = 'queued'; S.open = null; S.data = null; S.q = ''; var hh = document.getElementById(S.host); if (hh) hh.innerHTML = ''; render(); refresh(); }
    return { mount: mount, refresh: refresh, setRep: function (e) { S.rep = e || ''; refresh(); }, state: S };
  }
  global.IG_DM = create();
  // A second, independent table on the same page (admin Outbound: Instagram + Facebook).
  global.IG_DM.instance = function (o) { var i = create(); i.mount(o); return i; };
})(window);
