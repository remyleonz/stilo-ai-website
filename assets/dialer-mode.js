/* ============================================================
   DIALER MODE — full-screen power dialer, shared by both dashboards.

   One renderer, two hosts (admin/index.html + sdr/index.html), same
   pattern as nurture-stepper.js: the page hands us its own helpers via
   configure() and we never touch page globals directly.

   The engine: Quo has no dial API, but its webhook writes a row into
   prospecting.lead_calls seconds after hangup. So the loop is:

     SPACE  -> quo:// deep link opens the app pre-dialed + POST log-dial
     poll   -> GET /api/prospects/timeline every 3.5s until a NEW call
               row appears for this lead (id not in the pre-dial snapshot)
     keys   -> disposition overlay: 1 no answer/VM, 2 callback, 3 booked,
               4 not interested, 5 wrong number, 6 DNC (reason required)
     auto   -> 5s countdown, next lead. Esc pauses.

   Ordering matters: we poll FIRST and log SECOND, so log-call's merge
   rule updates the Quo row in place instead of inserting a duplicate.
   Key 1 writes nothing unless the rep typed a note — log-dial already
   counted the attempt and the webhook row carries the auto outcome
   (logging no_answer before the webhook lands would strand a manual
   row the webhook can't merge onto).

   Booking (key 3) reuses the page's real booking picker (client
   showroom branching included) via cfg.openBooking — the session
   pauses and a floating pill brings the rep back.

   Follow-ups (disposition screen): E drafts + sends the follow-up
   email through draft-email/send-email; T sends an SMS through
   send-sms, shown ONLY when this call connected (duration >= 20s,
   the connected-call gate).
   ============================================================ */
