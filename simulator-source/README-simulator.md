# Field Shift simulator (with the farm questionnaire)

NASA Space Apps 2026, "Field Shift: Adapting Farms with NASA Data".

**To use it: open `index.html` in a web browser** (Chrome, Edge, Firefox or Safari). No install, no account, no API key; it works offline (the web font needs internet, a system font is used otherwise).

**For the live features** (fitting the data to your own farm, the 30-day forecast and the AI notes), run the EcoShifters server from the repository root (`node server.js`, with `GEMINI_API_KEY` in `.env`) and open http://localhost:8787/fieldshift/. Opened as a file, the page says so and works with the county data alone.

## What it does
1. **Farm questionnaire.** About 12 short questions: where the farm is (search an address or use your location; the nearest of 14 counties is picked), your four fields and last year's crops, own or rent, water, land, limits, crops you won't grow, contracts, budget and cost-share, what matters most, buyers. Every question can be skipped, or "Use the example farm" (Story County, Iowa).
2. **Simulation.** Replays 44 real seasons (1982–2025) of NASA POWER daily weather on your fields with USDA NRCS soils, and compares crop plans (corn, soybeans, a cereal rye cover crop, corn after corn, soybeans after soybeans, oats) in yield and dollars. You can change the weather (temperature, rain, any past season, dry/wet/hot months), the planting date, irrigation and prices, or type what-ifs into the chat.
3. **Fitted to your farm** (server). The nearest county's data is fitted to your own point: its daily weather is shifted month by month by the NASA POWER climatology difference between your farm and the county point, the soils come from the USDA NRCS soil survey at four points on your farm, and normal yields are USDA NASS's last 5 years for your own county (found from the point with the FCC county lookup). Gemini then reads your land answers and makes small, capped changes: tile drainage, a drainage class that contradicts the survey, soil water-holding (−15% to +10%) and normal yields (±10%). The chat lists what was used and what was missing.
4. **Next 30 days** (server). Open-Meteo's 16-day forecast for your farm, plus a rough estimate for days 17–30 from Open-Meteo's long-range ensemble (mean, with the 10th–90th percentile range), against the normal for each date. Fixed-rule warnings: frost in the growing season, heat (35 °C), dry spells, heavy rain, strong gusts, snow, frozen ground, extreme cold for livestock, and when it is cool enough for fall nitrogen. The next harvest is estimated by replaying every past season with these days put in, per field on its current plan; in November these days barely move next year's harvest, and the page says so. Gemini writes a short note once a day.
5. **Farm map** (server). A "Simulation | Farm map" switch in the Simulation panel shows an illustrated map of the farm from above, drawn by the farm map converter (`farmmap/stylize_farm.py`, Python with OpenCV). The server fetches the same 1.6 km square from USDA NAIP aerial photos via the USGS National Map (about 1 m detail, US only, public domain) and from Sentinel-2 cloudless by EOX (10 m, worldwide, CC BY-NC-SA 4.0) at once, keeps the sharper one and converts it with settings for that source; the farmer can also use their own drone or aerial photo. Drawing takes 20–40 s the first time and is cached. In the US the aerial photo wins easily; elsewhere the satellite map shows field shapes only. The map is a drawing, not a survey: the simulation still uses its four example fields. Needs `pip install -r farmmap/requirements.txt` on the server (set `FARMMAP_PYTHON` if Python is not `py -3` on Windows or `python3` elsewhere).
6. **Advice.** Option cards with why, evidence, benefits, extra work, how to try it small, information gaps and what to check with your adviser, adjusted to your answers. A 44-season strip shows each past season at a glance.

## How far to trust it
The model was checked against 44 years of USDA NASS harvests for Story County, Iowa: it catches the 1988 and 2012 droughts but is no better than the long-term yield trend in ordinary years. The other 13 counties (Iowa, Illinois, Indiana, Minnesota, Nebraska, South Dakota, Ohio, North Dakota, Wisconsin, Michigan, Missouri, Kansas, Kentucky) use the same model with their own weather, soils and county yields and are not separately checked; Saline County, Missouri has only 3 years of USDA yields and Nemaha County, Kansas 4. A farm fitted to its own point is not checked against its own harvests either. NASA POWER's climatology is on a grid of roughly 50 km, so a farm close to its data county gets almost no weather correction. Days 17–30 of the outlook are a rough estimate. Costs are Iowa State budgets, so outside Iowa only differences between plans are shown in dollars. It supports, and does not replace, the farmer's judgment and local advisers. Details: `source/VALIDATION.md` and `source/DATA_NOTES.md`.

## Inside this folder
- `index.html`: the whole tool in one file.
- `source/`: everything it is built from:
  - `src/`: the code (engine.js is the crop model; questionnaire.js, chat.js, analysis.js, controls.js, fieldview.js, outlook.js, app.js are the page; sites.js holds the 14 counties).
  - The server side of the live features is `farmfit.js` in the repository root (`/api/localfit`, `/api/outlook`, `/api/outlooknote`).
  - `raw/` and `data/`: the downloaded NASA, NRCS, NOAA and USDA data, with SHA-256 hashes in `raw/HASHES.txt`.
  - `tools/`: scripts that rebuild the data and re-run the yield check.
  - `tests/` and `verify/qa2/`: tests.

## Rebuild and test
```
cd source
python3 build.py                  # writes dist/deep-dive.html; copy it to ../index.html
node --test tests/engine.test.js  # model tests
python3 tools/validate.py         # re-runs the USDA yield check (about 2 minutes)
```
The page tests in `verify/qa2/` need Node with Playwright.
