/* ============================================================
   DIAL COMPANION — the handset UI, shared by two hosts:

     · the SDR dashboard's Dialer tab (already authenticated,
       mounts with the dashboard's fetchJSON)
     · the standalone /dial/ page (its own one-time login for
       reps who bookmark the short URL)

   The laptop dialer's SPACE writes a dialer_handoff row; this
   view polls it every 2.5s (paused while the tab is hidden) and
   renders one oversized Call-in-Quo button. quo:// opens the Quo
   app pre-dialed; openphone:// and the web dialer are the quiet
   fallbacks. Deliberately NO tel: — a call from the phone's own
   number never reaches the webhook, so it would vanish from the
   lead's record.

   API:  DIAL_COMPANION.mount({ host, fetchJson, onAuthLost })
         DIAL_COMPANION.unmount()
   ============================================================ */
(function (global) {
    'use strict';

    var POLL_MS = 2500;

    var cfg = null;
    var state = { row: null, timer: null, host: null, lastSeen: null, err: false };

    var CSS = [
        '.dc{flex:1;min-height:100%;display:flex;flex-direction:column;color:#ecedf2;font-family:-apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;}',
        '.dc *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
        '.dc-stage{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:36px 26px;gap:0;}',
        '.dc-fade{animation:dcIn .35s ease both;}',
        '@keyframes dcIn{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}',

        /* status line */
        '.dc-live{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#565866;}',
        '.dc-live i{width:7px;height:7px;border-radius:50%;background:#10b981;animation:dcBlink 2.2s ease-in-out infinite;}',
        '.dc-live.dc-err i{background:#f87171;animation:none;}',
        '@keyframes dcBlink{0%,100%{opacity:1;}50%{opacity:.25;}}',

        /* waiting: radar rings around a phone glyph */
        '.dc-radar{position:relative;width:150px;height:150px;margin:34px 0 30px;display:flex;align-items:center;justify-content:center;}',
        '.dc-radar span{position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(37,99,235,.45);animation:dcPing 2.6s cubic-bezier(.2,.6,.35,1) infinite;}',
        '.dc-radar span:nth-child(2){animation-delay:.85s;}',
        '.dc-radar span:nth-child(3){animation-delay:1.7s;}',
        '@keyframes dcPing{0%{transform:scale(.42);opacity:0;}18%{opacity:.85;}100%{transform:scale(1.06);opacity:0;}}',
        '.dc-radar b{width:66px;height:66px;border-radius:50%;background:#101018;display:flex;align-items:center;justify-content:center;box-shadow:0 0 60px rgba(37,99,235,.16);}',
        '.dc-radar svg{width:26px;height:26px;stroke:#8a8c9c;}',

        '.dc-h1{font-size:24px;font-weight:700;letter-spacing:-.01em;margin:0 0 10px;line-height:1.2;}',
        '.dc-sub{font-size:14px;line-height:1.65;color:#8a8c9c;max-width:300px;margin:0 auto;}',
        '.dc-sub b{color:#c9cbd4;font-weight:600;}',
        '.dc-kbd{display:inline-block;padding:1px 7px;border-radius:5px;background:rgba(255,255,255,.09);font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:700;color:#c9cbd4;}',

        /* the handoff card */
        '.dc-tag{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#60a5fa;margin-bottom:14px;}',
        '.dc-biz{font-size:30px;font-weight:700;letter-spacing:-.015em;line-height:1.12;margin:0 0 10px;max-width:340px;}',
        '.dc-num{font-family:ui-monospace,Menlo,monospace;font-size:17px;letter-spacing:.04em;color:#8a8c9c;}',
        '.dc-age{font-size:12px;color:#565866;margin-top:10px;font-variant-numeric:tabular-nums;}',

        '.dc-callbtn{display:flex;align-items:center;justify-content:center;gap:14px;width:100%;max-width:360px;margin:36px auto 0;padding:22px;border:none;border-radius:22px;background:linear-gradient(180deg,#3070f0,#2058d4);color:#fff;font-size:19px;font-weight:700;font-family:inherit;letter-spacing:.01em;cursor:pointer;text-decoration:none;box-shadow:0 18px 50px rgba(37,99,235,.35),inset 0 1px 0 rgba(255,255,255,.18);transition:transform .08s ease;}',
        '.dc-callbtn:active{transform:scale(.965);}',
        '.dc-callbtn svg{width:22px;height:22px;fill:#fff;}',

        '.dc-alts{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:22px;flex-wrap:wrap;}',
        '.dc-alt{background:none;border:none;color:#565866;font-size:13px;font-weight:600;font-family:inherit;padding:8px 10px;cursor:pointer;text-decoration:none;border-radius:8px;}',
        '.dc-alt:active{color:#ecedf2;background:rgba(255,255,255,.06);}',
        '.dc-dot{color:#33343f;font-size:11px;}',

        '.dc-note{font-size:11.5px;line-height:1.6;color:#565866;text-align:center;max-width:320px;margin:26px auto 0;}',
        '.dc-note b{color:#8a8c9c;font-weight:600;}'
    ].join('');

    function injectCss() {
        if (document.getElementById('dcStyles')) return;
        var st = document.createElement('style');
        st.id = 'dcStyles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var PHONE_SVG = '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>';
    var PHONE_STROKE = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>';

    function liveChip() {
        return '<div class="dc-live' + (state.err ? ' dc-err' : '') + '"><i></i>' + (state.err ? 'Reconnecting' : 'Live') + '</div>';
    }

    function fmtAge(iso) {
        var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 5) return 'just now';
        if (s < 90) return s + 's ago';
        return Math.round(s / 60) + ' min ago';
    }

    function render() {
        var host = state.host;
        if (!host) return;
        var row = state.row;

        if (!row || !row.lead_id || !row.e164) {
            host.innerHTML = '<div class="dc"><div class="dc-stage dc-fade">'
                + liveChip()
                + '<div class="dc-radar"><span></span><span></span><span></span><b>' + PHONE_STROKE + '</b></div>'
                + '<h2 class="dc-h1">Standing by</h2>'
                + '<p class="dc-sub">Run the dialer on your laptop. Every <span class="dc-kbd">SPACE</span> lands here as a call button — keep this screen open.</p>'
                + '</div></div>';
            return;
        }

        var enc = encodeURIComponent(row.e164);
        host.innerHTML = '<div class="dc"><div class="dc-stage dc-fade">'
            + liveChip()
            + '<div style="margin-top:34px;" class="dc-tag">Ready to dial</div>'
            + '<h2 class="dc-biz">' + esc(row.business || 'Lead #' + row.lead_id) + '</h2>'
            + '<div class="dc-num">' + esc(row.e164) + '</div>'
            + '<div class="dc-age" id="dcAge">' + fmtAge(row.updated_at) + '</div>'
            + '<a class="dc-callbtn" href="quo://call?to=' + enc + '">' + PHONE_SVG + 'Call in Quo</a>'
            + '<div class="dc-alts">'
            + '<a class="dc-alt" href="openphone://call?to=' + enc + '">OpenPhone link</a><span class="dc-dot">·</span>'
            + '<a class="dc-alt" href="https://my.openphone.com/calls/new?to=' + enc + '" target="_blank">Web dialer</a><span class="dc-dot">·</span>'
            + '<button class="dc-alt" onclick="DIAL_COMPANION.copy()">Copy number</button>'
            + '</div>'
            + '<div class="dc-note">Always call from <b>Quo</b> — the phone\'s own dialer won\'t land the call on the lead\'s record.</div>'
            + '</div></div>';
    }

    function tick() {
        if (!cfg || !state.host) return;
        if (document.hidden) return;   // save the battery; visibilitychange re-polls
        Promise.resolve(cfg.fetchJson('/api/prospects/dialer-handoff')).then(function (row) {
            state.err = false;
            var changed = !state.row
                || (row && row.updated_at !== (state.row && state.row.updated_at))
                || (!row || !row.lead_id) !== (!state.row || !state.row.lead_id);
            state.row = row || null;
            if (changed) {
                render();
                if (row && row.lead_id && navigator.vibrate) { try { navigator.vibrate(120); } catch (e) {} }
            } else if (row && row.lead_id) {
                var age = document.getElementById('dcAge');
                if (age) age.textContent = fmtAge(row.updated_at);
            }
        }).catch(function (e) {
            if (e && e.status === 401 && cfg.onAuthLost) { unmount(); cfg.onAuthLost(); return; }
            if (!state.err) { state.err = true; render(); }
        });
    }

    function onVis() { if (!document.hidden) tick(); }

    function mount(opts) {
        unmount();
        cfg = opts || {};
        state.host = typeof cfg.host === 'string' ? document.getElementById(cfg.host) : cfg.host;
        if (!state.host) return;
        injectCss();
        state.row = null;
        state.err = false;
        render();
        tick();
        state.timer = setInterval(tick, POLL_MS);
        document.addEventListener('visibilitychange', onVis);
    }

    function unmount() {
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        document.removeEventListener('visibilitychange', onVis);
        state.host = null;
        state.row = null;
    }

    function copy() {
        if (!state.row || !state.row.e164) return;
        try { navigator.clipboard.writeText(state.row.e164).catch(function () {}); } catch (e) {}
    }

    global.DIAL_COMPANION = { mount: mount, unmount: unmount, copy: copy };
})(typeof window !== 'undefined' ? window : this);
