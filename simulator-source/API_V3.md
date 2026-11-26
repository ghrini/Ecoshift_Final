# API v3: "combine" round (shared contract)

Three developers work in parallel. Everything in CONTRACT.md and API_V2.md still holds unless changed here.
- MODEL developer owns: src/engine.js, src/data.js, tests/, tools/validate*, VALIDATION.md, DATA_NOTES.md.
- UI developer owns: src/chat.js, src/analysis.js, src/controls.js, src/app.js, src/fieldview.js, src/app.css, src/view.css, src/index.html, build.py.
- ECOSHIFTERS developer owns only the EcoShifters copy (see section 5). Nobody edits another developer's files.

## 1. Planting date (MODEL + UI)
- New control `controls.crops.plantShiftDays`: integer, -21..+21, step 7 (0 = the usual dates), applies to every field and plan. Add to `initialControls` (0).
- Engine: shifts each plan's target planting date (corn 28 Apr, soybean 15 May, rye-delayed plans keep their extra delay) by that many days; the existing wet-soil planting rule, GDD phenology, frost checks and the SOURCED planting-date yield curves (PD_CORN ISU 1997-2000, PD_SOY) then do the rest. No new fitted numbers. Earlier planting must be able to help (earlier maturity, less fall-frost risk) and hurt (spring frost, cold wet soil delay); report what the curves give.
- `summary.why` mentions the shift when it is not 0.

## 2. Weather events (MODEL + UI)
- New control `controls.weather.events`: array (default []) of `{ type: 'dryspell' | 'wetspell' | 'heatwave', month: 1-12, severity: 'moderate' | 'severe' }`. At most 3. Applied to every replayed season, like the temperature and rain sliders.
  - dryspell: that calendar month's rain x0.3 (moderate) or x0 (severe).
  - wetspell: that month's rain x2 (moderate) or x3 (severe).
  - heatwave: days 10-19 of that month Tmax +5 C (moderate) or +8 C (severe), Tmin +2 / +3 C, with ET0 raised the same way the temperature slider does. The model's direct heat damage is not identifiable from the data (VALIDATION.md), so the honest result is mostly extra water use; `summary.why` must say so in plain words when a heatwave is set. Do NOT invent a heat-damage penalty.
- `summary.why` names each event in plain words ("a dry July").

## 3. Season strip (MODEL + UI)
- `FS.engine.seasons(fieldId, controls)` -> `{ fieldId, years: [1982..2025], current: { plan, pct: [], perAcre: [] }, plan: { plan, pct: [], perAcre: [] }, diffPerAcre: [] }`
  - `current` = the field's current plan (`FS.data.initialControls.crops.plans[fieldId]`), `plan` = the plan set in `controls.crops.plans[fieldId]` (may equal current); both under the same controls (shifts, events, planting date, prices). `pct` = yield % of a normal crop per season, `perAcre` = $/acre return per season (null where money is hidden, e.g. oats), `diffPerAcre` = plan minus current (null if hidden).
  - Must take under 50 ms after warm-up (reuse the existing caches).
- UI: a compact row of 44 squares (one per past season) for the selected field, in the Results box under the headline sentence, with a one-line plain caption. If the plan differs from current: colour by `diffPerAcre` (earned more / about the same / less, using the same threshold as "too close to call" or $10/acre); if not: colour by `pct` (good year / normal / bad year). The selected scenario's year is outlined. Clicking a square selects that season (`weather.scenario = 'y' + year`, or the named scenario for that year) and runs. Keyboard accessible; tooltip/aria label "2012: rye then soybeans earned $40 per acre less". No new fonts sizes beyond the existing ones; keep it calm.

## 4. Linking from EcoShifters (UI reads, ECOSHIFTERS writes)
The deep dive is opened as `deep-dive/index.html#<params>` (URL hash, `&`-separated, all optional):
- `from=ecoshifters` -> show a small "← Back to EcoShifters" link in the header (history.back() when there is a same-origin referrer, else `../index.html`), and post a first chat line: "Opened from your EcoShifters brief. This is a demonstration farm in Story County, Iowa, not your field: it shows how the options behave on real Iowa weather and soils."
- `plan=<id>`: one of `rye-soy | rye-corn | corn-corn | soy-soy | oats-cover | corn | soy` -> set it on every field where that plan is valid (data.js `plans[id].after`), and select the first such field.
- `temp=<C>` (number, clamp -2..4, step 0.5), `rain=<pct>` (clamp -50..50, step 5), `priority=balanced|profit|risk|cover`, `season=<year 1982-2025>` (-> named scenario for that year if one exists, else `y<year>`), `costshare=1`, `plant=<days>` (clamp -21..21, round to step 7).
- Unknown or bad values are ignored silently. After applying, run once.

## 5. Copy and labels (UI)
- Footer (one or two lines): "Real NASA POWER weather (1982–2025) and USDA soils · demonstration farm in Story County, Iowa · catches the 1988 and 2012 droughts, no better than the yield trend in ordinary years (see Show details) · part of EcoShifters · supports, not replaces, your judgment."
- Page `<title>`: "EcoShifters Deep Dive · Story County, Iowa".
- Map caption stays "Illustrative field layout · weather and soils are real" (or "Demonstration farm · weather and soils are real").
- build.py also writes `dist/deep-dive.html`: a complete standalone page (doctype, head, the same CSS/JS) WITHOUT the test harness, for GitHub Pages.

## 6. Cleanup (MODEL)
- Remove the unused source entries (imerg, smap, modis, cdl) from `FS.data.sources` if nothing references them.
