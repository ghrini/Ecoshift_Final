// FieldShift farm fitting and 30-day outlook (used by server.js).
// - /api/localfit: fits the nearest county's data to the farm's own point with real data
//   (NASA POWER climatology at both points, NRCS soils at the farm, USDA NASS yields for the farm's own county),
//   then asks Gemini to turn the farmer's answers into small, bounded adjustments.
// - /api/outlook: observed weather since the season began (16 Nov), Open-Meteo's 16-day forecast,
//   and days 17-30 from Open-Meteo's seasonal ensemble (mean of members, with the spread).
// - /api/outlooknote: Gemini writes a short plain-language note from the warnings and the harvest estimate the page computed.
"use strict";

const UA = { "User-Agent": "fieldshift-simulator" };
const T = (ms) => AbortSignal.timeout(ms);
const round = (x, k = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Keeps answers for ttlMs. A failed call is never cached. keep(value) can veto caching a partial answer.
// With stale: true, the last good answer is kept and served (marked stale: true, with its date) when a refresh fails;
// it is retried after a minute, so a throttled service is not hit on every page open.
function cache(ttlMs, { stale = false } = {}) {
  const m = new Map(), last = new Map();
  return (key, make, keep) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    const entry = { t: Date.now(), v: null };
    entry.v = make().then((val) => {
      if (keep && !keep(val) && m.get(key) === entry) m.delete(key);
      if (stale) { last.set(key, { t: Date.now(), val }); if (last.size > 500) last.delete(last.keys().next().value); }
      return val;
    }, (e) => {
      const old = stale && last.get(key);
      if (old) { entry.t = Date.now() - ttlMs + 60e3; return { ...old.val, stale: true, staleDate: new Date(old.t).toISOString() }; }
      if (m.get(key) === entry) m.delete(key);
      throw e;
    });
    m.set(key, entry);
    if (m.size > 500) m.delete(m.keys().next().value);
    return entry.v;
  };
}
const longCache = cache(24 * 3600e3), hourCache = cache(3600e3, { stale: true });

async function getJSON(url, opts = {}, ms = 30000) {
  const res = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: T(ms) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

/* ---------- NASA POWER climatology (monthly means, 2001-2020) ---------- */
function powerClim(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  return longCache("clim" + key, async () => {
    const j = await getJSON("https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,PRECTOTCORR&community=AG" +
      `&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}&format=JSON`);
    const p = j.properties.parameter;
    return { t: MONTHS.map((m) => p.T2M[m]), rain: MONTHS.map((m) => p.PRECTOTCORR[m]) };
  });
}

/* ---------- SoilGrids (ISRIC, 250 m, worldwide): soil water-holding where there is no USDA soil survey ---------- */
// One point (ISRIC asks for at most 5 calls a minute). Water held between field capacity (wv0033) and wilting point (wv1500),
// averaged over 0-150 cm like the USDA aws0150 figure. Drainage is only a rough guess from texture: SoilGrids has no drainage class.
const SG_DEPTHS = [["0-5cm", 50], ["5-15cm", 100], ["15-30cm", 150], ["30-60cm", 300], ["60-100cm", 400], ["100-200cm", 500]];   // mm counted toward 0-150 cm
function soilGrids(lat, lon) {
  return longCache(`sg${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
    const q = SG_DEPTHS.map(([d]) => `&depth=${d}`).join("");
    const j = await getJSON(`https://rest.isric.org/soilgrids/v2.0/properties/query?lon=${lon.toFixed(4)}&lat=${lat.toFixed(4)}&property=wv0033&property=wv1500&property=clay&property=sand${q}&value=mean`, {}, 60000);
    const L = {}; for (const l of j.properties.layers) L[l.name] = Object.fromEntries(l.depths.map((d) => [d.label, d.values.mean]));
    let mm = 0, w = 0, clay = 0, sand = 0, tw = 0;
    for (const [d, th] of SG_DEPTHS) {
      const fc = L.wv0033?.[d], wp = L.wv1500?.[d];
      if (fc != null && wp != null) { mm += Math.max(0, fc - wp) / 1000 * th; w += th; }
      if (L.clay?.[d] != null && L.sand?.[d] != null) { clay += L.clay[d] / 10 * th; sand += L.sand[d] / 10 * th; tw += th; }
    }
    if (w < 500) return null;   // water, built-up land or no data at this point
    const awc = Math.round(mm / w * 1000), c = tw ? clay / tw : null, sd = tw ? sand / tw : null;
    const drainage = c == null ? "Moderately well drained" : c >= 40 ? "Somewhat poorly drained" : sd >= 65 ? "Well drained" : "Moderately well drained";
    return { name: `SoilGrids estimate: ${c == null ? "?" : Math.round(c)}% clay, ${sd == null ? "?" : Math.round(sd)}% sand`, awcMmPerM: clamp(awc, 60, 260),
      drainage, drainageEstimated: true, hydgrp: "", slopePct: 2, point: [round(lon, 5), round(lat, 5)], source: "soilgrids" };
  });
}

