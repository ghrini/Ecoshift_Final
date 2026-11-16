// /api/fieldconditions: the farmer's own field outlines (from a GeoJSON file) -> the conditions on those exact fields.
// - Weather: 44 seasons (16 Nov 1981 .. 15 Nov 2025) of NASA POWER daily weather at the farm's own point (the same source the
//   crop model was calibrated and validated on: its heat and frost thresholds are POWER's), with FAO-56 Penman-Monteith ET0
//   computed from POWER's temperature, dew point, wind and sunlight (Hargreaves where sunlight is missing, before 1984).
//   If NASA POWER does not answer, the Copernicus reanalysis from Open-Meteo's archive is used instead ("era5_seamless":
//   ERA5-Land at 0.1 degrees where Open-Meteo has the variable, ERA5 at 0.25 degrees for the rest), and the page says so.
// - Terrain: the Copernicus GLO-30 digital elevation model (30 m), read straight from its public AWS bucket
//   (Cloud Optimized GeoTIFFs: only the 1024 x 1024 tiles under the fields are downloaded). Every 30 m cell inside a field
//   gives a slope (Horn's method), so each field gets its own mean slope and height.
// - Soil: USDA NRCS soil survey at a point well inside each field (ISRIC SoilGrids outside the US), and USDA NASS county yields.
// Weather is cached on disk by ERA5-Land cell for 30 days: one 44-year request is heavy for Open-Meteo's free limits.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { helpers: H } = require("./farmfit");

const UA = { "User-Agent": "fieldshift-simulator" };
const DIR = path.join(os.tmpdir(), "fieldshift-geo");
const FIRST = 1982, LAST = 2025, DAYS = 365;
const MAX_FIELDS = 4, MAX_POINTS = 5000, ACRE_M2 = 4046.8564224;
const round = (x, k = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const R = Math.PI / 180;

/* ---------- geometry on the sphere (rings are [[lon, lat], ...]) ---------- */
function ringAreaM2(ring) {   // spherical excess approximation used by GeoJSON tools (Chamberlain & Duquette 2007)
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += (x2 - x1) * R * (2 + Math.sin(y1 * R) + Math.sin(y2 * R));
  }
  return Math.abs(s * 6378137 * 6378137 / 2);
}
function inRing(ring, x, y) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inField = (f, x, y) => inRing(f.ring, x, y) && !f.holes.some((h) => inRing(h, x, y));
function bboxOf(ring) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of ring) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return { x0: a, y0: b, x1: c, y1: d };
}
// a point well inside the field (the grid point farthest from the edge): soil is read there, not on a fence line
function interiorPoint(f) {
  const b = bboxOf(f.ring), ky = 111320, kx = 111320 * Math.cos((b.y0 + b.y1) / 2 * R);
  const edge = (x, y) => {
    let m = Infinity;
    for (const r of [f.ring, ...f.holes]) for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
      const px = (x - ax) * kx, py = (y - ay) * ky, vx = (bx - ax) * kx, vy = (by - ay) * ky, L = vx * vx + vy * vy;
      const t = L ? clamp((px * vx + py * vy) / L, 0, 1) : 0;
      m = Math.min(m, Math.hypot(px - t * vx, py - t * vy));
    }
    return m;
  };
  let best = null, bd = -1;
  for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) {
    const x = b.x0 + (b.x1 - b.x0) * i / 24, y = b.y0 + (b.y1 - b.y0) * j / 24;
    if (!inField(f, x, y)) continue;
    const d = edge(x, y); if (d > bd) { bd = d; best = [x, y]; }
  }
  return best || f.ring[0];
}

/* ---------- Copernicus reanalysis weather (Open-Meteo archive, era5_seamless) ---------- */
const mem = new Map();
function readDisk(name, maxAgeMs) {
  try { const p = path.join(DIR, name); if (Date.now() - fs.statSync(p).mtimeMs < maxAgeMs) return JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* not cached */ }
  return null;
}
function writeDisk(name, v) { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, name), JSON.stringify(v)); } catch (e) { console.warn("fieldgeo cache:", e.message); } }

