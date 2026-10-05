/**
 * assets/vsl-activity.js
 *
 * "Video page" block for the lead drawer, shared by /sdr/ and /admin/. Reads
 * lead.funnel (api/prospects/detail.js, from public.funnel_events) and renders
 * what the person did on the Blason video page: opened, played, how far they
 * watched, which quiz answers they gave (partial quizzes included), whether
 * they left contact details or booked, and whether they came from the email or
 * the text. Prepends itself to the drawer body so it is the first thing a rep
 * sees. No-op for leads with no page activity.
 */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(iso) { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
  function render(lead, host) {
    var f = lead && lead.funnel; if (!f || !host) return;
    var stage = f.booked ? ['Booked from the video page', '#10b981'] : f.contact ? ['Left contact details', '#10b981'] : f.quiz_complete ? ['Finished the quiz', '#2563EB']
      : Object.keys(f.answers).length ? ['Started the quiz', '#2563EB'] : f.pct >= 75 ? ['Watched most of the video', '#8b5cf6'] : f.plays ? ['Pressed play', '#8b5cf6'] : ['Opened the video page', '#64748b'];
    var src = Object.keys(f.sources).map(function (k) { return k + ' x' + f.sources[k]; }).join(', ');
    var answers = Object.keys(f.answers).map(function (k) { return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:999px;background:rgba(37,99,235,0.12);color:#2563EB;font-size:11px;font-weight:600;">' + esc(f.answers[k].label) + '</span>'; }).join('');
    var html = '<div id="vslActivityBlock" style="margin-bottom:18px;padding:12px 14px;border:1px solid ' + stage[1] + '55;border-left:3px solid ' + stage[1] + ';border-radius:8px;background:' + stage[1] + '0d;">'
      + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap;">'
      + '<div style="font-size:13px;font-weight:700;color:' + stage[1] + ';">Video page: ' + esc(stage[0]) + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted,#8a8aa0);">' + (f.last_seen ? 'last seen ' + esc(when(f.last_seen)) + ' ET' : '') + '</div></div>'
      + '<div style="font-size:12px;color:var(--text-secondary,#9a9ab0);margin-top:4px;">' + f.views + ' visit' + (f.views === 1 ? '' : 's') + (f.plays ? ', pressed play' + (f.pct ? ', watched ' + f.pct + '%' : '') : ', never pressed play') + (src ? ' · via ' + esc(src) : '') + (f.first_view ? ' · first ' + esc(when(f.first_view)) : '') + '</div>'
      + (answers ? '<div style="margin-top:8px;">' + answers + '</div>' : '')
      + '<div style="font-size:11px;color:var(--text-muted,#8a8aa0);margin-top:8px;">Do not mention the video on the call. Open on the machine they picked.</div>'
      + '</div>';
    var old = document.getElementById('vslActivityBlock'); if (old) old.remove();
    host.insertAdjacentHTML('afterbegin', html);
  }
  window.VSL_ACTIVITY = { render: render };
})();