/* ---------- NRCS Soil Data Access at the farm's four fields ---------- */
const OFFSETS = { north: [-0.01, 0.01], creek: [0, 0], west: [-0.03, 0.02], south: [0.01, -0.01] };
const NUDGES = [[0, 0], [0.004, 0], [0, 0.004], [-0.004, 0], [0, -0.004], [0.008, 0.008], [-0.008, -0.008], [0.008, -0.008], [-0.008, 0.008], [0.012, 0], [-0.012, 0]];
async function soilAt(lon, lat) {
  const sql = "SELECT mu.muname, ma.aws0150wta, ma.drclassdcd, ma.hydgrpdcd, ma.slopegraddcp " +
    `FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(${lon.toFixed(5)} ${lat.toFixed(5)})') k ` +
    "JOIN mapunit mu ON mu.mukey = k.mukey JOIN muaggatt ma ON ma.mukey = mu.mukey";
  const j = await getJSON("https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest",
    { method: "POST", body: new URLSearchParams({ query: sql, format: "JSON+COLUMNNAME" }) }, 20000);
  const t = j.Table || [];
  if (t.length < 2) return null;
  const r = Object.fromEntries(t[0].map((k, i) => [k, t[1][i]]));
  if (r.aws0150wta == null || r.aws0150wta === "" || !r.drclassdcd) return null;
  // not cropland (towns, water, gravel pits, steep slopes): move to the next nearby point
  if (/urban|water|pits|dam|dumps|made land/i.test(r.muname || "") || Number(r.slopegraddcp) > 18) return null;
  return { name: r.muname, awcMmPerM: Math.round(Number(r.aws0150wta) * 10 / 1.5), aws150cm: Number(r.aws0150wta), drainage: r.drclassdcd,
    hydgrp: r.hydgrpdcd || "", slopePct: Math.round(Number(r.slopegraddcp) || 0), point: [round(lon, 5), round(lat, 5)] };
}
const partial = new WeakSet();   // answers that are missing something because a call failed: not kept for a day
function farmSoils(lat, lon) {
  return longCache(`soil${lat.toFixed(4)},${lon.toFixed(4)}`, async () => {
    const out = {};
    await Promise.all(Object.entries(OFFSETS).map(async ([id, [dlon, dlat]]) => {
      let errors = 0;
      for (const [a, b] of NUDGES) {
        try { const s = await soilAt(lon + dlon + a, lat + dlat + b); if (s) { out[id] = s; return; } }
        catch { if (++errors >= 2) { partial.add(out); return; } }   // the service is struggling: stop after two failed calls for this field
      }
    }));
    return out;
  }, (v) => !partial.has(v));
}

