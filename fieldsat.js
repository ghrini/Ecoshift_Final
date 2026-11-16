// Copernicus Sentinel-2 over the fields (Level-2A surface reflectance, the free Cloud Optimized GeoTIFFs on AWS found through
// Element 84's Earth Search catalogue). Only the pieces of each image over the fields are downloaded.
// - Burned ground: the Normalized Burn Ratio, NBR = (NIR - SWIR2) / (NIR + SWIR2), from bands B8A and B12 (20 m), on the latest clear
//   image and one 2 to 20 weeks earlier from the same tile. A pixel is a burn candidate when NBR fell by 0.27 or more (the "moderate
//   burn severity" line in dNBR, Key and Benson 2006; it comes from forest fires, not cropland), the ground was covered before (NBR 0.15 or more),
//   NBR is now below -0.10 and the near-infrared fell to a dark 0.17 or less (charred residue). This is a weak test: harvest, tillage and dark
//   wet soil can look the same, so a candidate is only "possible burned ground" until NASA's fire satellites (fieldfire.js) confirm fire.
//   Pixels within 2 pixels (40 m) of cloud, cloud shadow, snow or no-data in either image are left out (cloud mask dilation).
// - Ground now: share of bare soil and plant cover from the image's own scene classification (SCL) and NDVI.
// - Weak growth zones: last summer's clearest July-August image, NDVI = (NIR - red) / (NIR + red) at 10 m. Parts of a field far less
//   green than the rest of that field (NDVI 0.15 or more below the field's median while the field itself was green) are where the soil
//   or crop struggled: low fertility, an eroded knoll, compaction or a wet spot.
// Clouds, shadows and snow are left out with the scene classification.
"use strict";

const { helpers: G } = require("./fieldgeo");

