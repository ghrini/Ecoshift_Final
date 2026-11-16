// /api/fieldhealth: field health from this season's Copernicus Sentinel-2 images, one time series per field.
// Each field's series is written to data/<farm>_<field>.csv (or the system temp folder where the disk is read-only, as on Vercel) and sent back.
// Indices, per clear image, over the field's clear plant/soil pixels at 20 m:
//   NDVI  = (B8A - B4) / (B8A + B4)                     canopy greenness
//   NDRE  = (B8A - B5) / (B8A + B5)                     chlorophyll, so nitrogen (red edge saturates later than NDVI)
//   NDMI  = (B8A - B11) / (B8A + B11)                   water in the leaves
//   S2REP = 705 + 35 * ((B4 + B7) / 2 - B5) / (B6 - B5) red-edge position in nm (Frampton et al. 2013): leaf chlorophyll and structure
//   SAVI  = 1.5 (B8A - B4) / (B8A + B4 + 0.5); LAI = -ln((0.69 - SAVI) / 0.59) / 0.91 (empirical leaf area index; rough)
//   FVC   = ((NDVI - 0.15) / (0.90 - 0.15))^2           share of ground covered by plants
//   CV    = spread of NDVI across the field (standard deviation / mean): uniformity
//   N sufficiency = mean NDRE / NDRE of the field's own best 10% of pixels ("virtual reference strip", after Holland and Schepers 2013).
//     A hint only: it cannot see a field that is short of nitrogen everywhere and is less reliable early in the season.
// Growth stage: growing degree days (base 10 C) from the planting date with ECMWF daily temperatures, checked against the NDVI curve.
// Phosphorus cannot be seen from orbit with any reliability, so it is reported as "soil test needed", not guessed.
// Scores, yield estimate, root causes and advice are simple published rules and thresholds, not a trained model: they say so on the page.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { helpers: G } = require("./fieldgeo");
const S = require("./fieldsat");

const UA = { "User-Agent": "fieldshift-simulator" };
const DAY = 864e5, iso = (t) => new Date(t).toISOString().slice(0, 10);
const round = (x, k = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// per-crop settings: growth stages by growing degree days (C, base 10, from planting), the season's healthy peak NDVI, and the stages
// when water and nitrogen matter most. Corn stages from Iowa State / Purdue GDD guides (converted from F); soybean stages are rougher.
const CROPS = {
  corn: { label: "corn", peak: 0.88, dryNdmi: 0.15, stages: [[0, "planted"], [67, "emerged (VE)"], [264, "V6"], [500, "V12"], [631, "tasselling (VT)"], [778, "silking (R1)"], [1000, "dough (R4)"], [1361, "dent (R5)"], [1500, "mature (R6)"]],
    nStages: ["V6", "V12"], waterStages: ["tasselling (VT)", "silking (R1)", "dough (R4)"] },
  soybean: { label: "soybeans", peak: 0.85, dryNdmi: 0.15, stages: [[0, "planted"], [90, "emerged (VE)"], [300, "V3"], [500, "flowering (R1)"], [750, "pod set (R3)"], [950, "seed fill (R5)"], [1300, "maturing (R7)"]],
    nStages: [], waterStages: ["pod set (R3)", "seed fill (R5)"] },
  oats: { label: "oats", peak: 0.8, dryNdmi: 0.12, stages: [[0, "planted"], [80, "emerged"], [350, "tillering"], [600, "heading"], [900, "grain fill"], [1150, "mature"]],
    nStages: ["tillering"], waterStages: ["heading", "grain fill"] },
};
CROPS.other = CROPS.corn;

function dataDir() {
  for (const d of [path.join(__dirname, "data"), path.join(os.tmpdir(), "fieldshift-data")]) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* next */ }
  }
  return null;
}
const COLS = ["date", "clear_pct", "ndvi", "ndvi_p10", "ndvi_p90", "ndvi_cv", "ndre", "ndre_p90", "n_sufficiency", "ndmi", "s2rep_nm", "savi", "lai", "fvc"];
function writeCsv(farmKey, f, rows) {
  const d = dataDir(); if (!d) return null;
  const name = `${farmKey}_${(f.name || f.id).replace(/[^\w-]+/g, "_").slice(0, 40)}.csv`;
  try { fs.writeFileSync(path.join(d, name), COLS.join(",") + "\n" + rows.map((r) => COLS.map((k) => (r[k] == null ? "" : r[k])).join(",")).join("\n") + "\n"); return path.relative(__dirname, path.join(d, name)).replace(/\\/g, "/"); }
  catch { return null; }
}

