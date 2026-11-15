# API v4: "one simulator" round (shared contract)

Goal: the Field Shift simulator becomes the single tool, with the best of EcoShifters folded in: the farmer sets up their farm (location, fields, crops, priorities), can irrigate, and option cards read like EcoShifters' brief. EcoShifters' own monthly replay is removed and its "simulator" step opens this one. CONTRACT.md, API_V2.md and API_V3.md still hold unless changed here.

Developers and ownership (nobody edits another developer's files):
- DATA: tools/build_sites.py (new), raw/sites/** (+ hashes appended to raw/HASHES.txt), src/sites.js (new, generated), DATA_NOTES.md section "Locations".
- MODEL: src/engine.js, src/data.js, tests/, tools/validate*, VALIDATION.md.
- UI: src/chat.js, src/analysis.js, src/controls.js, src/app.js, src/fieldview.js, src/app.css, src/view.css, src/index.html, build.py, verify/qa2/chat_test.js.
- ECOSHIFTERS: only the EcoShifters copy (scratchpad/combined/nasa-space-apps), never deep-dive/.

## 1. Locations (DATA -> MODEL)
`src/sites.js` (loaded right after climate.js) sets `FS.data.sites` = array, Story County first:
```
{ id: 'story-ia', name: 'Story County, Iowa', short: 'Story Co., IA', state: 'IA', lat, lon,
  validated: true,                 // only Story County was checked against USDA yields
  climate: null,                   // null = use FS.data.climate (already loaded); others: same structure as FS.data.climate ({meta, seasons})
  soils: { north: {...}, creek: {...}, west: {...}, south: {...} },   // same fields as data.js field.soil: name, awcMmPerM, aws150cm, drainage, hydgrp, slopePct, point
  normalYield: { corn, soybean },  // bu/acre: USDA NASS county average 2020-2024 (Story: keep the ISU budget 211 / 61 already in data.js economics)
  source: { power, nrcs, nass }    // short provenance strings
}
```
Seven more rainfed Corn Belt counties (real NASA POWER daily 1981-2025, same parameters and processing as tools/build_data.py, real NRCS soils at 4 farmland points about 1-3 km apart, real NASS county yields): O'Brien County IA, Champaign County IL, Tippecanoe County IN, Blue Earth County MN, Saunders County NE, Brookings County SD, Wood County OH. ids like 'obrien-ia', 'champaign-il'. Keep each site's climate payload close to the Story one (about 300 KB).

## 2. Farm setup (MODEL API, UI calls it)
`FS.engine.setFarm({ site: id, fields: [{ id, acres, lastCrop }] })`:
- field ids stay north | creek | west | south (the map layout is fixed and illustrative); acres 10-640; lastCrop 'corn' | 'soybean'.
- Updates FS.data.farm (place, lat, lon, each field's acres, lastCrop, soil from the site, name = position word + acres, e.g. 'North 80', 'Creek 40', 'West 40', 'South 120'), FS.data.climate (site climate), FS.data.initialControls.crops.plans (current plan = the usual rotation: after corn -> 'soy', after soybean -> 'corn') and trialAcres (= acres), economics normal yields for the site; resets every engine cache, and recomputes the site's typical year (same rule as Story's). Returns { ok, site }.
- Default farm = today's Story County farm exactly (results byte-identical when setFarm is never called or called with the defaults).
- For a site with validated: false, summary.why gets one plain line: "This location was not checked against its own county's harvests; the yield check was done for Story County, Iowa." Named scenarios keep their years (1988, 2012, 2008, 2023, 1997, 1991 are Corn Belt-wide events) but their notes must not quote Iowa numbers for other states.
- Economics: prices are national (keep); costs are Iowa State budgets (say so for other states in the card gaps: "costs are Iowa State budgets; check your local costs").

## 3. Irrigation (MODEL + UI)
`controls.crops.irrigation`: 'none' (default) | 'july' | 'july-aug' | 'jun-aug'. Adds 25 mm (one inch) per week, spread daily, in those months, on every field, in every replayed season (like the sliders). Cost per acre-inch: a sourced value if you can find one (e.g. a university pumping-cost estimate), else a clearly labelled working value; never shown as fact without a source. summary.why says it in plain words ("Irrigating an inch a week in July on every field."). Default 'none' must give identical results.

## 4. Card lines (MODEL + UI)
Each card (`card` in recommendations and compare items) gains two plain sentences:
- `work`: the extra work, timing and equipment (e.g. rye: "One extra pass to seed rye after harvest and one to end it 10-14 days before planting; a drill or a broadcast pass works.").
- `trySmall`: how to try it on part of a field first, using the field and its acres ("Try it on 20 acres of Creek 40 next to your usual plan and compare at harvest.").
UI shows cards in this order: How it compares / Why suggested, Evidence, Benefits, Extra work, Try it small, Information gaps, Check with your adviser (the renamed "Risks to check locally").

## 5. Setup screen and links (UI)
- On first open (no `#from=` hash), a "Set up your farm" panel in the page's own style (dark grey box, Raw Umber accents, 22px text) asks: where the farm is (the sites, Story County marked "tested against USDA yields"), the four fields' acres and last year's crop, what matters most (balanced / profit / lowest risk / most ground cover), cost-share yes/no, and whether they can irrigate. Buttons "Start" and "Use the example farm". A small "Your farm: Story County, Iowa · Change" line in the header reopens it. Remember the choice in localStorage (wrapped in try/catch).
- After setFarm: reset controls to the new initialControls, recompute the baseline, rebuild the field selector and labels, the map labels and legend, the chat's field words (position words and acres numbers), the footer place name and the map caption, then run.
- Hash additions: `site=<id>` (setFarm with that site and default fields), `irrigation=none|july|july-aug|jun-aug`, `acres=<n>` (the selected field's acres, 10-640). From EcoShifters, the setup panel is skipped.
- Irrigation control in the Crops box (select: None / 1 inch a week in July / July and August / June to August), shown only when the farmer said they can irrigate (or set via chat/hash). Chat: "an inch a week in July", "irrigate July and August", "no irrigation".

## 6. EcoShifters (ECOSHIFTERS)
- Remove EcoShifters' own replay simulator page (and sim.js / sim.test.js if nothing else needs them); its "simulator" step and every "Try it in the simulator" / "See it in depth" button opens `deep-dive/index.html#from=ecoshifters&site=<nearest site id>&plan=<id>&priority=<p>&costshare=1&irrigation=<...>&acres=<field size in acres>` using the farmer's answers. Nearest site by distance from the farmer's pin; if the nearest is over 400 km away or outside the US, still open the nearest one but say plainly first: "Our simulator has real data for 8 Corn Belt counties; the nearest one to your field is X, Y km away."
- Keep the questionnaire, the AI brief, demo mode, the rate limit and the honest wording. Update README/PRODUCT so they describe one simulator.
