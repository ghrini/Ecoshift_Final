// FieldShift site server: the EcoShifters server by Shaurya (n-shaurya/nasa-space-apps).
// Changed for the site: static files are served from ./public (the three-tab site), with the
// questionnaire in ./public/app and the Deep Dive simulator in ./public/deepdive. API routes are unchanged.
// EcoShifters local server.
// Serves the web app and the farm-fitting, forecast and farm-map APIs (NASA POWER, USDA, Open-Meteo, Google Gemini).
// The Gemini key lives only here (in .env), never in browser code.
// Run: node server.js   (Node 18+, no npm install needed)

"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8787;
// The key's name is matched without caring about capitals: GEMINI_API_KEY, Gemini_Api, GEMINI_API, Gemini_key, GOOGLE_API_KEY all work.
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ||
  (Object.entries(process.env).find(([k, v]) => v && /^(gemini|google)[_-]?(api([_-]?key)?|key)$/i.test(k)) || [])[1] || "";
// What farmers see when the key is missing; how to fix it is printed in the server log at startup.
const NO_KEY = "The AI helper isn't switched on yet. Ask the person who set up EcoShifters to add its key.";
// The chat endpoints answer farmers with this instead; NO_KEY (admin wording) stays in the server log only.
const NO_KEY_FARMER = "The AI helper is switched off right now. The built-in chat still tests what-ifs and explains your results.";
let noKeyLogged = false;
function noKeyForChat() { if (!noKeyLogged) { noKeyLogged = true; console.warn("[chat] " + NO_KEY); } return NO_KEY_FARMER; }
let geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/* ---------------- .env ---------------- */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

/* ---------------- Gemini ---------------- */
/* ---------------- NASA POWER ---------------- */
// Monthly values for every year since 1981 at the field's point.
// T2M = mean air temp (°C), T2M_MAX = hottest day of the month (monthly max, not the average high), PRECTOTCORR = rain (mm/day),
// GWETROOT = root-zone soil wetness (0 = dry, 1 = saturated).
// T2M_MIN = coldest day of the month. One request per field location, kept while the server runs
// (the brief and the simulator both read it).
const powerCache = new Map();
async function powerMonthly(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!powerCache.has(key)) {
    const end = new Date().getFullYear() - 1;
    const url = "https://power.larc.nasa.gov/api/temporal/monthly/point" +
      `?parameters=T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,GWETROOT&community=AG&latitude=${lat}&longitude=${lon}` +
      `&start=1981&end=${end}&format=JSON`;
    const job = fetch(url, { signal: AbortSignal.timeout(25000) }).then(async (res) => {
      if (!res.ok) throw new Error(`NASA POWER returned ${res.status}`);
      return { end, p: (await res.json()).properties.parameter };
    });
    powerCache.set(key, job);
    job.catch(() => powerCache.delete(key)); // a failed fetch is retried next time
  }
  return powerCache.get(key);
}

async function nasaClimate(lat, lon) {
  const { end, p } = await powerMonthly(lat, lon);

  const val = (param, y, m) => {
    const v = p[param]?.[`${y}${String(m).padStart(2, "0")}`];
    return v == null || v <= -999 ? null : v;
  };
  const mean = (a) => { const b = a.filter((x) => x != null); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Seasons flip south of the equator: summer is Dec–Feb there, and the main growing season Nov–Feb.
  const SUMMER = lat >= 0 ? [6, 7, 8] : [12, 1, 2];
  const GROWING = lat >= 0 ? [5, 6, 7, 8] : [11, 12, 1, 2];
  const years = [];
  for (let y = 1981; y <= end; y++) {
    const rainMm = DAYS.reduce((s, d, i) => { const v = val("PRECTOTCORR", y, i + 1); return v == null ? s : s + v * d; }, 0);
    years.push({
      year: y,
      tempC: r1(val("T2M", y, 13)),
      hottestSummerDayC: (() => { const v = SUMMER.map((m) => val("T2M_MAX", y, m)).filter((x) => x != null); return v.length ? r1(Math.max(...v)) : null; })(),
      rainMm: Math.round(rainMm),
      soilWetness: (() => { const w = mean(GROWING.map((m) => val("GWETROOT", y, m))); return w == null ? null : r1(w * 100); })(), // % in growing season
    });
  }
  const decade = (from, to, key) => r1(mean(years.filter((d) => d.year >= from && d.year <= to).map((d) => d[key])));
  const recent = end - 9;
  // How much yearly rain swings from year to year (standard deviation, mm): bigger = less dependable.
  const spread = (from, to) => {
    const r = years.filter((d) => d.year >= from && d.year <= to).map((d) => d.rainMm);
    const m = mean(r);
    return r.length > 1 ? Math.round(Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1))) : null;
  };
  const byRain = [...years].sort((a, b) => a.rainMm - b.rainMm);
  const byHeat = [...years].sort((a, b) => b.hottestSummerDayC - a.hottestSummerDayC);

  const monthlyNormals = Array.from({ length: 12 }, (_, i) => ({
    month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i],
    tempC: r1(mean(years.map((d) => val("T2M", d.year, i + 1)))),
    rainMm: Math.round(mean(years.map((d) => val("PRECTOTCORR", d.year, i + 1))) * DAYS[i]),
  }));

  return {
    source: "NASA POWER (MERRA-2 / GEOS), monthly, AG community",
    period: `1981–${end}`,
    lat, lon,
    compare: {
      [`avgTempC_1981_1990`]: decade(1981, 1990, "tempC"),
      [`avgTempC_${recent}_${end}`]: decade(recent, end, "tempC"),
      [`hottestSummerDayC_1981_1990`]: decade(1981, 1990, "hottestSummerDayC"),
      [`hottestSummerDayC_${recent}_${end}`]: decade(recent, end, "hottestSummerDayC"),
      [`yearlyRainMm_1981_1990`]: decade(1981, 1990, "rainMm"),
      [`yearlyRainMm_${recent}_${end}`]: decade(recent, end, "rainMm"),
      [`growingSeasonSoilWetnessPct_1981_1990`]: decade(1981, 1990, "soilWetness"),
      [`growingSeasonSoilWetnessPct_${recent}_${end}`]: decade(recent, end, "soilWetness"),
      [`yearlyRainSwingMm_1981_1990`]: spread(1981, 1990),
      [`yearlyRainSwingMm_${recent}_${end}`]: spread(recent, end),
    },
    // The same comparison, shaped for the brief page's NASA table (°C and mm; the page converts units).
    facts: {
      early: "1981–1990", recent: `${recent}–${end}`,
      rows: [
        ["tempC", decade(1981, 1990, "tempC"), decade(recent, end, "tempC")],
        ["hotDayC", decade(1981, 1990, "hottestSummerDayC"), decade(recent, end, "hottestSummerDayC")],
        ["rainMm", decade(1981, 1990, "rainMm"), decade(recent, end, "rainMm")],
        ["swingMm", spread(1981, 1990), spread(recent, end)],
        ["soilPct", decade(1981, 1990, "soilWetness"), decade(recent, end, "soilWetness")],
      ],
      driest: byRain.slice(0, 3).map((d) => d.year),
      hottest: byHeat.slice(0, 3).map((d) => d.year),
    },
    driestYears: byRain.slice(0, 3).map((d) => ({ year: d.year, rainMm: d.rainMm })),
    wettestYears: byRain.slice(-3).reverse().map((d) => ({ year: d.year, rainMm: d.rainMm })),
    hottestSummers: byHeat.slice(0, 3).map((d) => ({ year: d.year, hottestSummerDayC: d.hottestSummerDayC })),
    last5Years: years.slice(-5),
    monthlyNormals,
  };
}

