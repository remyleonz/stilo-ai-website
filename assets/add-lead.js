/**
 * assets/add-lead.js
 *
 * "Add lead" on both dashboards: a small form (business, website, owner,
 * phone, email, city, language, Instagram, Facebook, niche, notes) that
 * POSTs /api/prospects/create-lead and opens the new lead's panel. SDRs
 * land it in their own book and pool; admins can pick the pool and the rep.
 *
 *   ADD_LEAD.open({ admin: true|false, pools: [{id,name}], reps: [{email,name}] })
 */
(function (global) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fetcher() { return global.fetchJSON || global.prospectFetchJSON || null; }
  function opener() { return global.openLeadDrawer || global.openProspectDrawer || null; }
  var CSS = '.al-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px}.al{width:100%;max-width:560px;background:var(--bg-card,#14151c);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:20px 22px;max-height:92vh;overflow:auto;font-family:inherit}'
    + '.al h3{margin:0 0 4px;font-size:18px;font-weight:800;color:var(--text-primary,#ecedf2)}.al p{margin:0 0 14px;font-size:12px;color:var(--text-secondary,#9a9ab0)}.al-g{display:grid;grid-template-columns:1fr 1fr;gap:10px}.al-g .w{grid-column:span 2}'
    + '.al label{display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary,#9a9ab0);margin-bottom:4px}.al input,.al select,.al textarea{width:100%;box-sizing:border-box;padding:9px 11px;background:var(--bg-input,#0f1117);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:inherit;font:inherit;font-size:13px}'
    + '.al-a{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}.al-btn{border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;color:#fff;background:#2563EB}.al-btn.g{background:rgba(255,255,255,.1);color:var(--text-primary,#ecedf2)}.al-err{color:#f87171;font-size:12px;margin-top:8px;min-height:14px}';
  function ensureCss() { if (document.getElementById('addLeadCss')) return; var st = document.createElement('style'); st.id = 'addLeadCss'; st.textContent = CSS; document.head.appendChild(st); }
  function open(o) {
    o = o || {}; ensureCss();
    var old = document.getElementById('addLeadBg'); if (old) old.remove();
    var bg = document.createElement('div'); bg.id = 'addLeadBg'; bg.className = 'al-bg';
    var adminRows = '';
    if (o.admin) {
      adminRows = '<div><label>Pool</label><select name="client_id"><option value="">STILO (new client)</option>' + (o.pools || []).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') + '</select></div>'
        + '<div><label>Rep</label><select name="assigned_to">' + (o.reps || []).map(function (r) { return '<option value="' + esc(r.email) + '">' + esc(r.name || r.email) + '</option>'; }).join('') + '</select></div>';
    }
    bg.innerHTML = '<form class="al" id="addLeadForm"><h3>Add a lead</h3><p>Someone you met in a DM, a walk-in, a referral. Business name is the only required field; the rest you can fill on the call.</p>'
      + '<div class="al-g">'
      + '<div class="w"><label>Business</label><input name="name" required placeholder="Glow Med Spa"></div>'
      + '<div><label>Owner / decision maker</label><input name="owner_name" placeholder="Dr. Ana Pérez"></div>'
      + '<div><label>Owner phone</label><input name="owner_phone" placeholder="(305) 555-0199"></div>'
      + '<div><label>Email</label><input name="owner_email" type="email" placeholder="ana@glowmedspa.com"></div>'
      + '<div><label>Website</label><input name="website" placeholder="glowmedspa.com"></div>'
      + '<div><label>Instagram</label><input name="instagram_handle" placeholder="@glowmedspa"></div>'
      + '<div><label>Facebook</label><input name="facebook_url" placeholder="facebook.com/glowmedspa"></div>'
      + '<div><label>City</label><input name="city" placeholder="Doral"></div>'
      + '<div><label>Language</label><select name="primary_language"><option value="en">English</option><option value="es">Español</option></select></div>'
      + '<div><label>Niche</label><input name="niche" placeholder="Medical spa"></div>'
      + '<div><label>Temperature</label><select name="tier"><option value="cold">Cold (nothing yet)</option><option value="warm">Warm (they replied / we spoke)</option><option value="hot">Hot (real conversation)</option></select></div>'
      + adminRows
      + '<div class="w"><label>Notes</label><textarea name="notes" rows="2" placeholder="Where you met them, what they said"></textarea></div>'
      + '</div><div class="al-err" id="addLeadErr"></div>'
      + '<div class="al-a"><button type="button" class="al-btn g" id="addLeadCancel">Cancel</button><button type="submit" class="al-btn">Add lead and open it</button></div></form>';
    document.body.appendChild(bg);
    bg.querySelector('#addLeadCancel').onclick = function () { bg.remove(); };
    bg.onclick = function (ev) { if (ev.target === bg) bg.remove(); };
    bg.querySelector('#addLeadForm').onsubmit = async function (ev) {
      ev.preventDefault();
      var f = ev.target, body = {}; Array.prototype.forEach.call(f.elements, function (el) { if (el.name) body[el.name] = el.value; });
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Adding…';
      try {
        var r = await fetcher()('/api/prospects/create-lead', { method: 'POST', body: JSON.stringify(body) });
        bg.remove();
        if (!r.created && o.onDuplicate) o.onDuplicate(r);
        var op = opener(); if (op && r.lead_id) op(r.lead_id);
        if (o.onCreated) o.onCreated(r);
      } catch (e) { document.getElementById('addLeadErr').textContent = 'Could not add the lead: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Add lead and open it'; }
    };
    setTimeout(function () { var i = bg.querySelector('input[name=name]'); if (i) i.focus(); }, 50);
  }
  global.ADD_LEAD = { open: open };
})(window);
