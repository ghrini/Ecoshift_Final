// Evidence levels and the soil-health evidence layer, shared by fieldhealth.js and fieldlive.js (the page reads them from the JSON).
// Every score, finding, warning, likely cause and piece of advice carries one of five levels, so an inferred condition is never
// shown as a confirmed diagnosis:
//   measured              a direct reading: a station or probe, or the farmer's own soil test or field count
//   satellite_indicator   something a satellite sees (a vegetation index, bare soil, a fire detection, a height map); a proxy, not a diagnosis
//   model_estimate        computed by a model or map: weather and soil-moisture reanalysis (ECMWF, ERA5-Land, MERRA-2), SoilGrids, soil survey maps, our scoring rules
//   possible_explanation  one of several things that could produce what the satellite sees
//   verify_in_field       a recommendation that depends on an inference: look or test first
// Soil values from the farmer's own soil test are "measured"; mapped values (SoilGrids 250 m, USDA NRCS soil survey) are "model_estimate".
"use strict";

const LEVELS = {
  measured: { label: "Measured", meaning: "A direct reading, such as a weather station, a probe or your own soil test." },
  satellite_indicator: { label: "Satellite Indicator", meaning: "Something a satellite sees (greenness, red edge, bare soil, fire). It is a clue, not a diagnosis." },
  model_estimate: { label: "Model Estimate", meaning: "Worked out by a model or a map (weather models, SoilGrids, soil survey) or by a scoring rule. Not measured on this field." },
  possible_explanation: { label: "Possible Explanation", meaning: "One of several things that could explain what the satellite sees. Not confirmed." },
  verify_in_field: { label: "Check In The Field", meaning: "A recommendation that depends on an inference: look at the field or test first." },
};
const LEVEL_KEYS = Object.keys(LEVELS);

