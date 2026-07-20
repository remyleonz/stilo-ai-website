/**
 * Shared pre-meeting NURTURE STEPPER for /admin/ AND /sdr/.
 *
 * ONE renderer for both dashboards, same rule as assets/cold-call-script.js and
 * assets/vsl-agents.js. The admin had ~250 lines of this inline; copying it into
 * the SDR file is how the two dashboards drift until they show a rep and an
 * admin different answers about the same lead. Do NOT re-inline this.
 *
 * The dashboards differ only in their helper names (escapeAdminHtml vs
 * escapeHtml, fmtETp vs fmtET, prospectFetchJSON vs fetchJSON), so they inject
 * those through configure().
 *
 * These are the six steps the shipped sequence actually sends (see
 * api/prospects/send-confirmations.js, send-vsl-followup.js, send-day-before.js).
 * The original list showed "VSL sent" twice and carried "Value email" and
 * "Triaged", neither of which any cron has ever sent, so three of six pips could
 * only ever be lit by hand.
 *
 * A pip is FILLED only when its OWN signal fired. Do not fill everything up to
 * the current stage: that quietly asserts steps we never performed, and the gaps
 * are the useful part. A lead can be Confirmed with no Watched (they replied to
 * the SMS instead of opening the page) and that is worth seeing, not smoothing.
 */