(function (global) {
    'use strict';

    var cfg = null;   // page-supplied helpers, set by configure()
    var S = null;     // session state, null when closed

    var POLL_MS = 3500;
    var ADVANCE_SECONDS = 5;
    var CONNECT_SECONDS = 20;   // same threshold as outbound-enqueue + vsl-nurture

    /* ---------- voicemail + sms templates ----------
       Rules baked in: never a price, client-pool copy names the CLIENT
       and never STILO, 'es' leads get Spanish everything. */
    function firstName(lead) {
        var n = (lead.owner_name || '').trim();
        if (!n) return '';
        return n.split(/\s+/)[0];
    }
    function vmScript(lead) {
        var first = firstName(lead) || 'there';
        var rep = (cfg.getRepName && cfg.getRepName()) || 'me';
        var biz = lead.business_name || lead.name || 'your business';
        var es = lead.primary_language === 'es';
        var client = lead.client_company || (es ? 'la sala de ventas' : 'the showroom');
        if (lead.client_id) {
            return es
                ? 'Hola ' + first + ', le habla ' + rep + ' de ' + client + ' en Miami, para ' + biz + '. Es algo rápido. Llámeme a este número, o lo intento de nuevo mañana. De nuevo, ' + rep + ' de ' + client + '. Gracias.'
                : 'Hi ' + first + ', this is ' + rep + ' with ' + client + ' in Miami, calling for ' + biz + '. Quick one. Call me back at this number, or I\'ll try you again tomorrow. Again, ' + rep + ' with ' + client + '. Thanks.';
        }
        return es
            ? 'Hola ' + first + ', le habla ' + rep + ' desde Miami para ' + biz + '. Tengo algo puntual sobre traerle más clientes esta temporada. Es rápido. Llámeme a este número, o lo intento mañana. De nuevo, ' + rep + '. Gracias.'
            : 'Hi ' + first + ', this is ' + rep + ' calling from Miami for ' + biz + '. I\'ve got something specific on bringing you more customers this season. It\'s quick. Call me back at this number, or I\'ll try you again tomorrow. Again, ' + rep + '. Thanks.';
    }
    function smsTemplate(lead) {
        var first = firstName(lead);
        var hi = first ? 'Hi ' + first + ', ' : 'Hi, ';
        var hola = first ? 'Hola ' + first + ', ' : 'Hola, ';
        var rep = (cfg.getRepName && cfg.getRepName()) || 'me';
        var es = lead.primary_language === 'es';
        if (lead.client_id) {
            var client = lead.client_company || '';
            return es
                ? hola + 'soy ' + rep + (client ? ' de ' + client : '') + ', acabamos de hablar. En este número me encuentra directo si surge algo.'
                : hi + 'it\'s ' + rep + (client ? ' with ' + client : '') + ', we just spoke. This number reaches me directly if anything comes up.';
        }
        return es
            ? hola + 'soy ' + rep + ', acabamos de hablar por teléfono. En este número me encuentra directo si surge algo antes de volver a hablar.'
            : hi + 'it\'s ' + rep + ', we just spoke on the phone. This number reaches me directly if anything comes up before we talk again.';
    }

    /* ---------- small helpers ---------- */
    function esc(s) { return cfg.escape(s == null ? '' : String(s)); }
    function el(id) { return document.getElementById(id); }
    // Naive-UTC safe (lead timestamps often come without a timezone).
    function tsToMs(ts) {
        if (!ts) return 0;
        if (typeof ts === 'string' && !/[zZ]$|[+-]\d\d:?\d\d$/.test(ts)) ts = ts.replace(' ', 'T') + 'Z';
        var m = new Date(ts).getTime();
        return isNaN(m) ? 0 : m;
    }
    function leadPhone(r) { return r.owner_phone_e164 || r.owner_phone || r.phone || ''; }
    function toE164(raw) {
        if (!raw) return '';
        var d = String(raw).replace(/\D/g, '');
        if (d.length === 10) return '+1' + d;
        if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
        return String(raw).charAt(0) === '+' ? String(raw) : (d ? '+' + d : '');
    }
    function fmtDur(sec) {
        sec = Math.max(0, Math.round(sec || 0));
        var m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function fmtClock(ms) {
        var sec = Math.floor(ms / 1000);
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    function outcomeLabel(o) {
        return ({
            answered: 'Answered', voicemail: 'Voicemail', no_answer: 'No answer',
            missed_inbound: 'Missed inbound', callback_requested: 'Callback set',
            booked_meeting: 'Booked meeting', not_interested: 'Not interested',
            wrong_number: 'Wrong number', do_not_call: 'Do Not Call'
        })[o] || (o || '');
    }
    function tierChip(r) {
        var t = (r.prospect_tier || r.tier || '').toLowerCase();
        if (!t) return '';
        var c = t === 'hot' ? 'var(--red,#f87171)' : (t === 'warm' ? 'var(--yellow,#fbbf24)' : 'var(--text-tertiary,#6e7083)');
        return '<span class="dm-chip" style="color:' + c + ';border-color:currentColor;">' + esc(t.toUpperCase()) + '</span>';
    }

    /* ---------- css (injected once; both pages, fallbacked vars) ---------- */
    var CSS = ''
        + '#dmRoot{position:fixed;inset:0;z-index:12000;background:var(--bg-primary,#08080c);color:var(--text-primary,#ecedf2);display:flex;flex-direction:column;font-family:var(--font-body,-apple-system,system-ui,sans-serif);}'
        + '#dmRoot *{box-sizing:border-box;}'
        + '#dmRoot.dm-hidden{display:none;}'
        + '.dm-hud{display:flex;align-items:center;gap:18px;padding:10px 20px;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.07));flex-shrink:0;flex-wrap:wrap;}'
        + '.dm-wordmark{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;font-weight:700;letter-spacing:.18em;color:var(--blue,#2563eb);white-space:nowrap;}'
        + '.dm-hud-stats{display:flex;gap:22px;flex:1;justify-content:center;flex-wrap:wrap;}'
        + '.dm-stat{text-align:center;min-width:52px;}'
        + '.dm-stat b{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:17px;font-weight:700;line-height:1.1;}'
        + '.dm-stat span{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted,#6e7083);}'
        + '.dm-hud-right{display:flex;align-items:center;gap:10px;white-space:nowrap;}'
        + '.dm-pos{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;color:var(--text-secondary,#a2a3b4);}'
        + '.dm-iconbtn{padding:6px 13px;background:var(--bg-card,#14141c);border:1px solid var(--border-subtle,rgba(255,255,255,.09));border-radius:999px;color:var(--text-secondary,#a2a3b4);font-size:12px;font-weight:600;cursor:pointer;}'
        + '.dm-iconbtn:hover{color:var(--text-primary,#ecedf2);border-color:var(--border-medium,rgba(255,255,255,.16));}'
        + '.dm-main{flex:1;display:flex;gap:0;min-height:0;}'
        + '.dm-lead{width:400px;flex-shrink:0;overflow-y:auto;padding:26px 24px;border-right:1px solid var(--border-subtle,rgba(255,255,255,.07));}'
        + '.dm-script{flex:1;overflow-y:auto;padding:26px 30px;min-width:0;}'
        + '.dm-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}'
        + '.dm-chip{font-size:10px;font-weight:700;letter-spacing:.08em;padding:3px 9px;border-radius:999px;border:1px solid var(--border-medium,rgba(255,255,255,.14));color:var(--text-secondary,#a2a3b4);}'
        + '.dm-chip.dm-chip-cb{color:var(--blue,#60a5fa);border-color:var(--blue,#2563eb);}'
        + '.dm-chip.dm-chip-client{color:var(--yellow,#fbbf24);border-color:currentColor;}'
        + '.dm-bizname{font-family:var(--font-display,inherit);font-size:30px;font-weight:700;line-height:1.12;margin:0 0 4px;}'
        + '.dm-niche{font-size:13px;color:var(--text-tertiary,#6e7083);margin-bottom:16px;}'
        + '.dm-kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.05));font-size:13px;}'
        + '.dm-kv b{font-weight:600;text-align:right;}'
        + '.dm-kv span{color:var(--text-muted,#6e7083);flex-shrink:0;}'
        + '.dm-phone{font-family:var(--font-mono,ui-monospace,monospace);font-size:15px;letter-spacing:.02em;}'
        + '.dm-sec{margin-top:18px;}'
        + '.dm-sec h4{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted,#6e7083);margin:0 0 8px;font-weight:700;}'
        + '.dm-notes{font-size:13px;line-height:1.55;color:var(--text-secondary,#a2a3b4);white-space:pre-wrap;max-height:150px;overflow-y:auto;background:var(--bg-card,#0e0e14);border:1px solid var(--border-subtle,rgba(255,255,255,.06));border-radius:10px;padding:10px 12px;}'
        + '.dm-callrow{display:flex;gap:10px;align-items:baseline;font-size:12px;padding:5px 0;color:var(--text-secondary,#a2a3b4);}'
        + '.dm-callrow .dm-co{font-weight:600;color:var(--text-primary,#ecedf2);flex-shrink:0;}'
        + '.dm-callrow .dm-cd{font-family:var(--font-mono,ui-monospace,monospace);color:var(--text-muted,#6e7083);margin-left:auto;flex-shrink:0;}'
        + '.dm-vm{margin-top:22px;background:var(--bg-card,#0e0e14);border:1px solid var(--border-subtle,rgba(255,255,255,.07));border-left:3px solid var(--blue,#2563eb);border-radius:10px;padding:14px 16px;}'
        + '.dm-vm h4{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--blue,#60a5fa);margin:0 0 8px;font-weight:700;}'
        + '.dm-vm p{margin:0;font-size:14px;line-height:1.6;color:var(--text-secondary,#a2a3b4);}'
        + '.dm-foot{flex-shrink:0;border-top:1px solid var(--border-subtle,rgba(255,255,255,.07));padding:14px 20px;background:var(--bg-secondary,#0b0b10);}'
        + '.dm-callbtn{display:inline-flex;align-items:center;gap:12px;padding:14px 34px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:.01em;}'
        + '.dm-callbtn:hover{filter:brightness(1.1);}'
        + '.dm-key{display:inline-block;min-width:22px;text-align:center;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.10);font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;font-weight:700;}'
        + '.dm-foot-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}'
        + '.dm-hint{font-size:12px;color:var(--text-muted,#6e7083);}'
        + '.dm-pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--green,#10b981);animation:dmPulse 1.1s ease-in-out infinite;}'
        + '@keyframes dmPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.35;transform:scale(.75);}}'
        + '.dm-live{font-family:var(--font-mono,ui-monospace,monospace);font-size:15px;font-weight:700;}'
        + '.dm-disp{display:flex;gap:8px;flex-wrap:wrap;}'
        + '.dm-dbtn{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:10px 14px;background:var(--bg-card,#14141c);border:1px solid var(--border-subtle,rgba(255,255,255,.09));border-radius:10px;color:var(--text-primary,#ecedf2);font-size:13px;font-weight:600;cursor:pointer;min-width:118px;text-align:left;}'
        + '.dm-dbtn:hover{border-color:var(--border-medium,rgba(255,255,255,.2));background:var(--bg-input,#1b1b25);}'
        + '.dm-dbtn small{font-size:10px;font-weight:500;color:var(--text-muted,#6e7083);}'
        + '.dm-note{width:100%;margin-top:10px;padding:9px 12px;background:var(--bg-input,#101018);border:1px solid var(--border-subtle,rgba(255,255,255,.08));border-radius:9px;color:inherit;font-family:inherit;font-size:13px;resize:none;}'
        + '.dm-result{display:inline-flex;align-items:center;gap:10px;font-size:14px;font-weight:600;}'
        + '.dm-panel{margin-top:12px;padding:14px;background:var(--bg-card,#0e0e14);border:1px solid var(--border-subtle,rgba(255,255,255,.08));border-radius:12px;}'
        + '.dm-panel h4{margin:0 0 10px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted,#6e7083);}'
        + '.dm-qbtn{padding:8px 14px;background:var(--bg-input,#14141c);border:1px solid var(--border-medium,rgba(255,255,255,.14));border-radius:999px;color:var(--text-primary,#ecedf2);font-size:12.5px;font-weight:600;cursor:pointer;margin:0 6px 6px 0;}'
        + '.dm-qbtn:hover{border-color:var(--blue,#2563eb);color:var(--blue,#60a5fa);}'
        + '.dm-input{padding:8px 12px;background:var(--bg-input,#101018);border:1px solid var(--border-subtle,rgba(255,255,255,.1));border-radius:8px;color:inherit;font-family:inherit;font-size:13px;}'
        + '.dm-send{padding:9px 20px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;}'
        + '.dm-cancel{padding:9px 14px;background:none;border:none;color:var(--text-muted,#6e7083);font-size:12px;cursor:pointer;}'
        + '.dm-countwrap{flex:1;max-width:340px;}'
        + '.dm-countbar{height:4px;border-radius:2px;background:var(--border-subtle,rgba(255,255,255,.08));overflow:hidden;margin-top:8px;}'
        + '.dm-countbar i{display:block;height:100%;background:var(--blue,#2563eb);transition:width .1s linear;}'
        + '.dm-summary{max-width:560px;margin:60px auto;text-align:center;padding:0 20px;}'
        + '.dm-summary h2{font-family:var(--font-display,inherit);font-size:34px;margin:0 0 8px;}'
        + '.dm-sumgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:30px 0;}'
        + '.dm-sumcell{background:var(--bg-card,#0e0e14);border:1px solid var(--border-subtle,rgba(255,255,255,.07));border-radius:14px;padding:18px 10px;}'
        + '.dm-sumcell b{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:26px;}'
        + '.dm-sumcell span{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted,#6e7083);}'
        + '#dmResumePill{position:fixed;left:18px;bottom:18px;z-index:12001;display:flex;align-items:center;gap:10px;padding:11px 18px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:999px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 30px rgba(37,99,235,.45);}'
        + '.dm-overlay-menu{position:absolute;inset:0;background:rgba(8,8,12,.82);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:5;}'
        + '.dm-menu{background:var(--bg-card,#0e0e14);border:1px solid var(--border-medium,rgba(255,255,255,.12));border-radius:16px;padding:26px 30px;text-align:center;min-width:280px;}'
        + '.dm-menu h3{margin:0 0 16px;font-size:17px;}'
        + '@media(max-width:900px){.dm-main{flex-direction:column;overflow-y:auto;}.dm-lead{width:100%;border-right:none;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.07));padding:18px;overflow-y:visible;flex-shrink:0;}.dm-script{padding:18px;overflow:visible;flex-shrink:0;}.dm-hud-stats{gap:12px;}.dm-bizname{font-size:23px;}}';

    function injectCss() {
        if (el('dmStyles')) return;
        var st = document.createElement('style');
        st.id = 'dmStyles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    /* ---------- queue ---------- */
    // The rep's existing board, callbacks first: due (or coming due within
    // 30 min) callbacks are prepended to the callable rows. No new queue
    // logic beyond that.
    function buildQueue(rows, callbacks) {
        var now = Date.now();
        var due = (callbacks || []).filter(function (r) {
            var t = tsToMs(r.next_action_due_at);
            return t && t <= now + 30 * 60 * 1000 && leadPhone(r);
        });
        due.forEach(function (r) { r.__dmCallback = true; });
        var seen = {};
        var q = [];
        due.concat(rows || []).forEach(function (r) {
            if (!r || r.id == null || seen[r.id]) return;
            if (!leadPhone(r)) return;
            seen[r.id] = 1;
            q.push(r);
        });
        return q;
    }

    /* ---------- session state ---------- */
    function newSession(queue) {
        return {
            queue: queue, idx: -1,
            lead: null,             // detail-enriched current lead
            phase: 'ready',         // ready | dialing | disposition | advance | done
            knownCallIds: {},       // lead_calls ids seen BEFORE this dial
            currentCall: null,      // the webhook row detected for this dial
            dialStartedAt: 0,
            pollTimer: null, clockTimer: null, advTimer: null,
            advanceLeft: 0,
            pausedFor: null,        // 'booking' | 'menu' | null
            bookingPrior: null,     // meeting_scheduled_at before booking opened
            startedAt: Date.now(),
            stats: { dials: 0, connects: 0, talk: 0, booked: 0, callbacks: 0, logged: 0 },
            lastLoggedLabel: '',
            emailVariant: null,
            panel: null             // 'callback' | 'dnc' | 'email' | 'sms' | null
        };
    }

    /* ---------- shell ---------- */
    function openShell() {
        injectCss();
        var root = document.createElement('div');
        root.id = 'dmRoot';
        root.innerHTML =
            '<div class="dm-hud">'
            + '<span class="dm-wordmark">STILO DIALER</span>'
            + '<span class="dm-pos" id="dmClock">0:00</span>'
            + '<div class="dm-hud-stats">'
            + '<div class="dm-stat"><b id="dmStDials">0</b><span>Dials</span></div>'
            + '<div class="dm-stat"><b id="dmStConn">0</b><span>Connects</span></div>'
            + '<div class="dm-stat"><b id="dmStTalk">0:00</b><span>Talk</span></div>'
            + '<div class="dm-stat"><b id="dmStCb">0</b><span>Callbacks</span></div>'
            + '<div class="dm-stat"><b id="dmStBooked">0</b><span>Booked</span></div>'
            + '<div class="dm-stat"><b id="dmStPace">0</b><span>Dials/hr</span></div>'
            + '</div>'
            + '<div class="dm-hud-right">'
            + '<span class="dm-pos" id="dmQueuePos"></span>'
            + '<button class="dm-iconbtn" onclick="DIALER_MODE.menu()">Pause</button>'
            + '<button class="dm-iconbtn" onclick="DIALER_MODE.close()">End session</button>'
            + '</div>'
            + '</div>'
            + '<div class="dm-main" id="dmMain"></div>'
            + '<div class="dm-foot" id="dmFoot"></div>';
        document.body.appendChild(root);
        document.addEventListener('keydown', onKeyDown, true);
        S.clockTimer = setInterval(tickHud, 1000);
    }

    function tickHud() {
        if (!S) return;
        var elapsed = Date.now() - S.startedAt;
        var clock = el('dmClock'); if (clock) clock.textContent = fmtClock(elapsed);
        var hrs = Math.max(elapsed / 3600000, 1 / 60);  // floor at 1 min so pace isn't absurd
        var pace = S.stats.dials ? Math.round(S.stats.dials / hrs) : 0;
        setText('dmStDials', S.stats.dials);
        setText('dmStConn', S.stats.connects);
        setText('dmStTalk', fmtDur(S.stats.talk));
        setText('dmStCb', S.stats.callbacks);
        setText('dmStBooked', S.stats.booked);
        setText('dmStPace', pace);
        if (S.phase === 'dialing') {
            var t = el('dmLiveTimer');
            if (t) t.textContent = fmtClock(Date.now() - S.dialStartedAt);
        }
    }
    function setText(id, v) { var e = el(id); if (e) e.textContent = v; }

    /* ---------- lead rendering ---------- */
    function renderLead() {
        var r = S.lead || S.queue[S.idx];
        var main = el('dmMain');
        if (!main) return;
        setText('dmQueuePos', (S.idx + 1) + ' / ' + S.queue.length);

        var chips = '';
        if (r.__dmCallback) chips += '<span class="dm-chip dm-chip-cb">CALLBACK DUE</span>';
        chips += tierChip(r);
        if (r.client_id) chips += '<span class="dm-chip dm-chip-client">' + esc(r.client_company || 'CLIENT ACCOUNT') + '</span>';
        if (r.primary_language === 'es') chips += '<span class="dm-chip">ESPANOL</span>';

        var kv = '';
        kv += '<div class="dm-kv"><span>Owner</span><b>' + (r.owner_name ? esc(r.owner_name) : '<i style="color:var(--text-muted,#6e7083);">unknown</i>') + '</b></div>';
        if (r.front_desk_name) kv += '<div class="dm-kv"><span>Front desk</span><b>' + esc(r.front_desk_name) + '</b></div>';
        kv += '<div class="dm-kv"><span>Phone</span><b class="dm-phone">' + esc(leadPhone(r)) + '</b></div>';
        var lastBits = [];
        if (r.last_called_outcome) lastBits.push(outcomeLabel(r.last_called_outcome));
        if (r.last_called_at) lastBits.push(cfg.fmtTime(r.last_called_at));
        kv += '<div class="dm-kv"><span>Last call</span><b>' + (lastBits.length ? esc(lastBits.join(' · ')) : 'Never called') + '</b></div>';
        kv += '<div class="dm-kv"><span>Attempts</span><b>' + esc(r.call_attempts || 0) + '</b></div>';
        if (r.next_action_type === 'callback' && r.next_action_due_at) {
            kv += '<div class="dm-kv"><span>Callback due</span><b style="color:var(--blue,#60a5fa);">' + esc(cfg.fmtTime(r.next_action_due_at)) + '</b></div>';
        }
        if (r.nurture_email_count) {
            kv += '<div class="dm-kv"><span>Emails sent</span><b>' + esc(r.nurture_email_count) + (r.nurture_last_email_at ? ' · last ' + esc(cfg.fmtTime(r.nurture_last_email_at)) : '') + '</b></div>';
        }

        var notes = (r.rep_notes != null && r.rep_notes !== '') ? r.rep_notes : (r.call_notes || '');
        var notesHtml = notes
            ? '<div class="dm-sec"><h4>Notes</h4><div class="dm-notes">' + esc(notes) + '</div></div>'
            : '';

        var callsHtml = '';
        var hist = (r.call_history || []).slice(0, 3);
        if (hist.length) {
            callsHtml = '<div class="dm-sec"><h4>Recent calls</h4>' + hist.map(function (c) {
                return '<div class="dm-callrow">'
                    + '<span class="dm-co">' + esc(outcomeLabel(c.outcome) || '?') + '</span>'
                    + (c.transcript_summary ? '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(String(c.transcript_summary).slice(0, 90)) + '</span>' : '')
                    + '<span class="dm-cd">' + (c.duration_seconds ? fmtDur(c.duration_seconds) + ' · ' : '') + esc(cfg.fmtTime(c.called_at)) + '</span>'
                    + '</div>';
            }).join('') + '</div>';
        }

        main.innerHTML =
            '<div class="dm-lead">'
            + '<div class="dm-chips">' + chips + '</div>'
            + '<h2 class="dm-bizname">' + esc(r.business_name || r.name || 'Lead #' + r.id) + '</h2>'
            + '<div class="dm-niche">' + esc(r.category || r.niche || '') + (r.city ? ' · ' + esc(r.city) : '') + '</div>'
            + kv + notesHtml + callsHtml
            + '<div class="dm-vm"><h4>Voicemail · read it word for word</h4><p id="dmVmText">' + esc(vmScript(r)) + '</p></div>'
            + '</div>'
            + '<div class="dm-script" id="dmScriptPane"><div style="color:var(--text-muted,#6e7083);font-size:13px;">Loading script…</div></div>';

        // Script loads async through the page's own pipeline (client-pool
        // firewall, language, agent resolution all live there).
        var myIdx = S.idx;
        Promise.resolve(cfg.loadScriptHtml(r)).then(function (html) {
            if (!S || S.idx !== myIdx) return;
            var pane = el('dmScriptPane');
            if (pane) pane.innerHTML = html || '';
        }).catch(function () {
            if (!S || S.idx !== myIdx) return;
            var pane = el('dmScriptPane');
            if (pane) pane.innerHTML = '<div style="color:var(--text-muted,#6e7083);">Could not load script.</div>';
        });

        renderFoot();
    }

    /* ---------- footer per phase ---------- */
    function keyHint(k, label) { return '<span class="dm-hint"><span class="dm-key">' + k + '</span> ' + label + '</span>'; }

    function renderFoot() {
        var foot = el('dmFoot');
        if (!foot) return;
        S.panel = null;

        if (S.phase === 'ready') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<button class="dm-callbtn" onclick="DIALER_MODE.dial()"><span class="dm-key" style="background:rgba(255,255,255,.22);">SPACE</span> Call in Quo</button>'
                + keyHint('N', 'Skip lead') + keyHint('ESC', 'Pause')
                + '<span style="flex:1;"></span>'
                + '<span class="dm-hint">Space opens Quo pre-dialed. Tap call there, talk, hang up. This screen detects the hangup on its own.</span>'
                + '</div>';
            return;
        }
        if (S.phase === 'dialing') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<span class="dm-pulse"></span><span class="dm-live" id="dmLiveTimer">0:00</span>'
                + '<span class="dm-hint">In Quo. Waiting for the hangup…</span>'
                + '<span style="flex:1;"></span>'
                + dispositionKeysHtml()
                + '</div>'
                + noteBoxHtml();
            return;
        }
        if (S.phase === 'disposition') {
            var c = S.currentCall;
            var connected = c && (c.duration_seconds || 0) >= CONNECT_SECONDS;
            var result = c
                ? '<span class="dm-result"><span style="color:var(--green,#10b981);">●</span> ' + esc(outcomeLabel(c.outcome)) + (c.duration_seconds ? ' · ' + fmtDur(c.duration_seconds) : '') + '</span>'
                : '<span class="dm-result" style="color:var(--text-muted,#6e7083);">No call detected yet. Log it anyway:</span>';
            foot.innerHTML = '<div class="dm-foot-row">' + result
                + '<span style="flex:1;"></span>' + dispositionKeysHtml()
                + '</div>'
                + '<div class="dm-foot-row" style="margin-top:8px;">'
                + keyHint('E', 'Email follow-up')
                + (connected ? keyHint('T', 'Text follow-up') : '<span class="dm-hint" style="opacity:.45;"><span class="dm-key">T</span> Text (needs a ' + CONNECT_SECONDS + 's+ connect)</span>')
                + keyHint('N', 'Skip, no log')
                + '</div>'
                + noteBoxHtml()
                + '<div id="dmPanelHost"></div>';
            return;
        }
        if (S.phase === 'advance') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<span class="dm-result" style="color:var(--green,#10b981);">✓ ' + esc(S.lastLoggedLabel || 'Logged') + '</span>'
                + '<div class="dm-countwrap"><span class="dm-hint">Next lead in <b id="dmCountNum">' + S.advanceLeft + '</b>s</span>'
                + '<div class="dm-countbar"><i id="dmCountBar" style="width:100%;"></i></div></div>'
                + '<button class="dm-callbtn" style="padding:10px 22px;font-size:14px;" onclick="DIALER_MODE.nextNow()"><span class="dm-key" style="background:rgba(255,255,255,.22);">SPACE</span> Next now</button>'
                + keyHint('ESC', 'Pause')
                + '</div>';
            return;
        }
        foot.innerHTML = '';
    }

    function dispositionKeysHtml() {
        return '<div class="dm-disp">'
            + dBtn(1, 'No answer / VM', 'just move on')
            + dBtn(2, 'Callback', 'interested, set a time')
            + dBtn(3, 'Booked', 'open the slot picker')
            + dBtn(4, 'Not interested', 'a real no')
            + dBtn(5, 'Wrong number', '')
            + dBtn(6, 'DNC', 'reason required')
            + '</div>';
    }
    function dBtn(k, label, sub) {
        return '<button class="dm-dbtn" onclick="DIALER_MODE.disposition(' + k + ')"><span><span class="dm-key">' + k + '</span> ' + label + '</span>' + (sub ? '<small>' + sub + '</small>' : '') + '</button>';
    }
    function noteBoxHtml() {
        return '<textarea id="dmNote" class="dm-note" rows="1" placeholder="Call note (saved with the outcome)…"></textarea>';
    }
    function noteVal() { var n = el('dmNote'); return n ? n.value.trim() : ''; }

    /* ---------- lead lifecycle ---------- */
    function nextLead() {
        clearTimers(false);
        S.idx++;
        S.currentCall = null;
        S.knownCallIds = {};
        S.panel = null;
        if (S.idx >= S.queue.length) { S.phase = 'done'; renderSummary(); return; }
        S.phase = 'ready';
        S.lead = S.queue[S.idx];
        renderLead();
        // Enrich from detail (notes, history, contacts, client info) and
        // snapshot the existing call ids so the poll can spot the NEW row.
        var myIdx = S.idx;
        cfg.fetchJson('/api/prospects/detail?id=' + encodeURIComponent(S.queue[S.idx].id)).then(function (d) {
            if (!S || S.idx !== myIdx) return;
            var merged = Object.assign({}, S.queue[S.idx], d || {});
            merged.__dmCallback = S.queue[S.idx].__dmCallback;
            S.lead = merged;
            ((d && d.call_history) || []).forEach(function (c) { if (c.id != null) S.knownCallIds[c.id] = 1; });
            if (S.phase === 'ready') renderLead();
        }).catch(function () { /* queue row is enough to dial */ });
    }

    function dial() {
        if (!S || S.phase !== 'ready') return;
        var r = S.lead || S.queue[S.idx];
        var e164 = toE164(leadPhone(r));
        if (!e164) { advance('No phone number', true); return; }
        S.phase = 'dialing';
        S.dialStartedAt = Date.now();
        S.stats.dials++;
        renderFoot();

        // Deep link: quo:// first, web dialer fallback if nothing handles it
        // (same visibilitychange trick as the drawer's Call button).
        var enc = encodeURIComponent(e164);
        var appOpened = false;
        var onHide = function () { if (document.hidden) appOpened = true; };
        document.addEventListener('visibilitychange', onHide);
        window.location.href = 'quo://call?to=' + enc;
        setTimeout(function () {
            document.removeEventListener('visibilitychange', onHide);
            if (!appOpened && !document.hidden) window.open('https://my.openphone.com/calls/new?to=' + enc, '_blank');
        }, 1400);

        // Count the attempt (button-click stamp; the webhook row is the real call).
        cfg.fetchJson('/api/prospects/log-dial', { method: 'POST', body: JSON.stringify({ lead_id: r.id }) }).catch(function () {});

        startPoll();
    }

    function startPoll() {
        stopPoll();
        var leadId = (S.lead || S.queue[S.idx]).id;
        S.pollTimer = setInterval(function () {
            if (!S || S.phase !== 'dialing') { stopPoll(); return; }
            cfg.fetchJson('/api/prospects/timeline?id=' + encodeURIComponent(leadId)).then(function (data) {
                if (!S || S.phase !== 'dialing') return;
                var calls = ((data && data.events) || []).filter(function (e) { return e.kind === 'call'; });
                var fresh = calls.find(function (e) {
                    return e.id != null && !S.knownCallIds[e.id]
                        && tsToMs(e.called_at) > S.dialStartedAt - 120000;
                });
                if (fresh) {
                    S.currentCall = fresh;
                    S.knownCallIds[fresh.id] = 1;
                    var dur = fresh.duration_seconds || 0;
                    if (dur >= CONNECT_SECONDS) S.stats.connects++;
                    S.stats.talk += dur;
                    stopPoll();
                    S.phase = 'disposition';
                    renderFoot();
                }
            }).catch(function () { /* transient; keep polling */ });
        }, POLL_MS);
    }
    function stopPoll() { if (S && S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

    /* ---------- dispositions ---------- */
    // Poll-first-log-second discipline: when the webhook row exists,
    // log-call MERGES the human outcome onto it. When it doesn't (rep
    // dispositioned before Quo's event landed), log-call inserts a manual
    // row and the webhook merges onto that — EXCEPT for auto-valued
    // outcomes (no_answer/voicemail), which the webhook can't claim. So
    // key 1 only writes when the webhook row is already here AND the rep
    // typed a note; otherwise it's a pure advance.
    function disposition(k) {
        if (!S) return;
        if (S.phase !== 'disposition' && S.phase !== 'dialing') return;
        if (S.panel) return;   // a sub-panel is open; its own buttons handle input
        stopPoll();
        var r = S.lead || S.queue[S.idx];
        var note = noteVal();

        if (k === 1) {
            if (S.currentCall && note) {
                var oc = S.currentCall.outcome === 'voicemail' ? 'voicemail' : 'no_answer';
                logCall(r.id, oc, { notes: note });
            }
            advance('No answer / voicemail', false);
            return;
        }
        if (k === 2) { openCallbackPanel(); return; }
        if (k === 3) { pauseForBooking(); return; }
        if (k === 4) {
            logCall(r.id, 'not_interested', { notes: note });
            advance('Not interested', false);
            return;
        }
        if (k === 5) {
            logCall(r.id, 'wrong_number', { notes: note });
            advance('Wrong number', false);
            return;
        }
        if (k === 6) { openDncPanel(); return; }
    }

    function logCall(leadId, outcome, extra) {
        S.stats.logged++;
        var body = Object.assign({ id: leadId, lead_id: leadId, outcome: outcome, notes: '' }, extra || {});
        return cfg.fetchJson('/api/prospects/log-call', { method: 'POST', body: JSON.stringify(body) })
            .catch(function (e) { console.warn('[dialer] log-call failed', e); });
    }

    /* ---------- sub-panels (callback / dnc / email / sms) ---------- */
    function panelHost() {
        var h = el('dmPanelHost');
        if (!h && S.phase === 'dialing') {
            // Disposition during a live dial: promote to the disposition
            // footer first so the panel host exists.
            S.phase = 'disposition';
            renderFoot();
            h = el('dmPanelHost');
        }
        return h;
    }

    function openCallbackPanel() {
        var h = panelHost(); if (!h) return;
        S.panel = 'callback';
        function slot(label, ms) {
            return '<button class="dm-qbtn" onclick="DIALER_MODE.setCallback(' + ms + ')">' + label + '</button>';
        }
        var now = new Date();
        var tomorrow10 = new Date(now); tomorrow10.setDate(now.getDate() + 1); tomorrow10.setHours(10, 0, 0, 0);
        var tomorrow2 = new Date(now); tomorrow2.setDate(now.getDate() + 1); tomorrow2.setHours(14, 0, 0, 0);
        var monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); monday.setHours(10, 0, 0, 0);
        h.innerHTML = '<div class="dm-panel"><h4>Callback time</h4>'
            + slot('In 2 hours', now.getTime() + 2 * 3600000)
            + slot('Tomorrow 10 AM', tomorrow10.getTime())
            + slot('Tomorrow 2 PM', tomorrow2.getTime())
            + slot('Monday 10 AM', monday.getTime())
            + '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">'
            + '<input type="datetime-local" id="dmCbCustom" class="dm-input">'
            + '<button class="dm-send" onclick="DIALER_MODE.setCallbackCustom()">Set</button>'
            + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Cancel (Esc)</button>'
            + '</div></div>';
    }
    function setCallback(ms) { commitCallback(new Date(ms).toISOString()); }
    function setCallbackCustom() {
        var v = el('dmCbCustom') && el('dmCbCustom').value;
        if (!v) return;
        commitCallback(new Date(v).toISOString());
    }
    function commitCallback(iso) {
        var r = S.lead || S.queue[S.idx];
        logCall(r.id, 'callback_requested', { next_callback_at: iso, notes: noteVal() });
        S.stats.callbacks++;
        S.panel = null;
        advance('Callback set · ' + cfg.fmtTime(iso), false);
    }

    function openDncPanel() {
        var h = panelHost(); if (!h) return;
        S.panel = 'dnc';
        h.innerHTML = '<div class="dm-panel"><h4>Do Not Call · reason required</h4>'
            + '<div style="display:flex;gap:8px;align-items:center;">'
            + '<input id="dmDncReason" class="dm-input" style="flex:1;" placeholder="Why? (e.g. asked to never call again)">'
            + '<button class="dm-send" onclick="DIALER_MODE.commitDnc()">Mark DNC</button>'
            + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Cancel (Esc)</button>'
            + '</div></div>';
        var inp = el('dmDncReason'); if (inp) inp.focus();
    }
    function commitDnc() {
        var reason = (el('dmDncReason') && el('dmDncReason').value.trim()) || '';
        if (!reason) { var inp = el('dmDncReason'); if (inp) { inp.style.borderColor = 'var(--red,#f87171)'; inp.focus(); } return; }
        var r = S.lead || S.queue[S.idx];
        logCall(r.id, 'do_not_call', { notes: reason });
        if (cfg.dncExtra) { try { cfg.dncExtra(r.id); } catch (e) {} }
        S.panel = null;
        advance('Do Not Call', false);
    }

    function openEmailPanel() {
        var h = panelHost(); if (!h) return;
        S.panel = 'email';
        var r = S.lead || S.queue[S.idx];
        h.innerHTML = '<div class="dm-panel" id="dmEmailPanel"><h4>Follow-up email</h4>'
            + '<div style="color:var(--text-muted,#6e7083);font-size:12px;">Drafting…</div></div>';
        cfg.fetchJson('/api/prospects/draft-email', { method: 'POST', body: JSON.stringify({ id: r.id }) }).then(function (d) {
            var p = el('dmEmailPanel'); if (!p || !S || S.panel !== 'email') return;
            S.emailVariant = d.variant || null;
            p.innerHTML = '<h4>Follow-up email' + (d.agent ? ' · ' + esc(d.agent) : '') + '</h4>'
                + '<input id="dmEmTo" class="dm-input" style="width:100%;margin-bottom:6px;" value="' + esc(d.to_email || r.owner_email || r.email || '') + '">'
                + '<input id="dmEmSubj" class="dm-input" style="width:100%;margin-bottom:6px;" value="' + esc(d.subject || '') + '">'
                + '<textarea id="dmEmBody" class="dm-input" style="width:100%;min-height:120px;resize:vertical;">' + esc(d.body || '') + '</textarea>'
                + '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;">'
                + '<button class="dm-send" onclick="DIALER_MODE.sendEmail()">Send</button>'
                + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Cancel (Esc)</button>'
                + '<span class="dm-hint" id="dmEmMsg"></span>'
                + '</div>';
        }).catch(function (e) {
            var p = el('dmEmailPanel'); if (!p) return;
            p.innerHTML = '<h4>Follow-up email</h4><div style="color:var(--red,#f87171);font-size:12px;">Draft failed: ' + esc((e && e.message) || 'error') + '</div>'
                + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Close</button>';
        });
    }
    function sendEmail() {
        var r = S.lead || S.queue[S.idx];
        var to = el('dmEmTo') && el('dmEmTo').value.trim();
        var subject = el('dmEmSubj') && el('dmEmSubj').value.trim();
        var body = el('dmEmBody') && el('dmEmBody').value.trim();
        var msg = el('dmEmMsg');
        if (!to || !subject || !body) { if (msg) msg.textContent = 'To, subject and body are all required.'; return; }
        if (msg) msg.textContent = 'Sending…';
        var payload = { id: r.id, to: to, subject: subject, body: body };
        if (S.emailVariant) payload.variant = S.emailVariant;
        cfg.fetchJson('/api/prospects/send-email', { method: 'POST', body: JSON.stringify(payload) }).then(function (resp) {
            if (msg) msg.textContent = (resp && resp.duplicate_suppressed) ? 'Already sent this in the last 5 min.' : 'Sent.';
            setTimeout(function () { if (S && S.panel === 'email') closePanel(); }, 900);
        }).catch(function (e) {
            var detail = (e && e.body && (e.body.reason || e.body.error)) || (e && e.message) || 'failed';
            if (msg) msg.textContent = 'Not sent: ' + detail + (e && e.body && e.body.can_override ? ' (bounced before; send from the drawer to override)' : '');
        });
    }

    function openSmsPanel() {
        var c = S.currentCall;
        if (!c || (c.duration_seconds || 0) < CONNECT_SECONDS) return;  // connected-call gate
        var h = panelHost(); if (!h) return;
        S.panel = 'sms';
        var r = S.lead || S.queue[S.idx];
        h.innerHTML = '<div class="dm-panel"><h4>Follow-up text · from your Quo line</h4>'
            + '<textarea id="dmSmsBody" class="dm-input" style="width:100%;min-height:64px;resize:vertical;" maxlength="320">' + esc(smsTemplate(r)) + '</textarea>'
            + '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;">'
            + '<button class="dm-send" onclick="DIALER_MODE.sendSms()">Send text</button>'
            + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Cancel (Esc)</button>'
            + '<span class="dm-hint" id="dmSmsMsg"></span>'
            + '</div></div>';
    }
    function sendSms() {
        var r = S.lead || S.queue[S.idx];
        var body = el('dmSmsBody') && el('dmSmsBody').value.trim();
        var msg = el('dmSmsMsg');
        if (!body) return;
        if (msg) msg.textContent = 'Sending…';
        cfg.fetchJson('/api/prospects/send-sms', { method: 'POST', body: JSON.stringify({ lead_id: r.id, body: body }) }).then(function () {
            if (msg) msg.textContent = 'Sent.';
            setTimeout(function () { if (S && S.panel === 'sms') closePanel(); }, 900);
        }).catch(function (e) {
            var detail = (e && e.body && (e.body.reason || e.body.error)) || (e && e.message) || 'failed';
            if (msg) msg.textContent = 'Not sent: ' + detail;
        });
    }

    function closePanel() {
        if (!S) return;
        S.panel = null;
        var h = el('dmPanelHost');
        if (h) h.innerHTML = '';
    }

    /* ---------- booking (key 3): reuse the page's real picker ---------- */
    function pauseForBooking() {
        var r = S.lead || S.queue[S.idx];
        S.pausedFor = 'booking';
        S.bookingPrior = r.meeting_scheduled_at || null;
        var root = el('dmRoot');
        if (root) root.classList.add('dm-hidden');
        showResumePill('Booking… click here to return to the dialer');
        try { cfg.openBooking(r); } catch (e) { console.warn('[dialer] openBooking failed', e); }
    }
    function showResumePill(label) {
        hideResumePill();
        var pill = document.createElement('button');
        pill.id = 'dmResumePill';
        pill.textContent = label || 'Resume dialer';
        pill.onclick = function () { resume(); };
        document.body.appendChild(pill);
    }
    function hideResumePill() { var p = el('dmResumePill'); if (p) p.remove(); }

    function resume() {
        if (!S) return;
        hideResumePill();
        var root = el('dmRoot');
        if (root) root.classList.remove('dm-hidden');
        if (S.pausedFor === 'booking') {
            S.pausedFor = null;
            var r = S.lead || S.queue[S.idx];
            // Did the booking actually happen? One detail read settles it.
            cfg.fetchJson('/api/prospects/detail?id=' + encodeURIComponent(r.id)).then(function (d) {
                if (!S) return;
                var booked = d && d.meeting_scheduled_at && d.meeting_scheduled_at !== S.bookingPrior;
                if (booked) {
                    S.stats.booked++;
                    advance('Booked meeting · ' + cfg.fmtTime(d.meeting_scheduled_at), false);
                } else {
                    S.phase = 'disposition';
                    renderFoot();
                }
            }).catch(function () { if (S) { S.phase = 'disposition'; renderFoot(); } });
            return;
        }
        S.pausedFor = null;
        var menu = document.querySelector('#dmRoot .dm-overlay-menu');
        if (menu) menu.remove();
        if (S.phase === 'advance') startAdvanceTimer();
    }

    /* ---------- advance ---------- */
    function advance(label, silent) {
        closePanel();
        S.lastLoggedLabel = label;
        S.phase = 'advance';
        S.advanceLeft = ADVANCE_SECONDS;
        renderFoot();
        startAdvanceTimer();
        if (!silent && cfg.onLogged) { try { cfg.onLogged((S.lead || S.queue[S.idx]).id); } catch (e) {} }
    }
    function startAdvanceTimer() {
        if (S.advTimer) clearInterval(S.advTimer);
        var total = ADVANCE_SECONDS * 1000;
        var end = Date.now() + S.advanceLeft * 1000;
        S.advTimer = setInterval(function () {
            if (!S) return;
            var left = end - Date.now();
            S.advanceLeft = Math.max(0, Math.ceil(left / 1000));
            var n = el('dmCountNum'); if (n) n.textContent = S.advanceLeft;
            var b = el('dmCountBar'); if (b) b.style.width = Math.max(0, (left / total) * 100) + '%';
            if (left <= 0) { clearInterval(S.advTimer); S.advTimer = null; nextLead(); }
        }, 100);
    }
    function nextNow() {
        if (!S || S.phase !== 'advance') return;
        if (S.advTimer) { clearInterval(S.advTimer); S.advTimer = null; }
        nextLead();
    }

    /* ---------- pause menu / summary ---------- */
    function menu() {
        if (!S) return;
        if (S.pausedFor === 'menu') return;
        if (S.advTimer) { clearInterval(S.advTimer); S.advTimer = null; }
        S.pausedFor = 'menu';
        var root = el('dmRoot');
        var wrap = document.createElement('div');
        wrap.className = 'dm-overlay-menu';
        wrap.innerHTML = '<div class="dm-menu"><h3>Session paused</h3>'
            + '<button class="dm-callbtn" style="width:100%;justify-content:center;" onclick="DIALER_MODE.resume()">Resume (Esc)</button>'
            + '<button class="dm-iconbtn" style="width:100%;margin-top:8px;" onclick="DIALER_MODE.close()">End session</button>'
            + '</div>';
        root.appendChild(wrap);
    }

    function renderSummary() {
        clearTimers(false);
        var main = el('dmMain'), foot = el('dmFoot');
        var elapsed = Date.now() - S.startedAt;
        var hrs = Math.max(elapsed / 3600000, 1 / 60);
        function cell(v, l) { return '<div class="dm-sumcell"><b>' + v + '</b><span>' + l + '</span></div>'; }
        if (main) main.innerHTML = '<div class="dm-summary" style="width:100%;">'
            + '<h2>Queue cleared.</h2>'
            + '<div style="color:var(--text-secondary,#a2a3b4);">' + fmtClock(elapsed) + ' of dialing.</div>'
            + '<div class="dm-sumgrid">'
            + cell(S.stats.dials, 'Dials')
            + cell(S.stats.dials ? Math.round(S.stats.dials / hrs) : 0, 'Dials / hr')
            + cell(S.stats.connects, 'Connects')
            + cell(fmtDur(S.stats.talk), 'Talk time')
            + cell(S.stats.callbacks, 'Callbacks')
            + cell(S.stats.booked, 'Booked')
            + '</div>'
            + '<button class="dm-callbtn" onclick="DIALER_MODE.close()">Done</button>'
            + '</div>';
        if (foot) foot.innerHTML = '';
    }

    /* ---------- keyboard ---------- */
    function onKeyDown(ev) {
        if (!S) return;
        var root = el('dmRoot');
        if (!root || root.classList.contains('dm-hidden')) return;   // paused for booking: page owns the keys
        var tag = (ev.target && ev.target.tagName) || '';
        var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

        // Everything below is ours; keep the page's handlers (admin Esc /
        // chord buffer) out of it.
        if (ev.key === 'Escape') {
            ev.stopPropagation(); ev.preventDefault();
            if (typing) { ev.target.blur(); return; }
            if (S.panel) { closePanel(); return; }
            if (S.pausedFor === 'menu') { resume(); return; }
            menu();
            return;
        }
        if (typing) return;
        if (S.pausedFor === 'menu') return;

        if (ev.key === ' ' || ev.code === 'Space') {
            ev.stopPropagation(); ev.preventDefault();
            if (S.phase === 'ready') dial();
            else if (S.phase === 'advance') nextNow();
            return;
        }
        if (ev.key >= '1' && ev.key <= '6') {
            ev.stopPropagation(); ev.preventDefault();
            disposition(parseInt(ev.key, 10));
            return;
        }
        var k = (ev.key || '').toLowerCase();
        if (k === 'n') {
            ev.stopPropagation(); ev.preventDefault();
            if (S.phase === 'ready' || S.phase === 'dialing' || S.phase === 'disposition') advance('Skipped', true);
            return;
        }
        if (k === 'e' && S.phase === 'disposition') { ev.stopPropagation(); ev.preventDefault(); if (!S.panel) openEmailPanel(); return; }
        if (k === 't' && S.phase === 'disposition') { ev.stopPropagation(); ev.preventDefault(); if (!S.panel) openSmsPanel(); return; }
    }

    /* ---------- open / close ---------- */
    function clearTimers(all) {
        stopPoll();
        if (S && S.advTimer) { clearInterval(S.advTimer); S.advTimer = null; }
        if (all && S && S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; }
    }

    function configure(opts) { cfg = opts || {}; }

    function open(opts) {
        if (!cfg) { console.warn('[dialer] configure() first'); return; }
        if (S) return;   // already open
        var rows = (opts && opts.rows) || [];
        var boot = function (queueRows) {
            // Callbacks ride in front of the board.
            cfg.fetchJson('/api/prospects/callbacks').then(function (cb) {
                start(buildQueue(queueRows, (cb && cb.results) || []));
            }).catch(function () { start(buildQueue(queueRows, [])); });
        };
        if (rows.length) boot(rows);
        else {
            cfg.fetchJson('/api/prospects/callable?limit=200').then(function (d) {
                boot((d && (d.results || d.leads)) || []);
            }).catch(function () { boot([]); });
        }
    }

    function start(queue) {
        if (!queue.length) { alert('No callable leads in the queue.'); return; }
        S = newSession(queue);
        openShell();
        tickHud();
        nextLead();
    }

    function close() {
        if (!S) return;
        clearTimers(true);
        document.removeEventListener('keydown', onKeyDown, true);
        hideResumePill();
        var root = el('dmRoot');
        if (root) root.remove();
        var done = cfg.onClose;
        S = null;
        if (done) { try { done(); } catch (e) {} }
    }

    function isOpen() { return !!S; }
    function isPaused() { return !!(S && S.pausedFor === 'booking'); }

    global.DIALER_MODE = {
        configure: configure, open: open, close: close, resume: resume,
        isOpen: isOpen, isPaused: isPaused,
        dial: dial, disposition: disposition, nextNow: nextNow, menu: menu,
        setCallback: setCallback, setCallbackCustom: setCallbackCustom,
        commitDnc: commitDnc, closePanel: closePanel,
        sendEmail: sendEmail, sendSms: sendSms
    };
})(typeof window !== 'undefined' ? window : this);
