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
 *
 * READING the sequence, not just auditing it (2026-08): each step opens to the
 * FULL text of every email and SMS we sent, with the links live so you can click
 * the VSL page the prospect was sent and see what they saw. Under each message
 * is its delivery trail (sent, delivered, opened, clicked, replied, bounced) with
 * real timestamps. "All activity" flips the panel to every message and page hit
 * on the lead, including the ones no step claims — reminder emails, campaign
 * sends, inbound replies — because those were invisible before and they are
 * usually the interesting ones.
 *
 * On open tracking: cold sends run with the pixel OFF on purpose (it is a spam
 * signal). So a missing `opened_at` means UNKNOWN, not "they ignored it", and
 * this file says so rather than showing a silently empty pill. The VSL page-view
 * events are the honest engagement signal.
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

    var OPEN = null;    // which step is expanded. null = collapsed.
    var ALL = false;    // "All activity" view: every message + page hit, ignoring steps.
    var PREVIEW = null; // { leadId, subject, body } from confirmation-preview.js
    var EXPANDED = {};  // message id -> true, for bodies long enough to be clamped

    var URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

    // Escape, then turn bare URLs into real anchors. Escaping the whole string
    // first and regexing the RESULT would work by luck until a URL carried a
    // query string, because `&` is `&amp;` by then and the match would stop
    // short. So split the RAW text and escape each piece for its own context.
    function linkify(text) {
        var s = String(text == null ? '' : text);
        var out = '', last = 0, m;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(s)) !== null) {
            var url = m[0];
            // Trailing sentence punctuation is not part of the link.
            var trail = '';
            while (/[.,;:!?)]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
            out += A.escape(s.slice(last, m.index));
            out += '<a href="' + A.escape(url) + '" target="_blank" rel="noopener noreferrer"'
                + ' style="color:var(--blue,#2563EB);text-decoration:underline;text-underline-offset:2px;word-break:break-all;"'
                + ' onclick="event.stopPropagation();">' + A.escape(url) + '</a>';
            out += A.escape(trail);
            last = m.index + m[0].length;
        }
        return out + A.escape(s.slice(last));
    }

    function pill(txt, color) {
        return '<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;'
            + 'background:rgba(255,255,255,.05);color:' + color + ';margin:0 5px 4px 0;">' + txt + '</span>';
    }

    // Sent -> delivered -> opened -> clicked -> replied, plus bounced as a
    // terminal red. Absent stages are shown greyed rather than omitted, so the
    // gap between "delivered but never opened" and "we never tracked opens"
    // stays visible instead of both rendering as nothing.
    function deliveryTrail(m) {
        // A message they sent US has no delivery trail. Rendering "opened /
        // clicked / replied" against their own reply reads as five things we
        // failed to do, when the reply is the win.
        if (m.direction === 'inbound') return '';
        var steps = [
            { k: 'sent', label: 'sent', at: m.sent_at, on: '#94a3b8' },
            { k: 'delivered', label: 'delivered', at: m.delivered_at, on: '#22c55e' },
            { k: 'opened', label: 'opened', at: m.opened_at, on: '#22c55e' },
            { k: 'clicked', label: 'clicked', at: m.clicked_at, on: '#22c55e' },
            { k: 'replied', label: 'replied', at: m.replied_at, on: '#22c55e' }
        ];
        // SMS has no open/click concept at all: showing dead pills for them reads
        // as a failure that never existed.
        if (m.channel === 'sms') steps = steps.filter(function (s) { return s.k !== 'opened' && s.k !== 'clicked'; });
        var html = steps.map(function (s) {
            if (s.at) return pill(s.label + ' ' + A.fmtTime(s.at), s.on);
            return pill(s.label, 'var(--text-muted)');
        }).join('');
        if (m.bounced_at) html += pill('BOUNCED ' + A.fmtTime(m.bounced_at), '#ef4444');
        // Anything the trail above does not already say. status='bounced' next to
        // a BOUNCED pill is the same fact twice.
        var said = { sent: 1, delivered: 1, bounced: 1, received: 1 };
        if (m.status && !said[m.status]) html += pill(A.escape(m.status), 'var(--text-secondary)');
        // Cold mail ships without a tracking pixel by design, so "no open" is not
        // evidence of anything. Say that instead of letting a grey pill imply it.
        if (m.channel === 'email' && !m.opened_at && !m.bounced_at) {
            html += '<span style="font-size:10px;color:var(--text-muted);">opens not tracked on this send</span>';
        }
        return '<div style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;">' + html + '</div>';
    }

    function messageCard(m) {
        var body = m.body || m.body_preview || '';
        var isEmail = m.channel === 'email';
        var inbound = m.direction === 'inbound';
        var long = body.length > 700;
        var open = long && EXPANDED[m.id];
        var accent = inbound ? '#22c55e' : (m.channel === 'sms' ? '#2563eb' : '#5A7BE8');
        // Some senders historically wrote a DESCRIPTION into body_preview instead
        // of the copy. Flagging it beats rendering the description as if it were
        // the email, which is how you end up quoting words nobody ever sent.
        // Email only: an SMS preview is capped at 300 chars, which is the whole
        // text for every message we send, so the warning there is just noise.
        var summaryOnly = !m.body && !!m.body_preview && isEmail;

        return '<div style="border:1px solid ' + (inbound ? 'rgba(34,197,94,.35)' : 'var(--border-subtle)') + ';border-radius:9px;'
            + 'padding:11px 13px;margin-bottom:9px;background:var(--bg-input);">'
            + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:6px;">'
              + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:' + accent + ';">'
                + (inbound ? '&#8592; reply &middot; ' : '') + A.escape(m.channel || 'msg')
                + (m.variant ? '<span style="font-weight:500;color:var(--text-muted);text-transform:none;letter-spacing:0;"> &middot; ' + A.escape(m.variant) + '</span>' : '')
              + '</div>'
              + '<div style="font-size:11px;color:var(--text-tertiary);white-space:nowrap;">' + A.fmtTime(m.sent_at) + '</div>'
            + '</div>'
            + (m.subject && isEmail ? '<div style="font-size:12.5px;font-weight:600;margin-bottom:5px;color:var(--text-primary);">' + A.escape(m.subject) + '</div>' : '')
            + (body
                ? '<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.62;white-space:pre-wrap;word-break:break-word;'
                    + (long && !open ? 'max-height:190px;overflow:hidden;mask-image:linear-gradient(180deg,#000 65%,transparent);-webkit-mask-image:linear-gradient(180deg,#000 65%,transparent);' : '')
                    + '">' + linkify(body) + '</div>'
                : '<div style="font-size:12px;color:var(--text-muted);">No body was stored for this send.</div>')
            + (long
                ? '<div onclick="NURTURE_STEPPER.expand(' + JSON.stringify(String(m.id)) + ')" style="margin-top:6px;font-size:11px;font-weight:600;color:var(--blue,#2563EB);cursor:pointer;">'
                    + (open ? 'Show less' : 'Read full message') + '</div>'
                : '')
            + (summaryOnly ? '<div style="margin-top:7px;font-size:10.5px;color:var(--text-muted);font-style:italic;">'
                + 'Summary line only. Sends after Aug 6, 2026 store the full text.</div>' : '')
            + '<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);">'
              + (inbound ? 'from ' : 'to ') + A.escape((inbound ? m.from_address : m.to_address) || 'unknown')
              + (m.sent_by ? ' &middot; by ' + A.escape(m.sent_by) : '')
              + (m.provider ? ' &middot; ' + A.escape(m.provider) : '')
            + '</div>'
            + deliveryTrail(m)
            + '</div>';
    }

    // Page hits, collapsed per event. Twenty scanner-driven views is one fact,
    // not twenty rows. The path is a live link: clicking it opens the exact page
    // the prospect landed on.
    function eventBlock(evs) {
        var byEv = {};
        evs.forEach(function (e) {
            var k = e.event + '|' + (e.path || '');
            byEv[k] = byEv[k] || { event: e.event, path: e.path, flow: e.flow, n: 0, first: e.created_at, last: e.created_at };
            byEv[k].n++;
            if (new Date(e.created_at) < new Date(byEv[k].first)) byEv[k].first = e.created_at;
            if (new Date(e.created_at) > new Date(byEv[k].last)) byEv[k].last = e.created_at;
        });
        var keys = Object.keys(byEv);
        if (!keys.length) return '';
        return '<div style="border:1px solid rgba(34,197,94,.25);border-radius:9px;padding:11px 13px;margin-bottom:9px;background:rgba(34,197,94,.04);">'
            + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#22c55e;margin-bottom:7px;">What they did</div>'
            + keys.map(function (k) {
                var x = byEv[k];
                return '<div style="margin-bottom:5px;font-size:12px;color:var(--text-secondary);">'
                    + pill(A.escape(x.event) + (x.n > 1 ? ' &times;' + x.n : ''), '#22c55e')
                    + (x.path
                        ? '<a href="' + A.escape(x.path) + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();"'
                            + ' style="color:var(--blue,#2563EB);text-decoration:underline;text-underline-offset:2px;font-size:11px;">' + A.escape(x.path) + '</a> '
                        : '')
                    + '<span style="color:var(--text-tertiary);font-size:11px;">first ' + A.fmtTime(x.first)
                    + (x.n > 1 ? ' &middot; last ' + A.fmtTime(x.last) : '')
                    + (x.flow ? ' &middot; ' + A.escape(x.flow) : '') + '</span>'
                    + '</div>';
            }).join('')
            + '</div>';
    }

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

    function repaint() {
        var host = document.getElementById(A.hostId);
        if (host) host.innerHTML = render(A.getLead());
    }

    function toggle(key) {
        OPEN = (OPEN === key) ? null : key;
        if (OPEN) ALL = false;
        repaint();
    }
    function toggleAll() {
        ALL = !ALL;
        if (ALL) OPEN = null;
        repaint();
    }
    function expand(id) {
        EXPANDED[id] = !EXPANDED[id];
        repaint();
    }

    // The artifacts for one step: what we sent and what they did with it. All of
    // this was already in the database and simply never rendered.
    function stepDetail(d, stage) {
        var msgs = (d.nurture_messages || []).filter(function (m) { return stage.variants.indexOf(m.variant) >= 0; });
        var evs = (d.nurture_vsl || []).filter(function (e) {
            return stage.events.indexOf(e.event) >= 0 && (stage.key !== 'vsl_watched' || e.flow === 'confirm');
        });
        // Oldest first inside a step: you read a sequence forwards.
        msgs.sort(function (a, b) { return new Date(a.sent_at || 0) - new Date(b.sent_at || 0); });

        // The confirmation email is the one carrying the VSL link, and every send
        // before Aug 6 2026 stored a description instead of the copy. Rather than
        // showing nothing, offer the live build of that email for this lead, which
        // is byte-for-byte what goes out today.
        var extra = stage.key === 'vsl_sent' ? previewBlock(d) : '';

        if (!msgs.length && !evs.length && !extra) {
            return '<div style="font-size:12px;color:var(--text-muted);padding:10px 2px;">Nothing recorded for this step yet.</div>';
        }
        return '<div style="padding:10px 2px 2px;">' + msgs.map(messageCard).join('') + eventBlock(evs) + extra + '</div>';
    }

    // Every message and every page hit on the lead, in one column, oldest first.
    // The steps deliberately only surface the variants they own, which hid the
    // T-15 reminders, the campaign sends, and every inbound reply.
    function allActivity(d) {
        var msgs = (d.nurture_messages || []).slice()
            .sort(function (a, b) { return new Date(a.sent_at || 0) - new Date(b.sent_at || 0); });
        var evs = (d.nurture_vsl || []);
        if (!msgs.length && !evs.length) {
            return '<div style="font-size:12px;color:var(--text-muted);padding:10px 2px;">No messages or page hits recorded on this lead.</div>';
        }
        var counts = msgs.reduce(function (acc, m) {
            acc[m.direction === 'inbound' ? 'in' : (m.channel === 'sms' ? 'sms' : 'email')]++;
            return acc;
        }, { email: 0, sms: 0, in: 0 });
        return '<div style="padding:10px 2px 2px;">'
            + '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:9px;">'
                + counts.email + ' emails &middot; ' + counts.sms + ' texts &middot; ' + counts.in + ' replies &middot; '
                + evs.length + ' page hits</div>'
            + msgs.map(messageCard).join('')
            + eventBlock(evs)
            + '</div>';
    }

    // Lazily fetched, so opening a step costs nothing until you ask for it.
    function previewBlock(d) {
        var id = d && d.id;
        if (id == null) return '';
        if (PREVIEW && PREVIEW.leadId === id) {
            if (PREVIEW.error) {
                return '<div style="font-size:11.5px;color:var(--red,#ef4444);padding:4px 2px;">Could not build the preview: ' + A.escape(PREVIEW.error) + '</div>';
            }
            return '<div style="border:1px dashed var(--border-medium);border-radius:9px;padding:11px 13px;">'
                + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary);margin-bottom:6px;">'
                    + 'Confirmation email as it goes out today</div>'
                + '<div style="font-size:12.5px;font-weight:600;margin-bottom:5px;color:var(--text-primary);">' + A.escape(PREVIEW.subject || '') + '</div>'
                + '<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.62;white-space:pre-wrap;word-break:break-word;">'
                    + linkify(PREVIEW.body || '') + '</div>'
                + '<div style="margin-top:7px;font-size:10.5px;color:var(--text-muted);font-style:italic;">'
                    + 'Rebuilt live from this lead. Older sends stored only a summary line, so this is the copy, not a transcript of that exact send.</div>'
                + '</div>';
        }
        return '<div onclick="NURTURE_STEPPER.loadPreview(' + id + ')" style="display:inline-block;cursor:pointer;font-size:11.5px;font-weight:600;'
            + 'color:var(--blue,#2563EB);border:1px solid rgba(59,130,246,.35);border-radius:8px;padding:6px 11px;">'
            + 'Show the confirmation email + VSL link &rarr;</div>';
    }

    async function loadPreview(leadId) {
        PREVIEW = { leadId: leadId, subject: 'Loading…', body: '' };
        repaint();
        try {
            var r = await A.fetchJson('/api/prospects/confirmation-preview?lead_id=' + encodeURIComponent(leadId));
            PREVIEW = { leadId: leadId, subject: r.subject, body: r.body };
        } catch (e) {
            PREVIEW = { leadId: leadId, error: (e && e.message) || 'unknown' };
        }
        repaint();
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
        var detail;
        if (ALL) {
            detail = '<div style="margin-top:12px;border-top:1px solid var(--border-subtle);padding-top:10px;">'
                + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);margin-bottom:2px;">'
                + 'All activity</div>' + allActivity(d) + '</div>';
        } else if (openStage) {
            detail = '<div style="margin-top:12px;border-top:1px solid var(--border-subtle);padding-top:10px;">'
                + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);margin-bottom:2px;">'
                + A.escape(openStage.label) + '</div>'
                + stepDetail(d, openStage) + '</div>';
        } else {
            detail = '<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Click any step to read the exact email and SMS we sent, click the links they got, and see what they did with it.</div>';
        }

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
                + '<div onclick="NURTURE_STEPPER.toggleAll()" style="cursor:pointer;font-size:11px;font-weight:600;padding:4px 9px;border-radius:7px;'
                  + 'border:1px solid ' + (ALL ? 'var(--blue,#2563EB)' : 'var(--border-medium)') + ';'
                  + 'color:' + (ALL ? 'var(--blue,#2563EB)' : 'var(--text-secondary)') + ';'
                  + (ALL ? 'background:rgba(59,130,246,0.10);' : '') + '">All activity</div>'
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
        toggleAll: toggleAll,
        expand: expand,
        loadPreview: loadPreview,
        setStage: setStage,
        resolveStage: resolveStage,
        stageIndex: stageIndex,
        // Called when the drawer switches leads. PREVIEW and EXPANDED are keyed
        // to a lead, so leaving them set would show one prospect's email on
        // another prospect's panel.
        reset: function () { OPEN = null; ALL = false; PREVIEW = null; EXPANDED = {}; },
    };
})(typeof window !== 'undefined' ? window : this);
