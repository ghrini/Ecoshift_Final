/* "Advanced near-real-time conditions": a third view in the Simulation panel (next to Simulation and Farm map). It asks the server (/api/liveconditions,
   fieldlive.js and fieldsat.js) what is happening on the fields today: ECMWF weather, Copernicus ERA5-Land soil moisture and CAMS air,
   SoilGrids fertility, ESA WorldCover ponds and wet ground, Copernicus elevation low spots, and Sentinel-2 burned ground, bare soil and
   last summer's weak growth zones, plus NASA: fire detections (VIIRS and MODIS through NASA GIBS) that confirm or soften the burn check and a fire line, and NASA POWER (MERRA-2) soil wetness.
   Layout: a short "things to check today" list, a map of the fields drawn to scale with the places the data locates (water, wet ground,
   low spots where puddles collect, weak growth, burned ground, fire), numbered pins that match the numbered notes, then the notes grouped
   by topic (water and wet ground, soil, crop health, fire and air, weather) with small charts, and the sources at the bottom.
   With imported outlines the checks run on the exact fields; otherwise on a square of each field's size around its soil survey point. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var layer = null, open = false, seq = 0, timer = null, st = { key: '', data: null, err: null, busy: false, t0: 0, req: null }, pick = -1;
  var hs = { key: '', data: null, err: null, busy: false, t0: 0 }, hseq = 0;   // field health (this season's Sentinel-2 series)
  var hidden = {};   // map layers the farmer switched off
  var secOpen = {}, noteSec = {};   // sections the farmer opened or closed; which section each numbered note is in
  function narrow() { return !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches); }
  function isOpen(id) { return secOpen[id] != null ? secOpen[id] : !narrow(); }   // open on desktop, closed on phones until pressed
  var R = Math.PI / 180;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  function num(v, unit, k) { return v == null || !isFinite(v) ? '–' : (Math.round(v * Math.pow(10, k || 0)) / Math.pow(10, k || 0)) + (unit || ''); }

  // the fields to check: imported outlines when there are some, else a square of each field's acres around its soil point
  function request() {
    var su = FS.farmSetup && FS.farmSetup.setup, g = su && !su.example && su.geo, F = FS.data.farm.fields;
    if (g && g.fields.every(function (f) { return Array.isArray(f.ring) && f.ring.length >= 3; })) {
      return { approximate: false, fields: g.fields.filter(function (f) { return F.some(function (x) { return x.id === f.id; }); }).map(function (f) { return { id: f.id, name: f.name, ring: f.ring, holes: Array.isArray(f.holesLL) ? f.holesLL.filter(function (h) { return Array.isArray(h) && h.length >= 3; }) : [] }; }) };
    }
    return { approximate: true, fields: F.map(function (f) {
      var p = f.soil && f.soil.point; if (!p) return null;
      var half = Math.sqrt(f.acres * 4046.86) / 2, dy = half / 110574, dx = half / (111320 * Math.cos(p[1] * R));
      return { id: f.id, name: f.name, ring: [[p[0] - dx, p[1] - dy], [p[0] + dx, p[1] - dy], [p[0] + dx, p[1] + dy], [p[0] - dx, p[1] + dy]] };
    }).filter(Boolean) };
  }

  var auto = null;
  function load(force, quiet) {
    if (!open || !layer) return;
    if (!base()) { st.err = 'Live conditions need the EcoShift server (run npm start and open http://localhost:8787).'; render(); return; }
    var req = request(), key = JSON.stringify(req);
    if (!req.fields.length) { st.err = 'These fields have no location to check.'; render(); return; }
    if (!force && key === st.key && (st.data || st.busy)) { render(); return; }
    loadHealth(req, force && !quiet);
    var my = ++seq; st = { key: key, data: null, err: null, busy: true, t0: Date.now(), req: req }; pick = -1;
    clearInterval(timer); timer = setInterval(tick, 1000); render();
    fetch(base() + '/api/liveconditions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) { if (my !== seq) return; st.busy = false; if (!x.ok) st.err = (x.j && x.j.error) || 'The conditions could not be read just now.'; else { st.data = x.j; st.at = new Date(); } })
      .catch(function () { if (my !== seq) return; st.busy = false; st.err = 'Could not reach the EcoShift server.'; })
      .then(function () { if (my !== seq) return; if (!hs.busy) clearInterval(timer); render(); });
  }

  // ---------------------------------------------------------------- field health: crop and planting date of the season just grown
  function healthRequest(req) {
    var F = FS.data.farm.fields, E = FS.data.economics || {}, now = new Date(), lat0 = req.fields[0] && req.fields[0].ring[0][1], south = lat0 < 0, y = now.getUTCMonth() >= (south ? 8 : 2) ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    var irr = !!(FS.farmSetup && FS.farmSetup.canIrrigate);
    return { normalYield: E.normalYield || {}, fields: req.fields.map(function (x) {
      var f = F.filter(function (q) { return q.id === x.id; })[0] || {}, crop = f.lastCrop === 'soybean' ? 'soybean' : 'corn';
      return { id: x.id, name: x.name, ring: x.ring, holes: x.holes || [], crop: crop, plantDate: y + (south ? (crop === 'corn' ? '-10-28' : '-11-15') : (crop === 'corn' ? '-04-28' : '-05-15')), irrigable: irr };
    }) };
  }
  function loadHealth(req, force) {
    var body = healthRequest(req), key = JSON.stringify(body);
    if (!force && key === hs.key && (hs.data || hs.busy)) return;
    var my = ++hseq; hs = { key: key, data: null, err: null, busy: true, t0: Date.now() };
    fetch(base() + '/api/fieldhealth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) { if (my !== hseq) return; hs.busy = false; if (!st.busy) clearInterval(timer); if (!x.ok) hs.err = (x.j && x.j.error) || 'Field health could not be read just now.'; else hs.data = x.j; })
      .catch(function () { if (my !== hseq) return; hs.busy = false; hs.err = 'Could not reach the EcoShift server.'; })
      .then(function () { if (my !== hseq || !open) return; if (!st.busy) render(); });
  }
  // NDVI (green) and leaf water NDMI (blue, dashed) through the season
  function spark(rows) {
    if (!rows || rows.length < 2) return '';
    var W = 300, H = 80, t0 = Date.parse(rows[0].date), t1 = Date.parse(rows[rows.length - 1].date), sx = function (d) { return 6 + (Date.parse(d) - t0) / Math.max(1, t1 - t0) * (W - 12); }, sy = function (v) { return H - 6 - (v + 0.2) / 1.2 * (H - 12); };
    function line(k, cls) { return '<polyline class="' + cls + '" points="' + rows.filter(function (r) { return r[k] != null; }).map(function (r) { return sx(r.date).toFixed(1) + ',' + sy(r[k]).toFixed(1); }).join(' ') + '"/>'; }
    return '<svg class="fs-hl-spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Greenness (NDVI) and leaf water (NDMI) through the season, ' + esc(rows[0].date) + ' to ' + esc(rows[rows.length - 1].date) + '">' +
      '<line x1="6" x2="' + (W - 6) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" class="fs-hl-zero"/>' + line('ndvi', 'fs-hl-ndvi') + line('ndmi', 'fs-hl-ndmi') +
      '<text x="6" y="11" class="fs-hl-ax">' + esc(rows[0].date.slice(5)) + '</text><text x="' + (W - 6) + '" y="11" class="fs-hl-ax" text-anchor="end">' + esc(rows[rows.length - 1].date.slice(5)) + '</text></svg>';
  }
  function bar(label, sc, detail) {
    return '<div class="fs-hl-bar"><span class="fs-hl-bl">' + label + '</span><span class="fs-hl-track">' + (sc == null ? '' : '<i class="' + (sc >= 70 ? 'ok' : sc >= 45 ? 'mid' : 'bad') + '" style="width:' + sc + '%"></i>') + '</span>' +
      '<span class="fs-hl-v">' + (sc == null ? 'n/a' : sc) + '</span><span class="fs-hl-d">' + detail + '</span></div>';
  }
  function csvHref(rows) {
    var cols = ['date', 'clear_pct', 'ndvi', 'ndvi_p10', 'ndvi_p90', 'ndvi_cv', 'ndre', 'ndre_p90', 'n_sufficiency', 'ndmi', 's2rep_nm', 'savi', 'lai', 'fvc'];
    var t = cols.join(',') + '\n' + rows.map(function (r) { return cols.map(function (k) { return r[k] == null ? '' : r[k]; }).join(','); }).join('\n') + '\n';
    return 'data:text/csv;charset=utf-8,' + encodeURIComponent(t);
  }
  function healthHTML() {
    var h = '<h4 class="fs-cn-sub">This season, field by field <span class="fs-fm-faint">(Copernicus Sentinel-2)</span></h4>';
    if (hs.busy) return h + '<div class="fs-fm-busy" role="status"><span class="fs-fm-spin" aria-hidden="true"></span>Reading this season’s Sentinel-2 images of each field… <span class="fs-cn-hsec">' + Math.round((Date.now() - hs.t0) / 1000) + '</span> s <span class="fs-fm-faint">(15 to 60 s the first time)</span></div>';
    if (hs.err) return h + '<p class="fs-fm-msg fs-fm-err">' + esc(hs.err) + '</p>';
    if (!hs.data) return h;
    var D = hs.data;
    h += '<div class="fs-hl">';
    Object.keys(D.fields).forEach(function (id) {
      var f = D.fields[id], H = f.health;
      h += '<article class="fs-hl-field"><header><strong>' + esc(f.name) + '</strong> <span class="fs-fm-faint">' + esc(f.crop === 'soybean' ? 'soybeans' : f.crop) + ' · ' + f.observations + ' clear images</span></header>';
      if (f.error) { h += '<p>' + esc(f.error) + '</p></article>'; return; }
      var M = f.momentum || {}, Y = f.yieldEstimate || {}, hi = f.healthIndex != null ? f.healthIndex : f.yieldScore;
      h += '<div class="fs-hl-scores"><span class="fs-hl-big ' + (hi >= 70 ? 'ok' : hi >= 45 ? 'mid' : 'bad') + '">Health <b>' + hi + '</b>/100</span><span>Stage <b>' + esc(f.stage) + '</b></span><span>Growth <b>' + esc(M.word) + '</b></span><span>Yield guide <b>' + (Y.bu ? Y.bu + ' bu/acre' : '–') + '</b></span></div>';
      h += '<details class="fs-cn-more fs-hl-det"' + (narrow() ? '' : ' open') + '><summary>Details: greenness through the season and scores</summary><div class="fs-hl-grid"><div>' + spark(f.series) + '<p class="fs-hl-key"><i class="g"></i>greenness NDVI <i class="b"></i>leaf water NDMI</p></div><div class="fs-hl-bars">' +
        bar('Canopy', H.canopy.score, 'NDVI ' + H.canopy.ndvi + ', ' + Math.round(H.canopy.cover * 100) + '% cover') +
        bar('Nitrogen', H.nitrogen.score, H.nitrogen.note ? esc(H.nitrogen.note) : 'red edge ' + Math.round(H.nitrogen.sufficiency * 100) + '% of the field’s best (a hint only)') +
        bar('Moisture', H.moisture.score, 'leaf water NDMI ' + H.moisture.ndmi) +
        bar('Uniformity', H.uniformity.score, 'spread ' + Math.round(H.uniformity.cv * 100) + '% across the field') + '</div></div></details>';
      var top = (f.advice || []).filter(function (a) { return a.priority === 'high'; })[0] || (f.advice || [])[0];
      if (top) h += '<p class="fs-hl-todo"><span class="fs-hl-pr fs-hl-' + top.priority + '">' + top.priority + '</span> <b>' + esc(top.topic) + ':</b> ' + esc(top.text) + '</p>';
      h += '<details class="fs-cn-more"><summary>Root causes, all advice and details</summary>' +
        '<p class="fs-hl-line">Stage: <b>' + esc(f.stage) + '</b>' + (f.gdd != null ? ' (' + f.gdd + ' degree days since planting)' : '') + ' · Growth momentum: <b>' + esc(M.word) + '</b>' + (M.perWeek != null ? ' (NDVI ' + (M.perWeek > 0 ? '+' : '') + M.perWeek + ' a week' + (M.accel ? ', ' + esc(M.accel) : '') + ')' : '') + ' · Peak NDVI ' + f.peak.ndvi + ' on ' + esc(f.peak.date) + '</p>' +
        '<p class="fs-hl-line">Quality score <b>' + f.qualityScore + '</b>/100' + (Y.bu ? ' · Yield guide ' + Y.bu + ' bu/acre (range ' + Y.low + ' to ' + Y.high + '; county normal ' + Y.normal + ')' : '') + '</p>' +
        '<div class="fs-hl-bars">' + bar('Phosphorus', null, esc(H.phosphorus.note)) + bar('Leaf structure', H.leaf.score, 'red-edge position ' + H.leaf.redEdgeNm + ' nm') + '</div>' +
        '<p class="fs-fm-faint fs-hl-small">The health index (0 to 100) compares the canopy with a healthy crop’s normal peak, and the nitrogen, leaf structure and evenness with this field’s own best parts.</p>' +
        (Y.note ? '<p class="fs-fm-faint fs-hl-small">' + esc(Y.note) + '</p>' : '') +
        '<div class="fs-hl-cols"><div><h5>Root causes</h5><ul>' + f.causes.map(function (c) { return '<li><b>' + esc(c.cause) + '</b> <span class="fs-fm-faint">(' + esc(c.confidence) + ' confidence)</span>: ' + esc(c.why) + '</li>'; }).join('') + '</ul></div>' +
        '<div><h5>What to do</h5><ul class="fs-hl-adv">' + f.advice.map(function (a) { return '<li><span class="fs-hl-pr fs-hl-' + a.priority + '">' + a.priority + '</span> <b>' + esc(a.topic) + ':</b> ' + esc(a.text) + '</li>'; }).join('') + '</ul></div></div>' +
        '<p class="fs-hl-small"><a download="' + esc((f.name || id).replace(/[^\w-]+/g, '_')) + '_sentinel2.csv" href="' + csvHref(f.series || []) + '">Download this field’s data (CSV)</a>' + (f.csv ? ' · also saved on the server as <code>' + esc(String(f.csv).split(/[\\/]/).pop()) + '</code>' : '') + '</p></details></article>';
    });
    h += '</div>';
    return h + '<details class="fs-cn-more"><summary>How field health is worked out</summary><p class="fs-fm-note">' + esc((D.sources || []).join(' ')) + ' The health index, the yield guide, causes and advice are rules on published satellite indices (NDVI, NDRE, NDMI, red-edge position), not a model trained on harvests. Crop and planting date come from the farm setup (the last crop on each field; corn 28 April, soybeans 15 May, six months later south of the equator). Sentinel-1 radar and Sentinel-3 are not used: Sentinel-3 pixels (300 m) are bigger than most fields.</p></details>';
  }

  // ---------------------------------------------------------------- the map: fields to scale, located findings as layers, numbered pins
  var LAYERS = [
    ['water', 'Open water (pond, stream)', 'ESA WorldCover 2021'],
    ['wetland', 'Wetland / wet ground', 'ESA WorldCover 2021'],
    ['low', 'Low, flat spots where water collects', 'Copernicus elevation'],
    ['weak', 'Weak growth last summer', 'Sentinel-2'],
    ['burn', 'Possible burned ground', 'Sentinel-2'],
    ['fire', 'Fire seen near the field', 'NASA VIIRS/MODIS']
  ];
  function wetWord(d) { var w = d.wetNow; return w ? w.level : 'unknown'; }
  function lowLabel(d) {
    var w = wetWord(d);
    return w === 'likely' ? 'Low spots: puddles likely now' : w === 'possible' ? 'Low spots: puddles possible now' : 'Low spots where water collects after heavy rain';
  }
  function mapSVG(d, req, list) {
    var lat0 = 0, n0 = 0;
    req.fields.forEach(function (f) { f.ring.forEach(function (p) { lat0 += p[1]; n0++; }); }); lat0 /= n0;
    var k = Math.cos(lat0 * R), M = 110574;   // metres per degree of latitude; x is longitude times cos(latitude), so both axes are in the same units
    var xs = [], ys = [];
    req.fields.forEach(function (f) { f.ring.forEach(function (p) { xs.push(p[0] * k); ys.push(-p[1]); }); });
    var padD = 120 / M, x0 = Math.min.apply(null, xs) - padD, x1 = Math.max.apply(null, xs) + padD, y0 = Math.min.apply(null, ys) - padD, y1 = Math.max.apply(null, ys) + padD;
    var W = layer && layer.clientWidth && layer.clientWidth < 600 ? 400 : 720;   // a narrower drawing on phones, so labels and pins stay readable
    var H = Math.round(Math.max(W * 0.45, Math.min(W * 0.78, W * (y1 - y0) / Math.max(x1 - x0, 1e-9)))), s = Math.min(W / (x1 - x0), H / (y1 - y0));
    var ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
    function P(lon, lat) { return [ox + (lon * k - x0) * s, oy + (-lat - y0) * s]; }
    function sq(cells, wDeg, hDeg, band) {   // many small squares as one path (band: only the cells outside the field, false: only those inside)
      var w = Math.max(wDeg * k * s, 1.2), h = Math.max(hDeg * s, 1.2), out = '';
      (cells || []).forEach(function (c) {
        var lon = Array.isArray(c) ? c[0] : c.lon, lat = Array.isArray(c) ? c[1] : c.lat, ins = Array.isArray(c) ? c[2] : c.inside;
        if (band != null && (ins === false) !== band) return;
        var p = P(lon, lat); out += 'M' + (p[0] - w / 2).toFixed(1) + ' ' + (p[1] - h / 2).toFixed(1) + 'h' + w.toFixed(1) + 'v' + h.toFixed(1) + 'h' + (-w).toFixed(1) + 'z';
      });
      return out;
    }
    function lay(L, band) {   // one returned layer of cells: { stepDeg: [dlon, dlat], cellM?, cells }
      if (!L || !L.cells) return '';
      return L.cellM ? sq(L.cells, L.cellM / (111320 * k), L.cellM / M, band) : L.stepDeg ? sq(L.cells, L.stepDeg[0], L.stepDeg[1], band) : '';
    }
    var paths = { water: '', wetland: '', low: '', weak: '', burn: '' }, band = { water: '', wetland: '' }, fireIds = {};
    Object.keys(d.fields).forEach(function (id) {
      var x = d.fields[id], c = x.cover && x.cover.cells, t = x.terrain && x.terrain.lowCells, sat = x.satellite || {};
      if (c) { paths.water += lay(c.water, false); paths.wetland += lay(c.wetland, false); band.water += lay(c.water, true); band.wetland += lay(c.wetland, true); }
      if (t) paths.low += lay(t);
      ((sat.summer && sat.summer.weakZones) || []).forEach(function (z) { if (z.cells) paths.weak += sq(z.cells, z.cellM / (111320 * k), z.cellM / M); });
      ((sat.burn && sat.burn.patches) || []).forEach(function (z) { if (z.cells) paths.burn += sq(z.cells, z.cellM / (111320 * k), z.cellM / M); });
    });
    ((d.nasa && d.nasa.fire && d.nasa.fire.detections) || []).forEach(function (x) { fireIds[x.field] = 1; });
    var cls = 'fs-cn-map fs-cn-wet-' + wetWord(d) + Object.keys(hidden).filter(function (q) { return hidden[q]; }).map(function (q) { return ' hide-' + q; }).join('');
    var desc = [];
    LAYERS.forEach(function (L) { if (L[0] === 'fire' ? Object.keys(fireIds).length : paths[L[0]] || band[L[0]]) desc.push(L[0] === 'low' ? lowLabel(d) : L[1]); });
    var svg = '<svg class="' + cls + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="fs-cn-mt fs-cn-md"><title id="fs-cn-mt">Map of your fields, drawn to scale, north up</title>' +
      '<desc id="fs-cn-md">' + esc((desc.length ? 'Shows: ' + desc.join('; ') + '.' : 'No water, low spots, weak growth or burned ground found on the fields.') + ' Numbered pins match the numbered notes below the map.') + '</desc>' +
      '<defs><clipPath id="fs-cn-clip"><rect width="' + W + '" height="' + H + '"/></clipPath></defs><g clip-path="url(#fs-cn-clip)">' +
      '<rect width="' + W + '" height="' + H + '" class="fs-cn-bgd"/>';
    req.fields.forEach(function (f) {
      var ringD = function (r) { return 'M' + r.map(function (q) { return P(q[0], q[1]).map(function (v) { return v.toFixed(1); }).join(' '); }).join('L') + 'Z'; };
      svg += '<path fill-rule="evenodd" d="' + ringD(f.ring) + (f.holes || []).map(ringD).join('') + '" class="fs-cn-field' + (fireIds[f.id] ? ' L-fire fs-cn-fire' : '') + '"/>';
    });
    svg += '<path class="L-water fs-cn-water fs-cn-band" d="' + band.water + '"/><path class="L-wetland fs-cn-wetland fs-cn-band" d="' + band.wetland + '"/>' +
      '<path class="L-water fs-cn-water" d="' + paths.water + '"/><path class="L-wetland fs-cn-wetland" d="' + paths.wetland + '"/>' +
      '<path class="L-weak fs-cn-weak" d="' + paths.weak + '"/><path class="L-burn fs-cn-burn" d="' + paths.burn + '"/><path class="L-low fs-cn-low" d="' + paths.low + '"/>';
    req.fields.forEach(function (f) {
      var c = f.ring.reduce(function (a, q) { return [a[0] + q[0] / f.ring.length, a[1] + q[1] / f.ring.length]; }, [0, 0]), cp = P(c[0], c[1]);
      // the name under the field (the pins lean up and right, so they rarely cover it)
      var ys = f.ring.map(function (q) { return P(q[0], q[1])[1]; }), yBot = Math.max.apply(null, ys), yTop = Math.min.apply(null, ys);
      // inside the top of the field when it is tall enough (names below a field can run into the field under it), else below it, else above
      var ly = yBot - yTop >= 44 ? yTop + 18 : yBot + 18 <= H - 46 ? yBot + 18 : Math.max(16, yTop - 8);
      svg += '<text x="' + cp[0].toFixed(1) + '" y="' + ly.toFixed(1) + '" class="fs-cn-flabel">' + esc(f.name) + '</text>';
    });
    // numbered pins, nudged apart when they would overlap
    var placed = [];
    list.forEach(function (w) {
      if (w.lon == null) return;
      var p = P(w.lon, w.lat), tries = 0;
      while (tries++ < 8 && placed.some(function (q) { return Math.hypot(q[0] - p[0], q[1] - p[1]) < 24; })) p = [p[0] + 18, p[1] - 10];
      placed.push(p);
      // the pin stands a little up and to the right of the spot, on a short stem, so small spots stay visible under it
      var at = P(w.lon, w.lat), px = p[0] + 16, py = p[1] - 22;
      svg += '<g class="fs-cn-pin fs-cn-' + w.level + (w.n - 1 === pick ? ' fs-cn-on' : '') + '" data-i="' + (w.n - 1) + '" aria-hidden="true"><line x1="' + at[0].toFixed(1) + '" y1="' + at[1].toFixed(1) + '" x2="' + px.toFixed(1) + '" y2="' + py.toFixed(1) + '"/><circle class="fs-cn-dot" cx="' + at[0].toFixed(1) + '" cy="' + at[1].toFixed(1) + '" r="3"/>' +
        '<title>' + esc(w.n + ". " + String(w.text || w.title || "").slice(0, 300)) + '</title><circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="13"/><text x="' + px.toFixed(1) + '" y="' + (py + 5).toFixed(1) + '">' + w.n + '</text></g>';
    });
    // scale bar and north arrow
    var nice = [50, 100, 200, 250, 500, 1000, 2000], m = nice.filter(function (v) { return v / M * s <= W * 0.28; }).pop() || 50, L = m / M * s;
    svg += '<g class="fs-cn-scale"><rect x="10" y="' + (H - 40) + '" width="' + (L + 20).toFixed(1) + '" height="32" rx="5"/><line x1="20" x2="' + (20 + L).toFixed(1) + '" y1="' + (H - 16) + '" y2="' + (H - 16) + '"/>' +
      '<line x1="20" x2="20" y1="' + (H - 21) + '" y2="' + (H - 11) + '"/><line x1="' + (20 + L).toFixed(1) + '" x2="' + (20 + L).toFixed(1) + '" y1="' + (H - 21) + '" y2="' + (H - 11) + '"/>' +
      '<text x="' + (20 + L / 2).toFixed(1) + '" y="' + (H - 23) + '">' + (m >= 1000 ? m / 1000 + ' km' : m + ' m') + '</text></g>' +
      '<g class="fs-cn-north"><path d="M' + (W - 24) + ' 10 l9 22 h-18 z"/><text x="' + (W - 24) + '" y="52">N</text></g>';
    return svg + '</g></svg>';
  }
  function legendHTML(d) {
    var has = {}, fireN = ((d.nasa && d.nasa.fire && d.nasa.fire.detections) || []).length;
    Object.keys(d.fields).forEach(function (id) {
      var x = d.fields[id], c = x.cover && x.cover.cells, t = x.terrain && x.terrain.lowCells, sat = x.satellite || {};
      if (c && c.water && c.water.cells && c.water.cells.length) has.water = 1;
      if (c && c.wetland && c.wetland.cells && c.wetland.cells.length) has.wetland = 1;
      if (t && t.cells && t.cells.length) has.low = 1;
      if (sat.summer && sat.summer.weakZones && sat.summer.weakZones.length) has.weak = 1;
      if (sat.burn && sat.burn.patches && sat.burn.patches.length) has.burn = 1;
    });
    if (fireN) has.fire = 1;
    var none = [], items = LAYERS.map(function (L) {
      var label = L[0] === 'low' ? lowLabel(d) : L[1], sw = '<i class="sw sw-' + L[0] + (L[0] === 'low' ? ' sw-wet-' + wetWord(d) : '') + '" aria-hidden="true"></i>';
      if (!has[L[0]]) { none.push(L[1].toLowerCase()); return ''; }
      return '<li><button type="button" class="fs-cn-lg" data-l="' + L[0] + '" aria-pressed="' + (hidden[L[0]] ? 'false' : 'true') + '">' + sw + '<span>' + esc(label) + ' <span class="fs-fm-faint">(' + esc(L[2]) + ')</span></span></button></li>';
    });
    if (none.length) items.push('<li class="fs-cn-lg-none"><span>Not found on these fields: ' + esc(none.join(', ')) + '.</span></li>');
    return '<div class="fs-cn-legendbox"><p class="fs-cn-lg-t" id="fs-cn-lg-t">Map key <span class="fs-fm-faint">(press to show or hide)</span></p><ul class="fs-cn-legend" aria-labelledby="fs-cn-lg-t">' + items.join('') +
      '<li class="fs-cn-lg-pins"><i class="sw sw-pin" aria-hidden="true">1</i><span>Numbered note below: orange = check it, grey = for your information</span></li></ul></div>';
  }

  // ---------------------------------------------------------------- small charts
  // 7 days past + today + 3 days ahead: rain bars, warmest and coldest temperature lines
  function weatherChart(days) {
    if (!days || days.length < 3) return '';
    var W = 640, H = 220, L = 40, Rr = 40, T = 26, B = 44, n = days.length, bw = (W - L - Rr) / n;
    var rMax = Math.max(10, Math.max.apply(null, days.map(function (x) { return x.rainMm || 0; })) * 1.15);
    var ts = []; days.forEach(function (x) { if (x.minC != null) ts.push(x.minC); if (x.maxC != null) ts.push(x.maxC); });
    if (!ts.length) ts = [0, 10];
    var tMin = Math.floor(Math.min.apply(null, ts) / 5) * 5, tMax = Math.ceil(Math.max.apply(null, ts) / 5) * 5; if (tMax - tMin < 10) tMax = tMin + 10;
    var yR = function (v) { return H - B - v / rMax * (H - T - B); }, yT = function (v) { return H - B - (v - tMin) / (tMax - tMin) * (H - T - B); }, cx = function (i) { return L + bw * (i + 0.5); };
    var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], when = days.map(function (x) { return x.when; });
    var ti = when.indexOf('today'), firstNext = when.indexOf('next');
    var svg = '<svg class="fs-cn-wx" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Rain and temperature, past 7 days and next 3 days. ' +
      esc(days.map(function (x) { return x.date.slice(5) + (x.when === 'next' ? ' (forecast)' : '') + ': rain ' + (x.rainMm || 0) + ' mm, ' + x.minC + ' to ' + x.maxC + ' °C'; }).join('; ')) + '">';
    if (firstNext >= 0) svg += '<rect class="fs-cn-wx-fc" x="' + (L + bw * firstNext).toFixed(1) + '" y="' + T + '" width="' + (bw * (n - firstNext)).toFixed(1) + '" height="' + (H - T - B) + '"/><text class="fs-cn-wx-lab" x="' + (L + bw * (firstNext + (n - firstNext) / 2)).toFixed(1) + '" y="' + (T - 8) + '" text-anchor="middle">forecast</text>';
    if (ti >= 0) svg += '<text class="fs-cn-wx-lab" x="' + cx(ti).toFixed(1) + '" y="' + (T - 8) + '" text-anchor="middle">today</text>';
    [0, 0.5, 1].forEach(function (q) {
      var y = T + (H - T - B) * (1 - q);
      svg += '<line class="fs-cn-wx-grid" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text class="fs-cn-wx-ax" x="' + (L - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + Math.round(rMax * q) + '</text><text class="fs-cn-wx-ax" x="' + (W - Rr + 6) + '" y="' + (y + 4).toFixed(1) + '">' + Math.round(tMin + (tMax - tMin) * q) + '°</text>';
    });
    svg += '<text class="fs-cn-wx-ax" x="4" y="' + (T - 8) + '">mm</text><text class="fs-cn-wx-ax" x="' + (W - 4) + '" y="' + (T - 8) + '" text-anchor="end">°C</text>';
    days.forEach(function (x, i) {
      var r = x.rainMm || 0, y = yR(r), dd = new Date(x.date + 'T12:00:00Z');
      svg += '<rect class="fs-cn-wx-rain' + (x.when === 'next' ? ' is-fc' : '') + '" x="' + (cx(i) - bw * 0.32).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (bw * 0.64).toFixed(1) + '" height="' + Math.max(0, H - B - y).toFixed(1) + '" rx="2"/>';
      if (r >= 1) svg += '<text class="fs-cn-wx-val" x="' + cx(i).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle">' + Math.round(r) + '</text>';
      svg += '<text class="fs-cn-wx-day' + (i === ti ? ' is-today' : '') + '" x="' + cx(i).toFixed(1) + '" y="' + (H - B + 18) + '" text-anchor="middle">' + wd[dd.getUTCDay()] + '</text><text class="fs-cn-wx-ax" x="' + cx(i).toFixed(1) + '" y="' + (H - B + 34) + '" text-anchor="middle">' + (+x.date.slice(8)) + '</text>';
    });
    function line(key, c) { var pts = days.map(function (x, i) { return x[key] == null ? null : cx(i).toFixed(1) + ',' + yT(x[key]).toFixed(1); }).filter(Boolean); return '<polyline class="' + c + '" points="' + pts.join(' ') + '"/>' + days.map(function (x, i) { return x[key] == null ? '' : '<circle class="' + c + '-d" cx="' + cx(i).toFixed(1) + '" cy="' + yT(x[key]).toFixed(1) + '" r="3"/>'; }).join(''); }
    var frost = tMin < 0 && tMax > 0;
    if (frost) svg += '<line class="fs-cn-wx-frost" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + yT(0).toFixed(1) + '" y2="' + yT(0).toFixed(1) + '"/>';
    svg += line('maxC', 'fs-cn-wx-max') + line('minC', 'fs-cn-wx-min');
    return svg + '</svg><p class="fs-cn-key"><span><i class="k-rain"></i>rain, mm a day</span><span><i class="k-max"></i>warmest °C</span><span><i class="k-min"></i>coldest °C</span>' + (frost ? '<span><i class="k-frost"></i>0 °C (frost line)</span>' : '') + '</p>';
  }
  // a soil wetness gauge: value on a 0 to max scale, with the normal for the time of year marked when there is one
  function gauge(label, v, max, normal, valText, note) {
    if (v == null) return '';
    var pc = Math.max(0, Math.min(100, v / max * 100)), npc = normal == null ? null : Math.max(0, Math.min(100, normal / max * 100));
    var word = normal == null ? '' : v - normal > 0.08 ? 'wetter than normal' : v - normal < -0.08 ? 'drier than normal' : 'about normal';
    return '<div class="fs-cn-g"><div class="fs-cn-g-top"><span class="fs-cn-g-l">' + label + '</span><b>' + valText + (word ? ' <span class="fs-cn-g-w">' + word + '</span>' : '') + '</b></div>' +
      '<div class="fs-cn-g-track" role="img" aria-label="' + esc(label + ': ' + valText + (normal != null ? ', normal ' + normal + ', ' + word : '')) + '"><i style="width:' + pc.toFixed(0) + '%"></i>' + (npc != null ? '<span class="fs-cn-g-norm" style="left:' + npc.toFixed(0) + '%"></span>' : '') + '</div>' +
      '<div class="fs-cn-g-ends" aria-hidden="true"><span>dry</span>' + (npc != null ? '<span><i class="fs-cn-g-tick"></i> normal ' + normal + '</span>' : '') + '<span>wet</span></div>' + (note ? '<p class="fs-cn-g-n">' + note + '</p>' : '') + '</div>';
  }
  function chip(label, value, level, note) { return '<div class="fs-cn-chip lvl-' + level + '"><span class="fs-cn-chip-l">' + label + '</span><b>' + value + '</b><span class="fs-cn-chip-n">' + note + '</span></div>'; }
  // PM2.5 bands of the US EPA index (2024 breakpoints, 24-hour), UV index bands of the WHO
  function pmLevel(v) { return v == null ? ['–', 'na'] : v <= 9 ? ['good', 'ok'] : v <= 35.4 ? ['moderate', 'mid'] : v <= 55.4 ? ['unhealthy for sensitive people', 'bad'] : ['unhealthy', 'bad']; }
  function uvLevel(v) { return v == null ? ['–', 'na'] : v < 3 ? ['low', 'ok'] : v < 6 ? ['moderate', 'mid'] : v < 8 ? ['high', 'bad'] : ['very high', 'bad']; }

  // ---------------------------------------------------------------- notes: a short headline, the rest folded away
  function split(text) {
    var m = String(text).match(/^(.{40,180}?(?:[.;]|[^)]:))\s+(.+)$/);   // not at the colon after a bracket, as in 'NASA fire satellites (...):'
    return m ? [m[1].replace(/[:;]$/, '.'), m[2]] : [text, ''];
  }
  var GROUP = {
    low: function (k) { return k + ' low, flat spots where water gathers after heavy rain'; },
    weak: function (k, w) { return k + ' weak-growth zones in last summer\u2019s image' + (w.imageDate ? ' (' + w.imageDate + ', not today\u2019s crop)' : ''); },
    water: function (k) { return k + ' ponds, streams or open water'; },
    wetland: function (k) { return k + ' patches of wet ground (wetland)'; },
    burn: function (k) { return k + ' patches of possibly burned ground'; }
  };
  // one line per place inside a group card: its size and where it is
  function placeText(w) {
    var t = String(w.text).replace(/ \([\d,]+ m\u00b2\)/, '').replace(/ \(Copernicus elevation model\)/, '').replace(/ on the Sentinel satellite land-cover map/, '');
    var m = t.match(/about [\d.,]+ acres?,?[^.:(]*/);
    return w.kind === 'water' || w.kind === 'wetland' ? split(t)[0].replace(/\.$/, '') : m ? m[0].replace(/,\s*$/, '').trim() : split(t)[0];
  }
  function showBtn(w) { var on = w.n - 1 === pick; return '<button type="button" class="fs-cn-show" data-i="' + (w.n - 1) + '" aria-pressed="' + on + '">' + (on ? 'Shown on the map' : 'Show on map') + '</button>'; }
  function noteList(items) {
    if (!items.length) return '';
    var count = {}, done = {};
    items.forEach(function (w) { if (w.kind && GROUP[w.kind]) count[w.kind] = (count[w.kind] || 0) + 1; });
    return '<ol class="fs-cn-notes">' + items.map(function (w) {
      if (w.kind && count[w.kind] >= 2) {   // several notes of one kind: one card that lists the places, each with its number
        if (done[w.kind]) return '';
        done[w.kind] = 1;
        var g = items.filter(function (x) { return x.kind === w.kind; }), warn = g.some(function (x) { return x.level === 'warn'; }), tail = split(g[0].text)[1], on = g.some(function (x) { return x.n - 1 === pick; });
        return '<li class="fs-cn-group fs-cn-' + (warn ? 'warn' : 'info') + (on ? ' fs-cn-on' : '') + '"><div class="fs-cn-nhead"><p><span class="fs-cn-badge">' + (warn ? 'Check' : 'Note') + '</span> <b>' + esc(GROUP[w.kind](g.length, g[0])) + '</b></p></div>' +
          '<ul class="fs-cn-gitems">' + g.map(function (x) {
            return '<li class="fs-cn-' + x.level + (x.n - 1 === pick ? ' fs-cn-on' : '') + '"><span class="fs-cn-num" aria-hidden="true">' + x.n + '</span><span class="fs-cn-gt"><span class="fs-cn-sr">Note ' + x.n + ': </span>' + esc(placeText(x)) + '</span>' + (x.lon != null ? showBtn(x) : '') + '</li>';
          }).join('') + '</ul>' + (tail ? '<details class="fs-cn-more"><summary>What this means and what to do</summary><p>' + esc(tail) + '</p></details>' : '') + '</li>';
      }
      var p = String(w.text).length <= 240 ? [w.text, ''] : split(w.text), on1 = w.n - 1 === pick;
      return '<li class="fs-cn-' + w.level + (on1 ? ' fs-cn-on' : '') + '"><div class="fs-cn-nhead"><span class="fs-cn-num" aria-hidden="true">' + w.n + '</span>' +
        '<p><span class="fs-cn-sr">Note ' + w.n + ': </span><span class="fs-cn-badge">' + (w.level === 'warn' ? 'Check' : 'Note') + '</span> ' + esc(p[0]) + '</p></div>' +
        (w.lon != null || p[1] ? '<div class="fs-cn-nfoot">' + (w.lon != null ? showBtn(w) : '') +
        (p[1] ? '<details class="fs-cn-more"><summary>More</summary><p>' + esc(p[1]) + '</p></details>' : '') + '</div>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  // a section that folds: the header button shows a one-line summary and how many notes are inside
  function section(id, title, lead, inner, summary, notes) {
    var o = isOpen(id), warn = notes && notes.some(function (w) { return w.level === 'warn'; }), k = notes ? notes.length : 0;
    return '<section class="fs-cn-sec' + (o ? ' is-open' : '') + '" aria-labelledby="fs-cn-h-' + id + '"><h3 class="fs-cn-sech"><button type="button" id="fs-cn-h-' + id + '" class="fs-cn-secb" data-sec="' + id + '" aria-expanded="' + o + '" aria-controls="fs-cn-s-' + id + '">' +
      '<span class="fs-cn-st">' + title + '</span>' + (summary ? '<span class="fs-cn-ss">' + summary + '</span>' : '') +
      (k ? '<span class="fs-cn-cnt' + (warn ? ' is-warn' : '') + '">' + k + ' note' + (k > 1 ? 's' : '') + '</span>' : notes ? '<span class="fs-cn-cnt is-ok">all clear</span>' : '') + '<span class="fs-cn-chev" aria-hidden="true"></span></button></h3>' +
      '<div class="fs-cn-secbody" id="fs-cn-s-' + id + '"' + (o ? '' : ' hidden') + '>' + (lead ? '<p class="fs-cn-lead">' + lead + '</p>' : '') + inner + '</div></section>';
  }

  // a note's headline, shorter still for the top list
  function short(w) {
    var t = split(w.text)[0];
    if (w.kind === 'weak') t = t.replace(/ from last summer's image \([^)]*\),/, ',').replace(/\.$/, '') + ' (seen last summer).';
    return t.replace(/ \(Copernicus elevation model\)/, '');
  }
  // what is going well, from the data only (up to 3)
  function goingWell(d) {
    var out = [], n = d.now || {}, N = d.nasa || {}, a = d.air || {}, wn = d.wetNow;
    if (N.fire && N.fire.detections && !N.fire.detections.length) out.push('No fire seen on or near your fields in the last 14 days (NASA satellites, to ' + N.fire.to + ').');
    if (wn && wn.level === 'unlikely') out.push('No standing water likely in the low spots now (little recent rain).');
    if (n.minNext3C != null && n.minNext3C > 0) out.push('No frost expected in the next 3 days (coldest about ' + num(n.minNext3C, ' °C', 1) + ').');
    if (N.soil && N.soil.avgRoot != null && Math.abs(N.soil.root - N.soil.avgRoot) <= 0.08) out.push('Soil moisture is about normal for the date (NASA MERRA-2 root zone ' + N.soil.root + ', normal ' + N.soil.avgRoot + ').');
    if (a.pm25 != null && a.pm25 <= 9) out.push('Good air today for outdoor work (fine dust ' + num(a.pm25, ' µg/m³') + ').');
    Object.keys(d.fields || {}).forEach(function (id) {
      var x = d.fields[id], su = x.satellite && x.satellite.summer;
      if (su && su.ndviMedian >= 0.75 && su.weakPct != null && su.weakPct < 10) out.push('Strong, even growth on most of ' + (x.name || 'a field') + ' last summer (only ' + su.weakPct + '% of it weak, Sentinel-2 ' + su.date + ').');
    });
    if (n.windKmh != null && n.windKmh >= 5 && n.windKmh < 16) out.push('Wind ' + n.windKmh + ' km/h: inside the usual range for spraying.');
    return out.slice(0, 3);
  }
  // the three things most worth a look today
  function todayList(d, list) {
    var out = [], wn = d.wetNow, lows = list.filter(function (w) { return w.kind === 'low'; });
    if (wn && wn.level !== 'unlikely' && lows.length) out.push({ level: 'warn', text: (wn.level === 'likely' ? 'Water is likely standing in ' : 'Puddles are possible in ') + lows.length + ' low spot' + (lows.length > 1 ? 's' : '') + ' (notes ' + lows.map(function (w) { return w.n; }).join(', ') + '). Keep heavy machinery off them.', i: lows[0].n - 1 });
    var rank = { fire: 0, water: 1, weather: 2, air: 3, soil: 4, crop: 5 };
    var warns = list.filter(function (w) { return w.level === 'warn' && !(out.length && w.kind === 'low'); }).sort(function (a, z) { return (rank[a.topic] == null ? 9 : rank[a.topic]) - (rank[z.topic] == null ? 9 : rank[z.topic]) || a.n - z.n; });
    warns.forEach(function (w) { if (out.length < 3) out.push({ level: 'warn', text: short(w), i: w.lon != null ? w.n - 1 : -1, n: w.n }); });
    var urgent = out.length;
    list.forEach(function (w) { if (out.length < 3 && w.level !== 'warn' && !(urgent && w.kind === 'low' && out[0].i === lows[0].n - 1)) out.push({ level: 'info', text: short(w), i: w.lon != null ? w.n - 1 : -1, n: w.n }); });
    var good = goingWell(d), gh = good.length ? '<div class="fs-cn-good"><h4>Going well</h4><ul>' + good.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '';
    var h = '<section class="fs-cn-today" aria-labelledby="fs-cn-h-today"><h3 id="fs-cn-h-today">' + (urgent ? urgent + ' thing' + (urgent > 1 ? 's' : '') + ' to check today' : 'Nothing urgent on your fields today') + '</h3>';
    if (!out.length) return h + '<p class="fs-cn-lead">No warnings on these fields right now. The simulation below can help you plan next season with confidence.</p>' + gh + '</section>';
    if (!urgent) h += '<p class="fs-cn-lead">Worth knowing:</p>';
    return h + '<ul class="fs-cn-check">' + out.map(function (x) {
      return '<li class="fs-cn-' + x.level + '"><p>' + (x.n ? '<span class="fs-cn-num" aria-hidden="true">' + x.n + '</span> ' : '') + esc(x.text) + (x.n ? '<span class="fs-cn-sr"> (note ' + x.n + ')</span>' : '') + '</p>' + (x.i >= 0 ? '<button type="button" class="fs-cn-show" data-i="' + x.i + '">Show on map</button>' : '') + '</li>';
    }).join('') + '</ul>' + gh + '</section>';
  }

  // once a second while busy: the whole view while the conditions load, then only the field health seconds (so focus and open boxes stay put)
  function tick() {
    if (st.busy || !layer) return render();
    var e = layer.querySelector('.fs-cn-hsec'); if (e && hs.busy) e.textContent = Math.round((Date.now() - hs.t0) / 1000);
  }
  function detKey(list) {   // "summary text #n" for each <details>, so open ones stay open after a re-render
    var seen = {};
    return Array.prototype.map.call(list, function (x) { var t = (x.querySelector('summary') || {}).textContent || ''; seen[t] = (seen[t] || 0) + 1; return t + '#' + seen[t]; });
  }
  function render() {
    if (!layer) return;
    var keepScroll = layer.scrollTop;
    var h = '<div class="fs-fm-top"><p class="fs-fm-where"><b>Advanced Near-Real-Time Conditions</b> on your fields' + (st.at ? ' · checked ' + st.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</p>' +
      '<button type="button" class="fs-fm-btn" id="fs-cn-refresh"' + (st.busy ? ' disabled' : '') + '>Check again</button></div>';
    if (st.busy) h += '<div class="fs-fm-busy" role="status"><span class="fs-fm-spin" aria-hidden="true"></span>Reading satellites and weather for your fields… ' + Math.round((Date.now() - st.t0) / 1000) + ' s <span class="fs-fm-faint">(10 to 40 s the first time)</span></div>';
    else if (st.err) h += '<p class="fs-fm-msg fs-fm-err">' + esc(st.err) + '</p>';
    else if (st.data) h += body(st.data, st.req);
    // keep the open "More" boxes open across re-renders (the field health answer can arrive while one is open)
    var was = layer.querySelectorAll('details'), state = {}; detKey(was).forEach(function (k, i) { state[k] = was[i].open; });
    layer.innerHTML = h;
    var now = layer.querySelectorAll('details'); detKey(now).forEach(function (k, i) { if (state[k] != null) now[i].open = state[k]; });
    layer.scrollTop = keepScroll;
    var rf = layer.querySelector('#fs-cn-refresh'); if (rf) rf.addEventListener('click', function () { load(true); });
    Array.prototype.forEach.call(layer.querySelectorAll('.fs-cn-show, .fs-cn-pin'), function (b) {
      b.addEventListener('click', function () {
        var i = +b.getAttribute('data-i'), was = pick === i, pin = b.classList.contains('fs-cn-pin'), inToday = !!b.closest('.fs-cn-today');
        pick = was ? -1 : i; render();
        if (pin) {   // a pin: open its section if it is folded, then bring its note into view
          var sec = noteSec[i + 1]; if (sec && !isOpen(sec) && !was) { secOpen[sec] = true; render(); }
          var li = layer.querySelector('.fs-cn-notes .fs-cn-show[data-i="' + i + '"]'); if (li && !was) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
        var again = layer.querySelector((inToday ? '.fs-cn-today' : '.fs-cn-notes') + ' .fs-cn-show[data-i="' + i + '"]');
        if (!was) { var m = layer.querySelector('.fs-cn-mapbox svg'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        if (again) again.focus({ preventScroll: true });
      });
    });
    Array.prototype.forEach.call(layer.querySelectorAll('.fs-cn-secb'), function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-sec'); secOpen[id] = !isOpen(id); render(); var q = layer.querySelector('#fs-cn-h-' + id); if (q) q.focus({ preventScroll: true }); });
    });
    Array.prototype.forEach.call(layer.querySelectorAll('.fs-cn-lg'), function (b) {
      b.addEventListener('click', function () { var l = b.getAttribute('data-l'); hidden[l] = !hidden[l]; render(); var q = layer.querySelector('.fs-cn-lg[data-l="' + l + '"]'); if (q) q.focus(); });
    });
  }

  function body(d, req) {
    var n = d.now || {}, e5 = d.era5Soil, a = d.air || {}, N = d.nasa || {}, wn = d.wetNow;
    var list = (d.warnings || []).map(function (w, i) { return Object.assign({ n: i + 1 }, w); });
    var SEC = { water: 'water', soil: 'soil', crop: 'crop', fire: 'fire', air: 'fire', weather: 'weather' };
    noteSec = {}; list.forEach(function (w) { noteSec[w.n] = SEC[w.topic || 'soil'] || 'soil'; });
    var by = function (t) { return list.filter(function (w) { return (w.topic || 'soil') === t; }); };
    var plural = function (k, one, many) { return k + ' ' + (k === 1 ? one : many); };
    var h = '';
    if (req.approximate) h += '<p class="fs-cn-note">These are the example fields, so each is checked as a square of its size around its soil survey point. Import your real field outlines (the box below the simulation) for checks on your exact fields.</p>';
    h += todayList(d, list);

    // ---- map
    var sat = null; Object.keys(d.fields || {}).forEach(function (id) { var g = d.fields[id].satellite; if (g && g.summer && (!sat || g.summer.date > sat)) sat = g.summer.date; });
    h += '<section class="fs-cn-mapbox" aria-labelledby="fs-cn-h-map"><h3 id="fs-cn-h-map">Your fields from above</h3><div class="fs-cn-mapgrid"><div class="fs-cn-mapwrap">' + mapSVG(d, req, list) + '</div>' + legendHTML(d) + '</div>' +
      '<p class="fs-cn-cap">Drawn to scale, north up' + (req.approximate ? ' (example squares, not real outlines)' : '') + '. This is not a photo of today: puddles are judged from the rain and soil wetness, not seen.</p>' +
      '<details class="fs-cn-more fs-cn-capmore"><summary>Where each layer comes from</summary><p>Water and wetland come from the ESA WorldCover map, made from 2021 satellite images (paler squares are in the 150 m around the field). Low spots come from the Copernicus elevation model; whether water stands in them now is judged from the last week’s rain and soil wetness.' + (sat ? ' Weak growth: Sentinel-2 image of ' + esc(sat) + '.' : '') + '</p></details></section>';

    // ---- water and wet ground
    var wetTxt = !wn ? 'Could not judge standing water now (the weather did not answer).' : wn.level === 'likely' ? 'Standing water is <b>likely</b> in the low spots and wet ground now.' : wn.level === 'possible' ? 'Puddles are <b>possible</b> in the low spots now.' : 'Standing water is <b>unlikely</b> in the low spots right now.';
    var g = '';
    if (N.soil) {
      g += gauge('Top 5 cm of soil (NASA MERRA-2)', N.soil.top, 1, N.soil.avgTop, N.soil.top + ' of 1', 'on ' + esc(N.soil.date) + '; 0 = dry, 1 = saturated');
      g += gauge('Root zone, to about 1 m (NASA MERRA-2)', N.soil.root, 1, N.soil.avgRoot, N.soil.root + ' of 1', N.soil.avgRoot != null ? 'normal = the ' + esc(N.soil.years) + ' average for ' + esc(N.soil.window) : '');
    }
    if (n.soilMoist != null) g += gauge('Topsoil 0 to 7 cm, now (ECMWF)', n.soilMoist, 0.5, null, Math.round(n.soilMoist * 100) + '% water', 'by volume; most soils are saturated near 45 to 50%' + (e5 ? '. ERA5-Land: ' + Math.round(e5.top7 * 100) + '% on ' + esc(e5.time.slice(0, 10)) : ''));
    h += section('water', 'Water and wet ground', '',
      '<div class="fs-cn-wetnow wet-' + (wn ? wn.level : 'na') + '"><p class="fs-cn-wetbig">' + wetTxt + '</p>' + (wn ? '<p>Because: ' + esc(wn.why.join('; ')) + '.</p>' : '') + '</div>' +
      (g ? '<div class="fs-cn-gauges">' + g + '</div>' : '') + noteList(by('water')) + (by('water').length ? '' : '<p class="fs-cn-lead">No ponds, wetland or large low spots found in or right next to these fields.</p>'),
      (wn ? { likely: 'puddles likely now', possible: 'puddles possible now', unlikely: 'puddles unlikely now' }[wn.level] : 'wetness unknown') + (N.soil && N.soil.avgRoot != null ? ' · soil ' + (N.soil.root - N.soil.avgRoot > 0.08 ? 'wetter than normal' : N.soil.root - N.soil.avgRoot < -0.08 ? 'drier than normal' : 'about normal') : ''), by('water'));

    // ---- soil
    var tbl = '<div class="fs-cn-tablewrap" tabindex="0" aria-label="Soil table, scrolls sideways"><table class="fs-cn-table"><caption class="fs-cn-sr">Soil and land per field</caption><thead><tr><th scope="col">Field</th><th scope="col">pH</th><th scope="col">Organic carbon</th><th scope="col">Nitrogen</th><th scope="col">CEC</th><th scope="col">Slope</th><th scope="col">Bare soil now</th></tr></thead><tbody>' +
      req.fields.map(function (f) {
        var x = d.fields[f.id] || {}, s = x.fertility || {}, t = x.terrain || {}, sa = x.satellite || {};
        return '<tr><th scope="row">' + esc(f.name) + '</th><td>' + num(s.ph, '', 1) + '</td><td>' + num(s.organicCarbonGkg, ' g/kg', 1) + '</td><td>' + num(s.nitrogenGkg, ' g/kg', 2) + '</td><td>' + num(s.cecCmolKg, '', 0) + '</td><td>' + num(t.slopePct, '%', 1) + '</td><td>' + (sa.ground ? sa.ground.bareSoilPct + '% <span class="fs-fm-faint">(' + esc(sa.ground.date.slice(5)) + ')</span>' : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += section('soil', 'Soil', 'Model estimates for the top 30 cm (ISRIC SoilGrids); a lab soil test is more exact. CEC is how much nutrient the soil can hold.', tbl + noteList(by('soil')),
      (function () { var ph = req.fields.map(function (f) { var x = d.fields[f.id]; return x && x.fertility && x.fertility.ph; }).filter(function (v) { return v != null; }), lo = Math.min.apply(null, ph), hi = Math.max.apply(null, ph); return (ph.length ? 'pH ' + lo + (hi !== lo ? ' to ' + hi : '') + ' · ' : '') + plural(req.fields.length, 'field', 'fields'); })(), by('soil'));

    // ---- crop health
    var weakN = by('crop').filter(function (w) { return w.kind === 'weak'; }).length, his = hs.data ? Object.keys(hs.data.fields).map(function (id) { var f = hs.data.fields[id]; return f.healthIndex != null ? f.healthIndex : f.yieldScore; }).filter(function (v) { return v != null; }) : [];
    h += section('crop', 'Crop health', '', noteList(by('crop')) + healthHTML(),
      (weakN ? plural(weakN, 'weak-growth zone', 'weak-growth zones') : 'no weak-growth zones') + (his.length ? ' · health ' + Math.min.apply(null, his) + (his.length > 1 && Math.max.apply(null, his) !== Math.min.apply(null, his) ? ' to ' + Math.max.apply(null, his) : '') + ' of 100' : hs.busy ? ' · field health loading' : ''), by('crop'));

    // ---- fire and air
    var pm = pmLevel(a.pm25), uv = uvLevel(a.uv), fireN = N.fire ? N.fire.detections.length : null;
    h += section('fire', 'Fire and air', '',
      '<div class="fs-cn-chips">' +
      chip('Fire seen by NASA', fireN == null ? '–' : fireN ? 'Yes, ' + fireN + ' field' + (fireN > 1 ? 's' : '') : 'None', fireN ? 'bad' : fireN === 0 ? 'ok' : 'na', N.fire ? 'last 14 days, to ' + esc(N.fire.to) : 'the check did not answer') +
      chip('Fine dust PM2.5', num(a.pm25, ' µg/m³'), pm[1], esc(pm[0])) +
      chip('Desert dust', num(a.dust, ' µg/m³'), a.dust >= 50 ? 'bad' : a.dust != null ? 'ok' : 'na', 'Copernicus CAMS') +
      chip('UV index', num(a.uv, '', 1), uv[1], esc(uv[0])) + '</div>' +
      (N.fire ? '<details class="fs-cn-more"><summary>About the NASA fire check</summary><p>' + esc(N.fire.line) + '</p></details>' : '') + noteList(by('fire').concat(by('air'))),
      (fireN == null ? 'fire check did not answer' : fireN ? 'fire seen near ' + plural(fireN, 'field', 'fields') : 'no fire seen') + ' · air ' + (a.pm25 == null ? 'unknown' : pm[0]), by('fire').concat(by('air')));

    // ---- weather
    h += section('weather', 'Weather', '',
      '<div class="fs-cn-chips">' + chip('Now', num(n.tempC, ' °C', 1), 'na', 'humidity ' + num(n.rhPct, '%')) + chip('Wind', num(n.windKmh, ' km/h'), n.windKmh >= 16 ? 'bad' : n.windKmh != null ? 'ok' : 'na', 'gusts ' + num(n.gustKmh, ' km/h') + (n.windKmh >= 16 ? ' · too windy to spray' : '')) +
      chip('Rain, past 7 days', num(n.rainPast7Mm, ' mm', 1), 'na', 'next 3 days ' + num(n.rainNext3Mm, ' mm', 1)) + chip('Coldest, next 3 days', num(n.minNext3C, ' °C', 1), n.minNext3C != null && n.minNext3C <= 0 ? 'bad' : 'na', n.minNext3C != null && n.minNext3C <= 0 ? 'frost' : 'no frost') + '</div>' +
      weatherChart(n.daily) + noteList(by('weather')),
      num(n.tempC, ' °C', 1) + ' now · ' + num(n.rainPast7Mm, ' mm', 1) + ' rain past week · ' + num(n.rainNext3Mm, ' mm', 1) + ' next 3 days', by('weather'));

    // ---- sources
    h += '<details class="fs-cn-sources"><summary>Sources and how fresh each one is</summary>' + fresh(d) +
      '<p class="fs-fm-note">' + esc((d.sources || []).join(' ')) + '</p>' + (d.gaps && d.gaps.length ? '<p class="fs-fm-note"><b>Not available this time:</b> ' + esc(d.gaps.join(' ')) + '</p>' : '') +
      '<p class="fs-fm-note">Warnings are simple rules on these numbers, not an agronomist’s visit. "Puddles likely" is a rule too: low spots or wetland, plus heavy recent rain (25 mm in 7 days or 15 mm in 3) and wet topsoil. No satellite used here sees today’s standing water.</p></details>';
    return h;
  }
  // how old each source is: weather hourly, soil moisture days behind, Sentinel-2 every few days, maps fixed
  function ago(t) {
    var ms = Date.now() - Date.parse(t); if (!isFinite(ms)) return '';
    var m = Math.round(ms / 60e3); if (m < 90) return Math.max(0, m) + ' min ago';
    var h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function fresh(d) {
    var rows = [], n = d.now, sat = null;
    Object.keys(d.fields || {}).forEach(function (id) { var g = d.fields[id].satellite; if (g && g.ground && (!sat || g.ground.date > sat)) sat = g.ground.date; });
    if (n && n.time) rows.push(['Weather (ECMWF)', n.time.replace('T', ' ') + ' local', 'updated hourly']);
    if (d.air && d.air.time) rows.push(['Air (Copernicus CAMS)', d.air.time.replace('T', ' ') + ' local', 'updated hourly']);
    if (d.era5Soil) rows.push(['Soil moisture (ERA5-Land)', d.era5Soil.time.slice(0, 10), ago(d.era5Soil.time + 'Z') + ', runs about 5 days behind']);
    if (d.nasa && d.nasa.soil) rows.push(['Soil wetness (NASA POWER MERRA-2)', d.nasa.soil.date, ago(d.nasa.soil.date + 'T12:00:00Z') + ', runs about 3 days behind']);
    if (d.nasa && d.nasa.fire) rows.push(['Fire detections (NASA GIBS)', 'to ' + d.nasa.fire.to, ago(d.nasa.fire.to + 'T12:00:00Z') + ', NASA publishes with a delay']);
    if (sat) rows.push(['Last clear Sentinel-2 pass', sat, ago(sat + 'T12:00:00Z') + ', a new pass every 2 to 5 days']);
    rows.push(['Ponds and wet ground', 'ESA WorldCover 2021', 'fixed map'], ['Low spots', 'Copernicus GLO-30 elevation', 'fixed map'], ['Soil fertility', 'ISRIC SoilGrids', 'fixed map']);
    return '<ul class="fs-cn-fresh" aria-label="How recent each source is">' + rows.map(function (r) { return '<li><b>' + esc(r[0]) + '</b> ' + esc(r[1]) + ' <i>' + esc(r[2]) + '</i></li>'; }).join('') +
      '<li class="fs-cn-auto">Checks again by itself every 15 minutes while this view is open.</li></ul>';
  }

  function show(on, bodyEl) {
    if (!layer && on) { layer = document.createElement('section'); layer.className = 'fs-fm fs-cn'; layer.setAttribute('aria-label', 'Advanced Near-Real-Time Conditions'); bodyEl.appendChild(layer); }
    if (!layer) return;
    open = on; layer.hidden = !on;
    clearInterval(auto); auto = null;
    if (on) { load(); auto = setInterval(function () { if (!st.busy) load(true, true); }, 15 * 60e3); } else clearInterval(timer);
  }
  // the farm changed: check again next time the view is open (now, if it is open)
  function refresh() { if (open) load(); }
  FS.conditions = { show: show, refresh: refresh };
})();