/* ---------------- Gemini ---------------- */
// English page headings; the AI returns them translated in "labels". Keep keys in sync with renderBrief in app.js.
const UI_LABELS = {
  thingsToKnow: "3 things to know", yourOptions: "Your options", currentRotation: "Your current rotation", option: "Option",
  money: "Money", extraWork: "Extra work", tryItSmall: "Try it small", whyWePicked: "Why we picked it",
  good: "Good", watchOut: "Watch out for", dataShows: "What the data shows", dontKnow: "What we don't know",
  advisor: "Check with your farm advisor", weather: "What the weather has been doing on your field",
  source: "Source: NASA satellite and weather records", thisSeason: "What to do this season",
  scoreGood: "Good", scoreOk: "OK", scoreWeak: "Weak",
  testTitle: "Want to test these options?",
  testText: "Replay them through every year since 1981 on your field and see which one holds up in the bad years.",
  testButton: "Go to the simulator →", changeAnswers: "Change my answers", writeAgain: "Write it again",
};

// Crops the simulator has rules for (same English names as the questionnaire). Keep in sync with sim.js.
const SIM_MAIN = [
  "Corn", "Soybeans", "Winter wheat", "Spring wheat", "Cotton", "Sorghum", "Oats", "Barley", "Alfalfa", "Hay / pasture",
  "Peanuts", "Rice", "Sunflower", "Canola", "Dry beans", "Vegetables", "Potatoes", "Sugar beets", "Sugarcane",
  "Pulses (lentils, chickpeas, peas)", "Millet", "Cassava", "Fruit or orchard", "Tobacco", "Fallow", "Other crop",
];
const SIM_COVER = ["None", "Cereal rye (cover)", "Clover (cover)"];

const BRIEF_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    summary: { type: "STRING" },
    climateStory: { type: "ARRAY", items: { type: "STRING" } },
    takeaways: { type: "ARRAY", items: { type: "STRING" } },
    strategies: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          isCurrent: { type: "BOOLEAN" },
          rotation: { type: "STRING" },
          // The same rotation as one entry per year, in English crop names the simulator knows; it repeats this cycle.
          sequence: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { main: { type: "STRING", enum: SIM_MAIN }, cover: { type: "STRING", enum: SIM_COVER } },
              required: ["main", "cover"],
            },
          },
          why: { type: "STRING" },
          scores: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { label: { type: "STRING" }, rating: { type: "STRING", enum: ["High", "Medium", "Low"] } },
              required: ["label", "rating"],
            },
          },
          money: { type: "STRING" },
          extraWork: { type: "STRING" },
          tryItSmall: { type: "STRING" },
          benefits: { type: "ARRAY", items: { type: "STRING" } },
          risks: { type: "ARRAY", items: { type: "STRING" } },
          evidence: { type: "ARRAY", items: { type: "STRING" } },
          gaps: { type: "ARRAY", items: { type: "STRING" } },
          checkWithAdvisor: { type: "STRING" },
        },
        required: ["name", "isCurrent", "rotation", "sequence", "why", "scores", "money", "extraWork", "tryItSmall", "benefits", "risks", "evidence", "gaps", "checkWithAdvisor"],
      },
    },
    nextSteps: { type: "ARRAY", items: { type: "STRING" } },
    disclaimer: { type: "STRING" },
    // Page headings in the farmer's language (English text below is what each one says).
    labels: {
      type: "OBJECT",
      properties: Object.fromEntries(Object.keys(UI_LABELS).map((k) => [k, { type: "STRING" }])),
      required: Object.keys(UI_LABELS),
    },
  },
  required: ["title", "summary", "climateStory", "takeaways", "strategies", "nextSteps", "disclaimer", "labels"],
};

