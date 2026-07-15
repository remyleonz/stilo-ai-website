/* Meeting Confirmation mode for the VSL landing pages.
   Activates only when the URL has ?confirm=1&lid=<id>&t=<token> (the link we put
   in the 5-min confirmation email/SMS). It swaps the "Book" CTA for "Confirm My
   Meeting", and the modal shows the prospect's real date/time + Meet link (no
   booking picker, since they already booked). Tracks confirm_open + confirm. */
(function () {
    var params = new URLSearchParams(location.search);
    if (params.get('confirm') !== '1') return;
    var lid = params.get('lid'), t = params.get('t');
    if (!lid || !t) return;

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    // ai-seo and ontology have no .vsl-play button, so fall back to the slug in
    // the path (vsl-event.js does the same derivation server-side).
    function agentSlug() {
        var a = document.querySelector('.vsl-play');
        if (a) return a.getAttribute('data-agent');
        var m = /^\/agents\/([a-z0-9-]+)/.exec(location.pathname);
        return m ? m[1] : null;
    }
    function ev(name) { try { fetch('/api/public/vsl-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: name, agent: agentSlug(), lid: lid, flow: 'confirm', path: location.pathname }) }); } catch (e) {} }
    function fmtWhen(iso) { if (!iso) return 'your scheduled time'; try { return new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'; } catch (e) { return iso; } }

    function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
    ready(function () {
        document.querySelectorAll('.js-book').forEach(function (a) {
            var clone = a.cloneNode(true);           // drop any existing listeners/href
            clone.textContent = 'Confirm My Meeting';
            clone.removeAttribute('href');
            clone.style.cursor = 'pointer';
            a.parentNode.replaceChild(clone, a);
            clone.addEventListener('click', function (e) { e.preventDefault(); openConfirm(); });
        });
    });

    var overlay = null;
    async function openConfirm() {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'confirmOverlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,6,12,.82);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.style.display = 'none'; });
        }
        overlay.style.display = 'flex';
        overlay.innerHTML = '<div style="background:#0D0D11;border:1px solid rgba(255,255,255,.13);border-radius:18px;max-width:520px;width:100%;padding:30px;color:#F4F1EA;font-family:system-ui,sans-serif;text-align:center"><div style="color:#8b877e;font-size:14px">Loading your meeting…</div></div>';
        ev('confirm_open');
        var box = overlay.firstChild;
        try {
            var r = await fetch('/api/public/meeting-details?lid=' + encodeURIComponent(lid) + '&t=' + encodeURIComponent(t));
            var d = await r.json();
            if (!r.ok) { box.innerHTML = '<div style="color:#eab308;padding:8px">We could not pull up your meeting. Email stiloaiconsulting@gmail.com and we will sort it out.</div>'; return; }
            var when = fmtWhen(d.when_iso), meet = d.meet_link || d.event_link || '';
            box.innerHTML =
                '<h2 style="font-family:Georgia,serif;font-size:1.7rem;margin:0 0 6px">Confirm your meeting</h2>'
                + '<p style="color:#cfcabf;margin:0 0 20px;font-size:15px">Here are your details. Tap confirm so we know you are good to go.</p>'
                + '<div style="text-align:left;background:#151519;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:16px 18px;margin-bottom:20px">'
                + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b877e">When</div><div style="font-size:16px;font-weight:600;margin-bottom:12px">' + esc(when) + '</div>'
                + (d.business ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b877e">With</div><div style="font-size:15px;margin-bottom:12px">STILO AI Partners &middot; ' + esc(d.business) + '</div>' : '')
                + (meet ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b877e">Video link</div><div style="font-size:14px;word-break:break-all"><a href="' + esc(meet) + '" target="_blank" rel="noopener" style="color:#5A7BE8">' + esc(meet) + '</a></div>' : '')
                + '</div>'
                + (d.confirmed
                    ? '<div style="color:#10b981;font-weight:700;font-size:16px">You are all set. See you then.</div>'
                    : '<button id="cfBtn" style="width:100%;padding:16px;background:#1E3A8A;color:#fff;border:0;border-radius:10px;font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.1em;cursor:pointer">Confirm my meeting</button>')
                + '<div style="margin-top:14px"><a href="#" onclick="document.getElementById(\'confirmOverlay\').style.display=\'none\';return false" style="color:#8b877e;font-size:13px">Close</a></div>';
            var btn = document.getElementById('cfBtn');
            if (btn) btn.addEventListener('click', function () {
                btn.disabled = true; btn.textContent = 'Confirmed'; btn.style.background = '#10b981';
                ev('confirm');
                var note = document.createElement('div'); note.style.cssText = 'color:#10b981;margin-top:12px;font-weight:600'; note.textContent = 'Thank you. Your meeting is confirmed. See you then.'; btn.parentNode.appendChild(note);
            });
        } catch (e) { box.innerHTML = '<div style="color:#eab308;padding:8px">Something went wrong. Email stiloaiconsulting@gmail.com.</div>'; }
    }
})();
