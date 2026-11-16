// NASA fire confirmation: active-fire detections from NASA GIBS (Global Imagery Browse Services), no key needed.
// NASA FIRMS serves the same VIIRS and MODIS detections as tables; GIBS serves them as map images, so for each day we ask for a
// small PNG over the field (plus a 400 m buffer) and count the non-transparent pixels, which are the fire detections.
// Layers: VIIRS Suomi NPP and NOAA-20 (375 m) and MODIS Terra and Aqua combined (1 km), day and night passes together.
// PNG decoding is done here with zlib (no libraries): all five scanline filters, RGBA, RGB, grey and palette with tRNS.
"use strict";

const zlib = require("zlib");
const { helpers: G } = require("./fieldgeo");

const UA = { "User-Agent": "fieldshift-simulator" };
const DAY = 864e5, R = Math.PI / 180;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const LAYERS = [
  ["VIIRS_SNPP_Thermal_Anomalies_375m_All", "VIIRS Suomi NPP"],
  ["VIIRS_NOAA20_Thermal_Anomalies_375m_All", "VIIRS NOAA-20"],
  ["MODIS_Combined_Thermal_Anomalies_All", "MODIS Terra and Aqua"],
];
const BUFFER_M = 400;

// minimal PNG decoder: returns the number of pixels that are not fully transparent (alpha channel, tRNS or palette)
function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0, depth = 8, ctype = 6, interlace = 0, trns = null; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === "tRNS") trns = d; else if (type === "IDAT") idat.push(d); else if (type === "IEND") break;
    p += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG");
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; if (!chans || !w || !h) throw new Error("PNG type");
  const bpp = Math.max(1, chans * depth >> 3), stride = Math.ceil(w * chans * depth / 8), raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("short PNG data");
  const img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[dst + x - bpp] : 0, b = y ? img[dst - stride + x] : 0, c = x >= bpp && y ? img[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error("PNG filter " + f);
      img[dst + x] = v & 255;
    }
  }
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let alpha = 255;
    if (ctype === 6) alpha = depth === 8 ? img[y * stride + x * 4 + 3] : img[y * stride + x * 8 + 6];
    else if (ctype === 4) alpha = depth === 8 ? img[y * stride + x * 2 + 1] : img[y * stride + x * 4 + 2];
    else if (ctype === 3) {
      const idx = depth === 8 ? img[y * stride + x] : (img[y * stride + (x * depth >> 3)] >> (8 - depth - (x * depth & 7))) & ((1 << depth) - 1);
      alpha = trns && idx < trns.length ? trns[idx] : 255;
    }
    if (alpha > 0) n++;
  }
  return { w, h, n };
}

const cache = new Map();
function cached(key, ms, make) {
  const hit = cache.get(key); if (hit && Date.now() - hit.t < ms) return hit.p;
  const p = make(); cache.set(key, { t: Date.now(), p }); p.catch(() => cache.delete(key));
  if (cache.size > 6000) cache.delete(cache.keys().next().value);
  return p;
}
async function pool(jobs, limit) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => { while (i < jobs.length) { const k = i++; await jobs[k](); } }));
}

// the field's bounding box plus the buffer, and an image size of about 60 m a pixel (kept between 8 and 160 pixels)
function boxOf(f) {
  const b = G.bboxOf(f.ring), dy = BUFFER_M / 110574, dx = BUFFER_M / (111320 * Math.cos((b.y0 + b.y1) / 2 * R));
  const bb = [b.x0 - dx, b.y0 - dy, b.x1 + dx, b.y1 + dy].map((v) => +v.toFixed(5));
  const wm = (bb[2] - bb[0]) * 111320 * Math.cos((bb[1] + bb[3]) / 2 * R), hm = (bb[3] - bb[1]) * 110574;
  return { bb, W: Math.max(8, Math.min(160, Math.round(wm / 60))), H: Math.max(8, Math.min(160, Math.round(hm / 60))) };
}
// one layer, one day, one box: how many detection pixels (throws when GIBS did not answer)
function detections(layer, day, box, deadline) {
  return cached(`${layer}|${day}|${box.bb}`, day >= iso(Date.now() - 2 * DAY) ? 30 * 60e3 : 7 * 24 * 3600e3, async () => {
    const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&SRS=EPSG:4326&BBOX=${box.bb.join(",")}` +
      `&WIDTH=${box.W}&HEIGHT=${box.H}&FORMAT=image/png&TRANSPARENT=true&TIME=${day}`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(Math.max(500, Math.min(20000, deadline - Date.now()))) });
    if (!res.ok || !/png/.test(res.headers.get("content-type") || "")) throw new Error(`GIBS returned ${res.status}`);
    return decodePng(Buffer.from(await res.arrayBuffer())).n;
  });
}

// For each field, the days between `from` and `to` (ms) on which NASA's fire satellites saw fire in or within 400 m of it.
// Hard time budget (budgetMs, default 12 s): requests not started by then are skipped, newest days first. Returns { from, to, daysChecked, failed, skipped, answered, answeredTo, sensors, fields: { id: { days: [{date, sensors}] } } }; failed counts requests GIBS did not answer.
async function fireCheck(fields, from, to, budgetMs = 12000) {
  const deadline = Date.now() + budgetMs;
  const days = []; for (let t = Date.parse(iso(from)); t <= Date.parse(iso(to)); t += DAY) days.push(iso(t));
  const out = { from: days[0], to: days[days.length - 1], daysChecked: days.length, failed: 0, sensors: LAYERS.map((l) => l[1]), fields: {}, answeredTo: null, skipped: 0 };
  const jobs = [], per = {}, ok = new Set(), sensorTo = {};
  days.reverse();   // newest days first, so a time-out loses the oldest ones
  for (const f of fields) per[f.id] = {};
  for (const d of days) for (const f of fields) {
    const box = boxOf(f);
    for (const [layer, label] of LAYERS) jobs.push(async () => {
      if (Date.now() >= deadline) { out.skipped++; return; }
      try { const n = await detections(layer, d, box, deadline); ok.add(d); if (!sensorTo[label] || d > sensorTo[label]) sensorTo[label] = d; if (n > 0) (per[f.id][d] = per[f.id][d] || []).push(label); } catch { out.failed++; }
    });
  }
  await pool(jobs, 12);
  days.reverse();
  out.answered = days.filter((d) => ok.has(d));   // days at least one sensor's map answered for
  // NASA publishes the newest days with a delay (days, sometimes longer): answeredTo is the latest day at least one sensor answered for
  out.sensorTo = sensorTo;   // the latest day each sensor's map answered for (VIIRS and MODIS are published at different speeds)
  out.answeredTo = days.filter((d) => ok.has(d)).pop() || null;
  for (const f of fields) out.fields[f.id] = { days: Object.keys(per[f.id]).sort().map((d) => ({ date: d, sensors: per[f.id][d] })) };
  return out;
}

module.exports = { fireCheck, decodePng };