async function searchAll(bbox, from, to) {
  const body = { collections: ["sentinel-2-l2a"], bbox, datetime: `${iso(from)}T00:00:00Z/${iso(to)}T23:59:59Z`, limit: 100,
    query: { "eo:cloud_cover": { lt: 60 } }, sortby: [{ field: "properties.datetime", direction: "asc" }] };
  const res = await fetch("https://earth-search.aws.element84.com/v1/search", { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Earth Search returned ${res.status}`);
  const all = ((await res.json()).features || []).filter((x) => x.bbox && x.bbox[0] <= bbox[0] && x.bbox[1] <= bbox[1] && x.bbox[2] >= bbox[2] && x.bbox[3] >= bbox[3]);
  // one tile only (the commonest), so every date is on the same pixels; then the clearest image in each 8-day window
  const n = {}; all.forEach((x) => { const g = x.properties["grid:code"]; n[g] = (n[g] || 0) + 1; });
  const grid = Object.keys(n).sort((a, z) => n[z] - n[a])[0], bins = {};
  all.filter((x) => x.properties["grid:code"] === grid).forEach((x) => {
    const b = Math.floor(Date.parse(x.properties.datetime) / (8 * DAY));
    if (!bins[b] || x.properties["eo:cloud_cover"] < bins[b].properties["eo:cloud_cover"]) bins[b] = x;
  });
  return Object.keys(bins).sort().map((k) => bins[k]).slice(-24);
}

const BANDS = ["nir08", "red", "rededge1", "rededge2", "rededge3", "swir16", "scl"];
function stats(list) {
  const px = list.filter((p) => p.scl === 4 || p.scl === 5);
  if (px.length < 10) return null;
  const nd = (a, b) => (a + b > 0 ? (a - b) / (a + b) : null);
  const ndvi = [], ndre = [], ndmi = [], rep = [], savi = [];
  for (const p of px) {
    const v = nd(p.nir08, p.red), e = nd(p.nir08, p.rededge1), m = nd(p.nir08, p.swir16);
    if (v == null || v < -1 || v > 1) continue;
    ndvi.push(v); if (e != null) ndre.push(e); if (m != null) ndmi.push(m);
    const dd = p.rededge2 - p.rededge1; if (dd > 0.005) { const r = 705 + 35 * ((p.red + p.rededge3) / 2 - p.rededge1) / dd; if (r > 680 && r < 760) rep.push(r); }
    savi.push(1.5 * (p.nir08 - p.red) / (p.nir08 + p.red + 0.5));
  }
  if (ndvi.length < 10) return null;
  const mv = mean(ndvi), sd = Math.sqrt(mean(ndvi.map((x) => (x - mv) ** 2))), sv = mean(savi), re = mean(ndre), r90 = pct(ndre, 0.9);
  return { ndvi: round(mv, 3), ndvi_p10: round(pct(ndvi, 0.1), 3), ndvi_p90: round(pct(ndvi, 0.9), 3), ndvi_cv: round(mv > 0.05 ? sd / mv : null, 3),
    ndre: round(re, 3), ndre_p90: round(r90, 3), n_sufficiency: round(r90 > 0.05 ? re / r90 : null, 3), ndmi: round(mean(ndmi), 3), s2rep_nm: round(mean(rep), 1),
    savi: round(sv, 3), lai: round(sv < 0.68 ? clamp(-Math.log((0.69 - sv) / 0.59) / 0.91, 0, 7) : 7, 2), fvc: round(clamp((mv - 0.15) / 0.75, 0, 1) ** 2, 3) };
}

async function gdd(lat, lon, from, to) {
  const j = await (await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&models=ecmwf_ifs025&timezone=auto` +
    `&start_date=${iso(from)}&end_date=${iso(to)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum`, { headers: UA, signal: AbortSignal.timeout(30000) })).json();
  const d = j.daily || {}, out = []; let acc = 0, rain = 0;
  (d.time || []).forEach((t, i) => {
    const hi = clamp(d.temperature_2m_max[i] ?? 10, 10, 30), lo = clamp(d.temperature_2m_min[i] ?? 10, 10, 30);   // the 86/50 F method in C
    acc += (hi + lo) / 2 - 10; rain += d.precipitation_sum[i] || 0;
    out.push({ date: t, gdd: Math.round(acc), rain: Math.round(rain) });
  });
  return out;
}

