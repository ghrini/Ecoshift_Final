// /api/liveconditions: what is happening on the fields now, and warnings tied to places on them.
// - Weather now, the past 7 days and the next 3: ECMWF IFS (the European weather model; ECMWF also runs Copernicus) via Open-Meteo.
// - Soil moisture: Copernicus ERA5-Land, the latest day it has (about 5 days behind), next to the ECMWF value for now.
// - Air: Copernicus Atmosphere Monitoring Service (CAMS) via Open-Meteo: fine dust (PM2.5), desert dust, UV index.
// - Soil fertility: ISRIC SoilGrids 250 m (organic carbon, total nitrogen, pH, cation exchange capacity) in the top 30 cm at a point
//   well inside each field. Copernicus has no world soil-fertility map; SoilGrids is the standard open one. These are model estimates.
// - Land cover, ponds and wet ground: ESA WorldCover 2021 (10 m, from Copernicus Sentinel-1 and Sentinel-2) inside each field and
//   150 m around it. Low spots: the Copernicus GLO-30 elevation model.
// - Burned ground, bare soil now and weak growth zones from last summer: Copernicus Sentinel-2 (fieldsat.js).
// - NASA: active-fire detections over each field (VIIRS and MODIS through NASA GIBS, fieldfire.js) confirm or soften the Sentinel-2 burn
//   warning and give a "no fire in the last two weeks" line; NASA POWER (MERRA-2) root-zone and top-soil wetness against its 2001-2025 normal.
// Warnings are plain rules on these numbers (thresholds noted next to each); they point to the place on the field when there is one.
"use strict";

const { helpers: G } = require("./fieldgeo");
const { satellite } = require("./fieldsat");
const { fireCheck } = require("./fieldfire");