/* ---------- USDA NASS county yields (mean of the last 5 published years) ---------- */
const KEYS = { corn: "CORN, GRAIN - YIELD, MEASURED IN BU / ACRE", soybean: "SOYBEANS - YIELD, MEASURED IN BU / ACRE" };
// NASS spells counties its own way ("O BRIEN", "DE KALB", "ST CLAIR"), so names are compared with apostrophes, periods and spaces removed, and SAINT = ST.
const normCounty = (c) => String(c || "").toUpperCase().replace(/\s+(COUNTY|PARISH)$/, "").replace(/['\u2019.\s]/g, "").replace(/^SAINT/, "ST");
const csvRows = (csv) => csv.split(/\r?\n/).map((l) => l.match(/"([^"]*)"/g)?.map((x) => x.slice(1, -1))).filter(Boolean);
// every county of one state for one crop (about 1000 rows), so the county can be matched by normalised name
function nassState(st, crop) {
  return longCache(`nassst${st}|${crop}`, async () => {
    const form = new URLSearchParams({ source_desc: "SURVEY", short_desc: KEYS[crop], agg_level_desc: "COUNTY", state_name: st, freq_desc: "ANNUAL", reference_period_desc: "YEAR", year__GE: String(new Date().getFullYear() - 12) });
    const res = await fetch("https://quickstats.nass.usda.gov/uuid/encode", { method: "POST", body: form, headers: UA, signal: T(20000) });
    if (!res.ok) throw new Error(`quickstats.nass.usda.gov returned ${res.status}`);
    const uid = (await res.text()).trim().replace(/"/g, "");
    if (!/^[0-9A-F-]{30,}$/i.test(uid)) throw new Error("NASS did not give a query id");
    const r2 = await fetch(`https://quickstats.nass.usda.gov/data/spreadsheet/${uid}.csv`, { headers: UA, signal: T(30000) });
    if (!r2.ok) throw new Error(`quickstats.nass.usda.gov returned ${r2.status}`);
    const [head, ...rows] = csvRows(await r2.text());
    const col = (n) => (head || []).indexOf(n);
    const [cY, cP, cC, cD, cV] = ["Year", "Period", "County", "Domain", "Value"].map(col);
    if ([cY, cP, cC, cD, cV].some((x) => x < 0)) throw new Error("NASS columns changed");
    const byCounty = new Map();
    for (const r of rows) {
      if (r[cP] !== "YEAR" || r[cD] !== "TOTAL") continue;
      const v = Number(String(r[cV]).replace(/,/g, ""));
      if (!isFinite(v)) continue;
      const k = normCounty(r[cC]);
      if (!byCounty.has(k)) byCounty.set(k, {});
      byCounty.get(k)[Number(r[cY])] = v;
    }
    return byCounty;
  });
}
function nassCounty(state, county) {
  const st = String(state || "").toUpperCase().trim(), co = normCounty(county);
  if (!st || !co) return Promise.resolve(null);
  return longCache(`nass${st}|${co}`, async () => {
    const out = {}, res = {};
    await Promise.all(Object.keys(KEYS).map(async (crop) => {
      try {
        const vals = (await nassState(st, crop)).get(co);
        if (!vals) return;
        const yrs = Object.keys(vals).map(Number).sort((a, b) => b - a).slice(0, 5);
        if (yrs.length >= 3) out[crop] = { mean: round(yrs.reduce((s, y) => s + vals[y], 0) / yrs.length), years: yrs.sort() };
      } catch (e) { console.warn("nass:", e.message); partial.add(res); }
    }));
    const r = out.corn || out.soybean ? out : null;
    if (!r && partial.has(res)) throw new Error("NASS did not answer");   // not cached: try again next time
    if (r && partial.has(res)) partial.add(r);
    return r;
  }, (v) => !partial.has(v));
}

/* ---------- county and state for a point (FCC Census Area API; address search often gives only a town) ---------- */
function countyAt(lat, lon) {
  return longCache(`fcc${lat.toFixed(4)},${lon.toFixed(4)}`, async () => {
    const j = await getJSON(`https://geo.fcc.gov/api/census/area?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&censusYear=2020&format=json`, {}, 15000);
    const r = j.results && j.results[0];
    return r ? { county: String(r.county_name || "").replace(/\s+(County|Parish)$/i, ""), state: r.state_name || "" } : null;
  });
}

// The address search gives a two-letter state ("IA"); NASS wants the full name.
const STATES = "AL Alabama,AK Alaska,AZ Arizona,AR Arkansas,CA California,CO Colorado,CT Connecticut,DE Delaware,DC District of Columbia,FL Florida,GA Georgia,HI Hawaii,ID Idaho,IL Illinois,IN Indiana,IA Iowa,KS Kansas,KY Kentucky,LA Louisiana,ME Maine,MD Maryland,MA Massachusetts,MI Michigan,MN Minnesota,MS Mississippi,MO Missouri,MT Montana,NE Nebraska,NV Nevada,NH New Hampshire,NJ New Jersey,NM New Mexico,NY New York,NC North Carolina,ND North Dakota,OH Ohio,OK Oklahoma,OR Oregon,PA Pennsylvania,RI Rhode Island,SC South Carolina,SD South Dakota,TN Tennessee,TX Texas,UT Utah,VT Vermont,VA Virginia,WA Washington,WV West Virginia,WI Wisconsin,WY Wyoming".split(",").reduce((o, x) => { o[x.slice(0, 2)] = x.slice(3); return o; }, {});
const stateName = (s) => { const t = String(s || "").trim(); return t.length === 2 ? STATES[t.toUpperCase()] || "" : t; };

/* ---------- Gemini: answers -> bounded adjustments ---------- */
const FIT_SYSTEM = `You help a crop simulator fit one real farm. The simulator already uses real data for this farm's point: NASA weather corrected from the nearest county, USDA soil survey soils at the farm, and USDA county yields.
Your job: read the farmer's own answers and decide small, conservative adjustments the data cannot see. Never invent measurements.
- tileDrained: true only if the farmer said the land is tile drained.
- drainageClass: if the farmer's answer about drainage clearly contradicts the soil survey, give a USDA drainage class that matches what they said ("Well drained", "Moderately well drained", "Somewhat poorly drained", "Poorly drained"); otherwise "keep".
- awcPct: change to soil water-holding capacity, -15 to +10, only for clear reasons (worn-out, compacted or eroded soil: negative). Usually 0.
- yieldPct: change to the county-average normal yield for corn and soybeans, -10 to +10, only for clear reasons in the answers. Usually 0.
- notes: up to 3 short plain sentences (under 25 words each) telling the farmer what was fitted and why. Say when you changed nothing.
- confidence: low, medium or high.`;
const FIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    tileDrained: { type: "BOOLEAN" },
    drainageClass: { type: "STRING", enum: ["keep", "Well drained", "Moderately well drained", "Somewhat poorly drained", "Poorly drained"] },
    awcPct: { type: "NUMBER" },
    yieldPct: { type: "OBJECT", properties: { corn: { type: "NUMBER" }, soybean: { type: "NUMBER" } }, required: ["corn", "soybean"] },
    notes: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
  },
  required: ["tileDrained", "drainageClass", "awcPct", "yieldPct", "notes", "confidence"],
};

const okLatLon = (lat, lon) => isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
const km = (a, b, c, d) => { const r = Math.PI / 180, h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(h)); };