// Published averages from other farms, so money talk is grounded instead of invented.
const REFERENCE = `Reference figures (averages from other farms, not this farm). Name the source in plain words when you use one:
(All from US farms. Per-hectare versions are in brackets: use those when the farmer measures in hectares.)
- Cover crop cost: seed about $10-50 per acre [$25-125 per hectare]; total with planting and killing it, typically about $37 per acre [$91 per hectare] (National Cover Crop Survey, University of Wisconsin summary).
- Cover crop payback over time: about -$31 per acre [-$77 per hectare] in year 1, about break-even by year 3, about +$18 per acre [+$44 per hectare] after 5 years (same source).
- Yield after cover crops: farmers reported on average +3.5 bushels per acre of corn [+220 kg per hectare] and +1.4 bushels per acre of soybeans [+94 kg per hectare] (2026 National Cover Crop Report, farmer-reported).
- Iowa State study (2014-2017 data):
  - Cover crop over winter, THEN SOYBEANS planted in spring: about +$25 per acre [+$62 per hectare].
  - Cover crop over winter, THEN CORN planted in spring: about -$21 per acre [-$52 per hectare] with cost-share, -$46 per acre [-$114 per hectare] without.
- Cost-share: USDA NRCS programs such as EQIP, and many state programs, help pay for cover crops. Most farmers who got payments said they would keep going (2026 National Cover Crop Report).`;

// Every dollar amount the brief may quote: the ones in the reference figures. Anything else is a made-up money claim.
const MONEY_RE = /(?:US)?\$\s?-?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|dólares|dólar|dollars US)\b/giu;
const moneyValue = (s) => Math.abs(parseFloat(s.replace(/[^\d.]/g, "")));
const ALLOWED_MONEY = new Set((REFERENCE.match(MONEY_RE) || []).map(moneyValue));

// Removes sentences that quote a dollar figure not found in the reference figures. Returns how many it removed.
function keepReferenceMoneyOnly(brief) {
  let dropped = 0;
  const clean = (text) => {
    if (typeof text !== "string" || !MONEY_RE.test(text)) return text;
    MONEY_RE.lastIndex = 0;
    const sentences = text.split(/(?<=[.!?。])\s+/);
    const kept = sentences.filter((s) => {
      const ok = (s.match(MONEY_RE) || []).every((m) => ALLOWED_MONEY.has(moneyValue(m)));
      if (!ok) dropped++;
      return ok;
    });
    return kept.join(" ");
  };
  const cleanAny = (v) => (Array.isArray(v) ? v.map(clean).filter((x) => x) : clean(v));
  for (const k of ["summary", "disclaimer", "climateStory", "takeaways", "nextSteps"]) brief[k] = cleanAny(brief[k]);
  for (const s of brief.strategies || []) {
    for (const k of ["why", "extraWork", "tryItSmall", "checkWithAdvisor", "benefits", "risks", "evidence", "gaps"]) s[k] = cleanAny(s[k]);
    const money = clean(s.money);
    s.money = money || (s.money ? "The cost needs a local quote." : s.money);
  }
  MONEY_RE.lastIndex = 0;
  return dropped;
}

// Bump when UI_LABELS change, so briefs saved in browsers with the old headings fall back to the new English ones.
const LABELS_VERSION = 2;