async function copernicusWeather(lat, lon) {
  // ERA5-Land's grid is every 0.1 degree, so the farm's cell is the nearest tenth: one download serves every farm in the cell
  const la = Math.round(lat * 10) / 10, lo = Math.round(lon * 10) / 10, key = `wx_${la.toFixed(1)}_${lo.toFixed(1)}.json`;
  if (mem.has(key)) return mem.get(key);
  const p = (async () => {
    const disk = readDisk(key, 30 * 24 * 3600e3); if (disk) return disk;
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${la}&longitude=${lo}&start_date=${FIRST - 1}-11-16&end_date=${LAST}-11-15` +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration&models=era5_seamless&timezone=auto";
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 429 || /limit/i.test(j.reason || "") ? "the Copernicus weather service (Open-Meteo) is busy: try again in a minute" : `Open-Meteo returned ${res.status}`);
    const out = toSeasons(j);
    writeDisk(key, out);
    return out;
  })();
  mem.set(key, p); if (mem.size > 50) mem.delete(mem.keys().next().value);
  p.catch(() => mem.delete(key));
  return p;
}
/* ---------- NASA POWER daily weather at the farm (MERRA-2 meteorology, CERES / GEWEX sunlight) ---------- */
// FAO-56 Penman-Monteith reference evapotranspiration for one day (mm), as in the simulator's own data build.
function et0Day(tmax, tmin, tdew, u2, rs, z, latDeg, doy) {
  const T = (tmax + tmin) / 2, P = 101.3 * Math.pow((293 - 0.0065 * z) / 293, 5.26), gam = 0.000665 * P;
  const e0 = (t) => 0.6108 * Math.exp(17.27 * t / (t + 237.3)), D = 4098 * e0(T) / Math.pow(T + 237.3, 2);
  const phi = latDeg * R, dr = 1 + 0.033 * Math.cos(2 * Math.PI * doy / 365), dec = 0.409 * Math.sin(2 * Math.PI * doy / 365 - 1.39);
  const ws = Math.acos(clamp(-Math.tan(phi) * Math.tan(dec), -1, 1));
  const Ra = 24 * 60 / Math.PI * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
  if (rs == null || u2 == null || tdew == null) return Math.max(0, 0.0023 * (T + 17.8) * Math.sqrt(Math.max(0, tmax - tmin)) * Ra * 0.408);   // Hargreaves
  const es = (e0(tmax) + e0(tmin)) / 2, ea = Math.min(e0(tdew), es), Rso = (0.75 + 2e-5 * z) * Ra;
  const Rnl = 4.903e-9 * (Math.pow(tmax + 273.16, 4) + Math.pow(tmin + 273.16, 4)) / 2 * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * clamp(rs / Math.max(Rso, 1e-6), 0.25, 1) - 0.35);
  const Rn = 0.77 * rs - Rnl;
  return Math.max(0, (0.408 * D * Rn + gam * 900 / (T + 273) * u2 * (es - ea)) / (D + gam * (1 + 0.34 * u2)));
}
async function nasaPowerWeather(lat, lon) {
  const key = `power_${(Math.round(lat * 20) / 20).toFixed(2)}_${(Math.round(lon * 20) / 20).toFixed(2)}.json`;
  if (mem.has(key)) return mem.get(key);
  const p = (async () => {
    const disk = readDisk(key, 30 * 24 * 3600e3); if (disk) return disk;
    const url = "https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,T2MDEW,WS2M" +
      `&community=AG&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}&start=${FIRST - 1}1116&end=${LAST}1115&format=JSON`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(55000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.properties || !j.properties.parameter) throw new Error(`NASA POWER returned ${res.status}`);
    const P = j.properties.parameter, z = (j.geometry && j.geometry.coordinates && j.geometry.coordinates[2]) || 0;
    const ok = (v) => (v == null || v <= -998 ? null : v);
    const days = Object.keys(P.T2M_MAX || {}).sort(), daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], et0_fao_evapotranspiration: [] };
    for (const d of days) {
      const tmax = ok(P.T2M_MAX[d]), tmin = ok(P.T2M_MIN[d]), iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      const doy = Math.round((Date.parse(iso) - Date.UTC(+d.slice(0, 4), 0, 0)) / 864e5);
      daily.time.push(iso); daily.temperature_2m_max.push(tmax); daily.temperature_2m_min.push(tmin); daily.precipitation_sum.push(ok(P.PRECTOTCORR[d]));
      daily.et0_fao_evapotranspiration.push(tmax == null || tmin == null ? null : round(et0Day(tmax, tmin, ok(P.T2MDEW[d]), ok(P.WS2M[d]), ok(P.ALLSKY_SFC_SW_DWN[d]), z, lat, doy), 2));
    }
    const out = toSeasons({ daily, latitude: lat, longitude: lon, elevation: z }, "the NASA POWER weather series");
    out.meta.source = "NASA POWER daily weather (MERRA-2 meteorology, CERES and GEWEX sunlight), FAO-56 Penman-Monteith ET0";
    out.meta.short = "NASA POWER";
    writeDisk(key, out);
    return out;
  })();
  mem.set(key, p); if (mem.size > 50) mem.delete(mem.keys().next().value);
  p.catch(() => mem.delete(key));
  return p;
}
// NASA POWER first; the Copernicus reanalysis only when NASA POWER does not answer
function farmWeather(lat, lon) {
  return nasaPowerWeather(lat, lon).catch((e) => {
    console.warn("fieldgeo: NASA POWER did not answer (" + e.message + "); using the Copernicus reanalysis instead");
    return copernicusWeather(lat, lon).then((c) => { c.meta.fallback = "NASA POWER did not answer, so this farm uses the Copernicus ERA5 reanalysis."; return c; });
  });
}

// daily series -> the simulator's climate object: one 365-day season per year from 16 Nov (29 Feb dropped), values x10 as integers
function toSeasons(j, label = "the Copernicus weather series") {
  const d = j.daily || {}, idx = new Map((d.time || []).map((t, i) => [t, i]));
  const K = { tmax: "temperature_2m_max", tmin: "temperature_2m_min", rain: "precipitation_sum", et0: "et0_fao_evapotranspiration" };
  const seasons = {}, years = [];
  let filled = 0;
  for (let y = FIRST; y <= LAST; y++) {
    const s = { tmax: [], tmin: [], rain: [], et0: [] };
    let missing = 0;
    for (let t = Date.UTC(y - 1, 10, 16); s.tmax.length < DAYS; t += 864e5) {
      const iso = new Date(t).toISOString().slice(0, 10);
      if (iso.endsWith("-02-29")) continue;
      const i = idx.get(iso);
      for (const k in K) {
        let v = i == null ? null : d[K[k]][i];
        if (v == null || !isFinite(v)) { missing++; const a = s[k]; v = a.length ? a[a.length - 1] / 10 : (k === "rain" ? 0 : null); }
        s[k].push(v == null ? null : Math.round(v * 10));
      }
    }
    if (missing > 20 || s.tmax.some((v) => v == null)) continue;   // a season with real gaps is left out, not invented
    filled += missing;
    for (let k = 0; k < DAYS; k++) if (s.tmin[k] > s.tmax[k]) s.tmin[k] = s.tmax[k];
    seasons[y] = s; years.push(y);
  }
  if (years.length < 30) throw new Error(label + " has too many gaps at this spot");
  return {
    meta: { source: "Copernicus ERA5-Land and ERA5 daily reanalysis (C3S/ECMWF) via Open-Meteo", short: "Copernicus ERA5", lat: j.latitude, lon: j.longitude,
      elevation_m: j.elevation, seasonStart: "11-16", days: DAYS, years, typicalYear: 2011, scale: { tmax: 10, tmin: 10, rain: 10, et0: 10 },
      filledDays: filled, accessed: new Date().toISOString().slice(0, 10) },
    seasons,
  };
}

/* ---------- Copernicus GLO-30 DEM (Cloud Optimized GeoTIFF on AWS) ---------- */
function demName(la, lo) {
  const ns = la >= 0 ? "N" : "S", ew = lo >= 0 ? "E" : "W";
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(la)).padStart(2, "0")}_00_${ew}${String(Math.abs(lo)).padStart(3, "0")}_00_DEM`;
}
async function range(url, a, n) {
  const res = await fetch(url, { headers: { ...UA, Range: `bytes=${a}-${a + n - 1}` }, signal: AbortSignal.timeout(25000) });
  if (res.status === 404 || res.status === 403) return null;   // no tile: open sea
  if (res.status !== 206 && res.status !== 200) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// A Cloud Optimized GeoTIFF read in pieces: the header once, then only the 1024 x 1024 tiles that are needed.
// Handles the two files used here: the Copernicus DEM (32-bit float, floating-point predictor) and ESA WorldCover (8-bit classes).
const heads = new Map();
function cogHead(url) {
  if (heads.has(url)) return heads.get(url);
  const p = (async () => {
    let b = await range(url, 0, 65536);
    if (!b) return null;
    const le = b.toString("latin1", 0, 2) === "II";
    const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const f64 = (o) => (le ? b.readDoubleLE(o) : b.readDoubleBE(o));
    const off = u32(4), n = u16(off), T = {};
    for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; T[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 }; }
    const val = (t) => (T[t].type === 3 && T[t].count === 1 ? u16(T[t].at) : u32(T[t].at));
    const arr = (t, size, rd) => { const c = T[t].count, at = c * size > 4 ? u32(T[t].at) : T[t].at; if (at + c * size > b.length) throw new Error("GeoTIFF header too large"); return Array.from({ length: c }, (_, i) => rd(at + i * size)); };
    const bits = val(258);
    if (val(259) !== 8 || (bits !== 32 && bits !== 16 && bits !== 8)) throw new Error("unexpected GeoTIFF encoding");
    const geoKeys = T[34735] ? arr(34735, 2, u16) : [];
    let pointPx = false;
    for (let i = 4; i + 3 < geoKeys.length; i += 4) if (geoKeys[i] === 1025) pointPx = geoKeys[i + 3] === 2;   // GTRasterTypeGeoKey: 2 = PixelIsPoint
    const scale = arr(33550, 8, f64), tie = arr(33922, 8, f64);
    const h = { url, bits, le, w: val(256), h: val(257), tw: val(322), th: val(323), pred: T[317] ? val(317) : 1,
      offsets: arr(324, T[324].type === 16 ? 8 : 4, u32), counts: arr(325, T[325].type === 16 ? 8 : 4, u32),
      sx: scale[0], sy: scale[1], x0: tie[3] - (pointPx ? scale[0] / 2 : 0), y0: tie[4] + (pointPx ? scale[1] / 2 : 0) };
    h.across = Math.ceil(h.w / h.tw);
    return h;
  })();
  // a failed header is remembered for 5 minutes, so a file host that is down does not hold up every request
  heads.set(url, p); p.catch(() => setTimeout(() => { if (heads.get(url) === p) heads.delete(url); }, 5 * 60e3).unref?.());
  return p;
}
const tiles = new Map();   // decoded tiles (1 to 4 MB each): the last 16 are kept
function cogTile(h, ti) {
  const k = h.url + "#" + ti;
  if (tiles.has(k)) { const v = tiles.get(k); tiles.delete(k); tiles.set(k, v); return v; }
  const p = (async () => {
    const raw = await range(h.url, h.offsets[ti], h.counts[ti]);
    const buf = zlib.inflateSync(raw), W = h.tw;
    if (h.bits === 8) {   // class codes, one byte a pixel (horizontal predictor undone if present)
      const out = new Uint8Array(buf.buffer, buf.byteOffset, W * h.th).slice();
      if (h.pred === 2) for (let r = 0; r < h.th; r++) for (let c = 1; c < W; c++) out[r * W + c] = (out[r * W + c] + out[r * W + c - 1]) & 255;
      return out;
    }
    if (h.bits === 16) {   // Sentinel-2 reflectance: unsigned 16-bit, horizontal predictor undone row by row
      const out = new Uint16Array(W * h.th);
      for (let i = 0; i < W * h.th; i++) out[i] = h.le ? buf.readUInt16LE(i * 2) : buf.readUInt16BE(i * 2);
      if (h.pred === 2) for (let r = 0; r < h.th; r++) for (let c = 1; c < W; c++) out[r * W + c] = (out[r * W + c] + out[r * W + c - 1]) & 65535;
      return out;
    }
    const out = new Float32Array(W * h.th), dv = new DataView(new ArrayBuffer(4));
    for (let r = 0; r < h.th; r++) {
      const base = r * W * 4;
      if (h.pred === 3) {   // floating-point predictor: undo the byte differencing, then put the four byte planes back together (most significant first)
        for (let i = 1; i < W * 4; i++) buf[base + i] = (buf[base + i] + buf[base + i - 1]) & 255;
        for (let c = 0; c < W; c++) { dv.setUint8(0, buf[base + c]); dv.setUint8(1, buf[base + W + c]); dv.setUint8(2, buf[base + 2 * W + c]); dv.setUint8(3, buf[base + 3 * W + c]); out[r * W + c] = dv.getFloat32(0, false); }
      } else for (let c = 0; c < W; c++) out[r * W + c] = buf.readFloatLE(base + c * 4);
    }
    return out;
  })();
  tiles.set(k, p); if (tiles.size > 16) tiles.delete(tiles.keys().next().value);
  p.catch(() => tiles.delete(k));
  return p;
}
// The pixels of one file over a box (padded by pad pixels): returns the pixel range and a lookup v(row, col)
async function cogWindow(h, b, pad) {
  const col = (x) => Math.floor((x - h.x0) / h.sx), row = (y) => Math.floor((h.y0 - y) / h.sy);
  const c0 = clamp(col(b.x0) - pad, 0, h.w - 1), c1 = clamp(col(b.x1) + pad, 0, h.w - 1), r0 = clamp(row(b.y1) - pad, 0, h.h - 1), r1 = clamp(row(b.y0) + pad, 0, h.h - 1);
  const need = new Set();
  for (let tr = Math.floor(r0 / h.th); tr <= Math.floor(r1 / h.th); tr++) for (let tc = Math.floor(c0 / h.tw); tc <= Math.floor(c1 / h.tw); tc++) need.add(tr * h.across + tc);
  const got = {};
  await Promise.all([...need].map(async (ti) => { got[ti] = await cogTile(h, ti); }));
  const v = (r, c) => { r = clamp(r, 0, h.h - 1); c = clamp(c, 0, h.w - 1); const t = got[Math.floor(r / h.th) * h.across + Math.floor(c / h.tw)]; return t ? t[(r % h.th) * h.tw + (c % h.tw)] : NaN; };
  return { r0, r1, c0, c1, v, lon: (c) => h.x0 + (c + 0.5) * h.sx, lat: (r) => h.y0 - (r + 0.5) * h.sy };
}
// groups of touching cells (8 neighbours): [{ n, lon, lat }] with each group's centre, largest first
// (keep = true also returns each group's member cells as [[r, c], ...] in `cells`, for drawing them on a map)
function clusters(cells, lonOf, latOf, keep) {
  const key = (r, c) => r * 1e6 + c, set = new Set(cells.map(([r, c]) => key(r, c))), out = [];
  for (const [r, c] of cells) {
    if (!set.has(key(r, c))) continue;
    set.delete(key(r, c));
    const q = [[r, c]], mem = keep ? [] : null; let n = 0, sr = 0, sc = 0;
    while (q.length) {
      const [a, b] = q.pop(); n++; sr += a; sc += b; if (mem) mem.push([a, b]);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const k = key(a + i, b + j); if (set.has(k)) { set.delete(k); q.push([a + i, b + j]); } }
    }
    out.push(Object.assign({ n, lon: round(lonOf(sc / n), 5), lat: round(latOf(sr / n), 5) }, mem ? { cells: mem } : {}));
  }
  return out.sort((x, y) => y.n - x.n);
}
// a point that must pass ok(lon, lat): the point itself, or else the member cell nearest to it that passes (null if none does)
function snapIn(pt, members, toLL, ok) {
  if (ok(pt[0], pt[1])) return pt;
  let best = null, bd = Infinity;
  for (const [r, c] of members) {
    const q = toLL(r, c); if (!ok(q[0], q[1])) continue;
    const d = (q[0] - pt[0]) ** 2 + (q[1] - pt[1]) ** 2; if (d < bd) { bd = d; best = q; }
  }
  return best;
}
// Grid cells [[r, c], ...] as map squares, merged into k x k blocks (k = 1, 2, 3, ...) until there are at most `max` of them,
// so a big lake or zone stays a small answer. Returns { k, cells: [[lon, lat], ...], grp: [...] } with each block's centre (toLL(row, col) -> [lon, lat]).
// ok(lon, lat, group), when given, is where a block's centre must be (inside the field, or outside it for the band): a merged block
// whose centre misses moves to the mean of its cells, else to its member cell nearest the centre; a block with no such cell is dropped.
// grpOf(cell) keeps cells of different groups (inside the field, in the band) in separate blocks.
function blocks(cells, toLL, max = 600, ok, grpOf) {
  const gOf = grpOf || (() => 0);
  let k = 1, groups;
  for (;;) {
    groups = new Map();
    for (const x of cells) {
      const g = gOf(x), br = Math.floor(x[0] / k), bc = Math.floor(x[1] / k), key = g + ":" + br + ":" + bc;
      let o = groups.get(key); if (!o) groups.set(key, (o = { g, br, bc, m: [] }));
      o.m.push(x);
    }
    if (groups.size <= max || k >= 50) break;
    k++;
  }
  const out = [], grp = [];
  for (const o of groups.values()) {
    let p = toLL((o.br + 0.5) * k - 0.5, (o.bc + 0.5) * k - 0.5);
    if (ok && !ok(p[0], p[1], o.g)) {
      const pts = o.m.map(([r, c]) => toLL(r, c)), mean = [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
      p = snapIn(mean, o.m, toLL, (x, y) => ok(x, y, o.g));
    }
    if (!p) continue;
    out.push([round(p[0], 6), round(p[1], 6)]); grp.push(o.g);
  }
  return { k, cells: out, grp };
}
// a layer's cell size in metres from its size in degrees (the larger side, so the squares meet without gaps), and both sides
function sizeM(sx, sy, lat) {
  const dx = sx * 111320 * Math.cos(lat * R), dy = sy * 110574;
  return { cellM: round(Math.max(dx, dy), 1), cellMxy: [round(dx, 1), round(dy, 1)] };
}

const demHead = (la, lo) => { const name = demName(la, lo); return cogHead(`https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`); };
// Every DEM cell centre inside the field: mean height, height range and mean slope (Horn's 3 x 3 method on the 30 m grid),
// and its low spots: flat cells (under 1.5% slope) in the lowest part of the field, where water gathers after heavy rain.
async function terrain(f) {
  const b = bboxOf(f.ring), h = await demHead(Math.floor((b.y0 + b.y1) / 2), Math.floor((b.x0 + b.x1) / 2));
  if (!h) return null;
  const W = await cogWindow(h, b, 1), z = W.v;
  const lat = (b.y0 + b.y1) / 2, dx = h.sx * 111320 * Math.cos(lat * R), dy = h.sy * 110574;
  let n = 0, sz = 0, ss = 0, lo2 = Infinity, hi = -Infinity, steep = 0;
  const cells = [];
  for (let r = W.r0; r <= W.r1; r++) for (let c = W.c0; c <= W.c1; c++) {
    if (!inField(f, W.lon(c), W.lat(r))) continue;
    const e = z(r, c); if (!isFinite(e) || e < -100) continue;
    const a = z(r - 1, c - 1), bb = z(r - 1, c), cc = z(r - 1, c + 1), d = z(r, c - 1), ff = z(r, c + 1), g = z(r + 1, c - 1), hh = z(r + 1, c), ii = z(r + 1, c + 1);
    const gx = ((cc + 2 * ff + ii) - (a + 2 * d + g)) / (8 * dx), gy = ((g + 2 * hh + ii) - (a + 2 * bb + cc)) / (8 * dy);
    const sl = Math.hypot(gx, gy) * 100;
    if (!isFinite(sl)) continue;
    n++; sz += e; ss += sl; lo2 = Math.min(lo2, e); hi = Math.max(hi, e); if (sl > 6) steep++;
    cells.push([r, c, e, sl]);
  }
  if (!n) return null;
  const cut = lo2 + Math.min(1, (hi - lo2) * 0.15), cellM2 = dx * dy;
  const toLL = (r, c) => [W.lon(c), W.lat(r)], ok = (x, y) => inField(f, x, y);
  const lowK = clusters(cells.filter((x) => x[2] <= cut && x[3] < 1.5), W.lon, W.lat, true).filter((k) => k.n >= 2).slice(0, 3);
  // a low spot's middle can fall outside a curved spot (or in a hole): then its cell nearest the middle is used
  const low = lowK.map((k) => { const p = snapIn([k.lon, k.lat], k.cells, toLL, ok); return { lon: round(p[0], 5), lat: round(p[1], 5), areaM2: Math.round(k.n * cellM2) }; });
  // the low-spot cells themselves (30 m squares), for the map: where water collects after heavy rain
  const lb = blocks(lowK.flatMap((k) => k.cells), toLL, 400, ok);
  return { cells: n, elevationM: round(sz / n, 0), minM: round(lo2, 0), maxM: round(hi, 0), slopePct: round(ss / n, 1), steepSharePct: round(steep / n * 100, 0), lowSpots: low,
    lowCells: Object.assign({ stepDeg: [round(h.sx * lb.k, 7), round(h.sy * lb.k, 7)] }, sizeM(h.sx * lb.k, h.sy * lb.k, lat), { cells: lb.cells }) };
}

// ESA WorldCover 2021 (10 m land cover from Copernicus Sentinel-1 and Sentinel-2) inside the field and in a band around it:
// the share of each cover, and every patch of open water (class 80) or wetland (class 90) with its size and place.
const WC = { 10: "trees", 20: "shrubs", 30: "grass", 40: "cropland", 50: "built", 60: "bare", 70: "snow", 80: "water", 90: "wetland", 95: "mangrove", 100: "moss" };
function wcUrl(lat, lon) {
  const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3;
  const t = `${la >= 0 ? "N" : "S"}${String(Math.abs(la)).padStart(2, "0")}${lo >= 0 ? "E" : "W"}${String(Math.abs(lo)).padStart(3, "0")}`;
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${t}_Map.tif`;
}
async function landCover(f, bandM = 150) {
  const b = bboxOf(f.ring), h = await cogHead(wcUrl((b.y0 + b.y1) / 2, (b.x0 + b.x1) / 2));
  if (!h) return null;
  const lat = (b.y0 + b.y1) / 2, dx = h.sx * 111320 * Math.cos(lat * R), dy = h.sy * 110574, pad = Math.ceil(bandM / Math.min(dx, dy));
  const W = await cogWindow(h, b, pad);
  const count = {}, wetIn = [], wetOut = [];
  let n = 0;
  const nearRing = (x, y) => {   // within bandM of the outline (or of a hole's edge)?
    for (const ring of [f.ring, ...f.holes]) for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const px = (x - ax) * 111320 * Math.cos(lat * R), py = (y - ay) * 110574, vx = (bx - ax) * 111320 * Math.cos(lat * R), vy = (by - ay) * 110574, L = vx * vx + vy * vy;
      const t = L ? clamp((px * vx + py * vy) / L, 0, 1) : 0;
      if (Math.hypot(px - t * vx, py - t * vy) <= bandM) return true;
    }
    return false;
  };
  for (let r = W.r0; r <= W.r1; r++) for (let c = W.c0; c <= W.c1; c++) {
    const v = W.v(r, c), x = W.lon(c), y = W.lat(r), inside = inField(f, x, y);
    if (inside) { n++; const k = WC[v] || "other"; count[k] = (count[k] || 0) + 1; }
    if (v === 80 || v === 90) { if (inside) wetIn.push([r, c, v]); else if (nearRing(x, y)) wetOut.push([r, c, v]); }
  }
  if (!n) return null;
  const cellM2 = dx * dy, share = {};
  for (const k in count) share[k] = round(count[k] / n * 100, 1);
  const toLL = (r, c) => [W.lon(c), W.lat(r)], side = (x, y, g) => inField(f, x, y) === !!g;   // g = 1: inside the field, 0: in the band
  // a patch's middle stays on its own side of the edge (a pond ringing a hole would otherwise have its middle in the hole)
  const patches = (list, inside) => ["water", "wetland"].flatMap((kind) => clusters(list.filter((x) => x[2] === (kind === "water" ? 80 : 90)), W.lon, W.lat, true)
    .filter((k) => k.n * cellM2 >= 150).map((k) => { const p = snapIn([k.lon, k.lat], k.cells, toLL, (x, y) => side(x, y, inside)) || [k.lon, k.lat];
      return { kind, inside, lon: round(p[0], 5), lat: round(p[1], 5), areaM2: Math.round(k.n * cellM2) }; }));
  // the water and wetland pixels themselves (10 m squares, merged into bigger blocks when there are many), inside the field and in the band:
  // each cell is [lon, lat, inside] (inside = true when the square's centre is in the field, false in the band around it or in a hole)
  const tag = (g) => (x) => [x[0], x[1], x[2], g], all = wetIn.map(tag(1)).concat(wetOut.map(tag(0)));
  const layer = (cls) => {
    const b = blocks(all.filter((x) => x[2] === cls), toLL, 700, side, (x) => x[3]);
    return Object.assign({ stepDeg: [round(h.sx * b.k, 7), round(h.sy * b.k, 7)] }, sizeM(h.sx * b.k, h.sy * b.k, lat), { cells: b.cells.map((c, i) => [c[0], c[1], b.grp[i] === 1]) });
  };
  return { sharePct: share, water: patches(wetIn, true).concat(patches(wetOut, false)).sort((a, z) => z.areaM2 - a.areaM2).slice(0, 8),
    cells: { water: layer(80), wetland: layer(90), bandM } };
}

/* ---------- request ---------- */
function cleanRing(r) {
  if (!Array.isArray(r)) return null;
  const out = r.filter((p) => Array.isArray(p) && H.okLatLon(+p[1], +p[0])).map((p) => [+p[0], +p[1]]);
  if (out.length > 1) { const a = out[0], z = out[out.length - 1]; if (a[0] === z[0] && a[1] === z[1]) out.pop(); }
  return out.length >= 3 ? out : null;
}

module.exports = function fieldgeo({ readBody, send }) {
  async function handleFieldConditions(req, res) {
    let b;
    try { b = JSON.parse(await readBody(req, 400000)); } catch (e) { return send(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? "That file has too many points. Simplify the outlines and try again." : "Bad request." }); }
    const list = (Array.isArray(b && b.fields) ? b.fields : []).slice(0, MAX_FIELDS);
    const fields = [];
    let pts = 0;
    for (const x of list) {
      const ring = cleanRing(x && x.ring); if (!ring) continue;
      const holes = (Array.isArray(x.holes) ? x.holes : []).map(cleanRing).filter(Boolean);
      pts += ring.length + holes.reduce((s, h) => s + h.length, 0);
      const area = ringAreaM2(ring) - holes.reduce((s, h) => s + ringAreaM2(h), 0);
      fields.push({ id: String(x.id || "").replace(/\W/g, "").slice(0, 20), name: String(x.name || "").slice(0, 40), ring, holes, acres: area / ACRE_M2 });
    }
    if (!fields.length) return send(res, 400, { error: "No field outlines found in that file." });
    if (pts > MAX_POINTS) return send(res, 413, { error: "Those outlines have too many points. Simplify them and try again." });
    const bad = fields.find((f) => f.acres < 1 || f.acres > 5000);
    if (bad) return send(res, 400, { error: `${bad.name || "One field"} is ${round(bad.acres, 1)} acres. Each field must be between 1 and 5000 acres.` });
    // the farm's middle: the area-weighted mean of the field centres
    let A = 0, cx = 0, cy = 0;
    for (const f of fields) { const bb = bboxOf(f.ring); f.center = interiorPoint(f); A += f.acres; cx += (bb.x0 + bb.x1) / 2 * f.acres; cy += (bb.y0 + bb.y1) / 2 * f.acres; }
    cx /= A; cy /= A;
    const far = fields.find((f) => Math.hypot((f.center[0] - cx) * Math.cos(cy * R), f.center[1] - cy) * 111 > 30);
    if (far) return send(res, 400, { error: `${far.name || "One field"} is more than 30 km from the others. Import one farm at a time.` });

    const sources = [], gaps = [];
    const [wx, where, ...rest] = await Promise.allSettled([
      farmWeather(cy, cx),
      H.countyAt(cy, cx),
      ...fields.map((f) => terrain(f)),
      ...fields.map((f) => H.soilAt(f.center[0], f.center[1]).catch(() => null)),
    ]);
    if (wx.status !== "fulfilled") return send(res, 502, { error: "Could not get the weather for these fields: " + (wx.reason && wx.reason.message || "no answer") + "." });
    const terr = rest.slice(0, fields.length), soils = rest.slice(fields.length);
    const county = where.status === "fulfilled" && where.value && where.value.county ? where.value : null;
    const nass = county ? await H.nassCounty(county.state, county.county).catch(() => null) : null;

    const out = {};
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i], t = terr[i].status === "fulfilled" ? terr[i].value : null;
      let soil = soils[i].status === "fulfilled" ? soils[i].value : null;
      if (!soil && !county) soil = await H.soilGrids(f.center[1], f.center[0]).catch(() => null);
      if (soil) soil = { ...soil };
      if (soil && t) { soil.surveySlopePct = soil.slopePct; soil.slopePct = Math.round(t.slopePct); soil.slopeFrom = "Copernicus DEM"; }
      out[f.id] = { name: f.name, acres: round(f.acres, 1), center: [round(f.center[0], 5), round(f.center[1], 5)], terrain: t, soil };
      if (!t) gaps.push(`No Copernicus elevation for ${f.name || f.id}, so its slope comes from the soil survey.`);
      if (!soil) gaps.push(`No soil survey answer inside ${f.name || f.id}, so the county's soil is used there.`);
    }
    const C = wx.value;
    sources.push(`Weather: ${C.meta.years.length} seasons (${C.meta.years[0]}-${C.meta.years[C.meta.years.length - 1]}) of ${C.meta.source} at ${round(C.meta.lat, 2)}, ${round(C.meta.lon, 2)}${C.meta.short === "NASA POWER" ? ", the NASA POWER grid cell over your fields" : ", the reanalysis cell over your fields (via Open-Meteo)"}.`);
    if (terr.some((t) => t.status === "fulfilled" && t.value)) sources.push(`Slope and height: Copernicus GLO-30 elevation model, ${terr.reduce((s, t) => s + (t.value ? t.value.cells : 0), 0)} cells of 30 m inside your outlines.`);
    if (soils.some((s) => s.status === "fulfilled" && s.value)) sources.push("Soil: USDA NRCS soil survey at a point well inside each field.");
    if (nass) sources.push(`Normal yields: USDA NASS, ${county.county} County, ${county.state}.`);
    if (C.meta.fallback) gaps.push(C.meta.fallback);
    if (C.meta.filledDays) gaps.push(`${C.meta.filledDays} missing days in the weather series were filled with the day before.`);
    if (cy < 0) gaps.push("The simulator's season runs November to November (a northern-hemisphere calendar), so planting and harvest dates will not match a southern-hemisphere farm.");

    send(res, 200, {
      center: [round(cx, 5), round(cy, 5)], county: county ? `${county.county} County, ${county.state}` : "",
      climate: C, fields: out, normalYield: nass ? Object.fromEntries(["corn", "soybean"].filter((c) => nass[c]).map((c) => [c, nass[c].mean])) : null,
      sources, gaps,
    });
  }
  return { handleFieldConditions };
};
// shared with fieldlive.js (live conditions on the same outlines)
module.exports.helpers = { terrain, landCover, interiorPoint, cleanRing, bboxOf, ringAreaM2, inField, ACRE_M2, cogHead, cogWindow, clusters, blocks, snapIn };