const UA = { "User-Agent": "fieldshift-simulator" };
const round = (x, k = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const R = Math.PI / 180;
async function getJSON(url, ms = 30000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}
// small time-limited caches: weather 15 minutes, soil a month
function cache(ms) {
  const m = new Map();
  return (key, make) => {
    const hit = m.get(key); if (hit && Date.now() - hit.t < ms) return hit.p;
    const p = make(); m.set(key, { t: Date.now(), p }); p.catch(() => m.delete(key));
    if (m.size > 300) m.delete(m.keys().next().value);
    return p;
  };
}
const shortC = cache(15 * 60e3), longC = cache(30 * 24 * 3600e3);

function weatherNow(lat, lon) {
  const ll = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`;
  return shortC("wx" + ll, async () => {
    const j = await getJSON(`https://historical-forecast-api.open-meteo.com/v1/forecast?${ll}&models=ecmwf_ifs025&timezone=auto&past_days=7&forecast_days=3` +
      "&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m,soil_moisture_0_to_7cm,soil_temperature_0_to_7cm" +
      "&daily=precipitation_sum,temperature_2m_min,temperature_2m_max,wind_speed_10m_max");
    const c = j.current || {}, d = j.daily || {}, t = d.time || [], today = String(c.time || "").slice(0, 10);
    const sum = (a) => a.reduce((s, x) => s + (+x || 0), 0);
    const past = [], next = [];
    t.forEach((day, i) => { (day < today ? past : day > today ? next : []).push(i); });
    return {
      time: c.time, timezone: j.timezone, tempC: round(c.temperature_2m), rhPct: round(c.relative_humidity_2m, 0), rainNowMm: round(c.precipitation),
      windKmh: round(c.wind_speed_10m, 0), gustKmh: round(c.wind_gusts_10m, 0), soilMoist: round(c.soil_moisture_0_to_7cm, 3), soilTempC: round(c.soil_temperature_0_to_7cm),
      rainPast7Mm: round(sum(past.map((i) => d.precipitation_sum[i]))), rainNext3Mm: round(sum(next.map((i) => d.precipitation_sum[i]))),
      minNext3C: next.length ? round(Math.min(...next.map((i) => d.temperature_2m_min[i]))) : null,
      maxWindNext3Kmh: next.length ? round(Math.max(...next.map((i) => d.wind_speed_10m_max[i])), 0) : null,
    };
  });
}
function era5Soil(lat, lon) {
  const ll = `latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`;
  return shortC("e5" + ll, async () => {
    const end = new Date(), start = new Date(end.getTime() - 14 * 864e5), iso = (d) => d.toISOString().slice(0, 10);
    const j = await getJSON(`https://archive-api.open-meteo.com/v1/archive?${ll}&start_date=${iso(start)}&end_date=${iso(end)}&hourly=soil_moisture_0_to_7cm,soil_moisture_7_to_28cm&models=era5_land`);
    const h = j.hourly || {}, a = h.soil_moisture_0_to_7cm || [];
    let i = a.length - 1; while (i >= 0 && a[i] == null) i--;
    return i < 0 ? null : { time: h.time[i], top7: round(a[i], 3), to28: round(h.soil_moisture_7_to_28cm[i], 3) };
  });
}
// NASA POWER (MERRA-2 model) soil wetness: GWETROOT (root zone, to about 1 m) and GWETTOP (top 5 cm), 0 = dry, 1 = saturated.
// Latest day with a value (the newest ~3 days are -999 = not yet available) against the average of the same 14-day window in 2001-2025.
// The 25-year series is one request, cached 30 days. This is a model, not SMAP or a probe in the ground.
function powerSoil(lat, lon) {
  const q = `longitude=${lon.toFixed(2)}&latitude=${lat.toFixed(2)}&community=AG&format=JSON&parameters=GWETROOT,GWETTOP`;
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const ok = (v) => v != null && v > -900;
  const lastYear = new Date().getUTCFullYear() - 1;
  return shortC("pw" + q, async () => {
    const end = new Date(), start = new Date(end.getTime() - 14 * 864e5);
    const [recent, longJ] = await Promise.all([
      getJSON(`https://power.larc.nasa.gov/api/temporal/daily/point?${q}&start=${ymd(start)}&end=${ymd(end)}`, 12000),
      longC("pwlong" + q + lastYear, () => getJSON(`https://power.larc.nasa.gov/api/temporal/daily/point?${q}&start=20010101&end=${lastYear}1231`, 12000)),
    ]);
    const r = recent.properties.parameter, days = Object.keys(r.GWETROOT || {}).filter((d) => ok(r.GWETROOT[d])).sort();
    if (!days.length) return null;
    const day = days[days.length - 1], t1 = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8));
    const L = longJ.properties.parameter, avg = { GWETROOT: [], GWETTOP: [] };
    for (let y = 2001; y <= lastYear; y++) for (let k = 0; k < 14; k++) {
      const t = new Date(Date.UTC(y, new Date(t1).getUTCMonth(), new Date(t1).getUTCDate() - k)), key = ymd(t);
      for (const p of Object.keys(avg)) if (ok(L[p] && L[p][key])) avg[p].push(L[p][key]);
    }
    const m = (a) => (a.length > 50 ? round(a.reduce((s, x) => s + x, 0) / a.length, 2) : null);
    const w0 = new Date(t1 - 13 * 864e5);
    return { date: `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`, root: round(r.GWETROOT[day], 2), top: ok(r.GWETTOP && r.GWETTOP[day]) ? round(r.GWETTOP[day], 2) : null,
      avgRoot: m(avg.GWETROOT), avgTop: m(avg.GWETTOP), years: `2001-${lastYear}`, window: `${w0.toISOString().slice(5, 10)} to ${new Date(t1).toISOString().slice(5, 10)}` };
  });
}
function airNow(lat, lon) {
  const ll = `latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`;
  return shortC("aq" + ll, async () => {
    const c = (await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${ll}&current=pm2_5,dust,uv_index&timezone=auto`)).current || {};
    return { time: c.time, pm25: round(c.pm2_5), dust: round(c.dust), uv: round(c.uv_index) };
  });
}
// top 30 cm, weighted by layer thickness; SoilGrids stores whole numbers (d_factor) that are divided back here
function fertility(lat, lon) {
  return longC(`sg${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
    const j = await getJSON(`https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}` +
      "&property=soc&property=nitrogen&property=phh2o&property=cec&depth=0-5cm&depth=5-15cm&depth=15-30cm&value=mean", 60000);
    const W = { "0-5cm": 5, "5-15cm": 10, "15-30cm": 15 }, out = {};
    for (const l of j.properties.layers) {
      let s = 0, w = 0;
      for (const d of l.depths) if (d.values.mean != null && W[d.label]) { s += d.values.mean * W[d.label]; w += W[d.label]; }
      out[l.name] = w ? s / w / (l.unit_measure.d_factor || 1) : null;
    }
    if (out.soc == null && out.phh2o == null) return null;   // water or town: no soil
    return { organicCarbonGkg: round(out.soc), nitrogenGkg: round(out.nitrogen, 2), ph: round(out.phh2o), cecCmolKg: round(out.cec) };
  });
}

// which part of the field a point is in ("north-east part"), or which side it is off
function where(f, lon, lat) {
  const b = G.bboxOf(f.ring), fx = (lon - b.x0) / (b.x1 - b.x0 || 1), fy = (lat - b.y0) / (b.y1 - b.y0 || 1);
  const ns = fy > 0.66 ? "north" : fy < 0.33 ? "south" : "", ew = fx > 0.66 ? "east" : fx < 0.33 ? "west" : "";
  const dir = ns && ew ? ns + "-" + ew : ns || ew;
  return dir ? dir : "middle";
}
const acres = (m2) => round(m2 / G.ACRE_M2, m2 < 4000 ? 2 : 1);

const dayList = (a, z) => { const o = []; for (let t = Date.parse(a); t <= Date.parse(z); t += 864e5) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
function warningsFor(f, x, now, e5, month, fire) {
  const W = [], name = f.name || "this field";
  const add = (level, text, at) => { const w = Object.assign({ level, field: f.id, text }, at ? { lon: at.lon, lat: at.lat } : {}); W.push(w); return w; };
  const wet = (now && (now.soilMoist >= 0.38 || now.rainPast7Mm >= 25)) || (e5 && e5.top7 >= 0.4);
  for (const p of (x.cover && x.cover.water) || []) {
    const sz = `about ${acres(p.areaM2)} acres (${p.areaM2.toLocaleString("en-US")} m²)`;
    if (p.kind === "water" && p.inside) add("warn", `Open water, ${sz}, in the ${where(f, p.lon, p.lat)} part of ${name} on the Sentinel satellite land-cover map. Crop there drowns out; keep sprayers, manure and fertiliser back from the water's edge (state setbacks are often 30 to 60 m).`, p);
    else if (p.kind === "water") add("info", `A pond or stream, ${sz}, just off the ${where(f, p.lon, p.lat)} side of ${name}. Runoff and spray drift from this edge reach it: a grass buffer strip along it helps.`, p);
    else if (p.inside) add("warn", `Wet ground (wetland on the satellite map), ${sz}, in the ${where(f, p.lon, p.lat)} part of ${name}. Expect planting delays there in wet springs. In US farm programs, draining or cropping a wetland can break the wetland conservation rules: check with your NRCS office first.`, p);
    else add("info", `Wetland, ${sz}, beside the ${where(f, p.lon, p.lat)} side of ${name}. It holds water in wet spells; keep chemicals back from it.`, p);
  }
  for (const s of (x.terrain && x.terrain.lowSpots) || []) {
    if (s.areaM2 < 1500) continue;
    add(wet ? "warn" : "info", `Low, flat spot of about ${acres(s.areaM2)} acres in the ${where(f, s.lon, s.lat)} part of ${name} (Copernicus elevation model).` +
      (wet ? ` With ${now ? now.rainPast7Mm : "?"} mm of rain in the past week and wet topsoil, water is likely standing there now: keep heavy machinery off to avoid compaction.` : " Water gathers there after heavy rain."), s);
  }
  const sat = x.satellite || {};
  const fd = fire && fire.days || [], sat1 = sat.burn, effects = "Burning crop residue sends most of its nitrogen and sulfur into the air and burns off organic matter, so the soil there is less fertile and bare to wind and water erosion. If it was burned: plan extra nitrogen, test the soil, and next time leave or work in the residue.";
  for (const p of (sat1 && sat1.patches) || []) {
    const sz = `about ${acres(p.areaM2)} acres, in the ${where(f, p.lon, p.lat)} part of ${name}`, win = `between ${sat1.from} and ${sat1.to}`;
    if (fd.length) {
      const names = [...new Set(fd.flatMap((d) => d.sensors))].join(" and ");
      add("warn", `Burned ground, ${sz}, confirmed by fire: NASA ${names} saw active fire over this field on ${fd.map((d) => d.date).join(", ")} (NASA GIBS), and ${win} Sentinel-2 saw the burn ratio drop sharply and the ground turn dark like charred residue. ${effects}`, p);
    } else if (fire && fire.complete && fire.answeredTo && fire.answeredTo >= sat1.to) {
      add("info", `Possible burned ground or bare soil after harvest, ${sz}: ${win} Sentinel-2 saw the burn ratio drop and the ground turn dark. NASA's fire satellites (VIIRS and MODIS maps from NASA GIBS) saw no fire here from ${fire.from} to ${fire.answeredTo}, so this may be harvest, tillage or dark wet soil (a short fire or one under cloud can be missed). Check it on the ground before acting on it.`, p);
    } else {
      add("warn", `Possible burned ground, ${sz}: ${win} Sentinel-2 saw the burn ratio drop sharply and the ground turn dark like charred residue. NASA's fire satellite check could not be completed for those days, so this is not confirmed. ${effects} Check it on the ground first (harvest, fresh tillage or dark wet soil can look alike).`, p);
    }
  }
  const zones = (sat.summer && sat.summer.weakZones) || [];
  zones.slice(0, 2).forEach((z) => { const w = add(z.areaM2 >= 10000 ? "warn" : "info", `Weak growth zone from last summer's image (${sat.summer.date}, not today's crop), about ${acres(z.areaM2)} acres, in the ${where(f, z.lon, z.lat)} part of ${name}: plants there were much less green (NDVI ${z.ndvi}) than the rest of the field (${sat.summer.ndviMedian}). Common causes are low fertility, an eroded knoll, compaction or a wet spot. Soil-test this zone on its own.`, z); w.imageDate = sat.summer.date; });
  if (sat.ground && sat.ground.bareSoilPct >= 60 && (month >= 10 || month <= 4)) add("info", `${name} was ${sat.ground.bareSoilPct}% bare soil on ${sat.ground.date}. Bare soil over winter loses topsoil to wind and water; a cover crop or leaving residue protects it.`);
  const s = x.fertility;
  if (s) {
    if (s.ph != null && s.ph < 5.8) add("warn", `${name}: topsoil pH about ${s.ph} (acidic). Corn and soybeans do best near 6.0 to 7.0; a soil test will say how much lime to spread.`);
    if (s.ph != null && s.ph > 7.6) add("info", `${name}: topsoil pH about ${s.ph} (alkaline, likely limy). Soybeans on high-pH soils can get iron deficiency chlorosis (yellow leaves): choose a tolerant variety.`);
    if (s.organicCarbonGkg != null && s.organicCarbonGkg < 10) add("info", `${name}: low organic matter (about ${s.organicCarbonGkg} g of carbon per kg of topsoil). Cover crops and leaving residue build it up and help the soil hold water.`);
    if (s.cecCmolKg != null && s.cecCmolKg < 10) add("info", `${name}: low nutrient-holding capacity (CEC about ${s.cecCmolKg}), typical of sandy soil. Split nitrogen into smaller doses so less washes out.`);
  }
  return W;
}
function farmWarnings(now, e5, air, month) {
  const W = [], add = (level, text) => W.push({ level, text });
  if (now) {
    if (now.windKmh >= 16) add("warn", `Wind ${now.windKmh} km/h now (gusts ${now.gustKmh}): too windy for most spraying. Many labels allow about 5 to 16 km/h (3 to 10 mph).`);
    else if (now.windKmh != null && now.windKmh < 3) add("info", `Almost no wind (${now.windKmh} km/h): spray can hang in the air and drift on calm, still evenings.`);
    if (now.minNext3C != null && now.minNext3C <= 0 && [4, 5, 6, 9, 10].includes(month)) add("warn", `Frost likely: down to ${now.minNext3C} °C in the next 3 days. Young or late crops can be damaged.`);
    if (now.rhPct >= 90 && now.tempC >= 15 && now.tempC <= 30 && month >= 6 && month <= 9) add("warn", `Humid and warm (${now.rhPct}% humidity, ${now.tempC} °C): good weather for leaf diseases such as gray leaf spot in corn. Scout the lower leaves.`);
    if (now.soilMoist != null && now.soilMoist >= 0.4) add("warn", `Topsoil is very wet (${Math.round(now.soilMoist * 100)}% water by volume): driving on it now compacts the soil.`);
    else if (now.soilMoist != null && now.soilMoist < 0.15 && now.rainPast7Mm < 3) add("info", `Topsoil is dry (${Math.round(now.soilMoist * 100)}% water) with ${now.rainPast7Mm} mm of rain in the past week.`);
    if (now.rainNext3Mm >= 25) add("warn", `${now.rainNext3Mm} mm of rain expected in the next 3 days: hold off on fertiliser and manure that could wash off.`);
  }
  if (air && air.pm25 >= 35) add("warn", `Poor air (fine dust PM2.5 ${air.pm25} µg/m³, Copernicus CAMS): limit long hard work outdoors.`);
  return W;
}

module.exports = function fieldlive({ readBody, send }) {
  async function handleLive(req, res) {
    let b;
    try { b = JSON.parse(await readBody(req, 400000)); } catch (e) { return send(res, 400, { error: "Bad request." }); }
    const fields = (Array.isArray(b && b.fields) ? b.fields : []).slice(0, 4).map((x) => {
      const ring = G.cleanRing(x && x.ring); if (!ring) return null;
      const f = { id: String(x.id || "").replace(/\W/g, "").slice(0, 20), name: String(x.name || "").slice(0, 40), ring, holes: [] };
      f.center = G.interiorPoint(f);
      return f;
    }).filter(Boolean);
    if (!fields.length) return send(res, 400, { error: "No fields to check." });
    const cx = fields.reduce((s, f) => s + f.center[0], 0) / fields.length, cy = fields.reduce((s, f) => s + f.center[1], 0) / fields.length;
    if (fields.some((f) => Math.hypot((f.center[0] - cx) * Math.cos(cy * R), f.center[1] - cy) * 111 > 30)) return send(res, 400, { error: "The fields are more than 30 km apart." });

    const sources = [], gaps = [];
    const [now, e5, air, pw, fnow, ...rest] = await Promise.allSettled([
      weatherNow(cy, cx), era5Soil(cy, cx), airNow(cy, cx), powerSoil(cy, cx), fireCheck(fields, Date.now() - 27 * 864e5, Date.now()),
      ...fields.map((f) => fertility(f.center[1], f.center[0])),
      ...fields.map((f) => G.landCover(f)),
      ...fields.map((f) => G.terrain(f)),
      satellite(fields),
    ]);
    const val = (p, what) => { if (p.status === "fulfilled") return p.value; gaps.push(`${what} did not answer (${p.reason && p.reason.message || "no answer"}).`); return null; };
    const SAT = val(rest.pop(), "Copernicus Sentinel-2 imagery");
    if (SAT) { sources.push(...SAT.sources); gaps.push(...SAT.gaps); }
    const N = fields.length, W = val(now, "The ECMWF weather"), E = val(e5, "Copernicus ERA5-Land soil moisture"), A = val(air, "Copernicus CAMS air quality");
    const m0 = W && W.time ? +W.time.slice(5, 7) : new Date().getMonth() + 1, month = cy < 0 ? (m0 + 5) % 12 + 1 : m0;   // seasons in the southern hemisphere are 6 months apart
    const PW = val(pw, "NASA POWER soil wetness"), FN = val(fnow, "NASA GIBS fire detections");
    // fire over each field while the burn check's two images were taken (only when burned-looking patches were found)
    let FB = null;
    const burns = fields.map((f) => SAT && SAT.fields[f.id] && SAT.fields[f.id].burn).filter((x) => x && x.patches.length);
    if (burns.length) {
      const from = Math.max(Math.min(...burns.map((x) => Date.parse(x.from))), Date.now() - 150 * 864e5), to = Math.max(...burns.map((x) => Date.parse(x.to)));
      try { FB = await fireCheck(fields, Math.max(from, Date.now() - 45 * 864e5), to, 6000); } catch (e) { gaps.push(`NASA fire detections for the burn check did not answer (${e.message}).`); }
      if (FB && FB.skipped) gaps.push("NASA fire check did not answer in time for some of the burn-check days.");
    }
    const out = {}, warnings = farmWarnings(W, E, A, month);
    fields.forEach((f, i) => {
      const x = { name: f.name, center: [round(f.center[0], 5), round(f.center[1], 5)],
        fertility: val(rest[i], `SoilGrids for ${f.name}`), cover: val(rest[N + i], `ESA WorldCover for ${f.name}`), terrain: val(rest[2 * N + i], `the Copernicus elevation model for ${f.name}`), satellite: SAT ? SAT.fields[f.id] : null };
      const bw = x.satellite && x.satellite.burn, ff = FB && bw ? { from: FB.from, to: FB.to, answeredTo: FB.answeredTo, complete: bw.from >= FB.from && dayList(bw.from, bw.to).every((d) => FB.answered.includes(d)), days: FB.fields[f.id].days.filter((d) => d.date >= bw.from && d.date <= bw.to) } : null;
      if (ff) x.satellite.burn.fire = ff;
      out[f.id] = x;
      warnings.push(...warningsFor(f, x, W, E, month, ff));
    });
    // NASA lines: fire detections in the last two weeks, and MERRA-2 soil wetness against its 25-year normal
    const nasa = {};
    if (FN && FN.answeredTo) {
      // the last 14 days NASA has published (its newest days can lag by several days)
      const from = new Date(Date.parse(FN.answeredTo) - 13 * 864e5).toISOString().slice(0, 10), span = 14;
      const recent = (f) => FN.fields[f.id].days.filter((d) => d.date >= from), hits = fields.filter((f) => recent(f).length);
      const lag = FN.sensors.filter((s) => (FN.sensorTo[s] || "") < new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10));
      const miss = dayList(from, FN.answeredTo).filter((d) => !FN.answered.includes(d));
      const late = (miss.length ? ` NASA did not answer in time for ${miss.length} of those days.` : "") + (lag.length ? ` NASA had not yet published the newest maps for ${lag.map((s) => `${s} (latest ${FN.sensorTo[s] || "none"})`).join(", ")}.` : "");
      nasa.fire = { from, to: FN.answeredTo, days: span, sensors: FN.sensors, detections: hits.map((f) => ({ field: f.id, name: f.name, days: recent(f) })) };
      nasa.fire.line = hits.length
        ? `NASA fire satellites (VIIRS/MODIS, via NASA GIBS): fire detected over or within 400 m of ${hits.map((f) => `${f.name || f.id} on ${recent(f).map((d) => d.date).join(", ")}`).join("; ")} (${from} to ${FN.answeredTo}).${late}`
        : `NASA fire satellites (VIIRS/MODIS, via NASA GIBS): no fire detected over these fields in the last ${span} days (${from} to ${FN.answeredTo}).${late}`;
      if (hits.length) warnings.push({ level: "warn", text: nasa.fire.line });
    } else if (FN) gaps.push(FN.skipped || FN.failed ? "NASA fire check did not answer in time." : "NASA GIBS had no fire-detection maps for the last two weeks yet.");
    if (PW) {
      const d = PW.avgRoot == null ? null : PW.root - PW.avgRoot, word = d == null ? "" : d > 0.08 ? "wetter than normal" : d < -0.08 ? "drier than normal" : "close to normal";
      nasa.soil = Object.assign({}, PW, { line: `NASA MERRA-2 model soil wetness (NASA POWER; 0 = dry, 1 = saturated; a model, not SMAP): root zone ${PW.root}` + (PW.top != null ? `, top 5 cm ${PW.top}` : "") + ` on ${PW.date}` +
        (PW.avgRoot != null ? `, against an average of ${PW.avgRoot}` + (PW.avgTop != null ? ` (top ${PW.avgTop})` : "") + ` for ${PW.window} in ${PW.years}: ${word}.` : ".") });
    }
    if (W) sources.push(`Weather now, the past 7 days and the next 3: ECMWF IFS model (via Open-Meteo), ${W.time} ${W.timezone || ""}.`);
    if (E) sources.push(`Soil moisture: Copernicus ERA5-Land, latest day available (${E.time.slice(0, 10)}).`);
    if (A) sources.push("Air: Copernicus Atmosphere Monitoring Service (CAMS).");
    if (nasa.soil) sources.push(`Soil wetness: NASA POWER (MERRA-2 model), latest day ${nasa.soil.date}, against ${nasa.soil.years}.`);
    if (nasa.fire || FB) sources.push("Fire detections: NASA GIBS (VIIRS Suomi NPP and NOAA-20 375 m, MODIS Terra and Aqua 1 km; the same detections as NASA FIRMS), over each field plus 400 m.");
    if (fields.some((f) => out[f.id].fertility)) sources.push("Soil fertility: ISRIC SoilGrids 250 m model estimates for the top 30 cm (a soil test on the field is more exact).");
    if (fields.some((f) => out[f.id].cover)) sources.push("Ponds, wet ground and land cover: ESA WorldCover 2021, 10 m, made from Copernicus Sentinel-1 and Sentinel-2.");
    if (fields.some((f) => out[f.id].terrain)) sources.push("Low spots: Copernicus GLO-30 elevation model.");
    const order = { warn: 0, info: 1 };
    warnings.sort((a, z) => order[a.level] - order[z.level]);
    send(res, 200, { checkedAt: new Date().toISOString(), center: [round(cx, 5), round(cy, 5)], now: W, era5Soil: E, nasa, air: A, fields: out, warnings, sources, gaps, approximate: !!b.approximate });
  }
  return { handleLive };
};