const SYSTEM = `You are EcoShifters, a crop-rotation helper for everyday farmers, built for the NASA Space Apps "Field Shift" challenge.

What the model has been checked against (say exactly this, never more):
- The crop model was checked against 44 years (1982-2025) of USDA NASS Iowa state corn and soybean yields, with NASA POWER weather from one grid cell in Story County, Iowa. Each year was scored with settings fitted without it.
- It catches the big droughts (1988 and 2012 are two of its three worst years) but not their full depth: 1988 real 67% of trend, model 80%; 2012 real 76%, model 80%. It missed the 1993 flood (real 59%, model 84%).
- In ordinary years it is no better than the long-term yield trend (corn correlation 0.48 over all 44 years, 0.27 without 1988 and 2012). Any one season can be off by about 10 points.
- Dollar figures use today's prices and Iowa State University budgets; they are for comparing plans, not forecasts. Oats prices are rough guesses with no source.
- Only one county's weather has been checked; other places are not yet checked against their own harvests.

How farmers want information (follow this):
- Bottom line first. Lead with what to do and what it means for their wallet.
- Money matters most: give the cost per acre and how long until it pays back, using only the reference figures below.
- Say how much extra work and new equipment each option needs; farmers drop tools and practices that don't fit how they already work.
- Offer a low-risk way to try it on one field or a few acres first.
- Talk like a trusted neighbor or local agronomist: short sentences (under 15 words), everyday words, no science terms. Never say "evapotranspiration", "NDVI", "anomaly", "metric" or "resilience". Say "dry spell", "soil holding water", "hard ground".
- Keep it short: 2-3 bullets per list, one idea per bullet.
- Write plainly. No dashes as punctuation (— or –), no filler words (really, just, actually, simply, truly), no hype ("game-changer", "unlock", "powerful"), no "not X, but Y" or "it's not about X" lines, no rhetorical questions. Say the thing directly.
- Use the farmer's own field-size unit. If it is "acres", use °F, inches and acres; if it is "hectares", use °C, millimetres and hectares (convert the reference figures, and say they come from US farms). Round numbers.
- Write every text field in the farmer's "language" (default English), in simple everyday words for that language. Score labels are translated too; only the rating values stay exactly "High", "Medium" or "Low".
- "labels": translate EVERY one of these page headings into the farmer's language, including scoreGood, scoreOk and scoreWeak. Keep them short and plain, with the language's proper accents and punctuation (e.g. Spanish "Su rotación actual", "¿Quiere probar estas opciones?"). For English, copy them unchanged: ${JSON.stringify(UI_LABELS)}

${REFERENCE}

Rules:
- Use ONLY the farmer's answers, the NASA POWER climate summary and the reference figures above. Never invent other numbers, prices, costs, yields or field history. If something is unknown, say so in "gaps".
- Every dollar amount anywhere in the brief (not only in "money") must be one of the reference figures, copied as written. Do not multiply them by the farm size, add them up, or state savings, profit, fertilizer, price or yield-value amounts. Sentences with any other dollar amount are removed before the farmer sees the brief.
- "money": 1-2 sentences on cost per acre and payback for this option, using the reference figures and naming their source; for the current rotation, say it costs nothing new. If no reference figure fits, say the cost needs a local quote. For the Iowa State figures, look at the crop planted right AFTER the cover crop. Example: "Corn, then cover crop, then Soybeans" means soybeans follow the cover, so use the THEN SOYBEANS figure (+$25). "Soybeans, then cover crop, then Corn" uses the THEN CORN figure (-$21 / -$46).
- "extraWork": 1 sentence on added work, timing and equipment.
- "tryItSmall": 1 sentence on how to test it on part of the farm first.
- "sequence": the same rotation as one entry per year (1 to 4 entries), the cycle that repeats. "main" is that year's main crop, "cover" is a cover crop grown after it ("None" if none). Use the farmer's crops by name; a typed crop not in the list is "Other crop". For the current rotation, copy the farmer's known years in order, skipping "Don't remember", "Didn't farm this field that year" and "Not decided yet". A double crop (two harvests in one year) keeps the bigger crop as "main".
- "summary": 2 sentences: the bottom line for this farm.
- Respect every constraint: never suggest crops the farmer won't grow; keep must-keep crops; do not change acres that are already contracted; stay within their budget, water and equipment limits.
- Any answer may be missing (null or empty) or "Not sure": never guess it, and list what would help in "gaps".
- Rotation years marked "Don't remember", "Didn't farm this field that year" or "Not decided yet" are honest gaps, not crops. Work from the years that are known; if none are, say the field's history is unknown and keep advice general.
- Fit the farmer's situation:
  - Renting with a short, handshake or unknown lease: favor options that pay back within a year or two, and suggest talking to the landlord. "Landlord must approve changes" means say so in nextSteps.
  - New to this field: say past results here are unknown, and suggest starting small.
  - Already does no-till or cover crops: build on that; never present it as new.
  - Organic, moving to organic, or no sprayer: never rely on herbicide; end cover crops by mowing, rolling, grazing or winter-kill.
  - Mostly hand work, no tractor, or health/age limits: only suggest work that can be done by hand or with small tools, and keep extra work low.
  - Keeps animals: consider grazing a cover crop or growing feed. "Feed for my animals" or "Food for my family" as a priority means food comes before cash.
  - Soil, slope and drainage: steep or erosion-prone land needs year-round cover; waterlogged or poorly drained fields need crops that tolerate wet roots; sandy soil dries fast; clay holds water and packs down; salty soil limits crop choice. No soil test in 3 years: suggest one as a cheap first step.
  - Cost-share: "Yes" or "Maybe" means point to programs; "I didn't know that existed" means explain in one plain sentence what cost-share is.
  - "wouldTryChangeOn" sets the size of "tryItSmall"; "I'm not ready to change yet" means keep the current rotation first and frame alternatives as ideas for later.
  - No buyer yet, or home use only: weigh food value and local demand over market prices.
- Return exactly 3 strategies. Strategy 1 is the farmer's CURRENT rotation (isCurrent: true), described honestly with its strengths and weaknesses. Strategies 2 and 3 are alternatives (isCurrent: false) that fit their ranked priorities, e.g. adding a cover crop in bare months, a nitrogen-fixing legume, a drought-tolerant crop, or forage if they have livestock.
- Each strategy has exactly these 5 scores, where "High" ALWAYS means better for the farmer: "Money", "Handles bad weather", "Water", "Soil", "Easy to sell". Rate honestly: every option has trade-offs, so no strategy gets "High" on all 5, and alternatives should differ from each other where they really do.
- "evidence" items must point to a specific number from the NASA data or a specific answer the farmer gave.
- Each strategy's "sequence" must differ from the other two (different crops, order or cover crops). Two options that grow the same crops the same way are one option.
- "climateStory": 3 bullets on how this field's temperature, hottest summer day (hottestSummerDayC is the single hottest day of Jun-Aug, not an average), rainfall and soil moisture changed between 1981-1990 and the last decade, plus the worst years. Every bullet quotes the numbers it is based on, from "compare", converted to the farmer's units. Only call a change what the numbers show: a change under 5% (or under 0.5 °C / 1 °F) is "about the same". "yearlyRainSwingMm" is how much yearly rain varies: only say rain got more (or less) uneven or unpredictable if that number went up (or down) by 10% or more.
- "takeaways": exactly 3 short, concrete points.
- "nextSteps": 3 small, low-cost actions the farmer could take this season, such as calling the local NRCS office about cost-share or talking to a neighbor who already does it.
- The tool supports farmer judgment and local experts; it never replaces them. Say this in "disclaimer" in one or two sentences.`;

// True when two options would replay the exact same crops and cover crops.
function repeatsAnOption(brief) {
  const keys = (brief?.strategies || []).map((s) => JSON.stringify((s.sequence || []).map((x) => [x.main, x.cover])));
  return new Set(keys).size < keys.length;
}

function callGemini(payload) {
  return geminiJSON(SYSTEM, "Farm profile and NASA climate data (JSON):\n" + JSON.stringify(payload, null, 1), BRIEF_SCHEMA);
}