const memo = new Map();
module.exports = function fieldhealth({ readBody, send }) {
  async function handleHealth(req, res) {
    let b;
    try { b = JSON.parse(await readBody(req, 400000)); } catch { return send(res, 400, { error: "Bad request." }); }
    const fields = (Array.isArray(b && b.fields) ? b.fields : []).slice(0, 4).map((x) => {
      const ring = G.cleanRing(x && x.ring); if (!ring) return null;
      const f = { id: String(x.id || "").replace(/\W/g, "").slice(0, 20), name: String(x.name || x.id || "field").slice(0, 40), ring, holes: [],
        crop: CROPS[x.crop] ? x.crop : "other", plant: /^\d{4}-\d\d-\d\d$/.test(x.plantDate || "") ? x.plantDate : null, irrigable: !!x.irrigable };
      f.center = G.interiorPoint(f); return f;
    }).filter(Boolean);
    if (!fields.length) return send(res, 400, { error: "No fields to check." });
    const normal = b.normalYield || {}, now = Date.now(), d = new Date(now);
    // growing season starts 1 April (north) or 1 October (south of the equator, 6 months later)
    const south = fields.reduce((s, f) => s + f.center[1], 0) / fields.length < 0, m0 = south ? 8 : 2;
    const seasonYear = d.getUTCMonth() >= m0 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, start = Date.UTC(seasonYear, south ? 9 : 3, 1);
    const key = JSON.stringify([fields.map((f) => [f.ring, f.crop, f.plant]), iso(now)]);
    try {
      if (!memo.has(key)) { const p = run(fields, start, now, seasonYear, normal); memo.set(key, p); p.catch(() => memo.delete(key)); if (memo.size > 50) memo.delete(memo.keys().next().value); }
      send(res, 200, await memo.get(key));
    } catch (e) { send(res, 502, { error: "Could not read the Sentinel-2 images: " + e.message }); }
  }

  async function run(fields, start, now, seasonYear, normal) {
    const lons = fields.flatMap((f) => f.ring.map((p) => p[0])), lats = fields.flatMap((f) => f.ring.map((p) => p[1]));
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
    const items = await searchAll(bbox, start, now);
    const series = {}; fields.forEach((f) => { series[f.id] = []; });
    for (const it of items) {   // a cheap cloud check on the scene classification first, then the six bands where it is clear
      await Promise.all(fields.map(async (f) => {
        const scl = await S.pixels(it, ["scl"], f), clear = scl.list.filter((p) => S.CLEAR.has(p.scl)).length / Math.max(1, scl.list.length);
        if (clear < 0.6) return;
        const st = stats((await S.pixels(it, BANDS, f)).list);
        if (st) series[f.id].push(Object.assign({ date: iso(Date.parse(it.properties.datetime)), clear_pct: Math.round(clear * 100) }, st));
      }));
    }
    const cx = mean(fields.map((f) => f.center[0])), cy = mean(fields.map((f) => f.center[1]));
    const farmKey = `${cy.toFixed(3)}_${cx.toFixed(3)}_${seasonYear}`.replace(/-/g, "m");
    const out = { season: seasonYear, images: items.length, fields: {}, sources: [`Copernicus Sentinel-2 Level-2A, ${items.length} images from ${iso(start)} to ${iso(now)} (Earth Search on AWS), clearest in each 8 days.`] };
    const plants = fields.map((f) => (f.plant ? Date.parse(f.plant) : null)).filter(Boolean), p0 = plants.length ? Math.min(...plants) : start;
    let heat = [];
    try { heat = await gdd(cy, cx, p0, Math.min(now, Date.UTC(seasonYear + (cy < 0 ? 1 : 0), cy < 0 ? 4 : 10, 15))); out.sources.push("Growth stage: growing degree days (base 10 °C) from ECMWF daily temperatures since planting."); } catch { /* stage from the NDVI curve alone */ }
    for (const f of fields) {
      const rows = series[f.id].sort((a, z) => (a.date < z.date ? -1 : 1));
      out.fields[f.id] = analyse(f, rows, heat, normal, now);
      out.fields[f.id].csv = writeCsv(farmKey, f, rows);
      out.fields[f.id].series = rows;
    }
    return out;
  }
  return { handleHealth };
};

