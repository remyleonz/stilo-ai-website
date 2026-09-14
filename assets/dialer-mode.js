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
     keys   -> 1 no answer/VM, 2 callback, 3 booked, 4 not interested,
               5 wrong number, 6 DNC (reason required); E email, T text
     auto   -> 5s countdown, next lead. Esc pauses.

   Ordering matters: we poll FIRST and log SECOND, so log-call's merge
   rule updates the Quo row in place instead of inserting a duplicate.
   Key 1 writes nothing at all — log-dial already counted the attempt
   and the webhook row carries the auto outcome (a manual no_answer row
   written before the webhook lands can never be merged).

   Queue scoping: the host page passes its CURRENT board rows, a
   fetchQueue() fallback built from its own filters, a callbacksPath
   already carrying its rep scope, and a queueScope whose clientId
   keeps client-pool and STILO callbacks from crossing into each
   other's sessions (the pool firewall).

   Notes: the lead panel carries the rep's living note (leads.rep_notes
   via save-notes, debounced autosave). Activity: calls (Quo AI summary
   + expandable transcript) merged with sent emails/SMS, collapsible.

   Booking (key 3) reuses the page's real booking picker (client
   showroom branching included) via cfg.openBooking — the session
   pauses and a floating pill brings the rep back. T (SMS) only renders
   after a 20s+ connect on THIS call (the connected-call gate).
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
            wrong_number: 'Wrong number', do_not_call: 'Do Not Call',
            interested_followup: 'Interested', owner_uninterested: 'Not interested',
            dnc_request: 'Do Not Call'
        })[o] || (o || '');
    }

    /* ---------- css (injected once; both pages, fallbacked vars) ----------
       Design language: one surface, hierarchy from type and spacing, almost
       no rules or boxes. Elevation (#0d0d13) instead of borders. Blue only
       on the call-to-action, the wordmark and the VM accent. */
    var CSS = [
        '#dmRoot{position:fixed;inset:0;z-index:12000;background:var(--bg-primary,#08080c);color:var(--text-primary,#ecedf2);display:flex;flex-direction:column;font-family:var(--font-body,-apple-system,system-ui,sans-serif);font-size:15px;-webkit-font-smoothing:antialiased;}',
        '#dmRoot *{box-sizing:border-box;}',
        '#dmRoot.dm-hidden{display:none;}',
        '#dmRoot ::-webkit-scrollbar{width:8px;height:8px;}',
        '#dmRoot ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:4px;}',
        '#dmRoot ::-webkit-scrollbar-track{background:transparent;}',

        /* HUD */
        '.dm-hud{display:flex;align-items:center;gap:22px;padding:14px 28px;flex-shrink:0;flex-wrap:wrap;}',
        '.dm-wordmark{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;font-weight:700;letter-spacing:.22em;color:var(--blue,#2563eb);white-space:nowrap;}',
        '.dm-clock{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;color:var(--text-tertiary,#6e7083);}',
        '.dm-hud-stats{display:flex;gap:30px;flex:1;justify-content:center;flex-wrap:wrap;}',
        '.dm-stat{text-align:center;min-width:46px;}',
        '.dm-stat b{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:17px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;}',
        '.dm-stat span{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted,#565866);}',
        '.dm-hud-right{display:flex;align-items:center;gap:14px;white-space:nowrap;}',
        '.dm-pos{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;color:var(--text-tertiary,#6e7083);}',
        '.dm-iconbtn{padding:7px 14px;background:transparent;border:none;border-radius:8px;color:var(--text-tertiary,#6e7083);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;}',
        '.dm-iconbtn:hover{color:var(--text-primary,#ecedf2);background:rgba(255,255,255,.05);}',

        /* Main split — lead panel gets the room, script is reference */
        '.dm-main{flex:1;display:flex;min-height:0;}',
        '.dm-lead{width:48%;min-width:440px;overflow-y:auto;padding:30px 36px 40px;}',
        '.dm-script{flex:1;overflow-y:auto;padding:30px 40px 40px;min-width:0;background:rgba(255,255,255,.014);}',
        '.dm-script-inner{max-width:700px;}',

        /* Status tokens: dot + small caps, no boxes */
        '.dm-chips{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;align-items:center;}',
        '.dm-chip{font-size:10.5px;font-weight:700;letter-spacing:.13em;color:var(--text-tertiary,#8a8c9c);display:inline-flex;align-items:center;gap:7px;border:none;padding:0;}',
        '.dm-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;}',
        '.dm-chip-cb{color:var(--blue,#60a5fa);}',
        '.dm-chip-hot{color:#f87171;}',
        '.dm-chip-warm{color:#fbbf24;}',
        '.dm-chip-client{color:#fbbf24;}',

        '.dm-bizname{font-family:var(--font-display,inherit);font-size:33px;font-weight:700;line-height:1.1;margin:0 0 6px;letter-spacing:-.01em;}',
        '.dm-niche{font-size:14px;color:var(--text-tertiary,#6e7083);margin-bottom:24px;}',

        /* Identity + status: quiet grid, no rules */
        '.dm-grid{display:grid;grid-template-columns:118px 1fr;row-gap:11px;column-gap:16px;margin-bottom:26px;}',
        '.dm-grid span{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--text-muted,#565866);font-weight:600;padding-top:3px;}',
        '.dm-grid b{font-weight:600;font-size:15px;line-height:1.35;}',
        '.dm-phone{font-family:var(--font-mono,ui-monospace,monospace);font-size:18px;font-weight:500;letter-spacing:.02em;}',
        '.dm-dim{color:var(--text-tertiary,#6e7083);font-weight:400;font-style:normal;}',

        /* Section headers */
        '.dm-sec{margin-top:28px;}',
        '.dm-sec>h4{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-muted,#565866);margin:0 0 12px;font-weight:700;display:flex;align-items:baseline;gap:10px;}',
        '.dm-savedmsg{font-size:11px;letter-spacing:.02em;text-transform:none;color:var(--text-muted,#565866);font-weight:400;}',

        /* Live notes — the rep types here mid-call, autosaves to rep_notes */
        '.dm-notes-edit{width:100%;min-height:112px;padding:14px 16px;background:rgba(255,255,255,.035);border:none;border-radius:14px;color:var(--text-primary,#ecedf2);font-family:inherit;font-size:15px;line-height:1.6;resize:vertical;outline:none;}',
        '.dm-notes-edit:focus{background:rgba(255,255,255,.055);}',
        '.dm-notes-edit::placeholder{color:var(--text-muted,#565866);}',

        /* Activity timeline: calls + emails + sms, expandable */
        '.dm-act{display:flex;align-items:baseline;gap:12px;padding:9px 0;cursor:pointer;border-radius:8px;}',
        '.dm-act:hover{background:rgba(255,255,255,.03);margin:0 -10px;padding:9px 10px;}',
        '.dm-act-k{font-size:10px;font-weight:700;letter-spacing:.12em;width:44px;flex-shrink:0;color:var(--text-muted,#565866);}',
        '.dm-act-k.dm-k-call{color:var(--blue,#60a5fa);}',
        '.dm-act-o{font-size:14px;font-weight:600;flex-shrink:0;}',
        '.dm-act-s{font-size:13.5px;color:var(--text-tertiary,#6e7083);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}',
        '.dm-act-d{font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;color:var(--text-muted,#565866);flex-shrink:0;}',
        '.dm-act-caret{color:var(--text-muted,#565866);font-size:10px;flex-shrink:0;transition:transform .15s;}',
        '.dm-act.dm-open .dm-act-caret{transform:rotate(90deg);}',
        '.dm-act-body{margin:2px 0 14px 56px;font-size:14px;line-height:1.65;color:var(--text-secondary,#a2a3b4);}',
        '.dm-act-body p{margin:0 0 10px;white-space:pre-wrap;}',
        '.dm-act-sub{font-weight:600;color:var(--text-primary,#ecedf2);margin-bottom:6px;font-size:14.5px;}',
        '.dm-act-meta{font-size:12px;color:var(--text-muted,#565866);margin-top:6px;}',
        '.dm-txlink{display:inline-block;margin-top:4px;background:none;border:none;color:var(--blue,#60a5fa);font-size:12.5px;font-weight:600;cursor:pointer;padding:0;font-family:inherit;}',
        '.dm-tx{margin-top:10px;max-height:320px;overflow-y:auto;padding:14px 16px;background:rgba(255,255,255,.03);border-radius:12px;font-size:13.5px;line-height:1.7;white-space:pre-wrap;color:var(--text-secondary,#a2a3b4);}',
        '.dm-more{background:none;border:none;color:var(--text-muted,#565866);font-size:12.5px;font-weight:600;cursor:pointer;padding:8px 0;font-family:inherit;}',
        '.dm-more:hover{color:var(--text-secondary,#a2a3b4);}',

        /* Voicemail card — the one accented block */
        '.dm-vm{margin-top:30px;background:rgba(37,99,235,.06);border-radius:14px;padding:18px 20px 18px 22px;position:relative;overflow:hidden;}',
        '.dm-vm::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--blue,#2563eb);}',
        '.dm-vm h4{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue,#60a5fa);margin:0 0 10px;font-weight:700;}',
        '.dm-vm p{margin:0;font-size:15px;line-height:1.65;color:var(--text-secondary,#c6c7d2);}',

        /* Footer */
        '.dm-foot{flex-shrink:0;padding:18px 28px 14px;background:rgba(255,255,255,.02);}',
        '.dm-foot-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;}',
        '.dm-callbtn{display:inline-flex;align-items:center;gap:12px;padding:15px 36px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:.01em;font-family:inherit;box-shadow:0 10px 34px rgba(37,99,235,.28);}',
        '.dm-callbtn:hover{filter:brightness(1.08);}',
        '.dm-key{display:inline-block;min-width:20px;text-align:center;padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.08);font-family:var(--font-mono,ui-monospace,monospace);font-size:10.5px;font-weight:700;color:var(--text-secondary,#a2a3b4);}',
        '.dm-callbtn .dm-key{background:rgba(255,255,255,.22);color:#fff;}',
        '.dm-hint{font-size:12.5px;color:var(--text-muted,#565866);}',
        '.dm-pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--green,#10b981);animation:dmPulse 1.1s ease-in-out infinite;}',
        '@keyframes dmPulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.35;transform:scale(.75);}}',
        '.dm-live{font-family:var(--font-mono,ui-monospace,monospace);font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;}',
        '.dm-result{display:inline-flex;align-items:center;gap:10px;font-size:15px;font-weight:600;}',

        /* Disposition keys: quiet pills, single line */
        '.dm-disp{display:flex;gap:6px;flex-wrap:wrap;}',
        '.dm-dbtn{display:inline-flex;align-items:center;gap:9px;padding:11px 16px;background:rgba(255,255,255,.045);border:none;border-radius:11px;color:var(--text-primary,#ecedf2);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}',
        '.dm-dbtn:hover{background:rgba(255,255,255,.09);}',

        /* Always-visible key legend */
        '.dm-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;padding-top:11px;border-top:1px solid rgba(255,255,255,.04);}',
        '.dm-legend span{font-size:11.5px;color:var(--text-muted,#565866);display:inline-flex;align-items:center;gap:6px;}',
        '.dm-legend .dm-key{font-size:9.5px;min-width:16px;padding:1px 5px;background:rgba(255,255,255,.06);color:var(--text-tertiary,#8a8c9c);}',

        /* Sub-panels */
        '.dm-panel{margin-top:14px;padding:18px 20px;background:rgba(255,255,255,.035);border-radius:14px;}',
        '.dm-panel h4{margin:0 0 12px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted,#565866);font-weight:700;}',
        '.dm-qbtn{padding:9px 16px;background:rgba(255,255,255,.05);border:none;border-radius:999px;color:var(--text-primary,#ecedf2);font-size:13px;font-weight:600;cursor:pointer;margin:0 6px 6px 0;font-family:inherit;}',
        '.dm-qbtn:hover{background:rgba(37,99,235,.22);color:#fff;}',
        '.dm-input{padding:10px 14px;background:rgba(255,255,255,.05);border:none;border-radius:10px;color:var(--text-primary,#ecedf2);font-family:inherit;font-size:14px;outline:none;}',
        '.dm-input:focus{background:rgba(255,255,255,.08);}',
        '.dm-send{padding:10px 22px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:10px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;}',
        '.dm-cancel{padding:10px 14px;background:none;border:none;color:var(--text-muted,#565866);font-size:12.5px;cursor:pointer;font-family:inherit;}',

        /* Advance countdown */
        '.dm-countwrap{flex:1;max-width:340px;}',
        '.dm-countbar{height:3px;border-radius:2px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:8px;}',
        '.dm-countbar i{display:block;height:100%;background:var(--blue,#2563eb);transition:width .1s linear;}',

        /* Summary */
        '.dm-summary{max-width:600px;margin:70px auto;text-align:center;padding:0 20px;}',
        '.dm-summary h2{font-family:var(--font-display,inherit);font-size:38px;margin:0 0 8px;letter-spacing:-.01em;}',
        '.dm-sumgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:36px 0;}',
        '.dm-sumcell{background:rgba(255,255,255,.035);border-radius:16px;padding:22px 10px;}',
        '.dm-sumcell b{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:27px;font-weight:600;}',
        '.dm-sumcell span{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-muted,#565866);}',

        '#dmResumePill{position:fixed;left:18px;bottom:18px;z-index:12001;display:flex;align-items:center;gap:10px;padding:12px 20px;background:var(--blue,#2563eb);color:#fff;border:none;border-radius:999px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 30px rgba(37,99,235,.45);font-family:inherit;}',
        '.dm-overlay-menu{position:absolute;inset:0;background:rgba(8,8,12,.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:5;}',
        '.dm-menu{background:#101017;border-radius:20px;padding:30px 34px;text-align:center;min-width:300px;}',
        '.dm-menu h3{margin:0 0 18px;font-size:18px;}',

        '@media(max-width:980px){.dm-main{flex-direction:column;overflow-y:auto;}.dm-lead{width:100%;min-width:0;padding:20px;overflow-y:visible;flex-shrink:0;}.dm-script{padding:20px;overflow:visible;flex-shrink:0;background:none;}.dm-hud{padding:10px 16px;gap:12px;}.dm-hud-stats{gap:14px;}.dm-bizname{font-size:25px;}.dm-grid{grid-template-columns:100px 1fr;}.dm-foot{padding:12px 16px 10px;}}'
    ].join('');

    function injectCss() {
        var old = el('dmStyles');
        if (old) old.remove();
        var st = document.createElement('style');
        st.id = 'dmStyles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    /* ---------- queue ---------- */
    // The rep's existing board, callbacks first: due (or coming due within
    // 30 min) callbacks are prepended to the callable rows. queueScope keeps
    // the pools honest: a Blason session only pulls Blason callbacks, a
    // STILO session never pulls a client-account one.
    function inScope(r, scope) {
        if (!scope) return true;
        if (scope.clientId) return String(r.client_id || '') === String(scope.clientId);
        return !r.client_id;
    }
    function buildQueue(rows, callbacks, scope) {
        var now = Date.now();
        var due = (callbacks || []).filter(function (r) {
            var t = tsToMs(r.next_action_due_at);
            return t && t <= now + 30 * 60 * 1000 && leadPhone(r) && inScope(r, scope);
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
            bookingPrior: null,
            startedAt: Date.now(),
            stats: { dials: 0, connects: 0, talk: 0, booked: 0, callbacks: 0, logged: 0 },
            lastLoggedLabel: '',
            emailVariant: null,
            panel: null,            // 'callback' | 'dnc' | 'email' | 'sms' | null
            activity: [],           // merged calls + messages for the open lead
            actShowAll: false,
            notes: { leadId: null, dirty: false, timer: null }
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
            + '<span class="dm-clock" id="dmClock">0:00</span>'
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
        var hrs = Math.max(elapsed / 3600000, 1 / 60);
        setText('dmStDials', S.stats.dials);
        setText('dmStConn', S.stats.connects);
        setText('dmStTalk', fmtDur(S.stats.talk));
        setText('dmStCb', S.stats.callbacks);
        setText('dmStBooked', S.stats.booked);
        setText('dmStPace', S.stats.dials ? Math.round(S.stats.dials / hrs) : 0);
        if (S.phase === 'dialing') {
            var t = el('dmLiveTimer');
            if (t) t.textContent = fmtClock(Date.now() - S.dialStartedAt);
        }
    }
    function setText(id, v) { var e = el(id); if (e) e.textContent = v; }

    /* ---------- activity (calls + sent emails/sms), collapsible ---------- */
    function buildActivity(d) {
        var items = [];
        (d.call_history || []).forEach(function (c) {
            items.push({
                kind: 'call', ts: tsToMs(c.called_at), when: c.called_at,
                outcome: c.outcome, dur: c.duration_seconds || 0,
                summary: c.transcript_summary || '', transcript: c.transcript || '',
                notes: c.notes || ''
            });
        });
        (d.nurture_messages || []).forEach(function (m) {
            if (m.direction && m.direction !== 'outbound' && m.direction !== 'outgoing') {
                items.push({
                    kind: (m.channel === 'sms') ? 'sms-in' : 'email-in', ts: tsToMs(m.sent_at), when: m.sent_at,
                    subject: m.subject || '', body: m.body || m.body_preview || ''
                });
                return;
            }
            items.push({
                kind: (m.channel === 'sms') ? 'sms' : 'email', ts: tsToMs(m.sent_at), when: m.sent_at,
                subject: m.subject || '', body: m.body || m.body_preview || '',
                opened: m.opened_at, replied: m.replied_at, bounced: m.bounced_at, status: m.status
            });
        });
        items.sort(function (a, b) { return b.ts - a.ts; });
        return items;
    }
    function actKindLabel(k) {
        return { call: 'CALL', email: 'EMAIL', sms: 'SMS', 'email-in': 'REPLY', 'sms-in': 'SMS IN' }[k] || 'ACT';
    }
    function activityHtml() {
        if (!S.activity.length) return '<div class="dm-hint">No calls or messages yet. First touch.</div>';
        var max = S.actShowAll ? 40 : 6;
        var html = S.activity.slice(0, max).map(function (a, i) {
            var head, snippet;
            if (a.kind === 'call') {
                head = '<span class="dm-act-o">' + esc(outcomeLabel(a.outcome) || 'Call') + (a.dur ? ' · ' + fmtDur(a.dur) : '') + '</span>';
                snippet = a.summary ? '<span class="dm-act-s">' + esc(a.summary) + '</span>' : '<span class="dm-act-s"></span>';
            } else {
                head = '<span class="dm-act-o">' + esc(a.subject || (a.kind.indexOf('sms') === 0 ? 'Text' : 'Email')) + '</span>';
                snippet = '<span class="dm-act-s">' + esc((a.body || '').slice(0, 80)) + '</span>';
            }
            var body;
            if (a.kind === 'call') {
                body = (a.summary ? '<p>' + esc(a.summary) + '</p>' : '<p class="dm-hint">No AI summary for this call.</p>')
                    + (a.notes ? '<p><span class="dm-dim">Rep note:</span> ' + esc(a.notes) + '</p>' : '')
                    + (a.transcript
                        ? '<button class="dm-txlink" onclick="event.stopPropagation();DIALER_MODE.toggleTx(' + i + ')">Show full transcript</button><div class="dm-tx" id="dmTx' + i + '" hidden>' + esc(a.transcript) + '</div>'
                        : '');
            } else {
                var meta = [];
                if (a.opened) meta.push('opened ' + cfg.fmtTime(a.opened));
                if (a.replied) meta.push('replied ' + cfg.fmtTime(a.replied));
                if (a.bounced) meta.push('bounced');
                body = (a.subject ? '<div class="dm-act-sub">' + esc(a.subject) + '</div>' : '')
                    + '<p>' + esc(a.body || '') + '</p>'
                    + (meta.length ? '<div class="dm-act-meta">' + esc(meta.join(' · ')) + '</div>' : '');
            }
            return '<div class="dm-act" id="dmAct' + i + '" onclick="DIALER_MODE.toggleAct(' + i + ')">'
                + '<span class="dm-act-caret">▶</span>'
                + '<span class="dm-act-k' + (a.kind === 'call' ? ' dm-k-call' : '') + '">' + actKindLabel(a.kind) + '</span>'
                + head + snippet
                + '<span class="dm-act-d">' + esc(cfg.fmtTime(a.when)) + '</span>'
                + '</div>'
                + '<div class="dm-act-body" id="dmActBody' + i + '" hidden>' + body + '</div>';
        }).join('');
        if (S.activity.length > max) {
            html += '<button class="dm-more" onclick="DIALER_MODE.actAll()">Show all ' + S.activity.length + ' touches</button>';
        }
        return html;
    }
    function toggleAct(i) {
        var b = el('dmActBody' + i), r = el('dmAct' + i);
        if (!b) return;
        b.hidden = !b.hidden;
        if (r) r.classList.toggle('dm-open', !b.hidden);
    }
    function toggleTx(i) { var t = el('dmTx' + i); if (t) t.hidden = !t.hidden; }
    function actAll() {
        S.actShowAll = true;
        var host = el('dmActivityHost');
        if (host) host.innerHTML = activityHtml();
    }

    /* ---------- live notes (leads.rep_notes via save-notes) ---------- */
    function notesChanged() {
        var ta = el('dmLiveNotes');
        if (!ta || !S) return;
        S.notes.dirty = true;
        S.notes.leadId = (S.lead || S.queue[S.idx]).id;
        setText('dmNotesSaved', 'typing…');
        if (S.notes.timer) clearTimeout(S.notes.timer);
        S.notes.timer = setTimeout(flushNotes, 900);
    }
    function flushNotes() {
        if (!S || !S.notes.dirty) return;
        var ta = el('dmLiveNotes');
        var id = S.notes.leadId;
        if (!ta || id == null) return;
        var val = ta.value;
        S.notes.dirty = false;
        cfg.fetchJson('/api/prospects/save-notes', { method: 'POST', body: JSON.stringify({ id: id, notes: val }) })
            .then(function () { if (S) setText('dmNotesSaved', 'saved'); })
            .catch(function () { if (S) { S.notes.dirty = true; setText('dmNotesSaved', 'not saved — retrying'); if (S.notes.timer) clearTimeout(S.notes.timer); S.notes.timer = setTimeout(flushNotes, 4000); } });
        if (S.lead && S.lead.id === id) S.lead.rep_notes = val;
    }

    /* ---------- lead rendering ---------- */
    function renderLead() {
        var r = S.lead || S.queue[S.idx];
        var main = el('dmMain');
        if (!main) return;
        setText('dmQueuePos', (S.idx + 1) + ' / ' + S.queue.length);

        var chips = '';
        if (r.__dmCallback) chips += '<span class="dm-chip dm-chip-cb">Callback due</span>';
        var tier = (r.prospect_tier || r.tier || '').toLowerCase();
        if (tier) chips += '<span class="dm-chip dm-chip-' + tier + '">' + esc(tier) + '</span>';
        if (r.client_id) chips += '<span class="dm-chip dm-chip-client">' + esc(r.client_company || 'Client account') + '</span>';
        if (r.primary_language === 'es') chips += '<span class="dm-chip">Español</span>';

        var g = '';
        g += '<span>Owner</span><b>' + (r.owner_name ? esc(r.owner_name) : '<i class="dm-dim">unknown</i>') + '</b>';
        if (r.front_desk_name) g += '<span>Front desk</span><b>' + esc(r.front_desk_name) + '</b>';
        g += '<span>Phone</span><b class="dm-phone">' + esc(leadPhone(r)) + '</b>';
        var lastBits = [];
        if (r.last_called_outcome) lastBits.push(outcomeLabel(r.last_called_outcome));
        if (r.last_called_at) lastBits.push(cfg.fmtTime(r.last_called_at));
        g += '<span>Last call</span><b>' + (lastBits.length ? esc(lastBits.join(' · ')) : '<i class="dm-dim">never called</i>')
            + (r.call_attempts ? ' <span class="dm-dim">· ' + esc(r.call_attempts) + ' attempts</span>' : '') + '</b>';
        if (r.next_action_type === 'callback' && r.next_action_due_at) {
            g += '<span>Callback due</span><b style="color:var(--blue,#60a5fa);">' + esc(cfg.fmtTime(r.next_action_due_at)) + '</b>';
        }

        var notesVal = (r.rep_notes != null && r.rep_notes !== '') ? r.rep_notes : (r.call_notes || '');

        main.innerHTML =
            '<div class="dm-lead">'
            + '<div class="dm-chips">' + chips + '</div>'
            + '<h2 class="dm-bizname">' + esc(r.business_name || r.name || 'Lead #' + r.id) + '</h2>'
            + '<div class="dm-niche">' + esc(r.category || r.niche || '') + (r.city ? ' · ' + esc(r.city) : '') + '</div>'
            + '<div class="dm-grid">' + g + '</div>'
            + '<div class="dm-sec"><h4>Notes <span class="dm-savedmsg" id="dmNotesSaved"></span></h4>'
            + '<textarea id="dmLiveNotes" class="dm-notes-edit" placeholder="Type while you talk. Saves on its own." oninput="DIALER_MODE.notesChanged()">' + esc(notesVal) + '</textarea></div>'
            + '<div class="dm-sec"><h4>Activity</h4><div id="dmActivityHost">' + activityHtml() + '</div></div>'
            + '<div class="dm-vm"><h4>Voicemail · read it word for word</h4><p>' + esc(vmScript(r)) + '</p></div>'
            + '</div>'
            + '<div class="dm-script"><div class="dm-script-inner" id="dmScriptPane"><div class="dm-hint">Loading script…</div></div></div>';

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
            if (pane) pane.innerHTML = '<div class="dm-hint">Could not load script.</div>';
        });

        renderFoot();
    }

    /* ---------- footer per phase ---------- */
    function legendHtml() {
        function k(key, label) { return '<span><span class="dm-key">' + key + '</span>' + label + '</span>'; }
        return '<div class="dm-legend">'
            + k('1', 'No answer / VM') + k('2', 'Callback') + k('3', 'Booked')
            + k('4', 'Not interested') + k('5', 'Wrong number') + k('6', 'DNC')
            + k('E', 'Email') + k('T', 'Text') + k('SPACE', 'Call / Next') + k('N', 'Skip') + k('ESC', 'Pause')
            + '</div>';
    }

    function renderFoot() {
        var foot = el('dmFoot');
        if (!foot) return;
        S.panel = null;

        if (S.phase === 'ready') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<button class="dm-callbtn" onclick="DIALER_MODE.dial()"><span class="dm-key">SPACE</span> Call in Quo</button>'
                + '<span style="flex:1;"></span>'
                + '<span class="dm-hint">Quo opens pre-dialed. Talk, hang up. This screen detects the hangup on its own.</span>'
                + '</div>' + legendHtml();
            return;
        }
        if (S.phase === 'dialing') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<span class="dm-pulse"></span><span class="dm-live" id="dmLiveTimer">0:00</span>'
                + '<span class="dm-hint">In Quo. Waiting for the hangup…</span>'
                + '<span style="flex:1;"></span>'
                + dispositionKeysHtml()
                + '</div>' + legendHtml();
            return;
        }
        if (S.phase === 'disposition') {
            var c = S.currentCall;
            var result = c
                ? '<span class="dm-result"><span style="color:var(--green,#10b981);">●</span> ' + esc(outcomeLabel(c.outcome)) + (c.duration_seconds ? ' · ' + fmtDur(c.duration_seconds) : '') + '</span>'
                : '<span class="dm-result dm-hint" style="font-weight:500;">No call detected yet — log it anyway</span>';
            foot.innerHTML = '<div class="dm-foot-row">' + result
                + '<span style="flex:1;"></span>' + dispositionKeysHtml()
                + '</div>'
                + '<div id="dmPanelHost"></div>'
                + legendHtml();
            return;
        }
        if (S.phase === 'advance') {
            foot.innerHTML = '<div class="dm-foot-row">'
                + '<span class="dm-result" style="color:var(--green,#10b981);">✓ ' + esc(S.lastLoggedLabel || 'Logged') + '</span>'
                + '<div class="dm-countwrap"><span class="dm-hint">Next lead in <b id="dmCountNum">' + S.advanceLeft + '</b>s</span>'
                + '<div class="dm-countbar"><i id="dmCountBar" style="width:100%;"></i></div></div>'
                + '<button class="dm-callbtn" style="padding:11px 24px;font-size:14px;" onclick="DIALER_MODE.nextNow()"><span class="dm-key">SPACE</span> Next now</button>'
                + '</div>' + legendHtml();
            return;
        }
        foot.innerHTML = '';
    }

    function dispositionKeysHtml() {
        function b(k, label) {
            return '<button class="dm-dbtn" onclick="DIALER_MODE.disposition(' + k + ')"><span class="dm-key">' + k + '</span>' + label + '</button>';
        }
        return '<div class="dm-disp">'
            + b(1, 'No answer / VM') + b(2, 'Callback') + b(3, 'Booked')
            + b(4, 'Not interested') + b(5, 'Wrong number') + b(6, 'DNC')
            + '</div>';
    }

    /* ---------- lead lifecycle ---------- */
    function nextLead() {
        flushNotes();
        clearTimers(false);
        S.idx++;
        S.currentCall = null;
        S.knownCallIds = {};
        S.panel = null;
        S.activity = [];
        S.actShowAll = false;
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
            S.activity = buildActivity(d || {});
            // Don't wipe anything the rep already typed into the notes box.
            var ta = el('dmLiveNotes');
            var typed = ta && (S.notes.dirty && S.notes.leadId === merged.id) ? ta.value : null;
            if (S.phase === 'ready' || S.phase === 'dialing') {
                var ph = S.phase;
                renderLead();
                if (ph !== 'ready') { S.phase = ph; renderFoot(); }
                if (typed != null) { var ta2 = el('dmLiveNotes'); if (ta2) ta2.value = typed; }
            }
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
    // log-call MERGES the human outcome onto it. Key 1 never writes —
    // log-dial counted the attempt and the webhook row carries the auto
    // outcome. The rep's running context lives in the Notes box
    // (rep_notes), which autosaves independently of outcomes.
    function disposition(k) {
        if (!S) return;
        if (S.phase !== 'disposition' && S.phase !== 'dialing') return;
        if (S.panel) return;   // a sub-panel is open; its own buttons handle input
        stopPoll();
        var r = S.lead || S.queue[S.idx];

        if (k === 1) { advance('No answer / voicemail', false); return; }
        if (k === 2) { openCallbackPanel(); return; }
        if (k === 3) { pauseForBooking(); return; }
        if (k === 4) { logCall(r.id, 'not_interested', {}); advance('Not interested', false); return; }
        if (k === 5) { logCall(r.id, 'wrong_number', {}); advance('Wrong number', false); return; }
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
            + '<div style="margin-top:10px;display:flex;gap:8px;align-items:center;">'
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
        logCall(r.id, 'callback_requested', { next_callback_at: iso });
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
        if (!reason) { var inp = el('dmDncReason'); if (inp) { inp.style.outline = '1px solid var(--red,#f87171)'; inp.focus(); } return; }
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
            + '<div class="dm-hint">Drafting…</div></div>';
        cfg.fetchJson('/api/prospects/draft-email', { method: 'POST', body: JSON.stringify({ id: r.id }) }).then(function (d) {
            var p = el('dmEmailPanel'); if (!p || !S || S.panel !== 'email') return;
            S.emailVariant = d.variant || null;
            p.innerHTML = '<h4>Follow-up email' + (d.agent ? ' · ' + esc(d.agent) : '') + '</h4>'
                + '<input id="dmEmTo" class="dm-input" style="width:100%;margin-bottom:6px;" value="' + esc(d.to_email || r.owner_email || r.email || '') + '">'
                + '<input id="dmEmSubj" class="dm-input" style="width:100%;margin-bottom:6px;" value="' + esc(d.subject || '') + '">'
                + '<textarea id="dmEmBody" class="dm-input" style="width:100%;min-height:130px;resize:vertical;">' + esc(d.body || '') + '</textarea>'
                + '<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">'
                + '<button class="dm-send" onclick="DIALER_MODE.sendEmail()">Send</button>'
                + '<button class="dm-cancel" onclick="DIALER_MODE.closePanel()">Cancel (Esc)</button>'
                + '<span class="dm-hint" id="dmEmMsg"></span>'
                + '</div>';
        }).catch(function (e) {
            var p = el('dmEmailPanel'); if (!p) return;
            p.innerHTML = '<h4>Follow-up email</h4><div style="color:var(--red,#f87171);font-size:13px;">Draft failed: ' + esc((e && e.message) || 'error') + '</div>'
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
            + '<textarea id="dmSmsBody" class="dm-input" style="width:100%;min-height:68px;resize:vertical;" maxlength="320">' + esc(smsTemplate(r)) + '</textarea>'
            + '<div style="display:flex;gap:8px;margin-top:10px;align-items:center;">'
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
        flushNotes();
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
        flushNotes();
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
            + '<button class="dm-iconbtn" style="width:100%;margin-top:10px;" onclick="DIALER_MODE.close()">End session</button>'
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
            + '<div style="color:var(--text-tertiary,#6e7083);">' + fmtClock(elapsed) + ' of dialing.</div>'
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
        if (S && S.notes.timer) { clearTimeout(S.notes.timer); S.notes.timer = null; }
        if (all && S && S.clockTimer) { clearInterval(S.clockTimer); S.clockTimer = null; }
    }

    function configure(opts) { cfg = opts || {}; }

    function open(opts) {
        if (!cfg) { console.warn('[dialer] configure() first'); return; }
        if (S) return;   // already open
        var rows = (opts && opts.rows) || [];
        var scope = (typeof cfg.queueScope === 'function') ? cfg.queueScope() : (cfg.queueScope || null);
        var cbPath = (typeof cfg.callbacksPath === 'function') ? cfg.callbacksPath() : (cfg.callbacksPath || '/api/prospects/callbacks');
        var boot = function (queueRows) {
            // Callbacks ride in front of the board, same scope as the board.
            cfg.fetchJson(cbPath).then(function (cb) {
                start(buildQueue(queueRows, (cb && cb.results) || [], scope));
            }).catch(function () { start(buildQueue(queueRows, [], scope)); });
        };
        if (rows.length) boot(rows);
        else if (cfg.fetchQueue) {
            Promise.resolve(cfg.fetchQueue()).then(function (r2) { boot(r2 || []); }).catch(function () { boot([]); });
        } else {
            cfg.fetchJson('/api/prospects/callable?limit=200').then(function (d) {
                boot((d && (d.results || d.leads)) || []);
            }).catch(function () { boot([]); });
        }
    }

    function start(queue) {
        if (!queue.length) { alert('No callable leads in this queue. Check the filters on the board.'); return; }
        S = newSession(queue);
        openShell();
        tickHud();
        nextLead();
    }

    function close() {
        if (!S) return;
        flushNotes();
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
        sendEmail: sendEmail, sendSms: sendSms,
        toggleAct: toggleAct, toggleTx: toggleTx, actAll: actAll,
        notesChanged: notesChanged
    };
})(typeof window !== 'undefined' ? window : this);