// One Gemini call that must answer with JSON matching schema; retries other models when one is busy or retired.
// opts.thinking: let the model think before answering (the chat); opts.model: a different model for this call.
async function geminiJSON(system, userText, schema, opts = {}) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: opts.temperature ?? 0.4 },
  };
  if (opts.thinking) body.generationConfig.thinkingConfig = { thinkingBudget: 4096 };
  const first = opts.model || geminiModel;
  let res = await geminiRequest(first, body);
  if (res.status === 400 && opts.thinking) {
    // A model that cannot take a thinking budget: ask again without it.
    const peek = await res.clone().json().catch(() => ({}));
    if (/thinking/i.test(peek.error?.message || "")) { delete body.generationConfig.thinkingConfig; res = await geminiRequest(first, body); }
  }
  if (res.status === 404 || res.status === 503) {
    // Model retired (404) or overloaded (503): try the next newest Flash-Lite models (fast), up to 2 more.
    const retired = res.status === 404;
    const others = (await listFlashModels()).filter((m) => m !== first).slice(0, 2);
    for (const m of others) {
      console.log(`Gemini model "${geminiModel}" returned ${res.status}; trying "${m}".`);
      res = await geminiRequest(m, body);
      if (res.ok) { if (retired && !opts.model) geminiModel = m; break; } // a busy model stays the default
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    console.error(`Gemini error ${res.status}: ${msg}`); // the details are for whoever runs the server, not for farmers
    if (res.status === 400 && /API key/i.test(msg)) throw new UserError("The AI helper's key isn't working. Ask the person who set up EcoShifters to check it.");
    if (res.status === 429 || res.status === 503) throw new UserError("The AI helper is busy right now. Wait a minute and try again.");
    throw new UserError("The AI helper couldn't answer just now. Try again in a minute.");
  }
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  try { return JSON.parse(text); } catch { throw new UserError("The AI helper's answer came back garbled. Try again."); }
}

async function geminiRequest(model, body) {
  try {
    return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    // An overloaded model can hang instead of answering 503; treat it the same way.
    return new Response(JSON.stringify({ error: { message: `${model} took too long to answer. Try again in a minute.` } }), { status: 503 });
  }
}

async function listFlashModels() {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEMINI_KEY } });
  if (!res.ok) return [];
  const models = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n));
  // Newest version first.
  return models.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

class UserError extends Error {}

// Raw monthly weather for the simulator: years[i][month 0-11] = [mean °C, hottest day °C, coldest day °C, rain mm, soil wetness 0-1].
async function handleClimate(req, res) {
  const q = new URL(req.url, "http://x").searchParams;
  const lat = Number(q.get("lat")), lon = Number(q.get("lon"));
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || q.get("lat") === null || q.get("lon") === null) return send(res, 400, { error: "Missing field location." });
  try {
    const { end, p } = await powerMonthly(lat, lon);
    const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const v = (param, y, m) => { const x = p[param]?.[`${y}${String(m + 1).padStart(2, "0")}`]; return x == null || x <= -999 ? null : x; };
    const years = [];
    for (let y = 1981; y <= end; y++) {
      years.push(Array.from({ length: 12 }, (_, m) => {
        const rain = v("PRECTOTCORR", y, m);
        return [v("T2M", y, m), v("T2M_MAX", y, m), v("T2M_MIN", y, m), rain == null ? null : Math.round(rain * DAYS[m]), v("GWETROOT", y, m)];
      }));
    }
    send(res, 200, { start: 1981, end, lat, lon, years });
  } catch (e) {
    console.error(e);
    send(res, 502, { error: "Couldn't get NASA weather records for this field. Try again in a minute." });
  }
}

async function handleBrief(req, res) {
  if (!GEMINI_KEY) return send(res, 500, { error: NO_KEY });
  const raw = await readBody(req, 100_000);
  let profile;
  try { profile = JSON.parse(raw).profile; } catch { return send(res, 400, { error: "Bad request." }); }
  const lat = Number(profile?.location?.lat), lon = Number(profile?.location?.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return send(res, 400, { error: "Missing field location." });

  let climate = null;
  try { climate = await nasaClimate(lat, lon); }
  catch (e) { console.warn("NASA POWER failed:", e.message); }

  try {
    const nasa = climate ? { ...climate, facts: undefined } : "NASA POWER data unavailable right now; say so in gaps.";
    let brief = await callGemini({ farmer: profile, nasaClimate: nasa });
    // Options that repeat each other give the simulator nothing to compare: ask once more.
    if (repeatsAnOption(brief)) {
      console.log("Brief had two options with the same crops; asking again.");
      const again = await callGemini({ farmer: profile, nasaClimate: nasa, note: "Your previous answer had two options with the same year-by-year crops. Every option's sequence must be different." }).catch(() => null);
      if (again && !repeatsAnOption(again)) brief = again;
    }
    const dropped = keepReferenceMoneyOnly(brief);
    if (dropped) console.log(`Brief: removed ${dropped} sentence(s) with dollar figures not in the reference figures.`);
    send(res, 200, { brief, labelsVersion: LABELS_VERSION, climate: climate && { period: climate.period, lat, lon, facts: climate.facts }, model: geminiModel });
  } catch (e) {
    console.error(e);
    send(res, 502, { error: e instanceof UserError ? e.message : "Couldn't reach the brief service. Check your internet connection." });
  }
}

// The simulator's chat: turns what the farmer says into changes the simulation can apply.
const MONTH = { type: "INTEGER", minimum: 1, maximum: 12 };
const SIMCHAT_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    reset: { type: "BOOLEAN" },
    tempAdd: { type: "NUMBER", nullable: true },
    rainPct: { type: "NUMBER", nullable: true },
    plantShiftDays: { type: "INTEGER", nullable: true },
    monthRain: { type: "ARRAY", items: { type: "OBJECT", properties: { month: MONTH, pct: { type: "NUMBER" } }, required: ["month", "pct"] } },
    irrigation: { type: "ARRAY", items: { type: "OBJECT", properties: { month: MONTH, mm: { type: "NUMBER" } }, required: ["month", "mm"] } },
    events: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["hail", "flood", "heatwave", "frost", "drought"] },
          month: MONTH,
          severity: { type: "STRING", enum: ["light", "moderate", "severe"] },
          year: { type: "INTEGER" },
        },
        required: ["type", "month", "severity", "year"],
      },
    },
    crops: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          option: { type: "INTEGER" }, slot: { type: "INTEGER" },
          main: { type: "STRING", enum: SIM_MAIN }, cover: { type: "STRING", enum: SIM_COVER },
        },
        required: ["option", "slot", "main", "cover"],
      },
    },
    showYear: { type: "INTEGER", nullable: true },
    showOption: { type: "INTEGER", nullable: true },
  },
  required: ["reply", "reset", "monthRain", "irrigation", "events", "crops"],
};

