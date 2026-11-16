# EcoShift

A farmer-focused crop-rotation decision-support prototype for the 2026 NASA Space Apps Challenge ("Field Shift: Adapting Farms with NASA Data").

This folder is everything in one place: the website, its server, the simulator with its farm questionnaire, and the simulator's full source and data.

The site has three tabs:

- **Home**: what the project is, why it matters, why farmers can trust it, why it is credible (NASA data), and its honest limits.
- **Simulation**: the EcoShift simulator, in this order:
  1. **Farm questionnaire**, 13 questions (location by address search or "use my location", fields, crops, water, land, limits, money, priorities, buyers). Every question can be skipped, or use the example farm. A returning farmer sees the review of their saved answers.
  2. **Guided tutorial**: 14 steps through every part of the simulator, with large text, keyboard controls, screen-reader support and an optional read-aloud voice. It opens when the questionnaire closes, once per visit; "How to use this page" opens it again.
  3. **The simulation**: 44 real seasons (1982 to 2025) of NASA POWER daily weather, USDA soils and yields for 14 Corn Belt counties, crop plans compared in harvest and dollars, a chat for what-ifs, a 44-season strip, and a 30-day outlook.
- **About us**: the team.

This is a working prototype. Simulation results are estimates for comparing options, not guaranteed predictions.

## Run it on your computer

1. Install **Node.js 18 or newer** from https://nodejs.org (no `npm install` needed; there are no packages).
2. Optional, for the AI parts (the chat helper that answers any question and runs what-ifs the rules cannot read, fitting the data to your farm from your land answers, and the daily outlook note): copy `.env.example` to `.env` and put your Gemini key after `GEMINI_API_KEY=` (get one at https://aistudio.google.com/apikey). Without a key everything else works.
3. In a terminal, in this folder:

   ```bash
   npm start
   ```

4. Open **http://localhost:8787** (or the `PORT` you set in `.env`, e.g. http://localhost:3000).

Stop it with Ctrl+C.

Optional, for the "Farm map" view: Python 3 and `pip install -r farmmap/requirements.txt`. Without it the farm map shows a message and everything else works.

**Never commit or upload `.env`.** It is in `.gitignore`, but GitHub's "Add files via upload" does not read `.gitignore`: delete or leave out `.env` before uploading through the website.

What needs the server and internet: the address search, fitting the data to your own farm (NASA POWER, USDA NRCS soils, USDA NASS yields, FCC county lookup), importing your own field outlines, the 30-day forecast (Open-Meteo) and the farm map (USGS / Sentinel-2 imagery). The simulator itself also opens as a plain file (`public/deepdive/index.html`) and works offline on the county data.

**Your own fields from a GeoJSON file.** Press "Import field outlines" in the simulator header and pick a GeoJSON file of field boundaries in longitude/latitude (from geojson.io, QGIS, John Deere Operations Center or Climate FieldView). Up to four fields are used (the largest four if there are more); a `name` property names a field and a `crop` property (corn or soybean) sets its last crop. The server (`fieldgeo.js`, `/api/fieldconditions`) then measures the conditions on those exact fields:
- weather: 44 seasons of daily NASA POWER weather at the farm's own point. Only if NASA POWER does not answer does the server fall back to Copernicus reanalysis (ERA5-Land, about 9 km, for temperature; ERA5 for rain and FAO-56 reference evapotranspiration) from Open-Meteo's archive (`farmWeather` in `fieldgeo.js`);
- slope and height: the Copernicus GLO-30 elevation model (30 m), read straight from its public AWS bucket, averaged over every 30 m cell inside each outline;
- soil: the USDA soil survey at a point well inside each field; normal yields: USDA NASS for the fields' county.

**Advanced near-real-time conditions.** The third switch in the Simulation panel ("Simulation | Farm map | Advanced near-real-time conditions") checks the fields today, shows how recent each source is and checks again every 15 minutes while open (`fieldlive.js`, `fieldsat.js`, `/api/liveconditions`): ECMWF weather (now, past 7 days, next 3), Copernicus ERA5-Land soil moisture and CAMS air quality; soil fertility from ISRIC SoilGrids (organic carbon, nitrogen, pH, CEC); ponds and wet ground from ESA WorldCover (10 m, Copernicus Sentinel-1/2); low spots from the Copernicus DEM; and from Copernicus Sentinel-2 (Earth Search on AWS) possible burned ground (burn ratio change plus dark char, with cloud edges left out), bare soil now and last summer's weak growth zones (NDVI, shown with the date of that image). NASA data on the fields: (1) active-fire detections from NASA's VIIRS (Suomi NPP, NOAA-20) and MODIS (Terra, Aqua) satellites, read as small map images from NASA GIBS for every day over each field plus 400 m (`fieldfire.js`, with its own PNG decoder; FIRMS itself is not used). A Sentinel-2 burn warning is marked "confirmed by fire" when those satellites saw fire over the field in the burn window; with no detection it is softened to "possible burned ground or bare soil after harvest", and a line says whether any fire was seen in the last 14 days NASA has published. (2) NASA POWER (MERRA-2 model) root-zone and top-soil wetness, 0 = dry, 1 = saturated, latest day against the 2001-2025 average of the same 14-day window; it is a model, not SMAP. Both NASA checks have a hard time limit (about 12 s, 6 s for the burn confirmation) and are left out with a note if NASA is slow. The burn test (NBR drop of 0.27 or more, from forest-fire work, plus dark near-infrared) is weak on cropland, which is why the NASA confirmation matters. Evidence: `docs/evidence/burn-check-nasa-2026-11-16.json`. Warnings that belong to a place are numbered on a small map of the fields. With imported outlines the checks use the exact fields; otherwise a square of each field's size around its soil survey point.

**Field health** (bottom of "Advanced near-real-time conditions", `fieldhealth.js`, `/api/fieldhealth`): this season's Sentinel-2 images of each field (clearest in every 8 days) give a time series per field, saved as `data/<farm>_<field>.csv` (date, NDVI, NDRE, NDMI, red-edge position, LAI, cover, uniformity) and downloadable from the page. From it: growth stage (degree days since planting plus the NDVI curve), growth momentum, scores for canopy, nitrogen (red edge against the field's own best 10%), moisture, leaf structure and uniformity, yield and quality scores, a rough yield estimate, root causes, and prioritised advice for irrigation, nutrition, soil moisture and uniformity that depends on the crop and stage. Phosphorus is not visible from satellite, so the page asks for a soil test instead of guessing. The page leads with a 0 to 100 health index (canopy against a healthy crop's normal peak; nitrogen, leaf structure and evenness against the field's own best parts). The bushel figure is labelled a rough guide, not yet checked against real harvests: it is the county normal scaled by the health index, and its range is a design range (0.85 and 1.15 times), not a measured error. The red-edge nitrogen check cannot see a field that is short of nitrogen everywhere and is less reliable early in the season, so the advice is to confirm with a soil nitrate or tissue test before side-dressing (30 to 50 lb N/acre if confirmed). "No clear problem in the latest image" is kept apart from last summer's weak zones, which are labelled with their image date. In the southern hemisphere the season window and the summer image shift by six months. These are rules on published indices, not a model trained on harvests. Evidence: `docs/evidence/field-health-iowa-nasa-2026-11-16.json`.

