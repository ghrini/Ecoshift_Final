/* "Advanced near-real-time conditions": a third view in the Simulation panel (next to Simulation and Farm map). It asks the server (/api/liveconditions,
   fieldlive.js and fieldsat.js) what is happening on the fields today: ECMWF weather, Copernicus ERA5-Land soil moisture and CAMS air,
   SoilGrids fertility, ESA WorldCover ponds and wet ground, Copernicus elevation low spots, and Sentinel-2 burned ground, bare soil and
   last summer's weak growth zones, plus NASA: fire detections (VIIRS and MODIS through NASA GIBS) that confirm or soften the burn check and a fire line, and NASA POWER (MERRA-2) soil wetness. Warnings that belong to a place are numbered on a small map of the fields.
   With imported outlines the checks run on the exact fields; otherwise on a square of each field's size around its soil survey point. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var layer = null, open = false, seq = 0, timer = null, st = { key: '', data: null, err: null, busy: false, t0: 0, req: null }, pick = -1;
  var hs = { key: '', data: null, err: null, busy: false, t0: 0 }, hseq = 0;   // field health (this season's Sentinel-2 series)
  var R = Math.PI / 180;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function base() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  function num(v, unit, k) { return v == null || !isFinite(v) ? '–' : (Math.round(v * Math.pow(10, k || 0)) / Math.pow(10, k || 0)) + (unit || ''); }

  // the fields to check: imported outlines when there are some, else a square of each field's acres around its soil point
  function request() {
    var su = FS.farmSetup && FS.farmSetup.setup, g = su && !su.example && su.geo, F = FS.data.farm.fields;
    if (g && g.fields.every(function (f) { return Array.isArray(f.ring) && f.ring.length >= 3; })) {
      return { approximate: false, fields: g.fields.filter(function (f) { return F.some(function (x) { return x.id === f.id; }); }).map(function (f) { return { id: f.id, name: f.name, ring: f.ring }; }) };
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
    clearInterval(timer); timer = setInterval(render, 1000); render();
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
      return { id: x.id, name: x.name, ring: x.ring, crop: crop, plantDate: y + (south ? (crop === 'corn' ? '-10-28' : '-11-15') : (crop === 'corn' ? '-04-28' : '-05-15')), irrigable: irr };
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
    return '<svg class="fs-hl-spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Greenness (NDVI) and leaf water (NDMI) through the season">' +
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
    var h = '<section class="fs-hl"><h3>Field health this season <span class="fs-fm-faint">(Copernicus Sentinel-2)</span></h3>';
    if (hs.busy) return h + '<div class="fs-fm-busy" role="status"><span class="fs-fm-spin" aria-hidden="true"></span>Reading this season\u2019s Sentinel-2 images of each field\u2026 ' + Math.round((Date.now() - hs.t0) / 1000) + ' s <span class="fs-fm-faint">(15 to 60 s the first time)</span></div></section>';
    if (hs.err) return h + '<p class="fs-fm-msg fs-fm-err">' + esc(hs.err) + '</p></section>';
    if (!hs.data) return h + '</section>';
    var D = hs.data, L = st.data && st.data.fields || {};
    Object.keys(D.fields).forEach(function (id) {
      var f = D.fields[id], H = f.health;
      h += '<article class="fs-hl-field"><header><strong>' + esc(f.name) + '</strong> <span class="fs-fm-faint">' + esc(f.crop === 'soybean' ? 'soybeans' : f.crop) + ' · ' + f.observations + ' clear images</span></header>';
      if (f.error) { h += '<p>' + esc(f.error) + '</p></article>'; return; }
      var M = f.momentum || {};
      h += '<p class="fs-hl-line">Stage: <b>' + esc(f.stage) + '</b>' + (f.gdd != null ? ' (' + f.gdd + ' degree days since planting)' : '') + ' · Growth momentum: <b>' + esc(M.word) + '</b>' + (M.perWeek != null ? ' (NDVI ' + (M.perWeek > 0 ? '+' : '') + M.perWeek + ' a week' + (M.accel ? ', ' + esc(M.accel) : '') + ')' : '') + ' · Peak NDVI ' + f.peak.ndvi + ' on ' + esc(f.peak.date) + '</p>';
      var Y = f.yieldEstimate || {};
      h += '<div class="fs-hl-scores"><span>Health index <b>' + (f.healthIndex != null ? f.healthIndex : f.yieldScore) + '</b>/100</span><span>Quality score <b>' + f.qualityScore + '</b>/100</span><span>Rough yield guide <b>' + (Y.bu ? Y.bu + ' bu/acre' : '–') + '</b>' + (Y.bu ? ' (design range ' + Y.low + ' to ' + Y.high + '; county normal ' + Y.normal + ')' : '') + '</span></div>' +
        '<p class="fs-fm-faint fs-hl-small">The health index (0 to 100) compares the canopy with a healthy crop\u2019s normal peak, and the nitrogen, leaf structure and evenness with this field\u2019s own best parts. It is the number to read first.' + '</p>' +
        (Y.note ? '<p class="fs-fm-faint fs-hl-small">' + esc(Y.note) + '</p>' : '');
      h += '<div class="fs-hl-grid"><div>' + spark(f.series) + '<p class="fs-hl-key"><i class="g"></i>greenness NDVI <i class="b"></i>leaf water NDMI</p></div><div class="fs-hl-bars">' +
        bar('Canopy', H.canopy.score, 'NDVI ' + H.canopy.ndvi + ', ' + Math.round(H.canopy.cover * 100) + '% cover, leaf area ~' + H.canopy.lai) +
        bar('Nitrogen', H.nitrogen.score, H.nitrogen.note ? esc(H.nitrogen.note) : 'red edge ' + Math.round(H.nitrogen.sufficiency * 100) + '% of the field\u2019s best (a hint only: confirm with a soil or tissue test)') +
        bar('Phosphorus', null, esc(H.phosphorus.note)) +
        bar('Moisture', H.moisture.score, 'leaf water NDMI ' + H.moisture.ndmi) +
        bar('Leaf structure', H.leaf.score, 'red-edge position ' + H.leaf.redEdgeNm + ' nm') +
        bar('Uniformity', H.uniformity.score, 'spread ' + Math.round(H.uniformity.cv * 100) + '% across the field') + '</div></div>';
      var zs = L[id] && L[id].satellite && L[id].satellite.summer, zn = zs && zs.weakZones && zs.weakZones.length;
      h += '<div class="fs-hl-cols"><div><h4>Root causes</h4><ul>' + f.causes.map(function (c) { return '<li><b>' + esc(c.cause) + '</b> <span class="fs-fm-faint">(' + esc(c.confidence) + ' confidence)</span>: ' + esc(c.why) + '</li>'; }).join('') + (zn ? '<li class="fs-fm-faint">Last summer\u2019s weak growth zones (Sentinel-2 image of ' + esc(zs.date) + ', not this season) are listed separately under Warnings above.</li>' : '') + '</ul></div>' +
        '<div><h4>What to do</h4><ul class="fs-hl-adv">' + f.advice.map(function (a) { return '<li><span class="fs-hl-pr fs-hl-' + a.priority + '">' + a.priority + '</span> <b>' + esc(a.topic) + ':</b> ' + esc(a.text) + '</li>'; }).join('') + '</ul></div></div>';
      h += '<p class="fs-hl-small"><a download="' + esc((f.name || id).replace(/[^\w-]+/g, '_')) + '_sentinel2.csv" href="' + csvHref(f.series || []) + '">Download this field\u2019s data (CSV)</a>' + (f.csv ? ' · also saved on the server as <code>' + esc(f.csv) + '</code>' : '') + '</p></article>';
    });
    return h + '<p class="fs-fm-note">' + esc((D.sources || []).join(' ')) + ' The health index, the yield guide, causes and advice are rules on published satellite indices (NDVI, NDRE, NDMI, red-edge position), not a model trained on harvests. Crop and planting date come from the farm setup (the last crop on each field; corn 28 April, soybeans 15 May, six months later south of the equator). Sentinel-1 radar and Sentinel-3 are not used: Sentinel-3 pixels (300 m) are bigger than most fields.</p></section>';
  }

  // ---------------------------------------------------------------- small map: fields, ponds and numbered warnings
  function miniMap(d, req, list) {
    var pts = []; req.fields.forEach(function (f) { pts = pts.concat(f.ring); });
    Object.keys(d.fields).forEach(function (id) { var c = d.fields[id].cover; (c && c.water || []).forEach(function (w) { pts.push([w.lon, w.lat]); }); });
    var lat0 = pts.reduce(function (s, p) { return s + p[1]; }, 0) / pts.length, k = Math.cos(lat0 * R);
    var xs = pts.map(function (p) { return p[0] * k; }), ys = pts.map(function (p) { return -p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var W = 360, H = 240, pad = 22, s = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-9), (H - 2 * pad) / Math.max(y1 - y0, 1e-9));
    var ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2, mPerDeg = 110574;
    function P(lon, lat) { return [ox + (lon * k - x0) * s, oy + (-lat - y0) * s]; }
    var svg = '<svg class="fs-cn-map" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Map of the fields with the numbered warnings">';
    req.fields.forEach(function (f) {
      var pp = f.ring.map(function (q) { return P(q[0], q[1]).map(function (v) { return v.toFixed(1); }).join(','); }).join(' '), c = f.ring.reduce(function (a, q) { return [a[0] + q[0] / f.ring.length, a[1] + q[1] / f.ring.length]; }, [0, 0]), cp = P(c[0], c[1]);
      svg += '<polygon points="' + pp + '" class="fs-cn-field"/><text x="' + cp[0].toFixed(1) + '" y="' + (cp[1] - 10).toFixed(1) + '" class="fs-cn-flabel">' + esc(f.name) + '</text>';
    });
    Object.keys(d.fields).forEach(function (id) {
      var c = d.fields[id].cover;
      (c && c.water || []).forEach(function (w) { var p = P(w.lon, w.lat), r = Math.max(3, Math.sqrt(w.areaM2 / Math.PI) / mPerDeg * s); svg += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + r.toFixed(1) + '" class="fs-cn-' + w.kind + '"/>'; });
    });
    list.forEach(function (w, i) {
      if (w.lon == null) return;
      var p = P(w.lon, w.lat);
      svg += '<g class="fs-cn-pin fs-cn-' + w.level + (i === pick ? ' fs-cn-on' : '') + '" data-i="' + i + '"><circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="9"/><text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) + '">' + (i + 1) + '</text></g>';
    });
    return svg + '</svg>';
  }

  function render() {
    if (!layer) return;
    var h = '<div class="fs-fm-top"><p class="fs-fm-where"><b>Advanced Near-Real-Time Conditions</b> on your fields' + (st.at ? ' · checked ' + st.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '</p>' +
      '<button type="button" class="fs-fm-btn" id="fs-cn-refresh"' + (st.busy ? ' disabled' : '') + '>Check again</button></div>';
    if (st.busy) h += '<div class="fs-fm-busy" role="status"><span class="fs-fm-spin" aria-hidden="true"></span>Reading satellites and weather for your fields… ' + Math.round((Date.now() - st.t0) / 1000) + ' s <span class="fs-fm-faint">(10 to 40 s the first time)</span></div>';
    else if (st.err) h += '<p class="fs-fm-msg fs-fm-err">' + esc(st.err) + '</p>';
    else if (st.data) {
      var d = st.data, n = d.now || {}, e5 = d.era5Soil, a = d.air || {}, req = st.req, list = d.warnings || [];
      h += fresh(d);
      if (req.approximate) h += '<p class="fs-cn-note">These fields are the example layout, so each is checked as a square of its size around its soil survey point. Import your real field (the section below the simulation) for checks on your exact fields.</p>';
      h += '<div class="fs-cn-cards">' +
        card('Air', num(n.tempC, ' °C', 1), 'humidity ' + num(n.rhPct, '%')) +
        card('Wind', num(n.windKmh, ' km/h'), 'gusts ' + num(n.gustKmh, ' km/h')) +
        card('Rain', num(n.rainPast7Mm, ' mm', 1), 'past 7 days · next 3 days ' + num(n.rainNext3Mm, ' mm', 1)) +
        card('Topsoil water', n.soilMoist == null ? '–' : Math.round(n.soilMoist * 100) + '%', 'by volume, now' + (e5 ? ' · ERA5-Land ' + Math.round(e5.top7 * 100) + '% on ' + esc(e5.time.slice(5, 10)) : '')) +
        card('Air quality', num(a.pm25, ' µg/m³'), 'fine dust PM2.5 · UV ' + num(a.uv, '', 1)) + '</div>';
      h += nasaHTML(d);
      h += '<div class="fs-cn-main">' + miniMap(d, req, list) + '<div class="fs-cn-warns"><h3>Warnings</h3>' +
        (list.length ? '<ol>' + list.map(function (w, i) {
          return '<li class="fs-cn-' + w.level + (i === pick ? ' fs-cn-on' : '') + '"><button type="button" data-i="' + i + '"' + (w.lon == null ? ' disabled' : '') + '><span class="fs-cn-badge">' + (w.level === 'warn' ? 'Warning' : 'Note') + '</span> ' + esc(w.text) + '</button></li>';
        }).join('') + '</ol>' : '<p>Nothing to warn about on these fields right now.</p>') + '</div></div>';
      h += '<div class="fs-cn-tablewrap"><table class="fs-cn-table"><thead><tr><th>Field</th><th>Organic carbon</th><th>Nitrogen</th><th>pH</th><th>CEC</th><th>Cropland · water · wetland</th><th>Slope</th><th>Bare soil now</th><th>Last summer\u2019s greenness</th></tr></thead><tbody>' +
        req.fields.map(function (f) {
          var x = d.fields[f.id] || {}, s = x.fertility || {}, c = (x.cover && x.cover.sharePct) || {}, t = x.terrain || {}, sat = x.satellite || {};
          return '<tr><th>' + esc(f.name) + '</th><td>' + num(s.organicCarbonGkg, ' g/kg', 1) + '</td><td>' + num(s.nitrogenGkg, ' g/kg', 2) + '</td><td>' + num(s.ph, '', 1) + '</td><td>' + num(s.cecCmolKg, '', 0) + '</td>' +
            '<td>' + num(c.cropland, '%', 0) + ' · ' + num(c.water || 0, '%', 1) + ' · ' + num(c.wetland || 0, '%', 1) + '</td><td>' + num(t.slopePct, '%', 1) + '</td>' +
            '<td>' + (sat.ground ? sat.ground.bareSoilPct + '%' : '–') + '</td><td>' + (sat.summer ? 'NDVI ' + sat.summer.ndviMedian + ' <i class="fs-fm-faint">(image of ' + esc(sat.summer.date) + ')</i>' : '–') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      h += healthHTML();
      h += '<p class="fs-fm-note">Sources: ' + esc((d.sources || []).join(' ')) + (d.gaps && d.gaps.length ? ' Gaps: ' + esc(d.gaps.join(' ')) : '') +
        ' Organic carbon, nitrogen, pH and CEC (how much nutrient the soil holds) are model estimates for the top 30 cm; a lab soil test is more exact. Warnings are simple rules on these numbers, not an agronomist\'s visit.</p>';
    }
    layer.innerHTML = h;
    var rf = layer.querySelector('#fs-cn-refresh'); if (rf) rf.addEventListener('click', function () { load(true); });
    Array.prototype.forEach.call(layer.querySelectorAll('.fs-cn-warns button, .fs-cn-pin'), function (b) {
      b.addEventListener('click', function () { var i = +b.getAttribute('data-i'); pick = pick === i ? -1 : i; render(); });
    });
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
    rows.push(['Ponds and land cover', 'ESA WorldCover 2021', 'fixed map'], ['Soil fertility', 'ISRIC SoilGrids', 'fixed map']);
    return '<div class="fs-cn-fresh" aria-label="How recent each source is">' + rows.map(function (r) { return '<span><b>' + esc(r[0]) + '</b> ' + esc(r[1]) + ' <i>' + esc(r[2]) + '</i></span>'; }).join('') +
      '<span class="fs-cn-auto">Checks again by itself every 15 minutes while this view is open.</span></div>';
  }
  // the NASA lines: fire detections and MERRA-2 soil wetness
  function nasaHTML(d) {
    var N = d.nasa || {}, rows = [];
    if (N.fire) rows.push('<li class="' + (N.fire.detections.length ? 'fs-cn-warn' : '') + '">' + esc(N.fire.line) + '</li>');
    if (N.soil) rows.push('<li>' + esc(N.soil.line) + '</li>');
    return rows.length ? '<div class="fs-cn-nasa"><h3>NASA Data On These Fields</h3><ul>' + rows.join('') + '</ul></div>' : '';
  }
  function card(t, big, small) { return '<div class="fs-cn-card"><span class="fs-cn-t">' + t + '</span><strong>' + big + '</strong><span class="fs-cn-s">' + small + '</span></div>'; }

  function show(on, body) {
    if (!layer && on) { layer = document.createElement('section'); layer.className = 'fs-fm fs-cn'; layer.setAttribute('aria-label', 'Advanced Near-Real-Time Conditions'); body.appendChild(layer); }
    if (!layer) return;
    open = on; layer.hidden = !on;
    clearInterval(auto); auto = null;
    if (on) { load(); auto = setInterval(function () { if (!st.busy) load(true, true); }, 15 * 60e3); } else clearInterval(timer);
  }
  // the farm changed: check again next time the view is open (now, if it is open)
  function refresh() { if (open) load(); }
  FS.conditions = { show: show, refresh: refresh };
})();