const UA = { "User-Agent": "fieldshift-simulator" };
const round = (x, k = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const R = Math.PI / 180, DAY = 864e5;
const CLEAR = new Set([4, 5, 6]);   // SCL: vegetation, bare soil, water. Dark area (2) and unclassified (7) are not trusted as clear: they hide shadow and thin cloud
const BAD = new Set([1, 2, 3, 7, 8, 9, 10, 11]);   // SCL classes that grow the cloud mask around them
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// WGS84 longitude/latitude -> UTM metres (Snyder's series, as used for Sentinel-2's UTM grids)
function toUTM(lon, lat, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const p = lat * R, l = lon * R, l0 = ((zone - 1) * 6 - 180 + 3) * R, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
  const N = a / Math.sqrt(1 - e2 * s * s), T = t * t, C = ep2 * c * c, A = c * (l - l0);
  const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * p - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - (35 * e2 ** 3 / 3072) * Math.sin(6 * p));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  const y = k0 * (M + N * t * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [x, south ? y + 10000000 : y];
}
// a field in one image's UTM zone, with a local way back to longitude/latitude for the places it reports
function inZone(f, epsg) {
  const zone = epsg % 100, south = Math.floor(epsg / 100) === 327, to = (p) => toUTM(p[0], p[1], zone, south);
  const [lo, la] = f.center, o = to([lo, la]), ex = to([lo + 0.001, la]), ny = to([lo, la + 0.001]);
  const a = (ex[0] - o[0]) / 0.001, b = (ny[0] - o[0]) / 0.001, c = (ex[1] - o[1]) / 0.001, d = (ny[1] - o[1]) / 0.001, det = a * d - b * c;
  const back = (x, y) => { const dx = x - o[0], dy = y - o[1]; return [round(lo + (d * dx - b * dy) / det, 5), round(la + (-c * dx + a * dy) / det, 5)]; };
  return { ring: f.ring.map(to), holes: [], back };
}

const memo = new Map();
function cached(key, ms, make) {
  const hit = memo.get(key); if (hit && Date.now() - hit.t < ms) return hit.p;
  const p = make(); memo.set(key, { t: Date.now(), p }); p.catch(() => memo.delete(key));
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return p;
}
async function search(bbox, from, to, maxCloud, grid) {
  const body = { collections: ["sentinel-2-l2a"], bbox, datetime: `${iso(from)}T00:00:00Z/${iso(to)}T23:59:59Z`, limit: 12,
    query: Object.assign({ "eo:cloud_cover": { lt: maxCloud } }, grid ? { "grid:code": { eq: grid } } : {}), sortby: [{ field: "properties.datetime", direction: "desc" }] };
  const res = await fetch("https://earth-search.aws.element84.com/v1/search", { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Earth Search returned ${res.status}`);
  const j = await res.json();
  // only images that cover every field whole (neighbouring tiles overlap, so one usually does)
  return (j.features || []).filter((x) => x.bbox && x.bbox[0] <= bbox[0] && x.bbox[1] <= bbox[1] && x.bbox[2] >= bbox[2] && x.bbox[3] >= bbox[3]);
}

// the pixels of one image inside one field: for each pixel of the first band's grid, every band's value (reflectance, or the SCL class)
async function pixels(item, bands, f) {
  const epsg = item.properties["proj:epsg"] || +String(item.properties["proj:code"] || "").replace("EPSG:", "");
  const fu = inZone(f, epsg), b = G.bboxOf(fu.ring);
  const win = await Promise.all(bands.map(async (k) => {
    const as = item.assets[k], h = await G.cogHead(as.href); if (!h) throw new Error("Sentinel-2 band missing");
    const rb = (as["raster:bands"] || [])[0] || {};
    return { k, h, W: await G.cogWindow(h, b, 1), scale: k === "scl" ? 1 : rb.scale || 1e-4, offset: k === "scl" || item.properties["earthsearch:boa_offset_applied"] ? 0 : rb.offset || 0 };   // Earth Search has often removed the -0.1 offset already
  }));
  const g = win[0], out = [];
  for (let r = g.W.r0; r <= g.W.r1; r++) for (let c = g.W.c0; c <= g.W.c1; c++) {
    const x = g.W.lon(c), y = g.W.lat(r);
    if (!G.inField(fu, x, y)) continue;
    const v = { r, c, x, y };
    let ok = true;
    for (const w of win) {
      const raw = w === g ? w.W.v(r, c) : w.W.v(Math.floor((w.h.y0 - y) / w.h.sy), Math.floor((x - w.h.x0) / w.h.sx));
      if (!raw) { ok = false; break; }   // 0 = no data
      v[w.k] = w.k === "scl" ? raw : raw * w.scale + w.offset;
    }
    if (ok) out.push(v);
  }
  return { list: out, fu, cellM2: g.h.sx * g.h.sy, xOf: g.W.lon, yOf: g.W.lat };
}
const clearShare = (list) => (list.length ? list.filter((p) => CLEAR.has(p.scl)).length / list.length : 0);
// keys (r*1e6+c) of the pixels with a bad SCL pixel within `rad` pixels
function nearBad(list, rad) {
  const bad = new Set();
  for (const p of list) if (BAD.has(p.scl)) for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) bad.add((p.r + dr) * 1e6 + p.c + dc);
  return bad;
}
const nbr = (p) => (p.nir08 + p.swir22 > 0 ? (p.nir08 - p.swir22) / (p.nir08 + p.swir22) : null);

// the newest of a list of images that is clear over every field (70% of each field's pixels or more)
async function firstClear(items, bands, fields, min) {
  for (const it of items.slice(0, 4)) {
    const px = await Promise.all(fields.map((f) => pixels(it, bands, f)));
    if (px.every((p) => clearShare(p.list) >= min)) return { item: it, px };
  }
  return null;
}

async function satellite(fields, now = Date.now()) {
  const lons = fields.flatMap((f) => f.ring.map((p) => p[0])), lats = fields.flatMap((f) => f.ring.map((p) => p[1]));
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((v) => round(v, 5));
  const key = JSON.stringify(fields.map((f) => f.ring)) + iso(now);
  return cached(key, 6 * 3600e3, async () => {
    const out = { fields: {}, sources: [], gaps: [] };
    fields.forEach((f) => { out.fields[f.id] = {}; });
    const B = ["nir08", "swir22", "scl"];
    // latest clear image (past 60 days) and one 2 to 20 weeks before it, same tile
    const recent = await firstClear(await search(bbox, now - 60 * DAY, now, 50), B, fields, 0.7);
    if (!recent) out.gaps.push("No clear Sentinel-2 image of your fields in the past 60 days (clouds), so burned ground and bare soil could not be checked.");
    else {
      const t1 = Date.parse(recent.item.properties.datetime), grid = recent.item.properties["grid:code"];
      const before = await firstClear(await search(bbox, t1 - 140 * DAY, t1 - 14 * DAY, 50, grid), B, fields, 0.7);
      fields.forEach((f, i) => {
        const now1 = recent.px[i], o = out.fields[f.id], clear = now1.list.filter((p) => CLEAR.has(p.scl));
        o.ground = { date: iso(t1), bareSoilPct: round(clear.filter((p) => p.scl === 5).length / clear.length * 100, 0), plantsPct: round(clear.filter((p) => p.scl === 4).length / clear.length * 100, 0) };
        if (!before) return;
        const prev = new Map(before.px[i].list.map((p) => [p.r * 1e6 + p.c, p])), burned = [], badNow = nearBad(now1.list, 2), badThen = nearBad(before.px[i].list, 2);
        let n = 0;
        for (const p of clear) {
          const k = p.r * 1e6 + p.c, q = prev.get(k); if (!q || !CLEAR.has(q.scl) || p.scl === 6 || badNow.has(k) || badThen.has(k)) continue;
          n++;
          const d = nbr(q) - nbr(p);
          if (d >= 0.27 && nbr(q) >= 0.15 && nbr(p) < -0.1 && p.nir08 < 0.17 && q.nir08 - p.nir08 > 0.05) burned.push([p.r, p.c, d]);
        }
        const groups = G.clusters(burned.map(([r, c]) => [r, c]), now1.xOf, now1.yOf).filter((k) => k.n >= 10);   // 0.4 ha or more
        o.burn = { from: iso(Date.parse(before.item.properties.datetime)), to: iso(t1), checkedPct: round(n / Math.max(1, now1.list.length) * 100, 0),
          patches: groups.slice(0, 4).map((k) => { const [lon, lat] = now1.fu.back(k.lon, k.lat); return { lon, lat, areaM2: Math.round(k.n * now1.cellM2) }; }),
          burnedPct: round(burned.length / Math.max(1, n) * 100, 1) };
      });
      out.sources.push(`Burned ground and bare soil: Copernicus Sentinel-2 images of ${iso(t1)}` + (before ? ` and ${iso(Date.parse(before.item.properties.datetime))} (burn ratio change).` : "."));
      if (!before) out.gaps.push("No clear earlier Sentinel-2 image to compare with, so burned ground could not be checked.");
    }
    // last summer's crop: the clearest July-August image (January-February south of the equator)
    const d = new Date(now), south = (bbox[1] + bbox[3]) / 2 < 0, m0 = south ? 0 : 6, y = d.getUTCMonth() >= m0 + 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const sum = await search(bbox, Date.UTC(y, m0, 1), Date.UTC(y, m0 + 2, 0), 20);
    sum.sort((a, z) => a.properties["eo:cloud_cover"] - z.properties["eo:cloud_cover"]);
    const summer = await firstClear(sum, ["nir", "red", "scl"], fields, 0.8);
    if (!summer) out.gaps.push(`No clear Sentinel-2 image of your fields in ${south ? "January-February" : "July-August"} ${y}, so weak growth zones could not be checked.`);
    else {
      const ts = iso(Date.parse(summer.item.properties.datetime));
      fields.forEach((f, i) => {
        const P = summer.px[i], list = P.list.filter((p) => p.scl === 4 || p.scl === 5).map((p) => Object.assign(p, { ndvi: (p.nir - p.red) / (p.nir + p.red) })).filter((p) => isFinite(p.ndvi) && p.ndvi >= -1 && p.ndvi <= 1);
        if (list.length < 20) return;
        const sorted = list.map((p) => p.ndvi).sort((a, z) => a - z), med = sorted[Math.floor(sorted.length / 2)];
        const o = out.fields[f.id];
        o.summer = { date: ts, ndviMedian: round(med, 2), weakZones: [] };
        if (med < 0.5) return;   // the field was not a green crop then (fallow, oats already cut): no zones
        const weak = list.filter((p) => p.ndvi < med - 0.15);
        o.summer.weakPct = round(weak.length / list.length * 100, 1);
        o.summer.weakZones = G.clusters(weak.map((p) => [p.r, p.c]), P.xOf, P.yOf).filter((k) => k.n >= 20).slice(0, 4).map((k) => {
          const [lon, lat] = P.fu.back(k.lon, k.lat), mine = weak.filter((p) => Math.abs(p.x - k.lon) < 400 && Math.abs(p.y - k.lat) < 400);
          return { lon, lat, areaM2: Math.round(k.n * P.cellM2), ndvi: round(mine.reduce((s, p) => s + p.ndvi, 0) / Math.max(1, mine.length), 2) };
        });
      });
      out.sources.push(`Weak growth zones: Copernicus Sentinel-2 image of ${ts} (plant greenness, NDVI, 10 m).`);
    }
    return out;
  });
}

module.exports = { satellite, toUTM, search, pixels, inZone, CLEAR };
