/**
 * assets/fb-groups.js
 *
 * The rep's Facebook groups (shared by /sdr/ Facebook tab and /admin/ Facebook
 * page). One row per group with its join status; Add a group, mark Joined,
 * Log a post (reactions, comments, DMs sent), Remove. Click a row for the
 * playbook for THAT group: how to sound like a member (not a vendor), post
 * ideas by audience and language, the DM to someone who reacted, the
 * follow-up that carries the video, the close. Admin mode shows every rep,
 * per-rep numbers and an Assign control.
 *
 * Data: /api/prospects/fb-groups.   FB_GROUPS.mount({ host, fetchJson, admin })
 */
(function (global) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rep(email) { var e = String(email || '').toLowerCase(); if (!e || e === 'pool') return 'pool'; if (e.indexOf('remyleon') === 0) return 'Remy'; if (e.indexOf('davidcoira') === 0) return 'David'; if (e.indexOf('aleb') === 0) return 'Ale'; if (e.indexOf('georgegutierrez') === 0) return 'George'; if (e.indexOf('ayesjorge') === 0) return 'Jorge'; return e.split('@')[0]; }
  function ago(iso) { if (!iso) return ''; var m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)); if (m < 60) return m + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + 'h ago'; return Math.round(h / 24) + 'd ago'; }
  var VSL = 'https://blasononline.stiloaipartners.com?utm_source=facebook&utm_campaign=vsl';

  /* ── The playbook. Posts read like a member asking the room; the pitch only ever happens in the DM. ── */
  var PLAY = {
    blason: {
      en: {
        voice: ['You are a person who works around aesthetic equipment in Miami, asking the room a real question or sharing a real observation. First person. One sentence per line. No company name in the post. No link. No "DM me". The pitch happens in the DM after someone reacts, never in the post.', 'Never a price. Blason is in Miami. Reply to every comment within the hour, like a human.'],
        posts: [
          'Quick poll for the laser hair removal people: diode or alexandrite, and what made you pick it?\nI keep hearing both sides from clinics here in Miami and I want to know what the room actually runs.',
          'Honest question for the owners: what was the machine you bought that paid for itself fastest, and which one is still sitting in a corner?',
          'Which treatment do your clients ask for that you still send somewhere else?\nTrying to understand what the market in South Florida is really missing right now.',
          'For the nurses: when the clinic buys a new device, who actually picks it, the doctor, the owner, or you? Curious how it works in other places.',
          'Saw a clinic this week paying double for a machine because of the logo on the side. Same factory, same specs.\nHas anyone here compared the no-name version of their device side by side? What did you find?',
          'What is the oldest machine still running in your treatment room, and what are you going to do when it dies?',
        ],
        dm1: "hey, saw your comment on the {topic} post. what are you running right now for {treatment}?",
        dm2: 'thanks. I work with Blason, the laser importer here in Miami. made a 4 minute video on why clinics pay twice for the logo and how to skip it: ' + VSL,
        dm3: "if the logo wasn't in the way, which machine would you add next?",
        close: 'Manuel, the owner, does 10-minute calls with clinics and tells you straight what fits. Tuesday 11 or Thursday 2?',
        showroom: 'we have the machines running in the showroom in Miami, come try it. Tuesday or Thursday?',
      },
      es: {
        voice: ['Eres una persona que trabaja con equipos de estética en Miami y le hace una pregunta real al grupo. Primera persona. Una oración por línea. Sin nombre de empresa en el post. Sin link. Sin "escríbeme". La venta pasa en el DM cuando alguien reacciona, nunca en el post.', 'Nunca un precio. Blason está en Miami.'],
        posts: [
          'Pregunta para las que hacen depilación láser: ¿diodo o alexandrita, y por qué lo eligieron?\nEscucho las dos versiones en clínicas aquí en Miami y quiero saber qué usan de verdad.',
          '¿Cuál fue la máquina que más rápido se pagó sola, y cuál está arrinconada sin usar?',
          '¿Qué tratamiento le piden sus clientas que todavía mandan a otro lado?',
          'Vi una clínica esta semana pagando el doble por una máquina por el logo. Misma fábrica, mismas especificaciones.\n¿Alguien ha comparado la versión sin marca de su equipo? ¿Qué encontró?',
          '¿Cuál es la máquina más vieja que todavía funciona en su cabina, y qué va a hacer cuando se dañe?',
        ],
        dm1: 'hola, vi tu comentario en el post de {topic}. ¿qué están usando ahora para {treatment}?',
        dm2: 'gracias. trabajo con Blason, el importador de láser aquí en Miami. hice un video de 4 min de por qué las clínicas pagan dos veces por el logo y cómo evitarlo: ' + VSL + '&lang=es',
        dm3: 'si el logo no fuera un problema, ¿qué máquina agregarías primero?',
        close: 'Manuel, el dueño, hace llamadas de 10 minutos con clínicas y te dice de frente qué te conviene. ¿Martes a las 11 o jueves a las 2?',
        showroom: 'tenemos las máquinas encendidas en el showroom en Miami, ven a probarla. ¿martes o jueves?',
      },
    },
    stilo: {
      en: {
        voice: ['You are a business owner in Florida talking to other owners about getting customers. First person. One sentence per line. No company name, no link, no "DM me", never the word AI. The pitch is in the DM: we put buyer meetings on your calendar and only get paid when it closes.'],
        posts: [
          'Owners doing over 30k a month: where did your last three new accounts actually come from? Referral, ads, cold outreach, or luck?',
          'Honest question: who on your team is in charge of bringing in new business, or is it still you?',
          'What is the one thing you would hand off tomorrow if someone could do it as well as you? For me it was chasing new accounts.',
          'How many new clients a month does your business need to feel safe, and how many are you actually landing?',
          'Roofing and trades people: is your phone ringing from ads, or are you still knocking? What is working in 2026?',
        ],
        dm1: 'hey, saw your comment on the new accounts post. how many new clients a month are you landing right now?',
        dm2: 'asking because we put buyer meetings on the calendar for Florida companies like yours and only get paid when it closes. worth a 10-minute call?',
        dm3: 'who handles new business at your company today, you or someone on the team?',
        close: 'Remy runs the 10-minute calls. Tuesday 11 or Thursday 2?',
        showroom: '',
      },
    },
  };
  function play(g) { var a = g.audience === 'stilo' ? 'stilo' : 'blason'; return (PLAY[a] || {})[g.language === 'es' && PLAY[a].es ? 'es' : 'en']; }

  var CSS = '.fg-top{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 12px}.fg-stat{flex:1;min-width:110px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)}.fg-stat .l{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0)}.fg-stat .v{font-size:22px;font-weight:800;margin-top:3px}'
    + '.fg-row{border:1px solid rgba(255,255,255,.07);border-radius:10px;margin-bottom:6px;background:rgba(255,255,255,.02)}.fg-row.open{border-color:rgba(37,99,235,.5)}.fg-main{display:flex;align-items:center;gap:12px;padding:10px 12px;flex-wrap:wrap;cursor:pointer}.fg-main:hover{background:rgba(255,255,255,.03)}'
    + '.fg-who{flex:1;min-width:200px;font-size:13px}.fg-who b{font-weight:700}.fg-sub{display:block;font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:2px}'
    + '.fg-pill{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 7px;border-radius:999px;margin-left:6px;background:rgba(255,255,255,.08);color:var(--text-secondary,#9a9ab0)}.fg-pill.ok{background:rgba(34,197,94,.15);color:#4ade80}.fg-pill.w{background:rgba(251,191,36,.2);color:#fbbf24}.fg-pill.b{background:rgba(37,99,235,.15);color:#60a5fa}.fg-pill.es{background:rgba(139,92,246,.18);color:#c4b5fd}'
    + '.fg-btn{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB;white-space:nowrap;text-decoration:none;display:inline-block}.fg-btn.g{background:rgba(255,255,255,.1);color:var(--text-primary,#ecedf2)}.fg-btn.ok{background:#16a34a}.fg-btn.r{background:#b91c1c}'
    + '.fg-det{padding:4px 14px 14px;border-top:1px solid rgba(255,255,255,.06)}.fg-det .lbl{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);margin:12px 0 4px}.fg-say{display:flex;gap:10px;align-items:flex-start;margin-bottom:6px}.fg-say pre{flex:1;margin:0;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.05);font:inherit;font-size:13px;line-height:1.5;white-space:pre-wrap;color:var(--text-primary,#ecedf2)}'
    + '.fg-voice{font-size:12px;line-height:1.55;color:var(--text-secondary,#9a9ab0);padding:8px 12px;border-left:3px solid #2563EB;background:rgba(37,99,235,.06);border-radius:6px;margin:4px 0 8px}'
    + '.fg-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}.fg-form input,.fg-form select{padding:8px 10px;background:var(--bg-input,#0f1117);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:inherit;font:inherit;font-size:13px}.fg-form input.wide{flex:1;min-width:220px}.fg-form input.n{width:70px}'
    + '.fg-empty{font-size:12px;color:var(--text-secondary,#9a9ab0);padding:12px;border:1px dashed rgba(255,255,255,.1);border-radius:10px}'
    + '.fg-reps table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px}.fg-reps th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}.fg-reps td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05)}'
    + '.fg-log{font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:4px}.fg-log b{color:var(--text-primary,#ecedf2)}';
  function ensureCss() { if (document.getElementById('fbGroupsCss')) return; var st = document.createElement('style'); st.id = 'fbGroupsCss'; st.textContent = CSS; document.head.appendChild(st); }
  function copy(text, btn) { var done = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1200); } }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fb(text); done(); }); else { fb(text); done(); } function fb(t) { var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); } }

  function create() {
    var S = { host: null, fetchJson: null, admin: false, data: null, open: null, filter: 'mine' };
    function say(label, text, key) { return '<div class="lbl">' + esc(label) + '</div><div class="fg-say"><pre>' + esc(text) + '</pre><button class="fg-btn g" data-copy="' + esc(key) + '">Copy</button></div>'; }
    function detail(g) {
      var p = play(g); if (!p) return '';
      var posts = S.data.posts.filter(function (x) { return x.group_id === g.id; });
      var h = '<div class="fg-det">';
      h += '<div class="lbl">' + (g.language === 'es' ? 'Cómo sonar como miembro, no como vendedor' : 'How to sound like a member, not a vendor') + '</div>' + p.voice.map(function (v) { return '<div class="fg-voice">' + esc(v) + '</div>'; }).join('');
      if (g.rules) h += '<div class="lbl">' + (g.language === 'es' ? 'Reglas del grupo' : 'This group\'s rules') + '</div><div class="fg-voice" style="border-color:#fbbf24;background:rgba(251,191,36,.08)">' + esc(g.rules) + '</div>';
      h += '<div class="lbl">' + (g.language === 'es' ? 'Ideas de posts (reescribe cada uno con tus palabras, uno al día por grupo máximo)' : 'Post ideas (rewrite each in your own words, one a day per group at most)') + '</div>';
      p.posts.forEach(function (t, i) { h += '<div class="fg-say"><pre>' + esc(t) + '</pre><button class="fg-btn g" data-copy="post' + i + '">Copy</button></div>'; });
      h += say(g.language === 'es' ? 'DM 1, a quien reaccionó o comentó (una oración)' : 'DM 1, to someone who reacted or commented (one sentence)', p.dm1, 'dm1');
      h += say(g.language === 'es' ? 'DM 2, cuando contesten (lleva el video)' : 'DM 2, when they answer (carries the video)', p.dm2, 'dm2');
      h += say(g.language === 'es' ? 'DM 3' : 'DM 3', p.dm3, 'dm3');
      h += say(g.language === 'es' ? 'El cierre' : 'The close', p.close, 'close');
      if (p.showroom) h += say(g.language === 'es' ? 'Sur de la Florida: showroom' : 'South Florida: showroom', p.showroom, 'showroom');
      h += '<div class="lbl">' + (g.language === 'es' ? 'Registrar un post' : 'Log a post') + '</div><div class="fg-form"><input class="wide" data-f="copy" placeholder="' + (g.language === 'es' ? 'qué publicaste (una línea)' : 'what you posted (one line)') + '"><input class="n" data-f="reactions" type="number" min="0" placeholder="likes"><input class="n" data-f="comments" type="number" min="0" placeholder="cmts"><input class="n" data-f="dms_sent" type="number" min="0" placeholder="DMs"><button class="fg-btn ok" data-act="post">Posted</button></div>';
      if (posts.length) h += '<div class="lbl">' + (g.language === 'es' ? 'Tus posts aquí (14 días)' : 'Your posts here (14 days)') + '</div>' + posts.map(function (x) { return '<div class="fg-log"><b>' + esc(ago(x.posted_at)) + '</b> · ' + esc((x.copy || '').slice(0, 90)) + ' · ' + x.reactions + ' likes, ' + x.comments + ' comments, ' + x.dms_sent + ' DMs' + (S.admin ? ' · ' + esc(rep(x.posted_by)) : '') + '</div>'; }).join('');
      h += '<div class="fg-form" style="margin-top:14px">' + (g.status !== 'joined' ? '<button class="fg-btn ok" data-act="joined">Joined</button><button class="fg-btn g" data-act="pending">Requested</button><button class="fg-btn g" data-act="rejected">Rejected</button>' : '<button class="fg-btn g" data-act="left">Left the group</button>') + '<button class="fg-btn r" data-act="remove">Remove from my list</button>'
        + (S.admin ? '<select data-f="assign"><option value="">assign to…</option><option value="ale">Ale</option><option value="jorge">Jorge</option><option value="george">George</option><option value="remy">Remy</option><option value="david">David</option></select><button class="fg-btn" data-act="assign">Assign</button>' : '') + '</div>';
      return h + '</div>';
    }
    function row(g) {
      var st = { to_join: ['to join', 'w'], pending: ['requested', 'w'], joined: ['joined', 'ok'], left: ['left', ''], rejected: ['rejected', ''] }[g.status] || [g.status, ''];
      var posts = S.data.posts.filter(function (x) { return x.group_id === g.id; });
      return '<div class="fg-row' + (S.open === g.id ? ' open' : '') + '" data-id="' + g.id + '"><div class="fg-main" data-act="toggle">'
        + '<span class="fg-who"><b>' + esc(g.name) + '</b>' + (g.members ? ' · ' + Number(g.members).toLocaleString() + ' members' : '') + (g.geo ? ' · ' + esc(g.geo) : '')
        + '<span class="fg-pill ' + st[1] + '">' + esc(st[0]) + '</span><span class="fg-pill b">' + esc(g.audience) + '</span>' + (g.language === 'es' ? '<span class="fg-pill es">ES</span>' : '') + (S.admin && g.assigned_to ? '<span class="fg-pill">' + esc(rep(g.assigned_to)) + '</span>' : '')
        + '<span class="fg-sub">' + esc(g.rules ? g.rules.slice(0, 110) : (g.notes || '')) + (posts.length ? ' · ' + posts.length + ' post' + (posts.length === 1 ? '' : 's') + ' in 14d' : '') + '</span></span>'
        + '<a class="fg-btn" href="' + esc(g.url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Open group ↗</a>'
        + (g.status === 'joined' ? '<button class="fg-btn ok" data-act="toggle">Log a post</button>' : '<button class="fg-btn ok" data-act="joined">Joined</button>')
        + '</div>' + (S.open === g.id ? detail(g) : '') + '</div>';
    }
    function render() {
      ensureCss();
      var h = document.getElementById(S.host); if (!h) return;
      var d = S.data; if (!d) { h.innerHTML = '<div class="fg-empty">Loading your groups…</div>'; return; }
      var c = d.counts || {};
      var html = '<div class="fg-top"><div class="fg-stat"><div class="l">Groups</div><div class="v">' + (c.groups || 0) + '</div></div><div class="fg-stat"><div class="l">Joined</div><div class="v">' + (c.joined || 0) + '</div></div><div class="fg-stat"><div class="l">Posts today</div><div class="v">' + (c.posts_today || 0) + '<span style="font-size:12px;color:var(--text-secondary);font-weight:600"> / 5</span></div></div><div class="fg-stat"><div class="l">Reactions 14d</div><div class="v">' + (c.reactions_14d || 0) + '</div></div><div class="fg-stat"><div class="l">DMs from posts 14d</div><div class="v">' + (c.dms_14d || 0) + '</div></div></div>';
      if (S.admin && d.reps) html += '<div class="fg-reps"><table><thead><tr><th>Rep</th><th>Groups</th><th>Joined</th><th>Posts today</th><th>Posts 14d</th><th>Reactions</th><th>DMs</th></tr></thead><tbody>' + d.reps.map(function (r) { return '<tr><td><b>' + esc(rep(r.email)) + '</b></td><td>' + r.groups + '</td><td>' + r.joined + '</td><td>' + r.posts_today + '</td><td>' + r.posts_14d + '</td><td>' + r.reactions_14d + '</td><td>' + r.dms_14d + '</td></tr>'; }).join('') + '</tbody></table></div>';
      html += '<div class="fg-form" style="margin:0 0 12px"><input class="wide" id="fgAddUrl" placeholder="facebook.com/groups/…"><input id="fgAddName" placeholder="group name" style="min-width:180px"><select id="fgAddAud"><option value="blason">Blason</option><option value="stilo">STILO</option></select><select id="fgAddLang"><option value="en">English</option><option value="es">Español</option></select>' + (S.admin ? '<select id="fgAddRep"><option value="">me</option><option value="ale">Ale</option><option value="jorge">Jorge</option><option value="george">George</option><option value="remy">Remy</option><option value="david">David</option></select>' : '') + '<button class="fg-btn" data-act="add">+ Add group</button></div>';
      html += d.groups.length ? d.groups.map(row).join('') : '<div class="fg-empty">No groups on your list yet. Add the first one above, or ask Remy for your six.</div>';
      h.innerHTML = html; h.onclick = onClick;
    }
    async function act(body) { try { return await S.fetchJson('/api/prospects/fb-groups', { method: 'POST', body: JSON.stringify(body) }); } catch (e) { alert('Could not save: ' + (e.message || e)); } }
    async function onClick(ev) {
      var b = ev.target.closest('[data-act]'); var act0 = b ? b.getAttribute('data-act') : null;
      if (act0 === 'add') { var url = (document.getElementById('fgAddUrl') || {}).value; if (!url) return; var repSel = document.getElementById('fgAddRep'); await act({ action: 'add', url: url, name: (document.getElementById('fgAddName') || {}).value, audience: (document.getElementById('fgAddAud') || {}).value, language: (document.getElementById('fgAddLang') || {}).value, assigned_to: repSel ? repSel.value : undefined }); refresh(); return; }
      var rowEl = ev.target.closest('.fg-row'); if (!rowEl) return;
      var id = parseInt(rowEl.getAttribute('data-id'), 10); var g = S.data.groups.filter(function (x) { return x.id === id; })[0]; if (!g) return;
      var cp = ev.target.closest('[data-copy]');
      if (cp) { ev.stopPropagation(); var k = cp.getAttribute('data-copy'), p = play(g), text = k.indexOf('post') === 0 ? p.posts[parseInt(k.slice(4), 10)] : (p[k] || ''); copy(text, cp); return; }
      if (!b) return;
      if (act0 === 'toggle') { S.open = (S.open === id) ? null : id; render(); return; }
      ev.stopPropagation();
      if (act0 === 'post') { var det = rowEl.querySelector('.fg-det'); var v = function (n) { var el = det && det.querySelector('[data-f=' + n + ']'); return el ? el.value : ''; }; await act({ action: 'post', group_id: id, copy: v('copy'), reactions: v('reactions'), comments: v('comments'), dms_sent: v('dms_sent') }); S.open = id; refresh(); return; }
      if (act0 === 'assign') { var sel = rowEl.querySelector('[data-f=assign]'); await act({ action: 'assign', id: id, assigned_to: sel ? sel.value : '' }); refresh(); return; }
      if (act0 === 'remove') { if (!confirm('Remove this group from the list?')) return; await act({ action: 'remove', id: id }); refresh(); return; }
      if (['joined', 'pending', 'rejected', 'left'].indexOf(act0) >= 0) { await act({ action: 'status', id: id, status: act0 }); refresh(); return; }
    }
    async function refresh() { if (!S.fetchJson || !document.getElementById(S.host)) return; try { S.data = await S.fetchJson('/api/prospects/fb-groups' + (S.rep ? '?assigned_to=' + encodeURIComponent(S.rep) : '')); render(); } catch (e) { var h = document.getElementById(S.host); if (h) h.innerHTML = '<div class="fg-empty">Could not load: ' + esc(e.message || e) + '</div>'; } }
    function mount(o) { S.host = o.host; S.fetchJson = o.fetchJson; S.admin = !!o.admin; S.rep = o.rep || ''; S.open = null; S.data = null; render(); refresh(); }
    return { mount: mount, refresh: refresh, setRep: function (e) { S.rep = e || ''; refresh(); }, PLAY: PLAY };
  }
  global.FB_GROUPS = create();
  global.FB_GROUPS.instance = function (o) { var i = create(); i.mount(o); return i; };
})(window);
