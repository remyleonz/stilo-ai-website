/**
 * Editable confirmation-email preview for the booking modal, shared by
 * /admin/ and /sdr/.
 *
 * The rep picks a time and an agent, then sees the EXACT email the prospect will
 * receive and can edit it before booking. Copy comes from
 * /api/prospects/confirmation-preview, which is built by the same module the
 * sending cron uses, so what is shown is what goes out.
 *
 * The agent dropdown drives the content: the VSL link in the body is
 * agent-specific, so changing the selection re-fetches. Debounced, and stale
 * responses are dropped by sequence number, because a rep flicking through the
 * dropdown can easily have three requests in flight and the slowest one must not
 * win.
 *
 * EDITS ARE HONOURED. readEdits() returns what the rep typed, book-meeting.js
 * stores it, and send-confirmations.js prefers it over the template. If it only
 * looked editable, this would be worse than no preview at all.
 *
 * Same shared-asset rule as cold-call-script.js / vsl-agents.js /
 * nurture-stepper.js: the two dashboards otherwise hand-duplicate markup and
 * drift. Do NOT re-inline this.
 */
(function (global) {
    'use strict';

    var A = {
        escape: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
        fetchJson: function () { return Promise.reject(new Error('confirmation-preview: fetchJson not configured')); },
    };

    var STATE = { leadId: null, seq: 0, timer: null, loaded: null, dirty: false, hostId: null };

    function ids(hostId) {
        return { subj: hostId + '_subject', body: hostId + '_body', msg: hostId + '_msg', to: hostId + '_to' };
    }

    /** Static shell. Drop it under the date/time section of the booking picker. */
    function html(hostId) {
        STATE.hostId = hostId;
        return '<div id="' + hostId + '" style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border-medium);">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">'
              + '<label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-secondary);">Confirmation email</label>'
              + '<button type="button" onclick="CONFIRMATION_PREVIEW.reset()" style="background:none;border:none;color:var(--text-tertiary);font-size:11px;cursor:pointer;text-decoration:underline;">Reset to default</button>'
            + '</div>'
            + '<div id="' + ids(hostId).to + '" style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px;">Pick a time to preview the email.</div>'
            + '<input id="' + ids(hostId).subj + '" type="text" oninput="CONFIRMATION_PREVIEW.markDirty()" placeholder="Subject"'
              + ' style="width:100%;padding:8px 10px;background:var(--bg-input);border:1px solid var(--border-medium);border-radius:8px;color:inherit;font-family:inherit;font-size:12px;font-weight:600;margin-bottom:6px;">'
            + '<textarea id="' + ids(hostId).body + '" rows="11" oninput="CONFIRMATION_PREVIEW.markDirty()" placeholder="Email body"'
              + ' style="width:100%;padding:10px 11px;background:var(--bg-input);border:1px solid var(--border-medium);border-radius:8px;color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;resize:vertical;"></textarea>'
            + '<div id="' + ids(hostId).msg + '" style="font-size:11px;color:var(--text-muted);margin-top:5px;min-height:14px;">'
              + 'This is exactly what the prospect gets. Edit it and your version is what sends.</div>'
            + '</div>';
    }

    function setMsg(text, color) {
        if (!STATE.hostId) return;
        var el = document.getElementById(ids(STATE.hostId).msg);
        if (el) { el.style.color = color || 'var(--text-muted)'; el.textContent = text; }
    }

    function markDirty() {
        STATE.dirty = true;
        setMsg('Edited. Your version is what will send.', 'var(--green,#22c55e)');
    }

    /**
     * load({ leadId, agent, whenIso, force })
     * Debounced. A rep changing the agent dropdown must not clobber text they
     * have already typed, so an existing edit is preserved unless force=true.
     */
    function load(opts) {
        opts = opts || {};
        if (!STATE.hostId) return;
        STATE.leadId = opts.leadId != null ? opts.leadId : STATE.leadId;
        if (STATE.leadId == null) return;

        if (STATE.timer) clearTimeout(STATE.timer);
        STATE.timer = setTimeout(function () { run(opts); }, 180);
    }

    async function run(opts) {
        var seq = ++STATE.seq;
        var el = ids(STATE.hostId);
        setMsg('Loading the email…');
        try {
            var qs = '?lead_id=' + encodeURIComponent(STATE.leadId);
            if (opts.agent) qs += '&agent=' + encodeURIComponent(opts.agent);
            if (opts.whenIso) qs += '&when_iso=' + encodeURIComponent(opts.whenIso);
            var data = await A.fetchJson('/api/prospects/confirmation-preview' + qs);
            // A slower earlier request must never overwrite a newer one.
            if (seq !== STATE.seq) return;

            STATE.loaded = data;
            var subjEl = document.getElementById(el.subj);
            var bodyEl = document.getElementById(el.body);
            var toEl = document.getElementById(el.to);

            // Never silently discard something the rep typed.
            if (!STATE.dirty || opts.force) {
                if (subjEl) subjEl.value = data.subject || '';
                if (bodyEl) bodyEl.value = data.body || '';
                if (opts.force) STATE.dirty = false;
            }
            if (toEl) {
                toEl.innerHTML = data.to
                    ? 'To <strong style="color:var(--text-secondary);">' + A.escape(data.to) + '</strong> · VSL: ' + A.escape(data.slug || '')
                    : '<span style="color:var(--red,#ef4444);">No email on this lead. Enter one above or the prospect gets no confirmation.</span>';
            }
            if (STATE.dirty && !opts.force) setMsg('Kept your edits. Agent link updated in the default only.', 'var(--text-tertiary)');
            else if (data.edited) setMsg('Loaded a previously edited version for this lead.', 'var(--text-tertiary)');
            else setMsg('This is exactly what the prospect gets. Edit it and your version is what sends.');
        } catch (e) {
            if (seq !== STATE.seq) return;
            setMsg('Could not load the preview: ' + ((e && e.message) || 'unknown') + '. Booking still works; the default email will send.', 'var(--red,#ef4444)');
        }
    }

    function reset() {
        if (!STATE.loaded || !STATE.hostId) return;
        var el = ids(STATE.hostId);
        var subjEl = document.getElementById(el.subj);
        var bodyEl = document.getElementById(el.body);
        if (subjEl) subjEl.value = STATE.loaded.default_subject || '';
        if (bodyEl) bodyEl.value = STATE.loaded.default_body || '';
        STATE.dirty = false;
        setMsg('Back to the default email.');
    }

    /**
     * What to send with the booking. Returns {} when untouched, so an unedited
     * booking stores NULL and keeps following future template changes rather
     * than being frozen at today's wording.
     */
    function readEdits() {
        if (!STATE.hostId || !STATE.loaded) return {};
        var el = ids(STATE.hostId);
        var subjEl = document.getElementById(el.subj);
        var bodyEl = document.getElementById(el.body);
        var subj = subjEl ? subjEl.value.trim() : '';
        var body = bodyEl ? bodyEl.value.trim() : '';
        var out = {};
        if (subj && subj !== (STATE.loaded.default_subject || '')) out.confirmation_subject = subj;
        if (body && body !== (STATE.loaded.default_body || '')) out.confirmation_body = body;
        return out;
    }

    function clear() {
        STATE.leadId = null; STATE.loaded = null; STATE.dirty = false;
        if (STATE.timer) { clearTimeout(STATE.timer); STATE.timer = null; }
        STATE.seq++;
    }

    global.CONFIRMATION_PREVIEW = {
        configure: function (cfg) { Object.keys(cfg || {}).forEach(function (k) { if (cfg[k] != null) A[k] = cfg[k]; }); },
        html: html, load: load, reset: reset, readEdits: readEdits,
        markDirty: markDirty, clear: clear,
    };
})(typeof window !== 'undefined' ? window : this);