const round = (x, k = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const num = (v, lo, hi) => { const x = typeof v === "string" && v.trim() === "" ? NaN : +v; return isFinite(x) && x >= lo && x <= hi ? x : null; };

// the farmer's own soil test, as sent by the page (kept in the browser, never stored here): cleaned and range-checked
function cleanSoilTest(x) {
  if (!x || typeof x !== "object") return null;
  const date = /^\d{4}-\d\d-\d\d$/.test(x.date || "") && Date.parse(x.date) <= Date.now() + 864e5 ? x.date : null;
  const t = {
    date, om: num(x.om, 0, 30), ph: num(x.ph, 3, 10), pPpm: num(x.pPpm, 0, 600), pMethod: ["bray1", "mehlich3", "olsen", "other"].includes(x.pMethod) ? x.pMethod : null,
    kPpm: num(x.kPpm, 0, 2000), no3Ppm: num(x.no3Ppm, 0, 400), infiltrationMin: num(x.infiltrationMin, 0, 600), earthworms: num(x.earthworms, 0, 1000),
    notes: typeof x.notes === "string" ? x.notes.replace(/[<>]/g, "").slice(0, 240) : "",
  };
  return t.om == null && t.ph == null && t.pPpm == null && t.kPpm == null && t.no3Ppm == null && t.infiltrationMin == null && t.earthworms == null ? null : t;
}

// Iowa State University categories (PM 1688, A General Guide for Crop Nutrient and Limestone Recommendations in Iowa): corn and soybeans,
// top 6 inches. Other states and labs use other lines, so these are a guide: the lab's own rating comes first.
const P_CLASSES = { bray1: [8, 15, 20, 30], mehlich3: [8, 15, 20, 30], olsen: [3, 8, 15, 20] };   // upper edge of very low, low, optimum, high (ppm)
const K_CLASSES = [90, 130, 170, 200];
const CLASS_NAMES = ["very low", "low", "optimum", "high", "very high"];
const classOf = (v, edges) => { let i = 0; while (i < edges.length && v > edges[i]) i++; return CLASS_NAMES[i]; };
const METHOD_NAME = { bray1: "Bray-1", mehlich3: "Mehlich-3", olsen: "Olsen", other: "an unlisted method" };
const when = (t) => (t.date ? ` (${t.date})` : "");

// what the farmer's soil test says, in plain words. Each item is "measured" (the value is) and says what the lab or an agronomist should confirm.
function interpretSoilTest(t, crop) {
  if (!t) return [];
  const out = [], add = (key, text, action) => out.push({ key, evidence: "measured", basis: `your soil test${when(t)}`, text, action });
  if (t.ph != null) {
    if (t.ph < 5.8) add("ph", `pH ${t.ph} is acidic (corn and soybeans do best near 6.0 to 7.0).`, "Lime is likely worth it: ask the lab for the lime requirement (buffer pH) and check the lime's neutralising value before ordering.");
    else if (t.ph < 6.0) add("ph", `pH ${t.ph} is a little under the 6.0 to 7.0 target.`, "Watch it: retest next year, and lime if it keeps falling.");
    else if (t.ph > 7.6) add("ph", `pH ${t.ph} is alkaline.`, "Do not lime. Soybeans can show iron chlorosis (yellow leaves) on high-pH soil: choose a tolerant variety.");
    else add("ph", `pH ${t.ph} is in the 6.0 to 7.6 range.`, "No lime needed on this reading.");
  }
  if (t.om != null) add("om", `Organic matter ${t.om}%.`, "Compare it with the same spot next time, by the same lab: organic matter changes slowly (a few tenths of a percent over years), so one test cannot show a trend.");
  if (t.pPpm != null) {
    const m = t.pMethod || "other", edges = P_CLASSES[m];
    if (edges) {
      const c = classOf(t.pPpm, edges), low = c === "very low" || c === "low";
      add("p", `Phosphorus ${t.pPpm} ppm by ${METHOD_NAME[m]} is ${c} on Iowa State's scale for corn and soybeans.`, low ? "Phosphorus is likely limiting: apply more than the crop removes, at a rate from your lab or agronomist." : c === "optimum" ? "Replace what the crop removes (maintenance rate)." : "No phosphorus fertiliser is needed on this reading.");
    } else add("p", `Phosphorus ${t.pPpm} ppm (method not listed).`, "Ask the lab how to rate it: values from different methods cannot be compared.");
  }
  if (t.kPpm != null) {
    const c = classOf(t.kPpm, K_CLASSES), low = c === "very low" || c === "low";
    add("k", `Potassium ${t.kPpm} ppm is ${c} on Iowa State's scale (dry soil, 6 inches).`, low ? "Potassium is likely limiting: apply more than the crop removes, at a rate from your lab or agronomist." : c === "optimum" ? "Replace what the crop removes (maintenance rate)." : "No potassium fertiliser is needed on this reading.");
  }
  if (t.no3Ppm != null) {
    const mo = t.date ? +t.date.slice(5, 7) : null, lsnt = mo === 5 || mo === 6;
    add("no3", `Nitrate-N ${t.no3Ppm} ppm.`, lsnt && /corn/.test(crop || "corn") ? (t.no3Ppm >= 25 ? "At or above Iowa State's 25 ppm line for the late-spring nitrate test: little extra nitrogen is likely needed for corn." : "Below Iowa State's 25 ppm line for the late-spring nitrate test: corn is likely to need more nitrogen. Confirm the sampling depth (12 inches) and timing (corn 6 to 12 inches tall).")
      : "Nitrate moves with water, so it only means something against the date and depth it was taken. Iowa State's 25 ppm line applies to a 12-inch late-spring sample in corn.");
  }
  return out;
}

// The soil-health rows for one field: what is mapped, what a satellite sees, what needs a soil test or a look at the field.
// survey: { name, awcMmPerM, drainage, hydgrp, source } from the farm setup (USDA NRCS soil survey, or SoilGrids where the survey has nothing).
function soilRows(x, survey) {
  const s = x.fertility || null, t = x.terrain || null, g = x.satellite && x.satellite.ground || null, rows = [];
  const SG = "ISRIC SoilGrids 250 m (top 30 cm, model)", row = (key, label, value, evidence, source, note, need, extra) => rows.push(Object.assign({ key, label, value, evidence, source, note: note || "", need: need || null }, extra || {}));
  const om = s && s.organicCarbonGkg != null ? round(s.organicCarbonGkg * 1.724 / 10, 1) : null;   // organic matter % = organic carbon % x 1.724 (Van Bemmelen factor)
  if (om != null) row("om", "Organic Carbon / Organic Matter", `${s.organicCarbonGkg} g/kg carbon, about ${om}% organic matter`, "model_estimate", SG, "Mapped at 250 m, so it can be well off on one field. Organic matter changes slowly: a soil test is the only way to see it.", "Needs A Soil Test", { organicMatterPct: om });
  else row("om", "Organic Carbon / Organic Matter", null, "verify_in_field", "no map value", "", "Needs A Soil Test");
  row("ph", "pH", s && s.ph != null ? String(s.ph) : null, s && s.ph != null ? "model_estimate" : "verify_in_field", s && s.ph != null ? SG : "no map value", "Decide on lime from a soil test, not from a map.", s && s.ph != null ? "Needs A Soil Test" : "Needs A Soil Test");
  row("n", "Nitrogen", s && s.nitrogenGkg != null ? `${s.nitrogenGkg} g/kg total nitrogen` : null, s && s.nitrogenGkg != null ? "model_estimate" : "verify_in_field", s && s.nitrogenGkg != null ? SG : "no map value",
    "Total nitrogen is mostly locked in organic matter. What the crop can use is nitrate and ammonium, which change week to week.", "Needs A Soil Test (nitrate-N)");
  row("p", "Phosphorus", null, "verify_in_field", "not visible from satellites or on a map", "No dependable map or satellite reading exists.", "Needs A Soil Test");
  row("k", "Potassium", null, "verify_in_field", "not visible from satellites or on a map", "No dependable map or satellite reading exists.", "Needs A Soil Test");
  row("cec", "CEC (Nutrient-Holding Capacity)", s && s.cecCmolKg != null ? `${s.cecCmolKg} cmol/kg` : null, s && s.cecCmolKg != null ? "model_estimate" : "verify_in_field", s && s.cecCmolKg != null ? SG : "no map value", "Mapped at 250 m; a lab reports the real figure.", "Needs A Soil Test");
  const sv = survey && survey.awcMmPerM > 0 ? survey : null, svSrc = sv ? (sv.source === "soilgrids" ? "ISRIC SoilGrids 250 m (model, from clay and sand)" : "USDA NRCS soil survey (mapped soil unit)") : null;
  if (sv) row("whc", "Water-Holding Capacity", `${Math.round(sv.awcMmPerM)} mm of plant-available water per m (about ${round(sv.awcMmPerM / 83.3, 1)} in per ft)`, "model_estimate", svSrc, `${sv.name || "Mapped soil"}. A mapped average for the soil unit, not measured on this field.`, "Field Observation Needed (dig and feel the soil, or a lab test)");
  else row("whc", "Water-Holding Capacity", null, "verify_in_field", "no soil survey value", "", "Needs A Soil Test");
  if (t && t.slopePct != null) {
    const sp = t.slopePct, cls = sp < 2 ? "low" : sp < 5 ? "moderate" : sp < 9 ? "high" : "very high";
    row("erosion", "Erosion Risk", `${cls} by slope: mean slope ${sp}%${t.steepSharePct != null ? `, ${t.steepSharePct}% of the field steeper than 6%` : ""}`, "satellite_indicator", "Copernicus GLO-30 elevation model (satellite radar), slope on a 30 m grid",
      "Slope alone sets this rating. Soil type, rain, residue and cover also matter, and no satellite measures soil lost.", "Field Observation Needed (look for rills, gullies, pale knolls and silt at the field edge)", { slopePct: sp });
  } else row("erosion", "Erosion Risk", null, "verify_in_field", "no elevation value", "", "Field Observation Needed");
  if (g && g.bareSoilPct != null) row("cover", "Cover", `${g.bareSoilPct}% bare soil, ${g.plantsPct != null ? g.plantsPct + "% plants, " : ""}on ${g.date}`, "satellite_indicator", "Copernicus Sentinel-2 scene classification, 20 m",
    "One clear day only. Crop residue can read as bare soil, so walk the field to see what covers it.", "Field Observation Needed (residue cover: line-transect or photo)", { bareSoilPct: g.bareSoilPct });
  else row("cover", "Cover", null, "verify_in_field", "no clear Sentinel-2 image in the last 60 days", "", "Field Observation Needed");
  if (sv && sv.hydgrp) row("infiltration", "Infiltration / Structure", `NRCS runoff group ${sv.hydgrp} (a group C or D soil takes water in slowly when wet)`, "model_estimate", "USDA NRCS soil survey (mapped group)", "A mapped class, not a measured rate. Structure (crumbly or cloddy, compaction) cannot be seen from orbit.", "Field Observation Needed (infiltration ring time, spade test)");
  else row("infiltration", "Infiltration / Structure", null, "verify_in_field", "not visible from satellites or on a map", "Structure and water intake have to be looked at in the field.", "Field Observation Needed (infiltration ring time, spade test)");
  row("bio", "Biological Activity", null, "verify_in_field", "not visible from satellites or on a map", "Earthworms, root channels and how fast residue breaks down are seen in the field.", "Field Observation Needed (earthworm count, residue breakdown)");
  return rows;
}

module.exports = { LEVELS, LEVEL_KEYS, cleanSoilTest, interpretSoilTest, soilRows, legend: () => LEVEL_KEYS.map((k) => ({ level: k, label: LEVELS[k].label, meaning: LEVELS[k].meaning })) };