const SIMCHAT_SYSTEM = `You are the EcoShifters field simulation helper. A farmer is looking at a simulation that replays crop-rotation options through every year of real NASA weather on their field, and a day-by-day view of one season. They type what they want to try; you turn it into changes the simulation can apply, and reply in one to three short, plain sentences.

What the model has been checked against (say exactly this, never more):
- The crop model was checked against 44 years (1982-2025) of USDA NASS Iowa state corn and soybean yields, with NASA POWER weather from one grid cell in Story County, Iowa. Each year was scored with settings fitted without it.
- It catches the big droughts (1988 and 2012 are two of its three worst years) but not their full depth: 1988 real 67% of trend, model 80%; 2012 real 76%, model 80%. It missed the 1993 flood (real 59%, model 84%).
- In ordinary years it is no better than the long-term yield trend (corn correlation 0.48 over all 44 years, 0.27 without 1988 and 2012). Any one season can be off by about 10 points.
- Dollar figures use today's prices and Iowa State University budgets; they are for comparing plans, not forecasts. Oats prices are rough guesses with no source.
- Only one county's weather has been checked; other places are not yet checked against their own harvests.

Reply in the farmer's language (given as "language"). Talk like a trusted neighbor: plain sentences, no dashes as punctuation, no filler words (really, just, actually), no exclamation marks. Say what you changed and where to look: name the option by its name (never by a number or index) and give the year. Use the farmer's units in replies: when "unit" is F, say inches and °F and never millimetres or °C (100 mm is about 4 inches); when it is C, say millimetres and °C. The irrigation field itself is always in millimetres. Write every number in your reply as digits (4 inches, never four inches). Never invent numbers, prices or results: the simulation shows results, you don't.

What you can change (leave a field null or an array empty when the farmer didn't ask for it):
- tempAdd: make every year hotter or cooler, in the farmer's unit ("unit": F or C). Sets the hotter slider.
- rainPct: change all rain by a percent (negative = less rain). Sets the rain slider, so -20 means 20% less.
- monthRain: more or less rain in specific months, percent (e.g. {month: 7, pct: 50} = 50% more July rain).
- irrigation: water the farmer adds in a month, in millimetres (convert inches × 25.4; "an inch a week in July" ≈ 100 mm in month 7). Irrigation applies to that month in EVERY year of the replay, so say "every July", never a single year.
- events: weather events. type hail, flood, heatwave, frost or drought; month 1-12; severity light, moderate or severe; year = a specific year from 1981 on, or 0 for every year. If they say "this year" or don't say which year, use the year they are looking at ("selectedYear").
- plantShiftDays: plant earlier (negative) or later (positive), in days, -60 to 60. Applies to every crop in EVERY year of the replay, so never tie it to one year.
- crops: change a crop in an option: option and slot are 0-based indexes into "options" and each option's "sequence"; main must be a crop the simulator knows; cover is None, Cereal rye (cover) or Clover (cover).
- showYear / showOption: jump the view to a year or option (0-based) when it helps them see the change.
- reset: true only when they ask to undo everything or start over.

Months follow the calendar the farmer uses; "spring" in the northern hemisphere is months 3-5, in the southern 9-11 (use "lat").
If they ask for something the simulation can't model (prices, pests, a new machine, fertilizer amounts), change nothing for it and say so kindly in one sentence, pointing to the brief or a local advisor. If they ask a question, answer briefly from the context you're given.`;

async function handleSimChat(req, res) {
  if (!GEMINI_KEY) return send(res, 503, { error: noKeyForChat() });
  let body;
  try { body = JSON.parse(await readBody(req, 60_000)); } catch { return send(res, 400, { error: "Bad request." }); }
  const message = String(body.message || "").slice(0, 800).trim();
  if (!message) return send(res, 400, { error: "Bad request." });
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "farmer", text: String(m.text || "").slice(0, 800) }));
  try {
    const out = await geminiJSON(SIMCHAT_SYSTEM, JSON.stringify({ context: body.context || {}, history, message }), SIMCHAT_SCHEMA);
    send(res, 200, out);
  } catch (e) {
    console.error(e);
    send(res, 502, { error: e instanceof UserError ? e.message : "Couldn't reach the simulation helper." });
  }
}