(function (global) {
    'use strict';

    var A = {
        escape: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
        fmtTime: function (t) { return t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; },
        fetchJson: function () { return Promise.reject(new Error('nurture-stepper: fetchJson not configured')); },
        hostId: 'nurtureStepperHost',
        getLead: function () { return global.__lastProspectData || {}; },
        onStageSaved: null,
    };

    var STAGES = [
        {
            key: 'booked', label: 'Booked',
            signal: function (d) { return d.meeting_booked_at || d.meeting_scheduled_at || null; },
            variants: [], events: []
        },
        {
            key: 'vsl_sent', label: 'VSL sent',
            signal: function (d) { return d.meeting_confirmation_sent_at || null; },
            variants: ['meeting_confirm', 'nurture_sms_1_booked', 'nurture_sms_1_booked_recovery'],
            events: []
        },
        {
            key: 'vsl_watched', label: 'Watched',
            // Either they hit the page, or we saw enough to text them about it.
            signal: function (d) {
                var e = (d.nurture_vsl || []).filter(function (x) {
                    return x.flow === 'confirm' && (x.event === 'view' || x.event === 'play' || x.event === 'confirm_open');
                });
                return (e.length && e[0].created_at) || d.vsl_followup_sms_sent_at || null;
            },
            variants: ['nurture_sms_2_watched'], events: ['view', 'play', 'confirm_open']
        },
        {
            key: 'confirmed', label: 'Confirmed',
            signal: function (d) {
                if (d.meeting_confirmed_at) return d.meeting_confirmed_at;
                var e = (d.nurture_vsl || []).filter(function (x) { return x.event === 'confirm'; });
                return (e.length && e[0].created_at) || null;
            },
            variants: [], events: ['confirm']
        },
        {
            key: 'day_before_sent', label: 'Day-before',
            signal: function (d) { return d.day_before_sms_sent_at || null; },
            variants: ['nurture_sms_3_day_before'], events: []
        },
        {
            key: 'showed', label: 'Showed',
            signal: function (d) {
                var m = (d.meetings || []).filter(function (x) { return x && x.outcome; });
                return (m.length && (m[0].occurred_at || m[0].created_at)) || null;
            },
            variants: [], events: []
        }
    ];

    var OPEN = null;   // which step is expanded. null = collapsed.

    function stageIndex(key) {
        for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === key) return i;
        return -1;
    }
    function signals(d) {
        return STAGES.map(function (s) {
            try { return s.signal(d || {}) || null; } catch (_) { return null; }
        });
    }
    function stageFrom(d) {
        if (!d) return null;
        var isBooked = (d.last_called_outcome === 'booked_meeting') || !!d.meeting_scheduled_at || !!d.meeting_booked_at;
        if (!isBooked) return null;
        var sig = signals(d);
        var furthest = 0;
        for (var i = 0; i < STAGES.length; i++) if (sig[i]) furthest = i;
        return STAGES[furthest].key;
    }
    function resolveStage(d) {
        var explicit = d && d.nurture_stage;
        if (explicit && stageIndex(explicit) >= 0) return { key: explicit, derived: false };
        return { key: stageFrom(d), derived: true };
    }

    function toggle(key) {
        OPEN = (OPEN === key) ? null : key;
        var host = document.getElementById(A.hostId);
        if (host) host.innerHTML = render(A.getLead());
    }

    // The artifacts for one step: what we sent and what they did with it. All of
    // this was already in the database and simply never rendered.
    function stepDetail(d, stage) {
        var msgs = (d.nurture_messages || []).filter(function (m) { return stage.variants.indexOf(m.variant) >= 0; });
        var evs = (d.nurture_vsl || []).filter(function (e) {
            return stage.events.indexOf(e.event) >= 0 && (stage.key !== 'vsl_watched' || e.flow === 'confirm');
        });
        if (!msgs.length && !evs.length) {
            return '<div style="font-size:12px;color:var(--text-muted);padding:10px 2px;">Nothing recorded for this step yet.</div>';
        }
        var pill = function (txt, color) {
            return '<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;'
                + 'background:rgba(255,255,255,.05);color:' + color + ';margin-right:5px;">' + txt + '</span>';
        };
        var msgHtml = msgs.map(function (m) {
            var flags = '';
            if (m.bounced_at) flags += pill('bounced', '#ef4444');
            else if (m.status) flags += pill(A.escape(m.status), 'var(--text-secondary)');
            if (m.opened_at) flags += pill('opened ' + A.fmtTime(m.opened_at), '#10b981');
            if (m.clicked_at) flags += pill('clicked', '#10b981');
            if (m.replied_at) flags += pill('replied', '#10b981');
            return '<div style="border:1px solid var(--border-subtle);border-radius:9px;padding:10px 12px;margin-bottom:8px;background:var(--bg-input);">'
                + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:5px;">'
                + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:' + (m.channel === 'sms' ? '#2563eb' : '#5A7BE8') + ';">'
                + A.escape(m.channel || 'msg') + '</div>'
                + '<div style="font-size:11px;color:var(--text-tertiary);white-space:nowrap;">' + A.fmtTime(m.sent_at) + '</div></div>'
                + (m.subject ? '<div style="font-size:12px;font-weight:600;margin-bottom:3px;">' + A.escape(m.subject) + '</div>' : '')
                + (m.body_preview ? '<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;white-space:pre-wrap;">' + A.escape(m.body_preview) + '</div>' : '')
                + '<div style="margin-top:7px;font-size:11px;color:var(--text-tertiary);">'
                + (m.to_address ? 'to ' + A.escape(m.to_address) + ' · ' : '') + flags + '</div>'
                + '</div>';
        }).join('');
        // Collapse repeat events into a count: 20 scanner-driven views is one
        // fact, not twenty rows.
        var byEv = {};
        evs.forEach(function (e) {
            byEv[e.event] = byEv[e.event] || { n: 0, first: e.created_at, last: e.created_at };
            byEv[e.event].n++;
            if (new Date(e.created_at) > new Date(byEv[e.event].last)) byEv[e.event].last = e.created_at;
        });
        var evHtml = Object.keys(byEv).length
            ? '<div style="font-size:12px;color:var(--text-secondary);padding:2px;">'
                + Object.keys(byEv).map(function (k) {
                    var x = byEv[k];
                    return '<div style="margin-bottom:3px;">' + pill(A.escape(k) + (x.n > 1 ? ' ×' + x.n : ''), '#10b981')
                        + '<span style="color:var(--text-tertiary);font-size:11px;">first ' + A.fmtTime(x.first)
                        + (x.n > 1 ? ' · last ' + A.fmtTime(x.last) : '') + '</span></div>';
                }).join('')
            + '</div>'
            : '';
        return '<div style="padding:10px 2px 2px;">' + msgHtml + evHtml + '</div>';
    }

    function render(d) {
        var resolved = resolveStage(d);
        if (!resolved.key) return '';
        var curIdx = stageIndex(resolved.key);
        var sig = signals(d);

        var pips = STAGES.map(function (s, i) {
            var done = !!sig[i];
            var isCur = i === curIdx;
            var isOpen = OPEN === s.key;
            var dot = '<div style="width:' + (isCur ? '13px' : '10px') + ';height:' + (isCur ? '13px' : '10px') + ';border-radius:50%;flex-shrink:0;'
                + (done ? 'background:var(--blue,#2563EB);' + (isCur ? 'box-shadow:0 0 0 4px rgba(59,130,246,0.22);' : '')
                        : 'background:transparent;border:1.5px solid var(--border-medium);')
                + '"></div>';
            return '<div onclick="NURTURE_STEPPER.toggle(\'' + s.key + '\')" title="Click to see what we sent"'
                + ' style="display:flex;flex-direction:column;align-items:center;cursor:pointer;'
                + (isOpen ? 'background:rgba(59,130,246,0.10);border-radius:8px;' : '')
                + (i < STAGES.length - 1 ? 'flex:1;' : '') + 'padding:4px 2px;">'
                + '<div style="display:flex;align-items:center;width:100%;">'
                  + '<div style="flex:1;height:2px;background:transparent;"></div>' + dot + '<div style="flex:1;height:2px;background:transparent;"></div>'
                + '</div>'
                + '<div style="margin-top:6px;font-size:9.5px;font-weight:' + (isCur ? '700' : '500') + ';letter-spacing:0.02em;text-align:center;color:'
                + (done ? (isCur ? 'var(--text-primary)' : 'var(--text-secondary)') : 'var(--text-muted)') + ';white-space:nowrap;">' + s.label + '</div>'
                + '<div style="margin-top:2px;font-size:9px;color:var(--text-muted);white-space:nowrap;">' + (sig[i] ? A.fmtTime(sig[i]) : '—') + '</div>'
                + '</div>';
        });

        var track = '';
        for (var i = 0; i < STAGES.length; i++) {
            track += pips[i];
            if (i < STAGES.length - 1) {
                track += '<div style="flex:1;height:2px;margin:9px -14px 0;border-radius:2px;align-self:flex-start;background:'
                    + (sig[i] && sig[i + 1] ? 'var(--blue,#2563EB)' : 'var(--border-medium)') + ';"></div>';
            }
        }

        var openStage = null;
        for (var j = 0; j < STAGES.length; j++) if (STAGES[j].key === OPEN) openStage = STAGES[j];
        var detail = openStage
            ? '<div style="margin-top:12px;border-top:1px solid var(--border-subtle);padding-top:10px;">'
                + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);margin-bottom:2px;">'
                + A.escape(openStage.label) + '</div>'
                + stepDetail(d, openStage) + '</div>'
            : '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Click any step to see the exact email and SMS we sent, and whether they opened it.</div>';

        var opts = STAGES.map(function (s) {
            return '<option value="' + s.key + '"' + (s.key === resolved.key && !resolved.derived ? ' selected' : '') + '>' + s.label + '</option>';
        }).join('');
        var autoTag = resolved.derived
            ? '<span style="font-size:10px;color:var(--text-muted);background:rgba(255,255,255,0.05);border:1px solid var(--border-subtle);padding:1px 7px;border-radius:999px;">auto</span>'
            : '';

        return '<div style="margin-bottom:16px;padding:14px 16px;background:var(--bg-card);border:1px solid rgba(59,130,246,0.25);border-radius:12px;">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;">'
              + '<div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--blue,#2563EB);">Nurture sequence</div>'
              + '<div style="display:flex;align-items:center;gap:8px;">' + autoTag
                + '<select onchange="NURTURE_STEPPER.setStage(' + (d && d.id != null ? d.id : 'null') + ', this.value)" style="padding:4px 8px;background:var(--bg-input);border:1px solid var(--border-medium);border-radius:7px;color:var(--text-secondary);font-size:11px;cursor:pointer;">'
                  + '<option value="">Auto-derive</option>' + opts
                + '</select>'
              + '</div>'
            + '</div>'
            + '<div style="display:flex;align-items:flex-start;">' + track + '</div>'
            + detail
            + '<div id="nurtureStageMsg" style="margin-top:8px;font-size:11px;color:var(--text-muted);min-height:14px;"></div>'
            + '</div>';
    }

    async function setStage(leadId, stage) {
        var msg = document.getElementById('nurtureStageMsg');
        if (msg) { msg.style.color = 'var(--text-muted)'; msg.textContent = 'Saving…'; }
        try {
            await A.fetchJson('/api/prospects/set-nurture-stage', {
                method: 'POST',
                body: JSON.stringify({ id: leadId, stage: stage || null })
            });
            var lead = A.getLead();
            if (lead) lead.nurture_stage = stage || null;
            if (msg) { msg.style.color = 'var(--green,#22c55e)'; msg.textContent = stage ? 'Stage set.' : 'Back to auto-derive.'; }
            var host = document.getElementById(A.hostId);
            if (host) host.innerHTML = render(lead);
            if (typeof A.onStageSaved === 'function') A.onStageSaved(leadId, stage || null);
        } catch (e) {
            if (msg) { msg.style.color = 'var(--red,#ef4444)'; msg.textContent = 'Failed: ' + ((e && e.message) || 'unknown'); }
        }
    }

    global.NURTURE_STEPPER = {
        STAGES: STAGES,
        configure: function (cfg) { Object.keys(cfg || {}).forEach(function (k) { if (cfg[k] != null) A[k] = cfg[k]; }); },
        render: render,
        toggle: toggle,
        setStage: setStage,
        resolveStage: resolveStage,
        stageIndex: stageIndex,
        reset: function () { OPEN = null; },
    };
})(typeof window !== 'undefined' ? window : this);