// ---------------------------------------------------------------- one field
function analyse(f, rows, heat, normal, now) {
  const C = CROPS[f.crop], o = { name: f.name, crop: f.crop, observations: rows.length, south: f.center[1] < 0 };
  if (rows.length < 3) { o.error = "Fewer than 3 clear Sentinel-2 images this season, so field health cannot be judged yet."; return o; }
  const last = rows[rows.length - 1], peak = rows.reduce((a, r) => (r.ndvi > a.ndvi ? r : a), rows[0]);
  // growth stage: degree days since planting, then the NDVI curve decides harvested or not
  const plantT = f.plant ? Date.parse(f.plant) : null;
  let g = null;
  if (plantT && heat.length) { const h = heat.filter((x) => x.date >= f.plant && x.date <= last.date); g = h.length ? h[h.length - 1].gdd - (heat.find((x) => x.date >= f.plant) || { gdd: 0 }).gdd : null; }
  let stage = g == null ? null : C.stages.filter((s) => g >= s[0]).pop()[1];
  const after = Date.parse(last.date) - Date.parse(peak.date);
  // harvested: back to bare ground a month after the peak, or far below the peak more than ten weeks on (stubble with some weeds or a cover crop)
  const harvested = peak.ndvi > 0.6 && after > 30 * DAY && (last.ndvi < 0.35 || (after > 75 * DAY && last.ndvi < peak.ndvi - 0.3));
  if (harvested) stage = "harvested";
  else if (!stage) stage = peak.ndvi > 0.6 && after > 20 * DAY ? "past peak (maturing)" : last.ndvi > 0.5 ? "growing" : "early or bare";
  o.stage = stage; o.gdd = g; o.peak = { date: peak.date, ndvi: peak.ndvi }; o.latest = last;
  // growth momentum: NDVI change per week over the last three weeks, against the three weeks before
  const t = (r) => Date.parse(r.date) / DAY, lastT = t(last);
  const slope = (a) => { if (a.length < 2) return null; const mx = mean(a.map(t)), my = mean(a.map((r) => r.ndvi)); const num = a.reduce((s, r) => s + (t(r) - mx) * (r.ndvi - my), 0), den = a.reduce((s, r) => s + (t(r) - mx) ** 2, 0); return den ? num / den * 7 : null; };
  const w1 = slope(rows.filter((r) => t(r) >= lastT - 21)), w0 = slope(rows.filter((r) => t(r) < lastT - 21 && t(r) >= lastT - 42));
  o.momentum = { perWeek: round(w1, 3), before: round(w0, 3),
    word: w1 == null ? "not enough recent images" : w1 > 0.03 ? "growing fast" : w1 > 0.005 ? "growing" : w1 > -0.005 ? "steady" : w1 > -0.03 ? "slowing down" : "dropping",
    // when greenness is falling, a rising rate means the drop is easing, not that growth is speeding up
    accel: w1 != null && w0 != null ? (w1 < -0.005
      ? (w1 - w0 > 0.01 ? "the drop is easing" : w1 - w0 < -0.01 ? "the drop is getting faster" : "dropping at about the same pace")
      : (w1 - w0 > 0.01 ? "speeding up" : w1 - w0 < -0.01 ? "slowing" : "about the same pace")) : null };
  // health scores (0-100) from the peak of the season (or now, mid-season)
  const ref = harvested || /past peak|mature|R5|R6|R7/.test(stage) ? peak : last;
  const sc = (x) => (x == null ? null : Math.round(clamp(x, 0, 1) * 100));
  const nRows = rows.filter((r) => Math.abs(t(r) - t(peak)) <= 30 && r.n_sufficiency != null);
  const nsi = nRows.length ? mean(nRows.map((r) => r.n_sufficiency)) : ref.n_sufficiency;
  const integral = rows.reduce((s, r, i) => (i ? s + (r.fvc + rows[i - 1].fvc) / 2 * (t(r) - t(rows[i - 1])) : 0), 0);
  o.health = {
    canopy: { score: sc(ref.ndvi / C.peak), ndvi: ref.ndvi, cover: ref.fvc, lai: ref.lai, coverDays: Math.round(integral) },
    // the best tenth of any field is greener than its average, so 0.9 or more is full marks and 0.75 or less is a clear shortage; soybeans fix their own nitrogen
    nitrogen: f.crop === "soybean" ? { score: null, sufficiency: round(nsi, 2), ndre: ref.ndre, note: "Soybeans fix their own nitrogen." } : { score: sc((nsi - 0.75) / 0.15), sufficiency: round(nsi, 2), ndre: ref.ndre },
    phosphorus: { score: null, note: "Not visible from satellite. Test the soil every 2 to 4 years (Bray or Mehlich-3 P)." },
    moisture: { score: sc((ref.ndmi - C.dryNdmi) / (0.4 - C.dryNdmi)), ndmi: ref.ndmi, latest: last.ndmi },
    leaf: { score: sc((ref.s2rep_nm - 715) / 13), redEdgeNm: ref.s2rep_nm, lai: ref.lai },
    uniformity: { score: sc(1 - (ref.ndvi_cv - 0.05) / 0.25), cv: ref.ndvi_cv, p10: ref.ndvi_p10, p90: ref.ndvi_p90 },
  };
  const H = o.health, v = (k) => (H[k].score == null ? 50 : H[k].score);
  // Health index, 0 to 100: canopy against a healthy crop's peak NDVI for this crop ("normal"), and nitrogen, leaf structure and evenness against the field's own best parts
  o.yieldScore = Math.round(0.35 * v("canopy") + 0.25 * v("nitrogen") + 0.2 * v("moisture") + 0.1 * v("leaf") + 0.1 * v("uniformity"));
  o.healthIndex = o.yieldScore;
  o.qualityScore = Math.round(0.4 * v("nitrogen") + 0.3 * v("moisture") + 0.3 * v("uniformity"));
  const nb = +normal[f.crop];
  if (nb > 0 && (harvested || /past peak|R4|R5|R6|R7|mature|grain|seed fill|pod/.test(stage))) {
    const k = clamp(0.55 + 0.5 * o.yieldScore / 100, 0.4, 1.12), y = nb * k;
    o.yieldEstimate = { bu: Math.round(y), low: Math.round(y * 0.85), high: Math.round(y * 1.15), normal: nb, factor: round(k, 2),
      note: `Rough guide, not yet checked against real harvests. The estimate is the county normal yield (${nb} bu/acre) scaled by the health index (normal times ${round(k, 2)}). The range is a design range (0.85 times to 1.15 times the estimate), not a measured error.` };
  } else o.yieldEstimate = { bu: null, note: nb > 0 ? "Too early in the season to estimate." : "No normal yield for this crop." };
  o.causes = causes(o, C, rows);
  o.advice = advice(o, C, f);
  return o;
}