/* ---------------- HTTP ---------------- */
// Only the app's own web files: no hidden folders (.git, .env, .devcontainer), no server code, no other file types.
// Text files are gzipped once and kept in memory (keyed by path, modified time and size).
const GZIP_TYPES = new Set([".html", ".js", ".css", ".json", ".geojson", ".svg"]);
const gzCache = new Map();
function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, "Bad request"); }
  const file = path.normalize(path.join(PUBLIC, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath));
  const rel = path.relative(PUBLIC, file);
  const hidden = rel.split(path.sep).some((part) => part.startsWith("."));
  const serverOnly = /^(server|farmfit|farmmap|chatai|fieldgeo|fieldlive|fieldsat|fieldhealth|sim\.test)\.js$/i.test(path.basename(file));
  const ext = path.extname(file).toLowerCase();
  if (rel.startsWith("..") || path.isAbsolute(rel) || hidden || serverOnly || !MIME[ext]) return send(res, 404, "Not found");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    fs.readFile(file, (err2, buf) => {
      if (err2) return send(res, 404, "Not found");
      const headers = { "Content-Type": MIME[ext], "Cache-Control": "public, max-age=300", "Vary": "Accept-Encoding", "X-Content-Type-Options": "nosniff" };
      if (GZIP_TYPES.has(ext) && /\bgzip\b/i.test(String(req.headers["accept-encoding"] || "")) && buf.length > 1024) {
        const key = `${file}|${st.mtimeMs}|${st.size}`;
        let gz = gzCache.get(key);
        if (!gz) {
          gz = zlib.gzipSync(buf, { level: 6 });
          if (gzCache.size >= 200) gzCache.delete(gzCache.keys().next().value);
          gzCache.set(key, gz);
        }
        headers["Content-Encoding"] = "gzip"; headers["Content-Length"] = gz.length;
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : gz);
      }
      headers["Content-Length"] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? undefined : buf);
    });
  });
}

// Too big a body gets a 413 (the caller sends it); the extra bytes are dropped and the connection is closed after the reply.
function readBody(req, limit) {
  // On Vercel the platform may hand the body over already read
  if (req.body !== undefined && req.readableEnded) {
    const b = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    return b.length > limit ? Promise.reject(Object.assign(new Error("too big"), { status: 413 })) : Promise.resolve(b);
  }
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on("data", (c) => { size += c.length; if (over) return; if (size > limit) { over = true; reject(Object.assign(new Error("too big"), { status: 413 })); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  if (res.headersSent) return;
  const isJson = typeof body !== "string";
  const headers = { "Content-Type": isJson ? MIME[".json"] : "text/plain; charset=utf-8" };
  if (status === 413) { headers.Connection = "close"; res.on("finish", () => res.req && res.req.destroy()); }
  res.writeHead(status, headers);
  res.end(isJson ? JSON.stringify(body) : body);
}

// Each visitor gets a fair number of AI calls, so a shared link can't run up the key's bill.
const AI_LIMIT = { brief: 8, simchat: 40, localfit: 10, outlooknote: 12, chat: 40, fields: 10, live: 30, health: 10, translate: 120, geocode: 150, farmmap: 20, outlook: 60, climate: 60, all: 600 }; // calls per visitor per 10 minutes; "all" = everyone together
const WINDOW = 10 * 60_000;
// X-Forwarded-For is only believed when TRUST_PROXY says how many proxies of ours sit in front of the server (0 = none: use the socket address).
// With N hops the visitor is the Nth address from the right; anything further left was written by the visitor and can be faked.
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY, 10) || 0);
function clientIp(req) {
  if (process.env.VERCEL && req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  if (TRUST_PROXY > 0) {
    const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (hops.length) return hops[Math.max(0, hops.length - TRUST_PROXY)];
  }
  return req.socket.remoteAddress || "";
}
// NOTE: these counters live in this process's memory. On serverless hosts (Vercel) every instance has its own copy and instances come and go,
// so the limit is per instance there: a soft guard against a runaway page, not a hard quota. Use a shared store if a hard quota is needed.
const aiCalls = new Map(); // "visitor|kind" → recent call times
function overLimit(req, kind) {
  const who = clientIp(req);
  const now = Date.now();
  const recent = (key) => (aiCalls.get(key) || []).filter((t) => now - t < WINDOW);
  const mine = recent(`${who}|${kind}`), everyone = recent("*");
  const shared = !["geocode", "farmmap", "outlook", "climate"].includes(kind);   // address, map, forecast and climate lookups are not AI calls: they do not use the shared AI budget
  if (mine.length >= AI_LIMIT[kind] || (shared && everyone.length >= AI_LIMIT.all)) return true;
  aiCalls.set(`${who}|${kind}`, [...mine, now]);
  if (shared) aiCalls.set("*", [...everyone, now]);
  if (aiCalls.size > 5000) for (const [k, v] of aiCalls) if (!v.some((t) => now - t < WINDOW)) aiCalls.delete(k);
  return false;
}
const FIT = require("./farmfit")({ geminiJSON, hasKey: () => !!GEMINI_KEY, readBody, send, UserError });
const MAP = require("./farmmap")({ send });
const CHAT = require("./chatai")({ geminiJSON, hasKey: () => !!GEMINI_KEY, readBody, send, UserError, noKey: noKeyForChat });
const GEO = require("./fieldgeo")({ readBody, send });
const LIVE = require("./fieldlive")({ readBody, send });
const HEALTH = require("./fieldhealth")({ readBody, send });
const TOO_MANY = { error: "That's a lot of requests in a short time. Wait a few minutes and try again." };
const oops = (res) => (e) => { console.error(e); send(res, 500, { error: "Something went wrong on our side. Try again in a minute." }); };

// A bug in one request must not take the whole demo down: log it and keep serving.
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e && e.stack ? e.stack : e));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e && e.stack ? e.stack : e));

