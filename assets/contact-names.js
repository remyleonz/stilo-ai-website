/**
 * Shared CONTACTS CARD for /admin/ AND /sdr/.
 *
 * ONE renderer for both dashboards, same rule as assets/nurture-stepper.js and
 * assets/cold-call-script.js. Do NOT re-inline this into either page.
 *
 * Two editable name fields on every lead drawer:
 *   Owner / Office Manager  -> prospecting.leads.owner_name
 *   Front Desk              -> prospecting.leads.front_desk_name
 *
 * The point: the scraped owner_name is wrong often enough that reps ask for
 * the name on the call anyway. This card is where the answer lands. Each
 * field saves on blur (Enter commits, Escape reverts) through
 * /api/prospects/save-contacts. An owner edit stamps the verify columns
 * server-side ('verified' / 'rep_confirmed'), so a corrected name flows into
 * future calls, emails and SMS with no extra step. The pill next to the
 * owner label shows where the current name came from:
 *   verified + rep_confirmed  -> "Confirmed on a call" (green)
 *   verified (site scrape)    -> "Verified" (green)
 *   contradicted              -> "Site names someone else" (amber) - the
 *                                scrape found a different person; ask on the
 *                                call and type what you hear.
 *   anything else             -> "Unverified" (muted)
 *
 * The dashboards differ only in their helper names (escapeAdminHtml vs
 * escapeHtml, prospectFetchJSON vs fetchJSON), injected via configure().
 */
(function (global) {
    'use strict';

    var A = {
        escape: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
        fetchJson: function () { return Promise.reject(new Error('contact-names: fetchJson not configured')); },
        getLead: function () { return global.__lastProspectData || {}; },
        // Optional: patch cached list rows so tables show the new name without
        // a refetch. Called as onSaved(leadId, field, value).
        onSaved: null,
    };

    function configure(opts) {
        for (var k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) A[k] = opts[k];
    }

    var FIELDS = [
        { key: 'owner_name', label: 'Owner / Office Manager', placeholder: 'No name yet · ask on the call' },
        { key: 'front_desk_name', label: 'Front desk', placeholder: 'No name yet · ask on the call' }
    ];

    function ownerPillHtml(d) {
        var status = d.owner_name_verify_status || '';
        var source = d.owner_name_verify_source || '';
        var pill = function (text, color, bg, title) {
            return '<span id="cnOwnerPill" title="' + A.escape(title || '') + '" style="padding:1px 7px;border-radius:999px;font-size:9.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' + color + ';background:' + bg + ';border:1px solid ' + color + '33;white-space:nowrap;">' + text + '</span>';
        };
        if (status === 'verified' && source === 'rep_confirmed') {
            return pill('Confirmed on a call', 'var(--green,#22c55e)', 'rgba(34,197,94,0.10)', 'A rep heard this name on the phone and saved it.');
        }
        if (status === 'verified') {
            return pill('Verified', 'var(--green,#22c55e)', 'rgba(34,197,94,0.10)', 'Their own website attributes the business to this name.');
        }
        if (status === 'contradicted') {
            return pill('Site names someone else', '#f59e0b', 'rgba(245,158,11,0.10)', 'The website credits a different person. Ask on the call and type what you hear.');
        }
        if (d.owner_name) {
            return pill('Unverified', 'var(--text-muted,#6b7280)', 'rgba(255,255,255,0.04)', 'Scraped from a directory. Confirm it on the call.');
        }
        return '';
    }

    function fieldHtml(d, f) {
        var val = d[f.key] || '';
        var pill = f.key === 'owner_name' ? ownerPillHtml(d) : '';
        return '<div style="min-width:0;">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;min-height:15px;">'
              + '<span style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-secondary);white-space:nowrap;">' + f.label + '</span>'
              + '<span id="cnStatus_' + f.key + '" style="font-size:10.5px;color:var(--text-muted);white-space:nowrap;"></span>'
            + '</div>'
            + '<input id="cnInput_' + f.key + '" type="text" autocomplete="off" spellcheck="false" maxlength="120"'
              + ' value="' + A.escape(val) + '" data-saved="' + A.escape(val) + '" placeholder="' + A.escape(f.placeholder) + '"'
              + ' onkeydown="CONTACT_NAMES._key(event, this)"'
              + ' onblur="CONTACT_NAMES._blur(this, \'' + f.key + '\')"'
              + ' style="width:100%;padding:8px 11px;background:var(--bg-input);border:1px solid var(--border-medium);border-radius:8px;color:var(--text-primary);font-size:14px;font-family:inherit;outline:none;transition:border-color 0.15s;"'
              + ' onfocus="this.style.borderColor=\'var(--blue)\'"'
              + '>'
            // The pill gets its own line under the input; sharing the label
            // row made long pills collide with the neighboring column.
            + '<div id="cnPillRow_' + f.key + '" style="margin-top:5px;min-height:0;line-height:1;">' + pill + '</div>'
            + '</div>';
    }

    // The card. Sits between the action pills and the Niche/City/Email grid in
    // both drawers.
    function render(lead) {
        var d = lead || {};
        return '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:13px 16px 14px;margin-bottom:16px;">'
            + '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px;">'
              + '<span style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-secondary);">Contacts</span>'
              + '<span style="font-size:10.5px;color:var(--text-muted);">Type what you hear · saves on its own</span>'
            + '</div>'
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;">'
              + FIELDS.map(function (f) { return fieldHtml(d, f); }).join('')
            + '</div>'
          + '</div>';
    }

    function _key(ev, input) {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        else if (ev.key === 'Escape') {
            ev.preventDefault();
            input.value = input.getAttribute('data-saved') || '';
            input.blur();
        }
    }

    function _blur(input, field) {
        input.style.borderColor = 'var(--border-medium)';
        var val = input.value.trim();
        input.value = val;
        var saved = input.getAttribute('data-saved') || '';
        if (val === saved) return;
        var lead = A.getLead() || {};
        var id = lead.id;
        var status = document.getElementById('cnStatus_' + field);
        if (id == null) { if (status) { status.style.color = 'var(--red,#ef4444)'; status.textContent = 'No lead id'; } return; }
        if (status) { status.style.color = 'var(--text-muted)'; status.textContent = 'Saving…'; }
        A.fetchJson('/api/prospects/save-contacts', {
            method: 'POST',
            body: JSON.stringify({ id: id, field: field, value: val })
        }).then(function () {
            input.setAttribute('data-saved', val);
            lead[field] = val || null;
            if (field === 'owner_name') {
                // Mirror the server's verify stamps so a re-render shows the
                // right pill without a refetch, and refresh the drawer header.
                lead.owner_name_verify_status = val ? 'verified' : null;
                lead.owner_name_verify_source = val ? 'rep_confirmed' : null;
                var pillHost = document.getElementById('cnPillRow_owner_name');
                if (pillHost) pillHost.innerHTML = ownerPillHtml(lead);
                var header = document.getElementById('cnHeaderOwner');
                if (header) header.textContent = val || 'Owner (verify on call)';
            }
            if (status) {
                status.style.color = 'var(--green,#22c55e)'; status.textContent = 'Saved ✓';
                setTimeout(function () { if (status.textContent === 'Saved ✓') status.textContent = ''; }, 2500);
            }
            if (typeof A.onSaved === 'function') { try { A.onSaved(id, field, val || null); } catch (_) {} }
        }).catch(function () {
            if (status) { status.style.color = 'var(--red,#ef4444)'; status.textContent = 'Save failed · retry'; }
        });
    }

    global.CONTACT_NAMES = { configure: configure, render: render, _key: _key, _blur: _blur };
})(window);