// root causes: which of the usual suspects the numbers point to, with the evidence
function causes(o, C, rows) {
  const H = o.health, out = [], add = (cause, why, conf) => out.push({ cause, why, confidence: conf });
  if (H.nitrogen.score != null && H.nitrogen.score < 50) add("Nitrogen may be short", `Red-edge index (NDRE) is ${Math.round(H.nitrogen.sufficiency * 100)}% of the field's own best 10%; under about 82% can mean nitrogen is limiting, but this check is only against the field's own best parts and is less reliable early in the season: confirm with a soil nitrate or tissue test.`, "low");
  if (H.moisture.score != null && H.moisture.score < 40) add("Water stress", `Leaf water index (NDMI) was ${H.moisture.ndmi} at the reference date, near the dry line of ${C.dryNdmi}.`, "medium");
  if (H.uniformity.score != null && H.uniformity.score < 50) add("Patchy field", `Greenness varies a lot across the field (spread ${Math.round(H.uniformity.cv * 100)}%; weakest tenth at NDVI ${H.uniformity.p10}, best at ${H.uniformity.p90}). Typical causes: wet or eroded spots, compaction, uneven stand.`, "medium");
  if (H.canopy.score != null && H.canopy.score < 60 && !(H.nitrogen.score < 50) && !(H.moisture.score < 40)) add("Thin canopy without a clear nutrient or water signal", `Peak NDVI ${o.peak.ndvi} against a healthy ${C.peak}. Check stand count, planting date, pests, disease or hail.`, "low");
  // a sudden drop in NDVI between two images before the expected senescence: hail, flooding, lodging or a burn
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], z = rows[i], gap = (Date.parse(z.date) - Date.parse(a.date)) / DAY;
    if (a.ndvi > 0.6 && a.ndvi - z.ndvi > 0.2 && gap <= 16 && z.date < (o.south ? (+o.peak.date.slice(5, 7) >= 7 ? +o.peak.date.slice(0, 4) + 1 : o.peak.date.slice(0, 4)) + "-02-25" : o.peak.date.slice(0, 4) + "-08-25")) { add("Sudden damage", `NDVI fell from ${a.ndvi} to ${z.ndvi} between ${a.date} and ${z.date}, before the crop would normally turn. Hail, flooding, lodging or a fire are the usual causes.`, "medium"); break; }
  }
  if (!out.length) out.push({ cause: "No clear problem in the latest image", why: "Canopy, nitrogen, water and uniformity are all in the healthy range on this season's satellite indices. Weak growth zones from last summer's image, if there are any, are listed separately under Warnings.", confidence: "medium" });
  return out;
}