/* ---------------- translation (the farmer's language) ---------------- */
// The page's screen text, and what the farmer types in the chat, in another language. Keyed s0, s1, ... so every string
// comes back in its own slot. Kept while the server runs (and in the farmer's browser), so each sentence is translated once.
const translations = new Map(); // language -> Map(english -> translated)
async function handleTranslate(req, res) {
  if (!GEMINI_KEY) return send(res, 503, { error: NO_KEY });
  let language, strings;
  try { ({ language, strings } = JSON.parse(await readBody(req, 300_000))); } catch (e) { return send(res, e && e.status === 413 ? 413 : 400, { error: "Bad request." }); }
  if (typeof language !== "string" || !language.trim() || language.length > 40 || /[<>{}\n]/.test(language) || !Array.isArray(strings) || !strings.length || strings.length > 200 ||
      !strings.every((x) => typeof x === "string" && x.length <= 1500)) return send(res, 400, { error: "Bad request." });
  language = language.trim();
  if (!translations.has(language)) { if (translations.size >= 30) translations.delete(translations.keys().next().value); translations.set(language, new Map()); }
  const known = translations.get(language);
  const todo = [...new Set(strings.filter((x) => !known.has(x)))];
  if (todo.length) {
    const system = `Translate the screen text of a farm planning app into ${language}, for everyday farmers: short, plain, natural words, with the language's proper accents and punctuation.
Keep exactly as written: numbers, years, dates, units and $ amounts, {placeholders} in curly braces, symbols like → · … and %, the names "EcoShift", "NASA", "NASA POWER", "USDA" and "Gemini", county and state names, and field names such as "North 80", "Creek 40", "West 40" and "South 120".
If a text is already in ${language}, return it unchanged. Return the same keys with translated values.`;
    const batches = [];
    for (let i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));   // a response schema with too many keys is refused
    try {
      await Promise.all(batches.map(async (batch) => {
        const keyed = Object.fromEntries(batch.map((x, i) => [`s${i}`, x]));
        const schema = { type: "OBJECT", properties: Object.fromEntries(Object.keys(keyed).map((k) => [k, { type: "STRING" }])), required: Object.keys(keyed) };
        const out = await geminiJSON(system, JSON.stringify(keyed), schema);
        for (const [k, x] of Object.entries(keyed)) if (typeof out[k] === "string" && out[k].trim()) known.set(x, out[k]);
      }));
      if (known.size > 20000) for (const k of [...known.keys()].slice(0, 5000)) known.delete(k);
    } catch (e) {
      console.error(e);
      return send(res, 502, { error: e instanceof UserError ? e.message : "Couldn't reach the translation service." });
    }
  }
  send(res, 200, { translations: Object.fromEntries(strings.map((x) => [x, known.get(x) || x])) });
}

// One handler for every request. `node server.js` serves it on a port; on Vercel, api/*.js hand their requests to it.
function handle(req, res) {
  if (req.method === "POST" && req.url === "/api/brief") return overLimit(req, "brief") ? send(res, 429, TOO_MANY) : handleBrief(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/climate?")) return overLimit(req, "climate") ? send(res, 429, TOO_MANY) : handleClimate(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/simchat") return overLimit(req, "simchat") ? send(res, 429, TOO_MANY) : handleSimChat(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/localfit") return overLimit(req, "localfit") ? send(res, 429, TOO_MANY) : FIT.handleLocalFit(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/outlook?")) return overLimit(req, "outlook") ? send(res, 429, TOO_MANY) : FIT.handleOutlook(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/farmmap?")) return overLimit(req, "farmmap") ? send(res, 429, TOO_MANY) : MAP.handleFarmMap(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/farmmap/upload") return overLimit(req, "farmmap") ? send(res, 429, TOO_MANY) : MAP.handleUpload(req, res).catch(oops(res));
  if (req.method === "GET" && req.url.startsWith("/api/farmmap/img/")) return MAP.handleImage(req, res);
  if (req.method === "GET" && req.url.startsWith("/api/geocode?")) return overLimit(req, "geocode") ? send(res, 429, TOO_MANY) : FIT.handleGeocode(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/translate") return overLimit(req, "translate") ? send(res, 429, TOO_MANY) : handleTranslate(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/fieldhealth") return overLimit(req, "health") ? send(res, 429, TOO_MANY) : HEALTH.handleHealth(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/liveconditions") return overLimit(req, "live") ? send(res, 429, TOO_MANY) : LIVE.handleLive(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/fieldconditions") return overLimit(req, "fields") ? send(res, 429, TOO_MANY) : GEO.handleFieldConditions(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/chat") return overLimit(req, "chat") ? send(res, 429, TOO_MANY) : CHAT.handleChat(req, res).catch(oops(res));
  if (req.method === "POST" && req.url === "/api/outlooknote") return overLimit(req, "outlooknote") ? send(res, 429, TOO_MANY) : FIT.handleOutlookNote(req, res).catch(oops(res));
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
}
module.exports = { handle };
if (require.main !== module) return;

const server = http.createServer(handle);
server.requestTimeout = 120000;
server.listen(PORT, () => {
  console.log(`EcoShift running at http://localhost:${PORT}`);
  if (TRUST_PROXY) console.log(`Trusting ${TRUST_PROXY} proxy hop(s) for visitor addresses (TRUST_PROXY).`);
  if (GEMINI_KEY) console.log(`Gemini key loaded (model: ${geminiModel}).`);
  else if (process.env.CODESPACES === "true") console.log("No Gemini key yet: add a Codespaces secret named GEMINI_API_KEY for this repository (github.com/settings/codespaces), then rebuild or restart the codespace.");
  else console.log("No Gemini key yet: add GEMINI_API_KEY to .env and restart.");
});