Try it with `public/deepdive/sample-fields.geojson` (three fields near Ames, Iowa). "Use example fields" goes back. The 44-season download is heavy for Open-Meteo's free limits, so the server keeps it on disk for 30 days per 0.1-degree cell.

## Folder structure

```
fieldshift/
  README.md            this file
  package.json         "npm start" runs server.js
  server.js            the server: serves ./public and the API routes (address search, farm fit, outlook, farm map, AI notes)
  farmfit.js           farm fitting, 30-day outlook and address lookup (loaded by server.js)
  farmmap.js           farm-map service (loaded by server.js); runs the Python converter in farmmap/
  farmmap/             farm-map converter (Python, OpenCV), with examples
  .env.example         copy to .env and add your key (optional)
  public/              the website
    index.html         the three-tab site
    app.js             tab navigation; loads the simulator and adds the guide and the field photo to it
    sim-guide.js/.css  the guided tutorial
    sim-backdrop.css   the dimmed field photo behind the questionnaire
    styles.css         site design (black, Raw Umber, Plus Jakarta Sans)
    images/            the field photo used on Home and behind the questionnaire
    deepdive/index.html  the simulator with its questionnaire (one self-contained page, built from simulator-source/)
  simulator-source/    everything the simulator page is built from
    README-simulator.md  the simulator's own notes
    src/               the code (engine.js is the crop model; questionnaire.js, chat.js, analysis.js, controls.js,
                       fieldview.js, outlook.js, farmmap.js, app.js are the page; sites.js holds the 14 counties)
    raw/               the downloaded NASA, Open-Meteo, NRCS, NOAA and USDA data, SHA-256 hashes in raw/HASHES.txt
    data/              USDA NASS yields and the validation results
    tools/             scripts that rebuild the data and re-run the yield check
    tests/, verify/qa2/  tests
    VALIDATION.md, DATA_NOTES.md  how the model was checked, and where every number comes from
```

## Rebuild and test the simulator

```bash
cd simulator-source
python3 build.py                  # writes dist/deep-dive.html; copy it to ../public/deepdive/index.html
node --test tests/engine.test.js  # model tests (30)
python3 tools/validate.py         # re-runs the USDA yield check for Story County (about 2 minutes)
sha256sum -c raw/HASHES.txt       # checks the raw downloads
```

The page tests (`verify/qa2/chat_test.js`, `verify/qa2/setup_test.js`) need Node with Playwright and run against `dist/simulator.test.html`.

