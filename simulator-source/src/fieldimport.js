/* Field outlines from a GeoJSON file: the farm's own fields instead of the example layout.
   Takes a FeatureCollection, Feature or bare geometry of Polygons or MultiPolygons in longitude/latitude (WGS84, the GeoJSON standard),
   as exported by geojson.io, QGIS, John Deere Operations Center or Climate FieldView. Up to four fields: the largest four if there are more.
   A field's name comes from its "name" property (or Name, field_name, FIELD_NAME, title, label); its last crop from "crop" or "lastCrop" if given.
   The server (/api/fieldconditions, fieldgeo.js) then measures the conditions on those exact fields: 44 seasons of daily Copernicus
   NASA POWER weather at the farm (Copernicus ERA5 only if NASA POWER does not answer), slope and height from the Copernicus GLO-30 elevation model inside each outline, the USDA soil
   survey well inside each field and USDA county yields. The simulator replays that weather on those fields. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var IDS = ['north', 'creek', 'west', 'south'], MAX = 4, ACRE = 4046.8564224, R = Math.PI / 180, VW = 1000, VH = 640, PAD = 48;
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function fail(t) { say(t); status('err', t); }
  function say(t) { try { FS.actions.addChat({ role: 'assistant', text: t }); } catch (e) { console.log(t); } }
  function base() { return /^https?:$/.test(location.protocol) ? location.origin : null; }

  // ---------------------------------------------------------------- GeoJSON -> rings
  function areaM2(ring) {
    var s = 0;
    for (var i = 0; i < ring.length; i++) { var a = ring[i], b = ring[(i + 1) % ring.length]; s += (b[0] - a[0]) * R * (2 + Math.sin(a[1] * R) + Math.sin(b[1] * R)); }
    return Math.abs(s * 6378137 * 6378137 / 2);
  }
  function ringOf(r) {
    if (!Array.isArray(r)) return null;
    var out = [];
    for (var i = 0; i < r.length; i++) {
      var p = r[i]; if (!Array.isArray(p) || p.length < 2) return null;
      var x = +p[0], y = +p[1]; if (!isFinite(x) || !isFinite(y)) return null;
      if (Math.abs(x) > 180 || Math.abs(y) > 90) throw new Error('the coordinates are not longitude and latitude. Export the file in WGS84 (EPSG:4326), the GeoJSON standard');
      out.push([x, y]);
    }
    out = dedupe(out);
    if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-9 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
    return out.length >= 3 ? out : null;
  }
  // Fewer points for very detailed outlines (curved edges, center pivots, tractor-logged boundaries with thousands of points).
  // Douglas-Peucker in metres keeps the points that carry the shape, so curves stay curves and the area hardly changes;
  // the tolerance grows (0.1 m, 0.2 m, 0.4 m ...) only until the outline fits in max points.
  function simplifyAt(r, tol) {
    var n = r.length; if (n <= 4) return r.slice();
    var lat0 = 0; r.forEach(function (p) { lat0 += p[1]; }); lat0 /= n;
    var kx = 111320 * Math.cos(lat0 * R), ky = 110540, P = r.map(function (p) { return [p[0] * kx, p[1] * ky]; });
    // split the closed ring at its two farthest-apart points so both halves are simplified as open lines
    var a = 0, b = 0, best = -1;
    for (var i = 0; i < n; i++) { var dd = Math.pow(P[i][0] - P[0][0], 2) + Math.pow(P[i][1] - P[0][1], 2); if (dd > best) { best = dd; b = i; } }
    var keep = new Uint8Array(n); keep[a] = keep[b] = 1;
    function seg(p, q, i) {
      var dx = q[0] - p[0], dy = q[1] - p[1], L = dx * dx + dy * dy, t = L ? ((i[0] - p[0]) * dx + (i[1] - p[1]) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t)); return Math.hypot(i[0] - (p[0] + t * dx), i[1] - (p[1] + t * dy));
    }
    function dp(s, e) {   // indexes along the ring from s to e (wrapping)
      var stack = [[s, e]];
      while (stack.length) {
        var se = stack.pop(), i0 = se[0], i1 = se[1], m = -1, md = tol, len = (i1 - i0 + n) % n;
        for (var k = 1; k < len; k++) { var j = (i0 + k) % n, d = seg(P[i0], P[i1], P[j]); if (d > md) { md = d; m = j; } }
        if (m >= 0) { keep[m] = 1; stack.push([i0, m], [m, i1]); }
      }
    }
    dp(a, b); dp(b, a);
    var o = []; for (var j = 0; j < n; j++) if (keep[j]) o.push(r[j]);
    return o.length >= 3 ? o : r.slice(0, 3);
  }
  function thin(r, max) {
    if (r.length <= max) return r;
    for (var tol = 0.1; tol < 5000; tol *= 2) { var o = simplifyAt(r, tol); if (o.length <= max) return o; }
    var k = Math.ceil(r.length / max), q = []; for (var i = 0; i < r.length; i += k) q.push(r[i]); return q;   // never reached in practice
  }
  // A center pivot saved as a point with a radius (a common way pivots are stored): a 128-point circle.
  var RADIUS_M = ['radius', 'Radius', 'RADIUS', 'radius_m', 'radiusM', 'radius_meters'], RADIUS_FT = ['radius_ft', 'radiusFt', 'radius_feet'];
  function radiusOf(p) {
    p = p || {};
    for (var i = 0; i < RADIUS_M.length; i++) { var v = parseFloat(p[RADIUS_M[i]]); if (v > 0) return v; }
    for (var j = 0; j < RADIUS_FT.length; j++) { var f = parseFloat(p[RADIUS_FT[j]]); if (f > 0) return f * 0.3048; }
    return 0;
  }
  function circle(lon, lat, rM) {
    var o = [], kx = 111320 * Math.cos(lat * R), ky = 110540;
    for (var i = 0; i < 128; i++) { var t = i / 128 * 2 * Math.PI; o.push([lon + Math.cos(t) * rM / kx, lat + Math.sin(t) * rM / ky]); }
    return o;
  }
  // GeoJSON has no true arcs: curved edges arrive as many short straight pieces, which is what the simplification above keeps.
  // Repeated points and zero-length steps (common in GPS-logged outlines) are dropped.
  function dedupe(r) { var o = []; r.forEach(function (p) { var q = o[o.length - 1]; if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) o.push(p); }); return o; }
  function pickName(p) {
    p = p || {};
    var keys = ['name', 'Name', 'NAME', 'field_name', 'fieldName', 'FIELD_NAME', 'Field', 'field', 'title', 'label', 'id'];
    for (var i = 0; i < keys.length; i++) if (p[keys[i]] != null && String(p[keys[i]]).trim()) return String(p[keys[i]]).trim().slice(0, 28);
    return '';
  }
  function pickCrop(p) {
    p = p || {};
    var v = String(p.lastCrop || p.last_crop || p.crop || p.Crop || p.CROP || '').toLowerCase();
    return /corn|maize/.test(v) ? 'corn' : /soy/.test(v) ? 'soybean' : '';
  }
  function parse(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('the file is not valid JSON'); }
    var feats = [];
    (function walk(o, props) {
      if (!o || typeof o !== 'object') return;
      if (o.type === 'FeatureCollection') (o.features || []).forEach(function (f) { walk(f); });
      else if (o.type === 'Feature') walk(o.geometry, o.properties || {});
      else if (o.type === 'GeometryCollection') (o.geometries || []).forEach(function (g) { walk(g, props); });
      else if (o.type === 'Polygon' || o.type === 'MultiPolygon') feats.push({ g: o, p: props || {} });
      else if ((o.type === 'Point' || o.type === 'MultiPoint') && radiusOf(props) > 0) {
        var pts = o.type === 'Point' ? [o.coordinates] : o.coordinates || [], rM = radiusOf(props);
        pts.forEach(function (c) { if (Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])) feats.push({ g: { type: 'Polygon', coordinates: [circle(+c[0], +c[1], rM)] }, p: props || {} }); });
      }
    })(j);
    if (!feats.length) throw new Error('there are no field outlines in it (Polygon or MultiPolygon, or a center pivot saved as a Point with a "radius" in metres or "radius_ft" in feet)');
    var fields = [], multi = 0;
    feats.forEach(function (x) {
      var polys = x.g.type === 'Polygon' ? [x.g.coordinates] : x.g.coordinates || [];
      var best = null;
      polys.forEach(function (pc) {   // a field in several parts: the largest part is the field
        if (!Array.isArray(pc)) return;
        var ring = ringOf(pc[0]); if (!ring) return;
        var holes = pc.slice(1).map(ringOf).filter(function (h) { return h && areaM2(h) >= 100; })
          .sort(function (p, q) { return areaM2(q) - areaM2(p); }).slice(0, 12);
        var a = areaM2(ring) - holes.reduce(function (s, h) { return s + areaM2(h); }, 0);
        if (!best || a > best.area) best = { ring: ring, holes: holes, area: a };
      });
      if (polys.length > 1) multi++;
      if (best && best.area > 0) fields.push({ name: pickName(x.p), lastCrop: pickCrop(x.p), ring: best.ring, holes: best.holes, area: best.area });
    });
    if (!fields.length) throw new Error('none of its outlines has an area');
    var total = fields.length;
    fields.sort(function (a, b) { return b.area - a.area; });
    fields = fields.slice(0, MAX);
    return { fields: fields, total: total, multi: multi };
  }

  // ---------------------------------------------------------------- outlines -> the field view's 1000 x 640 canvas (north up, true shape)
  function toView(fields) {
    var lat0 = 0, n = 0;
    fields.forEach(function (f) { f.ring.forEach(function (p) { lat0 += p[1]; n++; }); });
    lat0 /= n;
    var k = Math.cos(lat0 * R), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    fields.forEach(function (f) { f.ring.forEach(function (p) { var x = p[0] * k, y = -p[1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }); });
    var s = Math.min((VW - 2 * PAD) / Math.max(x1 - x0, 1e-9), (VH - 2 * PAD) / Math.max(y1 - y0, 1e-9));
    var ox = (VW - (x1 - x0) * s) / 2, oy = (VH - (y1 - y0) * s) / 2;
    function px(p) { return [Math.round((ox + (p[0] * k - x0) * s) * 10) / 10, Math.round((oy + (-p[1] - y0) * s) * 10) / 10]; }
    return fields.map(function (f) {
      return { poly: thin(f.ring, 400).map(px), holes: (f.holes || []).map(function (h) { return thin(h, 80).map(px); }) };
    });
  }

  // ---------------------------------------------------------------- import
  function importText(text, fileName) {
    if (busy) return;
    var P;
    try { P = parse(text); } catch (e) { fail('I could not read ' + (fileName || 'that file') + ': ' + e.message + '.'); return; }
    var srv = base();
    if (!srv) { fail('Reading the conditions on your fields needs the EcoShift server (run npm start and open http://localhost:8787).'); return; }
    var fields = P.fields.map(function (f, i) { return { id: IDS[i], name: f.name || ('Field ' + (i + 1)), lastCrop: f.lastCrop, ring: f.ring, holes: f.holes, acres: f.area / ACRE }; });
    var rnd6 = function (r) { return r.map(function (p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }); };   // about 0.1 m
    function sized(maxRing, maxHole) { return fields.map(function (f) { return { id: f.id, name: f.name, ring: rnd6(thin(f.ring, maxRing)), holes: f.holes.map(function (h) { return rnd6(thin(h, maxHole)); }) }; }); }
    var sendRing = 1200, sendHole = 300, payload = sized(sendRing, sendHole);
    while (JSON.stringify({ fields: payload }).length > 90000 && sendRing > 60) { sendRing = Math.round(sendRing * 0.7); sendHole = Math.max(12, Math.round(sendHole * 0.7)); payload = sized(sendRing, sendHole); }
    fields.forEach(function (f, i) { f.ring = payload[i].ring; f.holes = payload[i].holes; });
    var small = fields.filter(function (f) { return f.acres < 1 || f.acres > 5000; })[0];
    if (small) { fail(small.name + ' is ' + Math.round(small.acres * 10) / 10 + ' acres. Each field must be between 1 and 5000 acres.'); return; }
    var polys = toView(fields);
    busy = true; setBusy(true);
    say('Reading ' + fields.length + ' field' + (fields.length === 1 ? '' : 's') + ' from ' + (fileName || 'your file') + ': ' + fields.map(function (f) { return f.name + ' (' + Math.round(f.acres) + ' ac)'; }).join(', ') + '.' +
      (P.total > MAX ? ' The file has ' + P.total + ' outlines; the simulator takes four, so I kept the four largest.' : '') +
      ' Getting 44 seasons of NASA POWER weather and the Copernicus elevation model for them. This takes 10 to 40 seconds.');
    fetch(srv + '/api/fieldconditions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: payload }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) {
        if (!x.ok || !x.j || !x.j.climate) throw new Error((x.j && x.j.error) || 'the server could not read the conditions just now');
        apply(fields, polys, x.j, fileName);
      })
      .catch(function (e) { fail('I could not get the conditions for your fields: ' + String(e && e.message || e) + ' Nothing was changed.'); })
      .then(function () { busy = false; setBusy(false); });
  }

  function nearestSite(lat, lon) {
    var best = 'story-ia', bd = Infinity;
    (FS.data.sites || []).forEach(function (s) {
      if (!isFinite(s.lat) || !isFinite(s.lon)) return;
      var d = Math.pow(s.lat - lat, 2) + Math.pow((s.lon - lon) * Math.cos(lat * R), 2); if (d < bd) { bd = d; best = s.id; }
    });
    return best;
  }

  function apply(fields, polys, cond, fileName) {
    var cur = FS.farmSetup.setup, setup = cur && !cur.example ? JSON.parse(JSON.stringify(cur)) : FS.farmSetup.blank();
    var before = setup.geo ? setup.geo.before : { fields: JSON.parse(JSON.stringify(setup.fields)), point: setup.point, site: setup.site, example: !cur || !!cur.example };   // put back by "Use example fields"
    setup.example = false;
    setup.site = nearestSite(cond.center[1], cond.center[0]);
    setup.point = { lat: cond.center[1], lon: cond.center[0], label: cond.county ? 'Your fields, ' + cond.county : 'Your fields', county: '', state: '' };
    setup.fit = null;
    // the questionnaire keeps four acre answers: the imported fields' own, kept in its range
    setup.fields.forEach(function (q) {
      var f = fields.filter(function (x) { return x.id === q.id; })[0];
      if (f) { q.acres = Math.max(10, Math.min(640, Math.round(f.acres))); if (f.lastCrop) q.lastCrop = f.lastCrop; }
    });
    setup.geo = {
      before: before, file: String(fileName || '').slice(0, 80), at: new Date().toISOString().slice(0, 10),
      fields: fields.map(function (f, i) {
        return { id: f.id, name: f.name, acres: Math.round(f.acres * 10) / 10, lastCrop: f.lastCrop || '', poly: polys[i].poly, holes: polys[i].holes,
          ring: thin(f.ring, 400).map(function (p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }),
          holesLL: (f.holes || []).map(function (h) { return thin(h, 80).map(function (p) { return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]; }); }) };   // the holes in longitude/latitude, for the live conditions (holes above is in view units)   // for the live conditions   // no crop in the file: the questionnaire's answer
      }),
      cond: cond
    };
    var r = FS.farmSetup.use(setup);
    if (!r.ok) { fail('Your fields could not be set up: ' + (r.error || 'unknown error') + '.'); return; }
    say(report(setup.geo, setup));
    status('ok', 'Imported. The simulation now runs on your fields; the details are in the chat and the Advanced Near-Real-Time Conditions tab.');
    show();
  }

  function report(g, setup) {
    var c = g.cond, t = [], crop = function (id) { var f = (FS.data.farm.fields || []).filter(function (x) { return x.id === id; })[0]; return f ? f.lastCrop : 'corn'; };
    t.push('Your fields are in the simulator, drawn from their real outlines.');
    g.fields.forEach(function (f) {
      var x = (c.fields || {})[f.id] || {}, tr = x.terrain, so = x.soil, bits = [Math.round(f.acres) + ' acres', 'last crop ' + (crop(f.id) === 'soybean' ? 'soybeans' : 'corn')];
      if (tr) bits.push(tr.slopePct + '% average slope, ' + tr.elevationM + ' m high (' + tr.minM + ' to ' + tr.maxM + ' m)');
      if (so) bits.push(so.name + ', ' + String(so.drainage || '').toLowerCase() + ', holds ' + so.awcMmPerM + ' mm of water per metre');
      t.push(f.name + ': ' + bits.join('; ') + '.');
    });
    if (c.sources && c.sources.length) t.push('Used: ' + c.sources.join(' '));
    if (c.gaps && c.gaps.length) t.push('Gaps: ' + c.gaps.join(' '));
    t.push('Set each field\'s last crop with a "crop" property in the file (corn or soybean), or change it under "Your farm · Change". This farm has not been checked against its own harvests.');
    return t.join('\n');
  }

  function remove() {
    var cur = FS.farmSetup.setup; if (!cur || !cur.geo) return;
    var b = cur.geo.before || {}, setup = b.example ? FS.farmSetup.blank() : JSON.parse(JSON.stringify(cur));
    delete setup.geo; setup.fit = null;
    if (b.example) setup.example = true;
    else { if (Array.isArray(b.fields) && b.fields.length === 4) setup.fields = b.fields; setup.point = b.point || null; if (b.site) setup.site = b.site; }
    var r = FS.farmSetup.use(setup);
    say(r.ok ? 'Back to the example field layout with the county\'s NASA weather.' : 'That did not work: ' + (r.error || 'unknown error') + '.');
    show();
  }

  // ---------------------------------------------------------------- the Import Field button and its small panel (in the Simulation panel)
  var TYPES = ['.geojson', '.json', '.kml'];
  var TYPES_WORDS = 'GeoJSON (.geojson or .json) or KML (.kml, as saved by Google Earth)';
  function extOf(name) { var m = /\.[^.]+$/.exec(String(name || '').toLowerCase()); return m ? m[0] : ''; }
  // KML (Google Earth): every Placemark with a Polygon becomes a GeoJSON feature; its name and an optional "crop" value come along
  function kmlToGeoJSON(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('the KML file could not be read');
    function ring(el) {
      var c = el && el.getElementsByTagName('coordinates')[0]; if (!c) return null;
      return c.textContent.trim().replace(/\s*,\s*/g, ',').split(/\s+/).map(function (t) { var p = t.split(','); return [+p[0], +p[1]]; }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    }
    var feats = [];
    Array.prototype.forEach.call(doc.getElementsByTagName('Placemark'), function (pm) {
      var nm = pm.getElementsByTagName('name')[0], props = { name: nm ? nm.textContent.trim() : '' };
      Array.prototype.forEach.call(pm.getElementsByTagName('Data'), function (d) { var v = d.getElementsByTagName('value')[0]; if (v) props[d.getAttribute('name')] = v.textContent.trim(); });
      Array.prototype.forEach.call(pm.getElementsByTagName('SimpleData'), function (d) { props[d.getAttribute('name')] = d.textContent.trim(); });
      Array.prototype.forEach.call(pm.getElementsByTagName('Polygon'), function (pg) {
        var outer = ring(pg.getElementsByTagName('outerBoundaryIs')[0]); if (!outer) return;
        var holes = Array.prototype.map.call(pg.getElementsByTagName('innerBoundaryIs'), ring).filter(Boolean);
        feats.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [outer].concat(holes) } });
      });
    });
    return JSON.stringify({ type: 'FeatureCollection', features: feats });
  }
  function readFile(f) {
    var ext = extOf(f.name);
    if (TYPES.indexOf(ext) < 0) { status('err', (ext ? 'A ' + ext + ' file' : 'That file') + ' can’t be used. Only ' + TYPES_WORDS + ' files work.'); return; }
    if (f.size > 5 * 1024 * 1024) { status('err', 'That file is over 5 MB. Export only the field boundaries, or simplify them, and try again.'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var t = String(rd.result || '');
      if (ext === '.kml') { try { t = kmlToGeoJSON(t); } catch (e) { status('err', 'I could not read ' + f.name + ': ' + e.message + '.'); return; } }
      importText(t, f.name);
    };
    rd.onerror = function () { status('err', 'I could not open ' + f.name + '.'); };
    rd.readAsText(f);
  }
  function status(kind, text) {
    var el = $('fs-imp-status'); if (!el) return;
    el.className = 'fs-imp-status' + (kind ? ' fs-imp-' + kind : ''); el.textContent = text || ''; el.hidden = !text;
    if (text) setOpen(true);   // a message (progress, error, done) is always shown, never hidden behind a closed panel
  }
  function setBusy(on) {
    var z = $('fs-imp-zone'); if (z) z.classList.toggle('fs-imp-busy', on);
    var i = $('fs-imp-file'); if (i) i.disabled = on;
    var b = $('fs-imp-btn'); if (b) b.classList.toggle('is-busy', on);
    if (on) status('wait', 'Reading your fields and getting 44 seasons of weather and the elevation of your land. This takes 10 to 40 seconds.');
  }
  function show() {
    var cur = FS.farmSetup && FS.farmSetup.setup, g = cur && !cur.example && cur.geo, done = $('fs-imp-done');
    if (!done) return;
    done.hidden = !g;
    var b = $('fs-imp-btn'); if (b) b.classList.toggle('is-on', !!g);
    if (g) {
      $('fs-imp-what').textContent = 'Simulating your ' + g.fields.length + ' imported field' + (g.fields.length === 1 ? '' : 's') + (g.file ? ' from ' + g.file : '') + ': ' +
        g.fields.map(function (f) { return f.name + ' (' + Math.round(f.acres) + ' ac)'; }).join(', ') + '.';
      var st = $('fs-imp-status'); if (st && /wait/.test(st.className)) status('', '');
      setOpen(true);   // imported fields are active: keep Reset Simulation easy to find
    }
  }
  // the small panel under the Simulation head: open on the Import Field button, held open while an import runs
  function setOpen(on) {
    var sec = $('fs-import'), btn = $('fs-imp-btn'); if (!sec || !btn) return;
    if (!on && busy) on = true;
    sec.hidden = !on; btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function mount() {
    if ($('fs-import')) return;
    var panel = $('fs-view-panel'), right = panel && panel.querySelector('.fs-head-right'), head = panel && panel.querySelector('.fs-panel-head');
    if (!panel || !right || !head) return;
    // the button sits in the Simulation head, after the Simulation / Farm Map / Conditions tabs
    var btn = document.createElement('button'); btn.type = 'button'; btn.id = 'fs-imp-btn'; btn.className = 'fs-imp-btn';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'fs-import');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg><span>Import Field</span>';
    var ex = right.querySelector('.fs-expand'); right.insertBefore(btn, ex || null);
    var sec = document.createElement('section'); sec.id = 'fs-import'; sec.className = 'fs-imp-panel'; sec.setAttribute('aria-label', 'Import your field'); sec.hidden = true;
    sec.innerHTML =
      '<div class="fs-imp-card">' +
      '<div class="fs-imp-row">' +
        '<label id="fs-imp-zone" class="fs-imp-zone" data-tip="Import your real field. Accepted: .geojson, .json or .kml">' +
          '<input type="file" id="fs-imp-file" accept=".geojson,.json,.kml,application/geo+json,application/vnd.google-earth.kml+xml" aria-describedby="fs-imp-types">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>' +
          '<span class="fs-imp-big">Drop a field file here, or click to choose</span>' +
          '<span class="fs-imp-tip" role="tooltip">Import your real field<br><b>Accepted:</b> .geojson, .json, .kml</span>' +
        '</label>' +
        '<p class="fs-imp-try">No file? Try a sample: <a href="sample-fields.geojson" class="fs-imp-sample" data-name="sample-fields.geojson">Iowa sample</a> · <a href="california-fields.geojson" class="fs-imp-sample" data-name="california-fields.geojson">California sample</a></p>' +
      '</div>' +
      '<div class="fs-imp-info">' +
        '<details class="fs-imp-more"><summary>Which Files Work?</summary>' +
          '<p id="fs-imp-types"><b>Files that work:</b> ' + TYPES_WORDS + '. Other files (shapefiles, KMZ, CSV, images) are not accepted.</p>' +
          '<ul><li>Field outlines (polygons) in longitude and latitude (WGS84), as exported by geojson.io, Google Earth, QGIS, John Deere Operations Center or Climate FieldView.</li>' +
          '<li>Up to 4 fields (the largest 4 if there are more), each 1 to 5000 acres; 5 MB at most.</li>' +
          '<li>Optional: a <code>name</code> for each field and a <code>crop</code> (corn or soybean).</li>' +
          '<li>Download the samples to see the format: <a href="sample-fields.geojson" download>Iowa</a>, <a href="california-fields.geojson" download>California</a>.</li></ul>' +
        '</details>' +
        '<p id="fs-imp-status" class="fs-imp-status" role="status" hidden></p>' +
        '<div id="fs-imp-done" class="fs-imp-done" hidden><p id="fs-imp-what"></p>' +
          '<button type="button" id="fs-imp-reset" class="fs-btn-primary">Reset Simulation</button>' +
          '<span class="fs-fm-faint">Removes your fields and starts again with every setting back to its start.</span></div>' +
      '</div></div>';
    head.parentNode.insertBefore(sec, head.nextSibling);   // right under the head; it floats over the view, so the map keeps its size
    btn.addEventListener('click', function () { setOpen(sec.hidden); });
    document.addEventListener('keydown', function (e) {   // Escape closes the panel when focus is in it or on its button
      if (e.key !== 'Escape' || busy || sec.hidden || !(sec.contains(document.activeElement) || document.activeElement === btn)) return;
      setOpen(false); btn.focus();
    });
    var inp = $('fs-imp-file'), zone = $('fs-imp-zone');
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; inp.value = ''; if (f) readFile(f); });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('fs-imp-over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('fs-imp-over'); }); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); if (busy) return; var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    // a file dropped anywhere on the Simulation panel opens the import panel and imports it
    function hasFiles(e) { return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0); }
    panel.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    panel.addEventListener('dragenter', function (e) { if (hasFiles(e)) { e.preventDefault(); setOpen(true); } });
    panel.addEventListener('drop', function (e) {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault(); if (busy) return; setOpen(true);
      var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f);
    });
    $('fs-imp-reset').addEventListener('click', reset);
    // the sample links import the sample straight away (their own download links sit next to them)
    Array.prototype.forEach.call(sec.querySelectorAll('.fs-imp-sample'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault(); if (busy) return;
        status('busy', 'Loading the ' + a.textContent + '…');
        fetch(a.getAttribute('href')).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
          .then(function (b) { readFile(new File([b], a.getAttribute('data-name'), { type: 'application/geo+json' })); })
          .catch(function () { status('err', 'The sample could not be loaded. Try again, or download it and drop it in the box.'); });
      });
    });
    show();
  }
  // back to the start: the imported fields come out, the farm returns to what it was, every setting goes back to its default and the simulation runs again
  function reset() {
    remove();
    try { FS.fieldView.pause(); FS.fieldView.setWeek(0); } catch (e) { /* the view may not be ready */ }
    status('ok', 'Reset. Your fields are out and every setting is back to its start.');
    var top = $('fs-app'); if (top && top.scrollIntoView) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 0); }); else setTimeout(mount, 0);

  FS.fieldImport = { open: setOpen, show: show, importText: importText, parse: parse, remove: remove, reset: reset, kmlToGeoJSON: kmlToGeoJSON };
})();