// prioritised, stage-aware advice in four groups
function advice(o, C, f) {
  const H = o.health, s = o.stage, A = [], add = (topic, priority, text) => A.push({ topic, priority, text });
  const post = s === "harvested" || /mature|R6|R7|past peak/.test(s);
  const nTime = C.nStages.some((x) => s.indexOf(x) >= 0), wTime = C.waterStages.some((x) => s.indexOf(x) >= 0);
  // irrigation
  if (post) add("Irrigation", "low", "Season's water use is over: no irrigation needed.");
  else if (H.moisture.score != null && H.moisture.score < 40) add("Irrigation", wTime ? "high" : "medium", f.irrigable ? `Leaves are short of water (NDMI ${H.moisture.latest})${wTime ? ` at ${s}, when ${C.label} yield is most sensitive` : ""}: apply about 25 mm (1 inch) this week unless rain is forecast.` : `Leaves are short of water (NDMI ${H.moisture.latest}) and the field is not irrigated: avoid extra stress such as late herbicide passes.`);
  else add("Irrigation", "low", "Leaf water is fine: no irrigation needed now.");
  // nutrition
  if (H.nitrogen.score != null && H.nitrogen.score < 50) {
    if (nTime) add("Nutrition", "medium", `Nitrogen may be short at ${s} (NDRE ${Math.round(H.nitrogen.sufficiency * 100)}% of the best part of the field). NDRE against the field's own best 10% cannot see a field that is short of nitrogen everywhere, and it is less reliable early in the season, so treat it as a hint. Check with a soil nitrate or tissue test before side-dressing; if confirmed, 30 to 50 lb N/acre, more where the field is palest.`);
    else if (post) add("Nutrition", "medium", `Nitrogen may have run short this season (${Math.round(H.nitrogen.sufficiency * 100)}% of the field's best). NDRE against the field's own best 10% cannot see a field that is short of nitrogen everywhere, and it is less reliable early in the season, so treat it as a hint. Next season, check the rate with a late-spring nitrate test and split the application.`);
    else add("Nutrition", "medium", `Nitrogen may be short (${Math.round(H.nitrogen.sufficiency * 100)}% of the field's best), past the usual side-dress window. NDRE against the field's own best 10% cannot see a field that is short of nitrogen everywhere, and it is less reliable early in the season, so treat it as a hint. Note the pale zones and confirm with a soil nitrate or tissue test before changing next year's plan.`);
  } else add("Nutrition", "low", f.crop === "soybean" ? "Soybeans fix their own nitrogen; the red edge shows no nitrogen shortage." : "The red edge shows no uneven nitrogen shortage (it cannot see a shortage across the whole field: a soil nitrate or tissue test can).");
  add("Nutrition", post ? "medium" : "low", "Phosphorus and potassium cannot be read from satellite: " + (post ? "now, after harvest, is the time to soil-sample (every 2.5 acres or by zone)." : "rely on your last soil test."));
  // soil moisture
  if (post) add("Soil moisture", "low", "Keep heavy equipment off wet ground this fall to avoid compaction; keep residue or plant a cover crop to hold soil water and topsoil over winter.");
  else if (H.moisture.latest != null && H.moisture.latest > 0.4) add("Soil moisture", "medium", "Leaves show plenty of water; if the ground is saturated, stay off it with heavy machinery.");
  else add("Soil moisture", H.moisture.score < 40 ? "medium" : "low", H.moisture.score < 40 ? "Conserve soil water: no tillage, keep residue on the surface." : "Soil water looks adequate for the crop.");
  // uniformity
  if (H.uniformity.score != null && H.uniformity.score < 50) add("Uniformity", "high", `The field is uneven (NDVI from ${H.uniformity.p10} in the weakest tenth to ${H.uniformity.p90} in the best). Walk the weak areas to find the cause, then manage them as zones: variable-rate seed and nitrogen, drainage for wet spots, erosion control on knolls.`);
  else if (H.uniformity.score != null && H.uniformity.score < 75) add("Uniformity", "medium", "Some unevenness: look at the weak growth zones on the map before deciding next year's rates.");
  else add("Uniformity", "low", "The field is even: one rate across it is fine.");
  const order = { high: 0, medium: 1, low: 2 };
  return A.sort((a, z) => order[a.priority] - order[z.priority]);
}