## Things to know

- The model was checked against USDA harvests only in Story County, Iowa: it catches the 1988 and 2012 droughts but is no better than the yield trend in ordinary years. The other 13 counties use the same model with their own weather, soils and county yields and are not separately checked; neither is a farm fitted to its own point. Outside the United States, soils come from ISRIC SoilGrids and harvests are a Corn Belt yardstick. The Home page says so.
- The 30-day forecast comes from Open-Meteo, not NASA; days 17 to 30 are a rough estimate.
- Costs are Iowa State University budgets; a few working values (rye seed, oats, irrigation pumping) are labelled in the tool. Outside Iowa only differences between plans are shown in dollars.
- The simulator and the guide are in English only.
- The server has per-visitor limits on the AI calls and the farm map (see Hosting for how visitors are told apart).

### Languages

The simulator speaks the farmer's language. A language picker sits on the questionnaire's first screen and in the simulator's top bar (English, Spanish, Portuguese, French, Hindi, Chinese, Arabic, Swahili, Vietnamese, Ukrainian, or any other typed in). Every piece of screen text, chat answers and the analysis included, is translated by Gemini through `POST /api/translate` and kept in the farmer's browser, so each sentence is translated once. What the farmer types in the chat is put into English before the simulator reads it. Numbers, dates and the year strip are left as they are. It needs `GEMINI_API_KEY` on the server; without it the page stays in English and says so.

## Hosting

- **Memory: at least 1 GB RAM.** One farm-map conversion peaks at about 415 MB (up to 2 run at once). A 512 MB host will run out of memory on the first "Farm map" click. Uploaded photos over 50 megapixels are refused to protect the server.
- **Python packages:** the farm map needs Python 3 and `pip install -r farmmap/requirements.txt` on the host. Without them everything else still works.
- **Secrets:** set `GEMINI_API_KEY` as a secret or environment variable in the host's settings. Never upload `.env` (also set `GEMINI_MODEL` there if you want a specific model). `.dockerignore` leaves `.env` out of the image.
- **`TRUST_PROXY`:** the per-visitor rate limits use the connection's address by default. If the host puts its own proxy or load balancer in front of the server (Render, Fly, Heroku, Cloudflare and similar), every visitor would look the same, so set `TRUST_PROXY` to the number of proxies in front of the server (1 for a single host proxy, 2 for Cloudflare in front of such a host). The server then reads the visitor's address from the `X-Forwarded-For` header, that many entries from the right. Leave it unset when visitors connect directly: the header can be faked, so it is ignored unless `TRUST_PROXY` is set.
- **Port:** the server listens on `PORT` (default 8787). Health check: `GET /`.
- **Docker:** a `Dockerfile` (Node 20, Python 3 and the converter's packages) and `.dockerignore` are included. **They were written without Docker available and have not been built or run.** Build and test the image before depending on it.
- Static pages are gzip-compressed by the server and cached by browsers for 5 minutes.

### Vercel

The repository deploys to Vercel as it is (`vercel.json`):

- `public/` is served as the website. The whole simulator, the 14 county example farms and their maps run in the browser.
- `api/index.js` is the one Vercel function: a rewrite in `vercel.json` sends every `/api/...` request to it, and it passes the request to the same handler `node server.js` uses (address lookup, fitting the data to the farm, the 30-day outlook, chat, translation, field import, live conditions, field health). One function keeps the site within the Hobby plan's limit of 12 functions per deployment.
- Drawing a **new** farm map (from a typed address or an uploaded photo) needs the Python map tools, which are too big for a Vercel function. Run the full server somewhere that has Python and set **`FARMMAP_URL`** in Vercel to its address: Vercel then passes every map request (and its images) on to it. Without `FARMMAP_URL` the site says that drawing a new map is not switched on, and the 14 built-in county maps still work.
- **Full server on Hugging Face Spaces** (as of November 2026, Docker Spaces need a Hugging Face PRO account): create a Space (SDK: Docker, blank template), upload the two files in `deploy/huggingface/` (`README.md` and `Dockerfile`) to it, and add `GEMINI_API_KEY` under the Space's Settings → Variables and secrets. It builds from this GitHub repository. When it is running, its address looks like `https://<user>-<space>.hf.space`: that is the `FARMMAP_URL` for Vercel (then redeploy Vercel). The Space is also a complete public copy of EcoShift with everything switched on. These files were not tested on Hugging Face. Without `FARMMAP_URL`, a Vercel site still works: a new address or photo shows the nearest example county's farm map instead of a newly drawn one.
- `.vercelignore` leaves the Python tools, the raw data and the simulator sources out of the upload.
- Settings: Framework Preset "Other" (set by `vercel.json`), Root Directory left empty. Optional environment variable: `GEMINI_API_KEY`. The visitor's address for rate limits comes from Vercel's `x-real-ip` header, so `TRUST_PROXY` is not needed.
