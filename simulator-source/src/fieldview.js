/* Bird's-eye farm view: canvas drawn like an aerial photo (procedural textures), animated week by week from result.weeks.
   FS.fieldView.mount(el) renders everything inside el (#fs-view): canvas, legend overlay, labels, tooltip, playback bar.
   When a real farm map exists (FS.data.farmMaps for the county, or the farmer's own map from the server) the four fields are painted on that map's
   real field outlines in the farm map converter's flat striped style; otherwise the hand-drawn layout below is used. See REALMAP.md. */
window.FS = window.FS || {};
(function () {
  'use strict';

  var DATA = FS.data, VW = DATA.farm.view.w, VH = DATA.farm.view.h;
  var FIELDS = DATA.farm.fields, SCN = DATA.farm.scenery;
  var WEEKS_PER_SEC = 1.6;                       // playback speed at 1x
  var CROP_LABEL = { corn: 'Corn', soybean: 'Soybean', rye: 'Cereal rye', oats: 'Oats', none: 'No crop' };
  var STAGE_LABEL = { bare: 'bare soil', residue: 'residue', planted: 'planted', emerged: 'emerged', vegetative: 'vegetative', flowering: 'flowering',
                      grainfill: 'grain fill', mature: 'mature', harvested: 'harvested', cover: 'cover crop' };
  var FLAG_LABEL = { heat: 'heat', drought: 'dry soil', frost: 'frost', waterlogged: 'waterlogged', erosion: 'erosion risk', 'planting-delay': 'planting delayed' };
  var TYPE_LABEL = { heat: 'Heat', drought: 'Dry soil', frost: 'Frost', waterlogged: 'Waterlogged', 'heavy-rain': 'Heavy rain', erosion: 'Erosion', 'planting-delay': 'Planting delay', harvest: 'Harvest' };
  var ROW_DIR = { north: 'h', creek: 'v', west: 'h', south: 'h' };
  var SPACING = { corn: 7.5, soybean: 4.8, oats: 3, rye: 2.6 };

  // ------------------------------------------------------------------ real farm map: palette (copied from farmmap/stylize_farm.py PAL) and field paint
  var MAPSIZE = 1000, STRIPES = 56, MGAP = 3;          // map units; the converter's stripes across the image and field gap
  var MP = {
    base: [104, 134, 56], grass: [[155, 181, 79], [126, 158, 66]], green: [[142, 168, 72], [118, 146, 58]], dark: [[110, 140, 56], [90, 118, 46]],
    yellow: [[194, 206, 98], [163, 180, 76]], soil: [[200, 168, 108], [174, 142, 88]], dry: [[230, 210, 144], [210, 188, 122]],
    gold: [[218, 178, 86], [194, 152, 64]], yg: [[176, 192, 84], [148, 166, 66]], parched: [[196, 172, 104], [176, 152, 88]]
  };
  var CREDIT_SHORT = { usgs: 'USDA NAIP aerial imagery via USGS (public domain)', s2: 'Sentinel-2 cloudless 2020, EOX (CC BY-NC-SA 4.0)' };
  var SOURCE_WORDS = { usgs: 'USDA aerial photos', s2: 'Sentinel-2 satellite images' };
  function mixC(a, b, t) { t = clamp(t, 0, 1); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function mixP(p, q, t) { return [mixC(p[0], q[0], t), mixC(p[1], q[1], t)]; }
  function rgb3(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a == null ? 1 : +a.toFixed(3)) + ')'; }

  // ------------------------------------------------------------------ small utils
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(s) { var h = 7; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  function parseCol(s) {
    s = (s || '').trim(); var m;
    if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) { var h = m[1]; if (h.length === 3) h = h.replace(/./g, '$&$&'); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; }
    if ((m = /rgba?\(([^)]+)\)/.exec(s))) { var p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return [128, 128, 128, 1];
  }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), 1]; }
  function shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k, 1]; }
  function light(c, t) { return mix(c, [255, 255, 255, 1], t); }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a == null ? 1 : +a.toFixed(3)) + ')'; }
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function has(arr, f) { return arr && arr.indexOf(f) >= 0 ? 1 : 0; }

  // ------------------------------------------------------------------ colors from tokens (re-read on theme change)
  var T = null;
  function readTokens() {
    var cs = getComputedStyle(document.documentElement);
    function g(n) { return parseCol(cs.getPropertyValue(n)); }
    T = { font: cs.getPropertyValue('--font-sans').trim(), bg: g('--bg'), panel: g('--panel'), text: g('--text'), accent: g('--accent'), info: g('--water'), warn: g('--warn'), danger: g('--danger'),
          border: g('--border-strong'), crop: { corn: g('--crop-corn'), soybean: g('--crop-soybean'), rye: g('--crop-rye'), oats: g('--crop-oats'), none: g('--crop-none') } };
    T.soil = shade(T.crop.none, 0.78); T.soilDark = shade(T.crop.none, 0.5); T.shadow = shade(T.soilDark, 0.3);
    T.ground = shade(mix(T.crop.soybean, T.crop.none, 0.35), 0.5); T.lawn = shade(mix(T.crop.soybean, T.crop.none, 0.2), 0.62);
    T.tan = light(mix(T.crop.oats, T.crop.none, 0.2), 0.25); T.road = light(mix(T.crop.oats, T.crop.none, 0.35), 0.45);
    T.water = mix(T.info, T.soilDark, 0.45); T.frost = light(mix(T.info, [255, 255, 255, 1], 0.6), 0.4); T.rain = light(T.info, 0.55);
    T.tree = shade(mix(T.crop.soybean, T.crop.rye, 0.4), 0.55);
    T.roof = mix(T.border, T.soilDark, 0.4); T.barn = mix(T.danger, T.soilDark, 0.55);
  }

  // ------------------------------------------------------------------ geometry
  function bbox(poly) { var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }; poly.forEach(function (p) { b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]); b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]); }); return b; }
  function inPoly(poly, x, y) {
    if (poly.holes && poly.holes.length && poly.holes.some(function (h) { return inRing(h, x, y); })) return false;
    return inRing(poly, x, y);
  }
  function inRing(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function distSeg(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  }
  function labelPoint(poly) {   // point furthest from every edge (pole of inaccessibility, coarse grid)
    var b = bbox(poly), best = null, bd = -1;
    for (var x = b.x0; x <= b.x1; x += 5) for (var y = b.y0; y <= b.y1; y += 5) {
      if (!inPoly(poly, x, y)) continue;
      var d = 1e9; [poly].concat(poly.holes || []).forEach(function (r) { for (var i = 0; i < r.length; i++) d = Math.min(d, distSeg(x, y, r[i], r[(i + 1) % r.length])); });
      if (d > bd) { bd = d; best = [x, y]; }
    }
    return best || [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  }
  function signedArea(r) { var s = 0; for (var i = 0; i < r.length; i++) { var a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; }
  // the outline, then each hole drawn the other way round, so fill() and clip() leave the holes empty (nonzero rule)
  function polyPath(c, poly) {
    c.beginPath(); poly.forEach(function (p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }); c.closePath();
    var dir = signedArea(poly) > 0;
    (poly.holes || []).forEach(function (h) {
      var r = (signedArea(h) > 0) === dir ? h.slice().reverse() : h;
      r.forEach(function (p, i) { if (i) c.lineTo(p[0], p[1]); else c.moveTo(p[0], p[1]); }); c.closePath();
    });
  }

  var GEO = {};   // per field: bbox, label point, dry and wet blobs
  function buildGeo() { GEO = {}; FIELDS.forEach(function (f) { if (f.poly) f.poly.holes = Array.isArray(f.holes) ? f.holes : []; }); FIELDS.forEach(geoField); }
  function geoField(f, idx) {
    var r = mulberry(hash(f.id) + 11), b = bbox(f.poly), dry = [], wet = [], tries = 0;
    function blobs(list, n, rmin, rmax) {
      while (list.length < n && tries++ < 400) {
        var x = lerp(b.x0, b.x1, r()), y = lerp(b.y0, b.y1, r());
        if (inPoly(f.poly, x, y)) list.push({ x: x, y: y, r: lerp(rmin, rmax, r()), e: lerp(0.55, 1, r()), a: r() * Math.PI });
      }
    }
    blobs(dry, 9, 22, 55); blobs(wet, 5, 16, 34);
    GEO[f.id] = { bb: b, lp: labelPoint(f.poly), dry: dry, wet: wet, dir: ROW_DIR[f.id] || (idx % 2 ? 'v' : 'h') };
  }
  buildGeo();
  function imported() { return !!DATA.farm.imported; }   // the farmer's own outlines (GeoJSON): no drawn farmstead, roads or creek
  // the weather behind an imported farm: NASA POWER, or the Copernicus ERA5 fallback when NASA POWER did not answer
  function importedWeatherName() { try { var g = FS.engine && FS.engine.site && FS.engine.site().geo; return (g && g.weather) || 'NASA POWER'; } catch (e) { return 'NASA POWER'; } }

  // Geometry of a real farm map's fields in map units (0..MAPSIZE), or null when the record cannot paint all four simulator fields.
  function buildMapGeo(rec) {
    if (!rec || !rec.fields || !rec.img) return null;
    var out = {}, ok = true;
    FIELDS.forEach(function (f) {
      var m = null; (rec.fields || []).forEach(function (q) { if (q && q.id === f.id) m = q; });
      if (!m || !m.poly || m.poly.length < 3) { ok = false; return; }
      var poly = m.poly.map(function (p) { return [p[0] * MAPSIZE, p[1] * MAPSIZE]; }), bb = bbox(poly), th = isFinite(m.theta) ? +m.theta : 0;
      var r = mulberry(hash(f.id) + 77), spots = [], specks = [], tries = 0;
      while ((spots.length < 5 || specks.length < 90) && tries++ < 1200) {
        var x = lerp(bb.x0, bb.x1, r()), y = lerp(bb.y0, bb.y1, r());
        if (!inPoly(poly, x, y)) continue;
        if (spots.length < 5) spots.push({ x: x, y: y, rx: lerp(9, 24, r()), ry: lerp(5, 12, r()), a: th + (r() - 0.5) * 0.4 });
        else specks.push([x, y, 0.9 + r() * 1.4]);
      }
      var n = [Math.cos(th), Math.sin(th)], d = [-Math.sin(th), Math.cos(th)];   // the converter's phase runs along n, stripes lie along d
      var us = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x0, bb.y1], [bb.x1, bb.y1]].map(function (q) { return q[0] * n[0] + q[1] * n[1]; });
      var cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      out[f.id] = { poly: poly, bb: bb, lp: labelPoint(poly), acres: m.acres, n: n, d: d, umin: Math.min.apply(null, us), umax: Math.max.apply(null, us),
                    bx: cx - n[0] * (cx * n[0] + cy * n[1]), by: cy - n[1] * (cx * n[0] + cy * n[1]), R: Math.hypot(bb.x1 - bb.x0, bb.y1 - bb.y0), spots: spots, specks: specks };
    });
    return ok ? out : null;
  }

  // ------------------------------------------------------------------ static textures (built once per size / theme)
  function noiseCanvas(cols, rows, seed, strength) {
    var c = mkCanvas(cols, rows), x = c.getContext('2d'), id = x.createImageData(cols, rows), r = mulberry(seed);
    for (var i = 0; i < cols * rows; i++) { var v = r(); id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v > 0.5 ? 255 : 0; id.data[i * 4 + 3] = Math.abs(v - 0.5) * 2 * strength * 255; }
    x.putImageData(id, 0, 0); return c;
  }
  function grainCanvas(seed, strength) {
    var c = mkCanvas(128, 128), x = c.getContext('2d'), id = x.createImageData(128, 128), r = mulberry(seed);
    for (var i = 0; i < 128 * 128; i++) { var v = r(); id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v > 0.5 ? 255 : 0; id.data[i * 4 + 3] = Math.pow(Math.abs(v - 0.5) * 2, 1.5) * strength * 255; }
    x.putImageData(id, 0, 0); return c;
  }
  function blotches(c, seed, mult) {     // soft light/dark patches in view space
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    [[12, 8, 0.30], [40, 26, 0.22], [130, 84, 0.16]].forEach(function (L, i) { c.drawImage(noiseCanvas(L[0], L[1], seed + i * 31, L[2] * mult), 0, 0, VW, VH); });
  }
  function grain(ctx, W, H, seed, strength) {   // device-pixel grain, drawn in identity transform
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = ctx.createPattern(grainCanvas(seed, strength), 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  function tree(c, x, y, r, rnd) {
    c.fillStyle = rgba(T.shadow, 0.34); c.beginPath(); c.ellipse(x + r * 0.5, y + r * 0.55, r * 1.05, r * 0.85, 0, 0, 7); c.fill();
    var g = c.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, rgba(light(T.tree, 0.28))); g.addColorStop(0.55, rgba(T.tree)); g.addColorStop(1, rgba(shade(T.tree, 0.6)));
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    for (var i = 0; i < 4; i++) { var a = rnd() * 6.28, d = r * (0.25 + rnd() * 0.4); c.fillStyle = rgba(light(T.tree, 0.12 + rnd() * 0.2), 0.45); c.beginPath(); c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.2 + rnd() * 0.18), 0, 7); c.fill(); }
  }
  function treeLine(c, pts, step, rmin, rmax, prob, jit, rnd) {
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (var d = 0; d < len; d += step) {
        if (rnd() > prob) continue;
        var t = d / len; tree(c, lerp(a[0], b[0], t) + (rnd() - 0.5) * jit, lerp(a[1], b[1], t) + (rnd() - 0.5) * jit, lerp(rmin, rmax, rnd()), rnd);
      }
    }
  }
  function smoothPath(c, pts) {
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) { var mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my); }
    c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }
  function creekPts() { var p = SCN.creek.map(function (q) { return q.slice(); }); p[p.length - 1] = [p[p.length - 1][0] + 2, 338]; return p; }

  // returns {base, soil, top} canvases for scale k (device px per view unit)
  function buildStatic(k) {
    var W = Math.round(VW * k), H = Math.round(VH * k), r = mulberry(4242), out = {};
    // soil texture used inside every field
    var soil = mkCanvas(W, H), sc = soil.getContext('2d'); sc.setTransform(k, 0, 0, k, 0, 0);
    sc.fillStyle = rgba(T.soil); sc.fillRect(0, 0, VW, VH); blotches(sc, 77, 1.0); grain(sc, W, H, 5, 0.34); out.soil = soil;

    // base: ground, farmstead lawn, pond, roads
    var base = mkCanvas(W, H), c = base.getContext('2d'); c.setTransform(k, 0, 0, k, 0, 0);
    c.fillStyle = rgba(T.ground); c.fillRect(0, 0, VW, VH); blotches(c, 311, 1.15);
    if (!imported()) {
    var fs = SCN.farmstead; c.fillStyle = rgba(T.lawn); c.fillRect(fs[0][0], fs[0][1], fs[2][0] - fs[0][0], fs[2][1] - fs[0][1]); blotches(c, 5, 0.0);
    c.fillStyle = rgba(T.lawn, 0.9); c.fillRect(fs[0][0], fs[0][1], fs[2][0] - fs[0][0], fs[2][1] - fs[0][1]);
    c.fillStyle = rgba(T.road, 0.55); c.fillRect(60, 150, 150, 120);              // yard gravel
    c.fillStyle = rgba(T.water, 0.9); c.beginPath(); c.ellipse(180, 470, 38, 15, -0.2, 0, 7); c.fill();   // pond
    c.strokeStyle = rgba(T.soilDark, 0.5); c.lineWidth = 2; c.stroke();
    c.fillStyle = rgba(light(T.water, 0.3), 0.3); c.beginPath(); c.ellipse(172, 466, 22, 6, -0.2, 0, 7); c.fill();
    }
    grain(c, W, H, 9, 0.2);
    c.setTransform(k, 0, 0, k, 0, 0);
    // driveway and gravel roads
    var roads = imported() ? [] : SCN.roads.concat([[[130, 270], [130, 325]]]);
    roads.forEach(function (rd) {
      c.lineCap = 'butt'; c.strokeStyle = rgba(T.shadow, 0.35); c.lineWidth = 15; c.beginPath(); rd.forEach(function (p, i) { i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]); }); c.stroke();
      c.strokeStyle = rgba(T.road, 0.92); c.lineWidth = 11; c.stroke();
      c.strokeStyle = rgba(T.soilDark, 0.18); c.lineWidth = 1.5; c.setLineDash([]);
      [-3, 3].forEach(function (o) { c.beginPath(); rd.forEach(function (p, i) { var q = rd[0][1] === rd[rd.length - 1][1] ? [p[0], p[1] + o] : [p[0] + o, p[1]]; i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); });
    });
    for (var i = 0; i < (roads.length ? 500 : 0); i++) {                                                // gravel speckle
      var rd = roads[i % roads.length], a = rd[0], b = rd[rd.length - 1], t = r(); c.fillStyle = rgba(r() > 0.5 ? light(T.road, 0.4) : T.soilDark, 0.35);
      c.fillRect(lerp(a[0], b[0], t) + (a[0] === b[0] ? (r() - 0.5) * 10 : 0), lerp(a[1], b[1], t) + (a[1] === b[1] ? (r() - 0.5) * 10 : 0), 1, 1);
    }
    out.base = base;

    // top: field borders, creek, trees, buildings, vignette
    var top = mkCanvas(W, H), t2 = top.getContext('2d'); t2.setTransform(k, 0, 0, k, 0, 0);
    var rnd = mulberry(99);
    FIELDS.forEach(function (f) { polyPath(t2, f.poly); t2.strokeStyle = rgba(T.shadow, 0.55); t2.lineWidth = 2.6; t2.stroke(); t2.strokeStyle = rgba(light(T.crop.oats, 0.4), 0.55); t2.lineWidth = 1; t2.stroke(); });
    if (!imported()) {
    var cp = creekPts();                                                            // creek
    smoothPath(t2, cp); t2.lineCap = 'round'; t2.lineJoin = 'round';
    t2.strokeStyle = rgba(T.soilDark, 0.4); t2.lineWidth = 20; t2.stroke();
    t2.strokeStyle = rgba(T.water); t2.lineWidth = 9; t2.stroke();
    t2.strokeStyle = rgba(light(T.water, 0.35), 0.4); t2.lineWidth = 2.5; t2.stroke();
    t2.fillStyle = rgba(T.road, 0.9); t2.fillRect(cp[cp.length - 1][0] - 9, 331, 18, 4); t2.fillStyle = rgba(T.shadow, 0.5); t2.fillRect(cp[cp.length - 1][0] - 5, 334, 10, 2.5);   // culvert
    for (i = 0; i < cp.length - 1; i++) {                                           // riparian trees both sides of the creek
      var a2 = cp[i], b2 = cp[i + 1], len = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]), nx = -(b2[1] - a2[1]) / len, ny = (b2[0] - a2[0]) / len;
      for (var d = 0; d < len; d += 15) { var tt = d / len, side = rnd() > 0.5 ? 1 : -1, off = side * (15 + rnd() * 8);
        if (rnd() > 0.78) continue; tree(t2, lerp(a2[0], b2[0], tt) + nx * off, lerp(a2[1], b2[1], tt) + ny * off, 6 + rnd() * 5, rnd); }
    }
    treeLine(t2, [[553, 36], [553, 290]], 20, 5, 8, 0.8, 3, rnd);                  // windbreaks in the gaps between fields
    treeLine(t2, [[262, 311], [968, 311]], 24, 5, 8, 0.7, 4, rnd);
    treeLine(t2, [[30, 624], [968, 624]], 20, 6, 9, 0.85, 4, rnd);
    treeLine(t2, [[984, 36], [984, 600]], 24, 6, 9, 0.8, 3, rnd);
    treeLine(t2, [[30, 12], [520, 12]], 22, 6, 9, 0.7, 4, rnd);
    treeLine(t2, [[34, 330], [34, 340], [320, 340]], 22, 5, 8, 0.6, 4, rnd);
    // farmstead: roofs, silos, trees
    function roof(x, y, w, h, col) {
      t2.fillStyle = rgba(T.shadow, 0.4); t2.fillRect(x + 4, y + 5, w, h);
      t2.fillStyle = rgba(col); t2.fillRect(x, y, w, h);
      t2.fillStyle = rgba(light(col, 0.18)); t2.fillRect(x, y, w, h / 2);
      t2.strokeStyle = rgba(shade(col, 0.55)); t2.lineWidth = 1; t2.beginPath(); t2.moveTo(x, y + h / 2); t2.lineTo(x + w, y + h / 2); t2.stroke();
    }
    roof(48, 58, 44, 28, T.roof); roof(110, 52, 66, 38, T.barn); roof(48, 110, 36, 22, T.roof); roof(100, 112, 70, 26, mix(T.roof, T.barn, 0.3));
    [[186, 62], [186, 84]].forEach(function (s) {
      t2.fillStyle = rgba(T.shadow, 0.4); t2.beginPath(); t2.arc(s[0] + 4, s[1] + 5, 11, 0, 7); t2.fill();
      var g = t2.createRadialGradient(s[0] - 3, s[1] - 3, 1, s[0], s[1], 11); g.addColorStop(0, rgba(light(T.border, 0.45))); g.addColorStop(1, rgba(shade(T.border, 0.7)));
      t2.fillStyle = g; t2.beginPath(); t2.arc(s[0], s[1], 10, 0, 7); t2.fill();
    });
    [[40, 44], [100, 44], [200, 40], [214, 110], [40, 150], [48, 186], [60, 232], [110, 258], [196, 232], [212, 270], [32, 280], [150, 290], [210, 170], [34, 100]].forEach(function (p) { tree(t2, p[0] + (rnd() - 0.5) * 6, p[1] + (rnd() - 0.5) * 6, 8 + rnd() * 6, rnd); });
    }
    // photo-like vignette and grain
    var vg = t2.createRadialGradient(VW / 2, VH / 2, VH * 0.45, VW / 2, VH / 2, VW * 0.65); vg.addColorStop(0, rgba(T.shadow, 0)); vg.addColorStop(1, rgba(T.shadow, 0.38));
    t2.fillStyle = vg; t2.fillRect(0, 0, VW, VH);
    out.top = top;
    return out;
  }

  // ------------------------------------------------------------------ the view
  function mount(el) {
    readTokens();
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
    var isReduce = function () { return !!(reduce && reduce.matches); };
    var result = null, weeks = null, n = 0, pos = 0, playing = false, speed = 1, raf = 0, last = 0, dirty = true, shownWeek = -1;
    var hover = null, selected = FS.store.get().selectedField, geom = null, stat = null, tipTimer = 0;
    var mode = 'old', mapGeo = null, mapRec = null, mapImg = null, mapSeq = 0, liveSt = { key: '', status: '', rec: null }, WW = VW, HH = VH, prog = {};
    var rainSeeds = []; (function () { var r = mulberry(1234); for (var i = 0; i < 150; i++) rainSeeds.push([r() * (VW + 200), r() * 1000, 14 + r() * 14, 260 + r() * 220]); })();
    var cloudSeeds = [[100, 120, 190], [520, 300, 240], [820, 140, 210]];

    el.classList.add('fv-root');
    el.innerHTML =
      '<div class="fv-stage" tabindex="0" role="group" aria-label="Farm bird\'s-eye view. Space plays or pauses, left and right arrow keys step through the weeks.">' +
        '<canvas class="fv-canvas" role="img" aria-label="Aerial illustration of the four fields"></canvas>' +
        '<div class="fv-labels" aria-hidden="true"></div>' +
        '<div class="fv-legend"><button type="button" class="fv-legend-head" id="fs-view-legend-toggle" aria-expanded="true" aria-controls="fv-legend-body"><span>Fields</span><span class="fv-chev" aria-hidden="true"></span></button>' +
          '<div class="fv-legend-body" id="fv-legend-body"><ul class="fv-fields"></ul><div class="fv-key" aria-hidden="true"></div>' +
          '<details class="fs-fold fv-about"><summary>About This Map</summary><div class="fv-credit">Illustrative field layout · weather and soils are real</div></details></div></div>' +
        '<div class="fv-topright"><div class="fv-wx" aria-live="off"></div><div class="fv-note" hidden>Changes not run yet</div></div>' +
        '<div class="fv-tip" role="tooltip" hidden></div>' +
        '<div class="fv-mapnote" role="status" hidden></div>' +
      '</div>' +
      '<div class="fv-bar">' +
        '<div class="fv-tl" role="group" aria-label="Event timeline: click a mark to jump to that week"><span class="fv-tl-track"></span><span class="fv-playhead"></span><span class="fv-ticks"></span></div>' +
        '<div class="fv-ctl">' +
          '<button type="button" id="fs-play" class="fv-btn fv-play" aria-label="Play"></button>' +
          '<input type="range" id="fs-week" class="fv-range" min="0" max="52" step="1" value="0" aria-label="Week of the season">' +
          '<output class="fv-date" for="fs-week">Nov 16, 2026</output>' +
          '<button type="button" id="fs-view-speed" class="fv-btn fv-speed" aria-label="Playback speed 1x. Press to change">1x</button>' +
          '<button type="button" id="fs-view-run" class="fv-btn fv-run" hidden>Run</button>' +
        '</div>' +
      '</div>';
    var $ = function (s) { return el.querySelector(s); };
    var stage = $('.fv-stage'), canvas = $('.fv-canvas'), ctx = canvas.getContext('2d'), tip = $('.fv-tip'), labelsEl = $('.fv-labels');
    var playBtn = $('#fs-play'), range = $('#fs-week'), dateEl = $('.fv-date'), speedBtn = $('#fs-view-speed'), runBtn = $('#fs-view-run');
    var tickEl = $('.fv-ticks'), playhead = $('.fv-playhead'), wxEl = $('.fv-wx'), noteEl = $('.fv-note'), legend = $('.fv-legend'), legToggle = $('#fs-view-legend-toggle');
    var ICON_PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
    var ICON_PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>';
    playBtn.innerHTML = ICON_PLAY;

    // legend rows and labels
    var rows = {}, labelEls = {}, ul = $('.fv-fields');
    function addRow(f) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'fv-row'; b.setAttribute('data-id', f.id);
      b.innerHTML = '<span class="fv-chip"></span><span class="fv-ftxt"><span class="fv-fname"></span><span class="fv-fcrop"></span></span><span class="fv-acres"></span>';
      b.querySelector('.fv-fname').textContent = f.name; b.querySelector('.fv-acres').textContent = f.acres + ' ac';
      b.addEventListener('click', function () { FS.actions.selectField(f.id, 'map'); setSelected(f.id); });
      li.appendChild(b); ul.appendChild(li); rows[f.id] = { btn: b, chip: b.querySelector('.fv-chip'), crop: b.querySelector('.fv-fcrop') };
      var lb = document.createElement('span'); lb.className = 'fv-label'; lb.textContent = f.name; labelsEl.appendChild(lb); labelEls[f.id] = lb;
      rows[f.id].li = li;
    }
    FIELDS.forEach(addRow);
    // how many fields: add one more (up to four) or take the last one away; imported outlines set their own number
    var cnt = document.createElement('div'); cnt.className = 'fv-count';
    cnt.innerHTML = '<button type="button" class="fv-count-btn" data-d="-1" aria-label="Remove the last field">\u2212</button>' +
      '<span class="fv-count-n" aria-live="polite"></span><button type="button" class="fv-count-btn fv-count-add" data-d="1">+ Add field</button>';
    ul.parentNode.insertBefore(cnt, ul.nextSibling);
    cnt.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || b.disabled || !FS.farmSetup.setFieldCount) return;
      FS.farmSetup.setFieldCount(FIELDS.length + Number(b.getAttribute('data-d')));
    });
    function showCount() {
      var n = FIELDS.length, imp = imported(), bs = cnt.querySelectorAll('button');
      cnt.querySelector('.fv-count-n').textContent = n + (n === 1 ? ' field' : ' fields');
      bs[0].disabled = imp || n <= 1; bs[1].disabled = imp || n >= 4;
      cnt.title = imp ? 'Your imported outlines set the fields. Press "Use example fields" to change the number.' : '';
    }
    showCount();
    var keyEl = $('.fv-key');
    ['corn', 'soybean', 'rye', 'oats', 'none'].forEach(function (c) {
      var s = document.createElement('span'); s.className = 'fv-key-i'; s.innerHTML = '<i class="fv-chip fv-chip-' + c + '"></i>' + (c === 'none' ? 'bare' : c === 'soybean' ? 'soy' : c); keyEl.appendChild(s);
    });
    var narrow = false, firstLayout = false;
    function setLegendOpen(open) { legend.classList.toggle('fv-collapsed', !open); legToggle.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    legToggle.addEventListener('click', function () { userToggled = true; setLegendOpen(legend.classList.contains('fv-collapsed')); });
    var userToggled = false;

    // ---- state for the drawn week
    function stateOf(fid) {
      if (!weeks) return { crop: 'none', stage: 'residue', green: 0.1, soilWater: 0.7, stress: 0, flags: [], dry: 0, wet: 0, frost: 0, heat: 0, prog: 0 };
      var i = Math.floor(pos), fr = pos - i, a = weeks[i].fields[fid], b = weeks[Math.min(i + 1, n - 1)].fields[fid], t = (b && a && a.crop === b.crop) ? fr : 0;
      if (!a) return { crop: 'none', stage: 'residue', green: 0.1, soilWater: 0.7, stress: 0, flags: [], dry: 0, wet: 0, frost: 0, heat: 0, prog: 0 };
      b = b || a;
      var o = { crop: a.crop, stage: a.stage, flags: a.flags, green: lerp(a.green, b.green, t), soilWater: lerp(a.soilWater, b.soilWater, t), stress: lerp(a.stress, b.stress, t),
                wet: lerp(has(a.flags, 'waterlogged'), has(b.flags, 'waterlogged'), t), heat: lerp(has(a.flags, 'heat'), has(b.flags, 'heat'), t),
                frost: lerp(has(a.flags, 'frost'), has(b.flags, 'frost'), t) };
      var pr = prog[fid]; if (pr) { var p0 = pr[i], p1 = pr[Math.min(i + 1, n - 1)]; o.prog = (a.stage === b.stage && a.crop === b.crop) ? lerp(p0, p1, fr) : p0; } else o.prog = 0;
      o.dry = clamp((0.40 - o.soilWater) / 0.30, 0, 1); return o;
    }
    function fxOf() {
      if (!weeks) return { rain: 0, frost: 0, frostStrong: 0, heat: 0 };
      var i = Math.floor(pos), fr = pos - i, a = weeks[i].weather, b = weeks[Math.min(i + 1, n - 1)].weather;
      var anyFrost = function (w) { return FIELDS.some(function (f) { var s = w.fields[f.id]; return s && has(s.flags, 'frost'); }); };
      return { rain: lerp(a.heavyRain ? 1 : 0, b.heavyRain ? 1 : 0, fr), frost: lerp(a.frost ? 1 : 0, b.frost ? 1 : 0, fr), heat: lerp(a.heat ? 1 : 0, b.heat ? 1 : 0, fr),
               frostStrong: lerp(anyFrost(weeks[i]) ? 1 : 0, anyFrost(weeks[Math.min(i + 1, n - 1)]) ? 1 : 0, fr) };
    }

    function geoOf(id) { return mode === 'map' && mapGeo && mapGeo[id] ? mapGeo[id] : GEO[id]; }
    function polyOf(id) { if (mode === 'map' && mapGeo && mapGeo[id]) return mapGeo[id].poly; var f = FIELDS.filter(function (q) { return q.id === id; })[0]; return f ? f.poly : null; }

    // ---- layout
    function layout() {
      var w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return false;
      var dpr = window.devicePixelRatio || 1, mp = mode === 'map';
      WW = mp ? MAPSIZE : VW; HH = mp ? MAPSIZE : VH;
      var s = Math.min(w / WW, h / HH), ox = (w - WW * s) / 2, wideStage = !(w < 800 || h < 420);
      if (mp && wideStage) {   // keep the square map clear of the field list (left) and the weather pill (right) when there is room
        var L = legend.getBoundingClientRect().right - stage.getBoundingClientRect().left + 12;
        var fitIn = function (a, b, keep) { var s2 = Math.min((b - a) / WW, h / HH); return s2 >= s * keep ? { s: s2, ox: a + (b - a - WW * s2) / 2 } : null; };
        // a slightly smaller map beside the open field list is better than a bigger map hidden under it
        var g = fitIn(L, w - 178, 0.9) || fitIn(L, w - 8, 0.9) || fitIn(L, w - 8, 0.5); if (g) { s = g.s; ox = g.ox; }
      }
      var oy = (h - HH * s) / 2;
      if (mp && wideStage && oy > 10) oy = 10;   // a map shorter than the box sits at the top, level with the field list
      geom = { w: w, h: h, dpr: dpr, s: s, ox: ox, oy: oy };
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      if (mp) {   // the map picture is drawn once per layout; per frame only the four fields and the effects are painted over it
        var side = Math.max(1, Math.round(MAPSIZE * s * dpr)), mc = mkCanvas(side, side), mx = mc.getContext('2d');
        mx.imageSmoothingEnabled = true; mx.imageSmoothingQuality = 'high'; mx.drawImage(mapImg, 0, 0, side, side); stat = { map: mc };
      } else stat = buildStatic(s * dpr);
      var boxes = [];   // field labels at each field's middle, nudged apart when two would overlap
      FIELDS.forEach(function (f) {
        var lb = labelEls[f.id], p = geoOf(f.id).lp, x = geom.ox + p[0] * s, y = geom.oy + p[1] * s, bw = lb.offsetWidth, bh = lb.offsetHeight;
        for (var k = 0; k < 6; k++) {
          var hit = boxes.filter(function (b) { return Math.abs(b.x - x) < (b.w + bw) / 2 + 4 && Math.abs(b.y - y) < (b.h + bh) / 2 + 2; })[0];
          if (!hit) break; y = hit.y + (y >= hit.y ? 1 : -1) * ((hit.h + bh) / 2 + 4);
        }
        boxes.push({ x: x, y: y, w: bw, h: bh }); lb.style.left = x + 'px'; lb.style.top = y + 'px';
      });
      // on a wide stage the caption and the map note sit beside the map, not over it
      var gl = geom.ox - 22, gr = w - (geom.ox + WW * s) - 20, side = mp && w >= 700;
      el.classList.toggle('fv-capside', side && gl >= 200); credEl.style.maxWidth = side && gl >= 200 ? gl + 'px' : '';
      noteEl2.style.maxWidth = side && gr >= 150 ? gr + 'px' : ''; el.classList.toggle('fv-noteside', side && gr >= 150);
      showCaption(); var wasNarrow = narrow; narrow = w < 800 || h < 420;   // on tablets and short maps the field list starts closed so it does not cover a field
      if (!userToggled && (wasNarrow !== narrow || !firstLayout)) setLegendOpen(!narrow);
      firstLayout = true; dirty = true; kick(); return true;
    }

    // ---- drawing
    function rowsPath(bb, dir, sp, off) {
      ctx.beginPath();
      if (dir === 'h') for (var y = bb.y0 + off; y < bb.y1; y += sp) { ctx.moveTo(bb.x0, y); ctx.lineTo(bb.x1, y); }
      else for (var x = bb.x0 + off; x < bb.x1; x += sp) { ctx.moveTo(x, bb.y0); ctx.lineTo(x, bb.y1); }
    }
    function blob(b, col, a) {
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.scale(1, b.e);
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, b.r); g.addColorStop(0, rgba(col, a)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, b.r, 0, 7); ctx.fill(); ctx.restore();
    }
    function drawField(f, st) {
      var G = GEO[f.id], bb = G.bb, crop = st.crop, g = st.green, stage = st.stage, cropCol = T.crop[crop] || T.crop.none;
      ctx.save(); polyPath(ctx, f.poly); ctx.clip();
      ctx.drawImage(stat.soil, 0, 0, VW, VH);
      // wash: crop color toward brown as green drops, toward dry tan with stress
      var col = mix(mix(cropCol, T.soil, 1 - g), T.tan, clamp(st.stress * 0.7, 0, 1));
      ctx.fillStyle = rgba(col, crop === 'none' ? 0.12 : 0.15 + 0.75 * Math.pow(g, 0.85)); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
      if (st.dry > 0) { ctx.fillStyle = rgba(T.tan, 0.2 * st.dry); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0); }
      var sp = SPACING[crop], dir = G.dir;
      ctx.lineCap = 'butt';
      if (stage === 'cover' || crop === 'oats' && stage !== 'harvested' && stage !== 'planted') {   // soft carpet
        var cs = SPACING[crop] || 2.6, can = mix(light(cropCol, 0.12), T.soil, 1 - g);
        rowsPath(bb, dir, cs, 0); ctx.strokeStyle = rgba(can, 0.2 + 0.4 * g); ctx.lineWidth = cs * 0.55; ctx.stroke();
        rowsPath(bb, dir, cs, cs / 2); ctx.strokeStyle = rgba(shade(col, 0.5), 0.14 + 0.1 * g); ctx.lineWidth = cs * 0.3; ctx.stroke();
      } else if ((crop === 'corn' || crop === 'soybean' || crop === 'oats') && (stage === 'planted' || stage === 'emerged' || stage === 'vegetative' || stage === 'flowering' || stage === 'grainfill' || stage === 'mature')) {
        var closure = clamp(g, 0, 1), can2 = mix(light(cropCol, 0.08), T.soil, 1 - g); can2 = mix(can2, T.tan, clamp(st.stress * 0.6, 0, 1));
        if (stage === 'planted') { rowsPath(bb, dir, sp, 0); ctx.strokeStyle = rgba(T.soilDark, 0.35); ctx.lineWidth = 1.4; ctx.stroke(); }
        else {
          rowsPath(bb, dir, sp, sp * 0.5); ctx.strokeStyle = rgba(shade(col, 0.4), 0.18 + 0.22 * (1 - closure * 0.5)); ctx.lineWidth = sp * 0.3; ctx.stroke();           // shadow between rows
          rowsPath(bb, dir, sp, 0); ctx.strokeStyle = rgba(can2, stage === 'emerged' ? 0.55 : 0.92); ctx.lineWidth = Math.max(1, sp * (0.2 + 0.62 * closure)); ctx.stroke();
          if (closure > 0.5) { ctx.setLineDash([2, 3.5]); ctx.strokeStyle = rgba(light(can2, 0.3), 0.3 * closure); ctx.lineWidth = Math.max(0.8, sp * 0.14); ctx.stroke(); ctx.setLineDash([]); }
        }
      } else if (stage === 'harvested') {
        rowsPath(bb, dir, 11, 0); ctx.strokeStyle = rgba(mix(cropCol, T.tan, 0.65), 0.42); ctx.lineWidth = 5.5; ctx.stroke();
        rowsPath(bb, dir, 11, 5.5); ctx.strokeStyle = rgba(shade(T.soil, 0.7), 0.3); ctx.lineWidth = 5.5; ctx.stroke();
      } else if (stage === 'bare') {
        rowsPath(bb, dir, 4.5, 0); ctx.strokeStyle = rgba(T.soilDark, 0.22); ctx.lineWidth = 1.6; ctx.stroke();
      } else {   // residue: sparse pale streaks
        ctx.setLineDash([16, 9, 5, 13]); rowsPath(bb, dir, 9, 0); ctx.strokeStyle = rgba(light(T.soil, 0.3), 0.16); ctx.lineWidth = 1.3; ctx.stroke(); ctx.setLineDash([]);
      }
      if (st.dry > 0.05) G.dry.forEach(function (b) { blob(b, T.tan, 0.55 * st.dry); });
      if (st.wet > 0.02) G.wet.forEach(function (b) { blob(b, T.soilDark, 0.5 * st.wet); blob({ x: b.x, y: b.y, r: b.r * 0.6, e: b.e, a: b.a }, T.info, 0.25 * st.wet); });
      if (st.heat > 0.02) { ctx.fillStyle = rgba(T.warn, 0.07 * st.heat); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0); }
      ctx.restore();
    }
    // Style of a field on the real map: two stripe tones from the converter's palette for the crop and stage of the drawn week.
    function mapStyle(st) {
      var crop = st.crop, stage = st.stage, g = clamp(st.green, 0, 1), pr = clamp(st.prog || 0, 0, 1), p, rows = 0;
      if (stage === 'cover' || crop === 'rye') p = mixP(MP.dry, MP.grass, 0.3 + 0.7 * clamp(g / 0.55, 0, 1));
      else if (crop === 'none' || stage === 'bare') p = MP.soil;
      else if (stage === 'residue') p = MP.dry;
      else if (stage === 'harvested') p = mixP(mixP(MP.dry, MP.soil, 0.12), [[216, 192, 128], [216, 192, 128]], 0.45);   // stubble: faint stripes
      else if (stage === 'planted') { p = MP.soil; rows = 1; }
      else if (stage === 'emerged') p = mixP(MP.soil, MP.green, clamp(Math.sqrt(g) * 1.3, 0, 0.8));
      else if (stage === 'vegetative') p = mixP(mixP(MP.soil, MP.green, clamp(Math.sqrt(g) * 1.3, 0, 1)), MP.dark, clamp((g - 0.6) / 0.4, 0, 1) * 0.55);
      else if (stage === 'flowering') p = mixP(MP.green, MP.dark, clamp(0.4 + g * 0.6, 0, 1));
      else if (stage === 'grainfill') p = crop === 'corn' ? mixP(MP.dark, MP.yellow, pr) : mixP(mixP(MP.green, MP.dark, 0.25), crop === 'soybean' ? MP.yg : MP.gold, pr * (crop === 'soybean' ? 0.85 : 0.7));
      else if (stage === 'mature') p = crop === 'corn' ? MP.yellow : crop === 'soybean' ? mixP(MP.yg, MP.gold, 0.8) : MP.gold;
      else p = MP.soil;
      var growing = stage === 'emerged' || stage === 'vegetative' || stage === 'flowering' || stage === 'grainfill';
      if (growing && st.stress > 0.05) p = mixP(p, MP.dry, clamp(st.stress * 0.55, 0, 0.5));
      if (st.dry > 0.02) p = mixP(p, MP.parched, 0.5 * st.dry);
      return { p: p, rows: rows };
    }
    function drawMapField(f, st) {
      var G = mapGeo[f.id], sty = mapStyle(st), bb = G.bb, period = MAPSIZE / STRIPES;
      ctx.save(); polyPath(ctx, G.poly); ctx.clip();
      ctx.fillStyle = rgb3(sty.p[0]); ctx.fillRect(bb.x0 - 2, bb.y0 - 2, bb.x1 - bb.x0 + 4, bb.y1 - bb.y0 + 4);
      // second tone: bands of half a period along the stripe direction, in the converter's phase
      ctx.strokeStyle = rgb3(sty.p[1]); ctx.lineWidth = period / 2; ctx.lineCap = 'butt'; ctx.beginPath();
      for (var k = Math.floor(G.umin / period) - 1, k1 = Math.ceil(G.umax / period) + 1; k <= k1; k++) {
        var u = (k + 0.75) * period, x = G.bx + G.n[0] * u, y = G.by + G.n[1] * u;
        ctx.moveTo(x - G.d[0] * G.R, y - G.d[1] * G.R); ctx.lineTo(x + G.d[0] * G.R, y + G.d[1] * G.R);
      }
      ctx.stroke();
      if (sty.rows) {   // just planted: faint green rows on the soil
        ctx.strokeStyle = rgb3(MP.green[0], 0.5); ctx.lineWidth = 0.9; ctx.beginPath();
        for (var j = Math.floor(G.umin / period * 3), j1 = Math.ceil(G.umax / period * 3); j <= j1; j++) {
          var v = j * period / 3, x2 = G.bx + G.n[0] * v, y2 = G.by + G.n[1] * v;
          ctx.moveTo(x2 - G.d[0] * G.R, y2 - G.d[1] * G.R); ctx.lineTo(x2 + G.d[0] * G.R, y2 + G.d[1] * G.R);
        }
        ctx.stroke();
      }
      if (st.wet > 0.02) {   // waterlogged: blue tint and a few glossy patches
        ctx.fillStyle = rgb3([60, 130, 190], 0.2 * st.wet); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
        G.spots.forEach(function (q) {
          ctx.fillStyle = rgb3([40, 120, 180], 0.55 * st.wet); ctx.beginPath(); ctx.ellipse(q.x, q.y, q.rx, q.ry, q.a, 0, 7); ctx.fill();
          ctx.fillStyle = rgb3([170, 220, 240], 0.55 * st.wet); ctx.beginPath(); ctx.ellipse(q.x - q.rx * 0.25, q.y - q.ry * 0.3, q.rx * 0.5, q.ry * 0.35, q.a, 0, 7); ctx.fill();
        });
      }
      if (st.heat > 0.02) { ctx.fillStyle = rgb3([238, 150, 50], 0.12 * st.heat); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0); }
      if (st.frost > 0.02) {   // frost: white speckle
        ctx.fillStyle = rgb3([255, 255, 255], 0.75 * st.frost); ctx.beginPath();
        G.specks.forEach(function (q) { ctx.rect(q[0], q[1], q[2], q[2]); });
        ctx.fill(); ctx.fillStyle = rgb3([235, 245, 255], 0.1 * st.frost); ctx.fillRect(bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0);
      }
      // the converter's gap: a darker strip around each field, with a softer edge inside it
      polyPath(ctx, G.poly); ctx.lineJoin = 'round';
      ctx.strokeStyle = rgb3(MP.base, 0.45); ctx.lineWidth = MGAP * 2 + 3; ctx.stroke();
      ctx.strokeStyle = rgb3(MP.base); ctx.lineWidth = MGAP * 2; ctx.stroke();
      ctx.restore();
    }
    function draw(now) {
      var d = geom.dpr, fx = fxOf(), time = isReduce() ? 0 : now / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = rgba(T.panel); ctx.fillRect(0, 0, canvas.width, canvas.height);
      var VW = WW, VH = HH, mp = mode === 'map';
      if (mp) ctx.drawImage(stat.map, Math.round(geom.ox * d), Math.round(geom.oy * d));
      ctx.setTransform(geom.s * d, 0, 0, geom.s * d, geom.ox * d, geom.oy * d);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.clip();
      if (!mp) ctx.drawImage(stat.base, 0, 0, VW, VH);
      var sts = {};
      FIELDS.forEach(function (f) { sts[f.id] = stateOf(f.id); if (mp) drawMapField(f, sts[f.id]); else drawField(f, sts[f.id]); });
      if (!mp) ctx.drawImage(stat.top, 0, 0, VW, VH);
      // weather overlays
      if (fx.heat > 0.01) { var hg = ctx.createLinearGradient(0, 0, 0, VH); hg.addColorStop(0, rgba(T.warn, 0.14 * fx.heat)); hg.addColorStop(1, rgba(T.warn, 0.05 * fx.heat)); ctx.fillStyle = hg; ctx.fillRect(0, 0, VW, VH); }
      if (fx.frost > 0.01) { ctx.fillStyle = rgba(T.frost, 0.07 * fx.frost + 0.16 * fx.frostStrong); ctx.fillRect(0, 0, VW, VH); }
      if (fx.rain > 0.01) {
        ctx.fillStyle = rgba(T.shadow, 0.16 * fx.rain); ctx.fillRect(0, 0, VW, VH);
        cloudSeeds.forEach(function (c, i) {
          var cx = ((c[0] + time * (14 + i * 5)) % (VW + 600)) - 300, cy = c[1] + Math.sin(time * 0.2 + i) * 12, r = c[2];
          var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, rgba(T.shadow, 0.3 * fx.rain)); g.addColorStop(1, rgba(T.shadow, 0));
          ctx.save(); ctx.translate(cx, cy); ctx.scale(1.6, 1); ctx.translate(-cx, -cy); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.restore();
        });
        ctx.strokeStyle = rgba(T.rain, 0.5 * fx.rain); ctx.lineWidth = 1.1; ctx.beginPath();
        rainSeeds.forEach(function (s) { var y = (s[1] + time * s[3]) % (VH + 40) - 20, x = s[0] - 120 - (y - s[1]) * 0.12; x = ((x % (VW + 120)) + (VW + 120)) % (VW + 120) - 40; ctx.moveTo(x, y); ctx.lineTo(x - s[2] * 0.25, y + s[2]); });
        ctx.stroke();
      }
      // erosion markers
      FIELDS.forEach(function (f) {
        if (!has(sts[f.id].flags, 'erosion')) return;
        var p = geoOf(f.id).lp, pulse = 1 + 0.12 * Math.sin(time * 4), x = p[0], y = p[1] + 24;
        ctx.strokeStyle = rgba(T.soilDark, 0.7); ctx.lineWidth = 1.8; ctx.lineCap = 'round';
        [-9, 0, 9].forEach(function (o, i) { ctx.beginPath(); ctx.moveTo(x + o, y + 4); ctx.bezierCurveTo(x + o + 5, y + 14, x + o - 5, y + 24, x + o + 3 * (i - 1), y + 36); ctx.stroke(); });
        ctx.fillStyle = rgba(T.warn); ctx.strokeStyle = rgba(shade(T.warn, 0.35)); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 8 * pulse, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = rgba(shade(T.warn, 0.2)); ctx.font = 'bold 11px ' + (T.font || 'sans-serif'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', x, y + 0.5);
      });
      // selection and hover outlines
      function outline(id, col, w1, a1) { var pl = polyOf(id); if (!pl) return; polyPath(ctx, pl); ctx.lineJoin = 'round'; ctx.strokeStyle = rgba(col, a1 * 0.3); ctx.lineWidth = w1 * 3.2 / geom.s * 0.5 + 4; ctx.stroke(); ctx.strokeStyle = rgba(col, a1); ctx.lineWidth = w1 / geom.s; ctx.stroke(); }
      if (hover && hover !== selected) outline(hover, T.text, 1.5, 0.8);
      if (selected) outline(selected, T.accent, 2.5, 1);
      ctx.restore();
    }

    // ---- loop
    function ambient() { if (isReduce()) return false; var f = fxOf(); return f.rain > 0.01; }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    function frame(now) {
      raf = 0; if (!geom) return;
      var dt = last ? Math.min(0.2, (now - last) / 1000) : 0; last = now;
      if (playing && n > 1) {
        pos += dt * WEEKS_PER_SEC * speed; dirty = true;
        if (pos >= n - 1) { pos = n - 1; pause(); }
      }
      if (dirty || ambient()) { dirty = false; syncUI(); draw(now); }
      if (playing || ambient()) kick(); else last = 0;
    }
    function syncUI() {
      var i = Math.floor(pos + 1e-6);
      playhead.style.left = n > 1 ? (pos / (n - 1) * 100) + '%' : '0%';
      if (i === shownWeek) return; shownWeek = i;
      range.value = i;
      var w = weeks && weeks[i];
      var txt = w ? w.label + ', ' + w.date.slice(0, 4) : 'No run yet';
      dateEl.textContent = txt; range.setAttribute('aria-valuetext', txt);
      wxEl.textContent = w ? w.label + ' · ' + Math.round(w.weather.tmaxC) + '°C · ' + Math.round(w.weather.rainMm) + ' mm rain' : '';
      FIELDS.forEach(function (f) {
        var s = w ? w.fields[f.id] : null, r = rows[f.id], c = s ? s.crop : 'none';
        r.chip.style.background = 'var(--crop-' + (T.crop[c] ? c : 'none') + ')';
        r.crop.textContent = s ? CROP_LABEL[c] + ' · ' + (STAGE_LABEL[s.stage] || s.stage) + (s.flags.length ? ' · ' + s.flags.map(function (q) { return FLAG_LABEL[q] || q; }).join(', ') : '') : 'Waiting for a run';
        r.btn.classList.toggle('fv-flagged', !!(s && s.flags.length));
      });
      if (hover && !tip.hidden) showTip(hover, tipX, tipY);
    }

    // ---- public controls
    function setWeek(i) { pos = clamp(Math.round(i), 0, Math.max(0, n - 1)); shownWeek = -1; dirty = true; kick(); }
    function play() {
      if (!n) return; if (pos >= n - 1) pos = 0;
      playing = true; playBtn.innerHTML = ICON_PAUSE; playBtn.setAttribute('aria-label', 'Pause'); last = 0; dirty = true; kick();
    }
    function pause() { playing = false; playBtn.innerHTML = ICON_PLAY; playBtn.setAttribute('aria-label', 'Play'); pos = Math.round(pos); shownWeek = -1; dirty = true; kick(); }
    function toggle() { playing ? pause() : play(); }
    playBtn.addEventListener('click', toggle);
    range.addEventListener('input', function () { if (playing) pause(); setWeek(+range.value); });
    speedBtn.addEventListener('click', function () { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; speedBtn.textContent = speed + 'x'; speedBtn.setAttribute('aria-label', 'Playback speed ' + speed + 'x. Press to change'); });
    runBtn.addEventListener('click', function () { FS.actions.runSimulation('view'); });
    el.addEventListener('keydown', function (e) {
      var tg = e.target, isRange = tg === range, isBtn = tg.tagName === 'BUTTON';
      if (e.key === ' ' && !isBtn) { e.preventDefault(); toggle(); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isRange) { e.preventDefault(); if (playing) pause(); setWeek(pos + (e.key === 'ArrowRight' ? 1 : -1)); }
      else if (e.key === 'Home' && !isRange) { e.preventDefault(); if (playing) pause(); setWeek(0); }
      else if (e.key === 'End' && !isRange) { e.preventDefault(); if (playing) pause(); setWeek(n - 1); }
    });

    // ---- selection, hover, tooltip
    function setSelected(id) {
      selected = id;
      FIELDS.forEach(function (f) { var on = f.id === id; rows[f.id].btn.setAttribute('aria-pressed', on ? 'true' : 'false'); rows[f.id].btn.classList.toggle('fv-sel', on); labelEls[f.id].classList.toggle('fv-sel', on); });
      renderTicks(); dirty = true; kick();
    }
    var tipX = 0, tipY = 0;
    function showTip(id, x, y) {
      var f = FIELDS.filter(function (q) { return q.id === id; })[0], s = stateOf(id); if (!f) return;
      var fl = s.flags.length ? '<div class="fv-tip-flags">' + s.flags.map(function (q) { return '<span>' + (FLAG_LABEL[q] || q) + '</span>'; }).join('') + '</div>' : '';
      tip.innerHTML = '<b></b><div class="fv-tip-sub"></div><div class="fv-tip-grid"><span>Soil water</span><span class="fv-m">' + Math.round(s.soilWater * 100) + '%</span><span>Stress</span><span class="fv-m">' + Math.round(s.stress * 100) + '%</span></div>' + fl;
      tip.querySelector('b').textContent = f.name + ' · ' + f.acres + ' ac';
      tip.querySelector('.fv-tip-sub').textContent = weeks ? CROP_LABEL[s.crop] + ', ' + (STAGE_LABEL[s.stage] || s.stage) : 'Waiting for a run';
      var mg = mode === 'map' && mapGeo && mapGeo[id];
      if (mg) {
        var ex = document.createElement('div'); ex.className = 'fv-tip-map';
        ex.textContent = (mg.acres != null ? 'Map outline about ' + Math.round(mg.acres) + ' acres. ' : '') + 'Found automatically; the simulation uses your answers for size and crops.';
        tip.appendChild(ex);
      }
      tip.hidden = false;
      var w = tip.offsetWidth, h = tip.offsetHeight, px = x + 14, py = y + 14;
      if (px + w > geom.w - 6) px = x - w - 14; if (py + h > geom.h - 6) py = y - h - 14;
      tip.style.left = Math.max(6, px) + 'px'; tip.style.top = Math.max(6, py) + 'px';
    }
    function fieldAt(e) {
      var r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, x = (px - geom.ox) / geom.s, y = (py - geom.oy) / geom.s, hit = null;
      FIELDS.forEach(function (f) { var pl = polyOf(f.id); if (pl && inPoly(pl, x, y)) hit = f.id; });
      return { id: hit, px: px, py: py };
    }
    canvas.addEventListener('pointermove', function (e) {
      if (!geom || e.pointerType === 'touch') return;
      var h = fieldAt(e); tipX = h.px; tipY = h.py;
      if (h.id !== hover) { hover = h.id; dirty = true; kick(); canvas.style.cursor = hover ? 'pointer' : 'default'; }
      if (hover) showTip(hover, h.px, h.py); else tip.hidden = true;
    });
    canvas.addEventListener('pointerleave', function () { hover = null; tip.hidden = true; dirty = true; kick(); });
    canvas.addEventListener('click', function (e) {
      if (!geom) return; var h = fieldAt(e);
      if (h.id) { FS.actions.selectField(h.id, 'map'); setSelected(h.id); }
      if (h.id && e.pointerType === 'touch' || (h.id && e.detail === 0)) { hover = h.id; showTip(h.id, h.px, h.py); clearTimeout(tipTimer); tipTimer = setTimeout(function () { tip.hidden = true; hover = null; dirty = true; kick(); }, 2600); }
      stage.focus({ preventScroll: true });
    });

    // ---- timeline ticks
    var TICK_CLASS = { heat: 'heat', drought: 'drought', frost: 'frost', waterlogged: 'wet', 'heavy-rain': 'rain', erosion: 'ero', 'planting-delay': 'delay', harvest: 'harvest' };
    function indexOfDate(d) { for (var i = 0; i < n; i++) if (weeks[i].date === d) return i; return -1; }
    function renderTicks() {
      tickEl.innerHTML = ''; if (!result) return;
      (result.summary.events || []).forEach(function (ev) {
        var i = indexOfDate(ev.date); if (i < 0) return;
        var b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1;
        b.className = 'fv-tick fv-t-' + (TICK_CLASS[ev.type] || 'heat') + (ev.fieldId && ev.fieldId !== selected ? ' fv-dim' : '');
        b.style.left = (i / (n - 1) * 100) + '%'; b.title = weeks[i].label + ': ' + ev.text; b.setAttribute('aria-label', weeks[i].label + ': ' + ev.text + ' (' + (TYPE_LABEL[ev.type] || ev.type) + ')');
        b.addEventListener('click', function () { if (playing) pause(); setWeek(i); }); tickEl.appendChild(b);
      });
    }

    // How far through its stage each field is in each week (0..1), so grain fill can ripen from green to gold.
    function computeProg() {
      prog = {};
      FIELDS.forEach(function (f) {
        var arr = new Array(n), i = 0;
        while (i < n) {
          var a = weeks[i].fields[f.id], j = i; while (j + 1 < n && weeks[j + 1].fields[f.id] && a && weeks[j + 1].fields[f.id].stage === a.stage && weeks[j + 1].fields[f.id].crop === a.crop) j++;
          for (var k = i; k <= j; k++) arr[k] = j > i ? (k - i + 1) / (j - i + 1) : 1;
          i = j + 1;
        }
        prog[f.id] = arr;
      });
    }

    // ---- result loading
    function worstIndex() {
      var f = result.summary.fields[selected], i = f && f.worstWeek ? indexOfDate(f.worstWeek) : -1; return i < 0 ? 0 : i;
    }
    function startIndex() {   // play from two weeks before the first spring planting, so the first thing seen is the season starting
      for (var i = 0; i < n; i++) { var fs = weeks[i].fields; for (var k in fs) if (fs[k] && fs[k].crop !== 'rye' && fs[k].stage === 'planted') return Math.max(0, i - 2); }
      return 0;
    }
    function load(r) {
      result = r; weeks = r.weeks; n = weeks.length; range.max = String(n - 1); noteEl.hidden = true; computeProg();
      if (playing) pause(); shownWeek = -1;
      renderTicks();
      if (isReduce()) setWeek(worstIndex()); else { pos = startIndex(); dirty = true; play(); }
    }
    FS.store.on('sim:done', load);
    FS.store.on('field:select', function (p) { setSelected(p.id); });
    FS.store.on('controls:change', function () { if (result) noteEl.hidden = false; });

    // ---- resize, theme
    var rafLayout = 0;
    function relayout() { cancelAnimationFrame(rafLayout); rafLayout = requestAnimationFrame(function () { layout(); }); }
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(stage); else window.addEventListener('resize', relayout);
    function themeChanged() { readTokens(); layout(); }
    if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', themeChanged); else if (mq.addListener) mq.addListener(themeChanged); }
    if (window.MutationObserver) new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', function () { dirty = true; kick(); });

    // ---- which map: the farmer's own live map (server only), else the county map, else the hand-drawn layout
    var noteEl2 = $('.fv-mapnote'), credEl = $('.fv-credit'), imgCache = {};
    function setNote(t) { noteEl2.textContent = t || ''; noteEl2.hidden = !t; }
    function serverBase() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
    function ownPoint() {
      var su = FS.farmSetup && FS.farmSetup.setup, p = su && !su.example && su.point;
      return p && isFinite(p.lat) && isFinite(p.lon) ? { lat: +p.lat, lon: +p.lon } : null;
    }
    function siteName() { var si = FS.farmSetup && FS.farmSetup.site; return si && si.name ? si.name : (DATA.farm.place || 'the county'); }
    function countyRec() {
      var si = FS.farmSetup && FS.farmSetup.site, m = DATA.farmMaps; if (!m) return null;
      var r = m[si && si.id ? si.id : 'story-ia']; return r && r.img && r.fields ? r : null;
    }
    function loadImg(src, ok, bad) {
      var c = imgCache[src]; if (c && c.complete && c.naturalWidth) { ok(c); return; }
      var im = new Image(); im.onload = function () { imgCache[src] = im; ok(im); }; im.onerror = bad; im.src = src;
    }
    var capFull = '', capShort = '', capTitle = '';
    function showCaption() { if (mode !== 'map') return; var nar = geom && geom.w < 560; credEl.textContent = nar ? capShort : capFull; credEl.title = nar ? capTitle : ''; }
    function captionFor(rec, own, kind) {
      var src = rec.source === 's2' ? 's2' : 'usgs', words = SOURCE_WORDS[src] || 'aerial photos', cr = rec.credit ? String(rec.credit) : (CREDIT_SHORT[src] || '');
      var short = CREDIT_SHORT[rec.source] || (cr.length > 110 ? cr.slice(0, 107) + '…' : cr);
      var lead = own ? 'Your farm from above, drawn from ' + words : 'Example farm near ' + (rec.name || siteName()) + ', drawn from ' + words;
      capFull = lead + ' · fields found automatically; the simulation uses your answers for size and crops · weather and soils are real · Imagery: ' + short;
      capShort = lead + ' · fields found automatically · weather and soils are real'; capTitle = (cr ? 'Imagery: ' + cr + '. ' : '') + 'Fields found automatically; the simulation uses your answers for size and crops.';
      showCaption();
    }
    function useMap(rec, own, kind, url) {     // kind 'live' | 'county'; the image must load before the map replaces what is shown
      var my = ++mapSeq, geo = buildMapGeo(rec);
      if (!geo) { fallBack(my, own, kind); return; }
      loadImg(url, function (im) {
        if (my !== mapSeq) return;
        mode = 'map'; mapGeo = geo; mapRec = rec; mapImg = im;
        el.classList.add('fv-realmap'); canvas.setAttribute('aria-label', 'Illustrated aerial map of the farm with the four fields painted by crop and growth stage');
        captionFor(rec, own, kind); layout(); setNote(kind === 'county' && liveSt.status === 'busy' ? 'Drawing your farm\u2019s own map from aerial photos\u2026' : kind === 'county' && liveSt.status === 'err' ? 'Your own map could not be drawn just now; showing the county map.' : '');
      }, function () { if (my !== mapSeq) return; fallBack(my, own, kind); });
    }
    function fallBack(my, own, kind) {
      if (kind === 'live') { var c = countyRec(); if (c) { liveSt.status = 'err'; useMap(c, false, 'county', c.img); return; } }
      mapSeq++; mode = 'old'; mapGeo = null; mapRec = null; mapImg = null; el.classList.remove('fv-realmap'); setNote('');
      canvas.setAttribute('aria-label', 'Aerial illustration of the four fields');
      credEl.textContent = 'Illustrative field layout · weather and soils are real' + (FS.farmSetup && FS.farmSetup.site ? ' · ' + FS.farmSetup.site.short : ''); credEl.title = '';
      layout();
    }
    function fetchLive(pt, key) {
      var base = serverBase(); liveSt = { key: key, status: 'busy', rec: null };
      fetch(base + '/api/farmmap?lat=' + pt.lat.toFixed(5) + '&lon=' + pt.lon.toFixed(5)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
        .then(function (x) {
          if (liveSt.key !== key) return;
          var d = x.j || {};
          if (!x.ok || !d.map || !d.fields) { liveSt.status = 'err'; setNote('Your own map could not be drawn just now; showing the county map.'); return; }
          offerLive(pt.lat, pt.lon, d, true);
        }).catch(function () { if (liveSt.key !== key) return; liveSt.status = 'err'; setNote('Could not reach the server to draw your own map; showing the county map.'); });
    }
    // the Farm map switch (farmmap.js) hands over what it already fetched for the same point
    function offerLive(lat, lon, d, fromFetch) {
      var pt = ownPoint(), base = serverBase(); if (!pt || !base || !d || !d.map || !d.fields) return;
      var key = pt.lat.toFixed(3) + ',' + pt.lon.toFixed(3); if (key !== lat.toFixed(3) + ',' + lon.toFixed(3)) return;
      var rec = { name: (FS.farmSetup.setup.point.label) || 'your farm', source: d.source, credit: d.credit, widthKm: d.widthKm, fields: d.fields, img: base + d.map };
      liveSt = { key: key, status: 'ok', rec: rec }; useMap(rec, true, 'live', rec.img);
    }
    function pickMap() {
      if (imported()) { liveSt = { key: '', status: '', rec: null }; fallBack(0, false, 'county'); credEl.textContent = 'Your own field outlines · ' + importedWeatherName() + ' weather · Copernicus terrain'; return; }
      var pt = ownPoint(), base = serverBase(), c = countyRec();
      if (pt && base) {
        var key = pt.lat.toFixed(3) + ',' + pt.lon.toFixed(3);
        if (liveSt.key === key && liveSt.status === 'ok' && liveSt.rec) { useMap(liveSt.rec, true, 'live', liveSt.rec.img); return; }
        if (liveSt.key !== key) fetchLive(pt, key);
        if (c) useMap(c, false, 'county', c.img); else fallBack(0, false, 'county');
        if (liveSt.status === 'busy') setNote('Drawing your farm\u2019s own map from aerial photos\u2026');
        else if (liveSt.status === 'err') setNote('Your own map could not be drawn just now; showing the county map.');
        return;
      }
      liveSt = { key: '', status: '', rec: null };
      if (c) useMap(c, false, 'county', c.img); else fallBack(0, false, 'county');
    }

    // A new farm was set up (names, acres, place): re-read the field list and relabel the legend, the labels and the caption.
    function refresh() {
      FIELDS = DATA.farm.fields;
      buildGeo();
      FIELDS.forEach(function (f) { if (!rows[f.id]) addRow(f); });
      Object.keys(rows).forEach(function (id) { var on = FIELDS.some(function (f) { return f.id === id; }); rows[id].li.hidden = !on; labelEls[id].hidden = !on; });
      showCount();
      FIELDS.forEach(function (f) {
        var r = rows[f.id]; if (!r) return;
        r.btn.querySelector('.fv-fname').textContent = f.name; r.btn.querySelector('.fv-acres').textContent = f.acres + ' ac';
        labelEls[f.id].textContent = f.name;
      });
      credEl.textContent = 'Illustrative field layout · weather and soils are real' + (FS.farmSetup && FS.farmSetup.site ? ' · ' + FS.farmSetup.site.short : '');
      pickMap();
      tip.hidden = true; hover = null; dirty = true; kick();
    }
    FS.fieldView.offerLive = offerLive;
    FS.fieldView.refresh = refresh;
    setSelected(selected);
    pickMap();
    layout();
    var cur = FS.store.get().current; if (cur) load(cur);
    FS.fieldView.setWeek = setWeek; FS.fieldView.play = play; FS.fieldView.pause = pause; FS.fieldView.getWeek = function () { return Math.floor(pos); };
  }

  FS.fieldView = { mount: mount, offerLive: function () {}, refresh: function () {}, setWeek: function () {}, play: function () {}, pause: function () {}, getWeek: function () { return 0; } };
})();