module.exports = function farmfit({ geminiJSON, hasKey, readBody, send, UserError }) {
  const bodyFail = (res, e) => (e && e.status === 413 ? send(res, 413, { error: "That request is too big." }) : send(res, 400, { error: "Bad request." }));
  async function handleLocalFit(req, res) {
    let b;
    try { b = JSON.parse(await readBody(req, 40_000)); } catch (e) { return bodyFail(res, e); }
    const lat = Number(b.lat), lon = Number(b.lon), site = b.site || {};
    if (!okLatLon(lat, lon) || !okLatLon(Number(site.lat), Number(site.lon))) return send(res, 400, { error: "Missing farm location." });
    const dist = Math.round(km(lat, lon, site.lat, site.lon));
    const sources = [], gaps = [];

    // the farm's own county from the point itself; the search result's county is the fallback
    let fccFailed = false;
    const where = await countyAt(lat, lon).catch(() => { fccFailed = true; return null; });
    let inUS = !!(where && where.county);
    if (inUS) { b.county = where.county; b.state = where.state; }
    else if (fccFailed) {
      // the county service did not answer: that does not mean the farm is outside the US. Use what the address search found.
      b.state = stateName(b.state);
      if (b.county && b.state) { inUS = true; gaps.push(`The county lookup did not answer, so ${b.county} County from your address search is used.`); }
      else gaps.push("The county lookup did not answer, so your county is not known. Soil is still checked at your point.");
    }
    const none = Promise.resolve(null);
    const tryUS = inUS || (fccFailed && !b.county);   // county unknown and lookup down: still try the US soil survey; it finds nothing outside the US
    const [cf, cs, soils, nass] = await Promise.allSettled([powerClim(lat, lon), powerClim(Number(site.lat), Number(site.lon)), tryUS ? farmSoils(lat, lon) : none, inUS ? nassCounty(b.state, b.county) : none]);
    const local = { lat: round(lat, 4), lon: round(lon, 4), label: String(b.label || "").slice(0, 120), siteId: site.id, km: dist, county: b.county || "", state: b.state || "" };

    // Weather: monthly corrections from NASA POWER climatology (farm point minus county point).
    if (cf.status === "fulfilled" && cs.status === "fulfilled") {
      local.tempC = cf.value.t.map((t, i) => round(clamp(t - cs.value.t[i], -8, 8), 2));
      local.rainRatio = cf.value.rain.map((r, i) => round(clamp(cs.value.rain[i] > 0.05 ? r / cs.value.rain[i] : 1, 0.4, 2.5), 3));
      sources.push(`NASA POWER climatology at your farm and at ${site.name || "the county point"} (${dist} km apart): ${site.name || "county"} daily weather is shifted month by month to your spot.`);
    } else gaps.push("NASA POWER climatology did not answer, so the county's weather is used as it is.");

    // Soils: NRCS at the farm's fields (US); SoilGrids at the farm point everywhere else, or if NRCS had nothing.
    if (soils.status === "fulfilled" && soils.value && Object.keys(soils.value).length) {
      local.soils = soils.value;
      sources.push(`USDA NRCS soil survey at ${Object.keys(soils.value).length} points on your farm.`);
    } else {
      // the service is slow at times: one retry; a town centre has no soil, so then tries about 2 and 5 km out
      const sgTry = (la, lo) => soilGrids(la, lo).catch(() => soilGrids(la, lo)).catch((e) => { console.warn("soilgrids:", e.message); return undefined; });
      let sg = await sgTry(lat, lon);
      if (sg === null) sg = await sgTry(lat - 0.015, lon + 0.015);
      if (sg === null) sg = await sgTry(lat + 0.04, lon - 0.05);   // ISRIC allows about 5 calls a minute: three tries at most
      if (sg) {
        local.soils = { north: sg, creek: sg, west: sg, south: sg };
        sources.push(`ISRIC SoilGrids (250 m world soil map) at your farm: ${sg.awcMmPerM} mm of water per metre of soil, ${sg.name.replace("SoilGrids estimate: ", "")}; the same soil is used on all four fields.`);
        gaps.push(`SoilGrids has no drainage class, so "${sg.drainage.toLowerCase()}" is a rough guess from the soil texture, and slope is set to 2%.`);
      } else gaps.push(tryUS ? "No soil survey answer for your point, so the county's soils are used." : "No world soil map answer for your point, so the county's soils are used.");
    }
    if (!inUS && !fccFailed) gaps.push(`Outside the US there are no USDA county yields, so ${site.name || "the nearest county"}'s yields are the yardstick: read the bushels as Corn Belt numbers, not your local yield.`);
    if (lat < 0) gaps.push("The simulator's season runs November to November (a northern-hemisphere calendar), so planting and harvest dates will not match a southern-hemisphere farm.");

    // Yields: NASS for the farm's own county.
    if (nass.status === "fulfilled" && nass.value) {
      local.normalYield = {};
      for (const c of ["corn", "soybean"]) if (nass.value[c]) local.normalYield[c] = nass.value[c].mean;
      const yrs = (nass.value.corn || nass.value.soybean).years;
      sources.push(`USDA NASS yields for ${b.county} County, ${yrs[0]}–${yrs[yrs.length - 1]} average.`);
    } else if (!inUS) { /* said above */ }
    else if (nass.status === "rejected") gaps.push(`The USDA yield service did not answer, so ${site.name || "the nearest county"}'s yields are used.`);
    else if (!b.county) gaps.push("Your county could not be found from the location, so " + (site.name || "the nearest county") + "'s yields are used.");
    else gaps.push(`USDA has no recent corn and soybean yields for ${b.county} County, so ${site.name || "the nearest county"}'s yields are used.`);

    // Gemini: the farmer's own answers -> small, bounded changes.
    let ai = null;
    if (hasKey()) {
      try {
        const facts = { farm: { label: local.label, county: b.county, state: b.state, kmToDataCounty: dist }, dataCounty: site.name,
          soils: local.soils ? Object.fromEntries(Object.entries(local.soils).map(([k, s]) => [k, `${s.name}; ${s.drainage}; ${s.slopePct}% slope; water ${s.awcMmPerM} mm/m`])) : "county soils",
          normalYield: local.normalYield || "county yields", answers: b.answers || {} };
        const out = await geminiJSON(FIT_SYSTEM, JSON.stringify(facts), FIT_SCHEMA);
        ai = {
          tileDrained: out.tileDrained === true && b.answers?.tile === "yes",
          drainageClass: FIT_SCHEMA.properties.drainageClass.enum.includes(out.drainageClass) ? out.drainageClass : "keep",
          awcPct: round(clamp(Number(out.awcPct) || 0, -15, 10), 0),
          yieldPct: { corn: round(clamp(Number(out.yieldPct?.corn) || 0, -10, 10), 0), soybean: round(clamp(Number(out.yieldPct?.soybean) || 0, -10, 10), 0) },
          notes: (Array.isArray(out.notes) ? out.notes : []).slice(0, 3).map((s) => String(s).slice(0, 220)),
          confidence: ["low", "medium", "high"].includes(out.confidence) ? out.confidence : "low",
        };
        local.ai = ai;
      } catch (e) {
        console.error("localfit gemini:", e.message);
        gaps.push(e instanceof UserError ? e.message : "The AI helper could not read your answers just now; only the measured data was fitted.");
      }
    } else gaps.push("The AI helper is off (no key), so only the measured data was fitted.");

    send(res, 200, { local, sources, gaps });
  }

  // Season year Y runs 16 Nov (Y-1) .. 15 Nov Y, the simulator's calendar.
  function seasonStart(today) {
    const y = today.getUTCFullYear(), s = Date.UTC(y, 10, 16);
    return today.getTime() >= s ? s : Date.UTC(y - 1, 10, 16);
  }
  const iso = (t) => new Date(t).toISOString().slice(0, 10);

  async function handleOutlook(req, res) {
    const q = new URL(req.url, "http://x").searchParams, lat = Number(q.get("lat")), lon = Number(q.get("lon"));
    if (!okLatLon(lat, lon) || !q.get("lat") || !q.get("lon")) return send(res, 400, { error: "Missing farm location." });
    try {
      const out = await hourCache(`out${lat.toFixed(2)},${lon.toFixed(2)}`, () => outlook(lat, lon));
      send(res, 200, out);
    } catch (e) {
      console.error("outlook:", e.message);
      send(res, 502, { error: "Couldn't get the weather forecast right now. Try again in a few minutes." });
    }
  }

  async function outlook(lat, lon) {
    const D = "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration";
    const ll = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    const fc = await getJSON(`https://api.open-meteo.com/v1/forecast?${ll}&daily=${D},precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,snowfall_sum&past_days=7&forecast_days=16&timezone=auto`);
    const today = fc.daily.time[7];
    // the season the outlook belongs to is the one that holds tomorrow (on 15 Nov, the season starting 16 Nov)
    const t0 = Date.parse(today + "T00:00:00Z"), start = seasonStart(new Date(t0 + 864e5));
    const day = (j, i) => ({ date: j.daily.time[i], tmax: j.daily.temperature_2m_max[i], tmin: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_sum[i], et0: j.daily.et0_fao_evapotranspiration?.[i] ?? null });

    // Observed since the season began: ERA5 archive up to 8 days ago, then the forecast model's own past week.
    const observed = [];
    const archEnd = t0 - 8 * 864e5;
    let obsGap = null;
    if (archEnd >= start) try {
      const a = await getJSON(`https://archive-api.open-meteo.com/v1/archive?${ll}&start_date=${iso(start)}&end_date=${iso(archEnd)}&daily=${D}&timezone=auto`, {}, 45000);
      a.daily.time.forEach((_, i) => observed.push(day(a, i)));
    } catch (e) { console.warn("archive:", e.message); obsGap = "Weather already past this season was not available; the simulator uses past seasons for those days."; }
    fc.daily.time.forEach((d, i) => { if (i < 7 && Date.parse(d + "T00:00:00Z") >= start) observed.push(day(fc, i)); });

    const forecast = fc.daily.time.slice(7).map((d, k) => {
      const i = k + 7;
      return { ...day(fc, i), rainChance: fc.daily.precipitation_probability_max?.[i] ?? null, wind: fc.daily.wind_speed_10m_max?.[i] ?? null,
        gust: fc.daily.wind_gusts_10m_max?.[i] ?? null, snow: fc.daily.snowfall_sum?.[i] ?? null };
    });

    // Days 17-30: the seasonal ensemble, mean and spread across its members.
    let extended = [], extNote = null;
    try {
      const s = await getJSON(`https://seasonal-api.open-meteo.com/v1/seasonal?${ll}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=45&timezone=auto`, {}, 40000);
      const keys = Object.keys(s.daily);
      const members = (v) => keys.filter((k) => k === v || k.startsWith(v + "_member"));
      const stat = (v, i) => {
        const xs = members(v).map((k) => s.daily[k][i]).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
        if (!xs.length) return [null, null, null];
        const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
        return [xs.reduce((a, b) => a + b, 0) / xs.length, q(0.1), q(0.9)];
      };
      const last = Date.parse(forecast[forecast.length - 1].date + "T00:00:00Z");
      s.daily.time.forEach((d, i) => {
        const t = Date.parse(d + "T00:00:00Z");
        if (t <= last || t > last + 14 * 864e5) return;
        const [tx, tx10, tx90] = stat("temperature_2m_max", i), [tn, tn10, tn90] = stat("temperature_2m_min", i), [p, p10, p90] = stat("precipitation_sum", i);
        extended.push({ date: d, tmax: round(tx), tmin: round(tn), rain: round(p), range: { tmax: [round(tx10), round(tx90)], tmin: [round(tn10), round(tn90)], rain: [round(p10), round(p90)] } });
      });
      extNote = "Open-Meteo seasonal ensemble (mean of its members; the range is the 10th to 90th percentile).";
    } catch (e) {
      console.warn("seasonal:", e.message);
      extNote = "The long-range model did not answer; days 17-30 use the past seasons' normal for these dates.";
    }
    return { today, seasonStart: iso(start), timezone: fc.timezone, observed, forecast, extended, extNote, obsGap,
      sources: ["Open-Meteo forecast (best-match weather models), 16 days", "Open-Meteo ERA5 archive for days already past this season", extNote] };
  }

  const NOTE_SYSTEM = `You write a short weather-and-harvest note for one farmer from a simulator's results. Use only the numbers you are given.
Plain words, short sentences, no hype. summary: 2-3 sentences on what the next 30 days mean for this farm. actions: up to 4 short practical things to do or check, tied to the warnings and the season (for example field work, fall nitrogen timing, cover crop, grain storage, planting). Say plainly that days 17-30 are a rough estimate.`;
  const NOTE_SCHEMA = { type: "OBJECT", properties: { summary: { type: "STRING" }, actions: { type: "ARRAY", items: { type: "STRING" } } }, required: ["summary", "actions"] };
  async function handleOutlookNote(req, res) {
    // no AI key: a normal answer ("off"), not an error, so the page stays quiet
    if (!hasKey()) return send(res, 200, { off: true });
    let b;
    try { b = JSON.parse(await readBody(req, 30_000)); } catch (e) { return bodyFail(res, e); }
    try {
      const out = await geminiJSON(NOTE_SYSTEM, JSON.stringify(b).slice(0, 20000), NOTE_SCHEMA);
      send(res, 200, { summary: String(out.summary || "").slice(0, 600), actions: (out.actions || []).slice(0, 4).map((s) => String(s).slice(0, 200)) });
    } catch (e) {
      console.error("outlooknote:", e.message);
      send(res, 502, { error: e instanceof UserError ? e.message : "The AI helper couldn't write the note just now." });
    }
  }

  // US street addresses with house numbers (the US Census geocoder; it sends no CORS headers, so the page asks through here)
  const tc = (x) => String(x || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  async function handleGeocode(req, res) {
    const q = String(new URL(req.url, "http://x").searchParams.get("q") || "").trim().slice(0, 200);
    if (q.length < 5) return send(res, 400, { error: "Type more of the address." });
    try {
      const out = await longCache(`geo${q.toLowerCase()}`, async () => {
        const j = await getJSON(`https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json`, {}, 12000);
        return ((j.result && j.result.addressMatches) || []).slice(0, 3).map((m) => {
          const c = m.addressComponents || {}, co = m.geographies && m.geographies.Counties && m.geographies.Counties[0];
          const street = tc(m.matchedAddress.split(",")[0]);
          return { lat: m.coordinates.y, lon: m.coordinates.x, label: `${street}, ${tc(c.city)}, ${c.state} ${c.zip || ""}`.trim(), county: co ? co.BASENAME : "", state: c.state || "" };
        });
      });
      send(res, 200, { hits: out });
    } catch (e) {
      console.warn("geocode:", e.message);
      send(res, 502, { error: "The address lookup is not answering right now." });
    }
  }

  return { handleLocalFit, handleOutlook, handleOutlookNote, handleGeocode };
};
// shared with fieldgeo.js (GeoJSON fields): the same soil, county and yield lookups, with the same caches
module.exports.helpers = { soilAt, soilGrids, countyAt, nassCounty, getJSON, okLatLon };
