/* Farm map: an illustrated map of the farm from above, made on the EcoShift server by the team's converter
   (farmmap/stylize_farm.py). The server fetches US aerial photos (USGS NAIP) and Sentinel-2 satellite imagery for the
   same square at once and keeps the sharper one; the farmer can also use their own drone or aerial photo.
   It sits in the Simulation panel behind a "Simulation | Farm map" switch and only loads when opened. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var panel = null, body = null, layer = null, tabs = null, open = false, view = 'map';
  var state = { key: '', data: null, err: null, busy: false, t0: 0 }, timer = null, seq = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  function where() {
    var s = FS.farmSetup && FS.farmSetup.setup, p = s && !s.example && s.point;
    if (p && isFinite(p.lat) && isFinite(p.lon)) return { lat: +p.lat, lon: +p.lon, label: p.label || 'your farm', own: true };
    var site = (FS.farmSetup && FS.farmSetup.site) || {}, farm = FS.data.farm || {};
    var lat = site.lat != null ? site.lat : farm.lat, lon = site.lon != null ? site.lon : farm.lon;
    return { lat: +lat, lon: +lon, label: site.name || farm.place || 'the county', own: false };
  }

  // the county example farm's map is built into the page (src/farmmaps.js): shown at once, with no server needed
  function builtIn() {
    var si = FS.farmSetup && FS.farmSetup.site, m = FS.data.farmMaps; if (!m) return null;
    var r = m[si && si.id ? si.id : 'story-ia']; return r && r.img ? r : null;
  }
  function render() {
    if (!layer) return;
    var w = where(), d = state.data, h = '', bi = !w.own && !state.upload ? builtIn() : null;
    if (bi) {
      layer.innerHTML = '<div class="fs-fm-top"><p class="fs-fm-where">From above: example farm near ' + esc(bi.name || w.label) + ' (add your address under “Your farm · Change” to draw your own farm)</p>' +
        '<label class="fs-fm-up"><input type="file" accept="image/jpeg,image/png,image/webp" id="fs-fm-file"' + (base() ? '' : ' disabled') + '><span>Use my own photo</span></label></div>' +
        '<figure class="fs-fm-fig"><img src="' + bi.img + '" alt="Illustrated map of an example farm from above: fields, trees, water and roads"></figure>' +
        '<p class="fs-fm-note">About ' + (bi.widthKm || 1.6) + ' km across. Drawn by the team\'s farm map converter from ' + (bi.source === 's2' ? 'Sentinel-2 satellite images' : 'USDA aerial photos') +
        '; the four simulation fields were found automatically. The map is a drawing made by image processing, not a field survey. Imagery: ' + esc(bi.credit || '') + '.</p>';
      var f0 = layer.querySelector('#fs-fm-file'); if (f0) f0.addEventListener('change', function () { if (f0.files && f0.files[0]) upload(f0.files[0]); });
      return;
    }
    h += '<div class="fs-fm-top"><p class="fs-fm-where">' + (state.upload ? 'Your own photo' : (w.own ? 'From above: your farm near ' + esc(w.label) : 'From above: ' + esc(w.label) + ' (add your address under “Your farm · Change” for your own spot)')) + '</p>' +
      '<label class="fs-fm-up"><input type="file" accept="image/jpeg,image/png,image/webp" id="fs-fm-file"' + (base() ? '' : ' disabled') + '><span>Use my own photo</span></label></div>';
    if (!base()) h += '<p class="fs-fm-msg">Open this page through the EcoShift server to draw your farm map (run <code>npm start</code>, then open http://localhost:8787).</p>';
    else if (state.busy) {
      var s = Math.round((Date.now() - state.t0) / 1000);
      h += '<div class="fs-fm-busy" role="status"><span class="fs-fm-spin" aria-hidden="true"></span>' + (state.upload ? 'Turning your photo into a map' : 'Getting aerial and satellite images, keeping the sharper one, and drawing your map') + '… ' + s + ' s <span class="fs-fm-faint">(usually 20–40 s)</span></div>';
    } else if (state.err) h += '<p class="fs-fm-msg fs-fm-err">' + esc(state.err) + '</p><button type="button" class="fs-fm-btn" id="fs-fm-retry">Try again</button>';
    else if (d) {
      h += '<div class="fs-fm-seg" role="group" aria-label="Show"><button type="button" data-v="map" aria-pressed="' + (view === 'map') + '">Illustrated map</button><button type="button" data-v="photo" aria-pressed="' + (view === 'photo') + '">Photo it was drawn from</button></div>' +
        '<figure class="fs-fm-fig"><img src="' + esc(base() + (view === 'map' ? d.map : d.photo)) + '" alt="' + esc(view === 'map' ? 'Illustrated map of the farm from above: fields, trees, water and roads' : 'Aerial view of the farm from above') + '"></figure>' +
        '<p class="fs-fm-note">' + (d.source === 'upload' ? 'Drawn from your photo.' : 'About ' + (d.widthKm || 1.6) + ' km across, centred on the point. Source: ' + esc(d.detail) + '.' +
          (d.scores ? ' Sharpness score ' + Object.keys(d.scores).map(function (k) { return (k === 'usgs' ? 'USGS aerial ' : k === 's2' ? 'Sentinel-2 ' : k + ' ') + (d.scores[k] == null ? 'no image' : d.scores[k]); }).join(', ') + '; the sharper one was used.' : '')) +
        ' The map is a drawing made by image processing, not a field survey; the simulation paints its four fields on the matching map in the Simulation view and uses your answers for their size and crops. ' + esc(d.credit) + '.</p>';
    }
    layer.innerHTML = h;
    var f = layer.querySelector('#fs-fm-file'); if (f) f.addEventListener('change', function () { if (f.files && f.files[0]) upload(f.files[0]); });
    var r = layer.querySelector('#fs-fm-retry'); if (r) r.addEventListener('click', function () { state.key = ''; load(); });
    Array.prototype.forEach.call(layer.querySelectorAll('.fs-fm-seg button'), function (b) { b.addEventListener('click', function () { view = b.getAttribute('data-v'); render(); }); });
  }

  function tick(on) { clearInterval(timer); timer = on ? setInterval(render, 1000) : null; }
  function run(promise, my) {
    state.busy = true; state.err = null; state.t0 = Date.now(); tick(true); render();
    promise.then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) {
        if (my !== seq) return;
        state.busy = false; tick(false);
        if (!x.ok) { state.err = (x.j && x.j.error) || 'The farm map could not be drawn.'; state.key = state.upload ? state.key : ''; }
        else { state.data = x.j; view = 'map'; if (!state.upload && FS.fieldView && FS.fieldView.offerLive) { try { var ww = where(); FS.fieldView.offerLive(ww.lat, ww.lon, x.j); } catch (e) { /* the simulation map just keeps what it has */ } } }
        render();
      })
      .catch(function () { if (my !== seq) return; state.busy = false; tick(false); state.err = 'Could not reach the EcoShift server.'; state.key = ''; render(); });
  }
  function load() {
    if (!open || !base()) { render(); return; }
    var w = where(); if (!isFinite(w.lat) || !isFinite(w.lon)) return;
    if (!w.own && builtIn() && !state.upload) { render(); return; }
    var key = w.lat.toFixed(3) + ',' + w.lon.toFixed(3);
    if (key === state.key && (state.data || state.busy)) { render(); return; }
    state.key = key; state.data = null; state.upload = false;
    run(fetch(base() + '/api/farmmap?lat=' + w.lat.toFixed(5) + '&lon=' + w.lon.toFixed(5)), ++seq);
  }
  function upload(file) {
    if (file.size > 8 * 1024 * 1024) { state.err = 'That photo is over 8 MB. Make it smaller and try again.'; render(); return; }
    state.upload = true; state.data = null; state.key = 'upload';
    run(fetch(base() + '/api/farmmap/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file }), ++seq);
  }

  function setOpen(on) {
    open = on;
    layer.hidden = !on;
    if (on) load(); else window.dispatchEvent(new Event('resize'));
  }

  function mount(p) {
    panel = p; if (!panel) return;
    body = panel.querySelector('.fs-view-body'); var right = panel.querySelector('.fs-head-right'); if (!body || !right) return;
    tabs = document.createElement('div'); tabs.className = 'fs-fm-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'View');
    tabs.innerHTML = '<button type="button" data-t="sim" aria-pressed="true">Simulation</button><button type="button" data-t="map" aria-pressed="false">Farm map</button><button type="button" data-t="now" aria-pressed="false">Advanced near-real-time conditions</button>';
    right.insertBefore(tabs, right.firstChild);
    layer = document.createElement('section'); layer.className = 'fs-fm'; layer.hidden = true; layer.setAttribute('aria-label', 'Farm map');
    body.appendChild(layer);
    // three views: the simulation, the farm map, and the conditions on the fields now (conditions.js)
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var t = b.getAttribute('data-t');
      Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-t') === t)); });
      setOpen(t === 'map');
      if (FS.conditions) FS.conditions.show(t === 'now', body);
    });
  }
  // the farm moved: a new map next time the switch is on (or now, if it is on); an uploaded photo stays until then
  function refresh() { if (state.upload) return; if (open) load(); }

  FS.farmMap = { mount: mount, refresh: refresh };
})();
