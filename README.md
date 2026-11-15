# EcoShift

A farmer-focused crop-rotation decision-support prototype for the 2026 NASA Space Apps Challenge ("Field Shift: Adapting Farms with NASA Data").

This folder is everything in one place: the website, its server, the simulator with its farm questionnaire, and the simulator's full source and data.

The site has three tabs:

- **Home**: what the project is, why it matters, why farmers can trust it, why it is credible (NASA data), and its honest limits.
- **Simulation**: the EcoShift simulator, in this order:
  1. **Farm questionnaire**, about 12 questions (location by address search or "use my location", fields, crops, water, land, limits, money, priorities, buyers). Every question can be skipped, or use the example farm. A returning farmer sees the review of their saved answers.
  2. **Guided tutorial**: 14 steps through every part of the simulator, with large text, keyboard controls, screen-reader support and an optional read-aloud voice. It opens when the questionnaire closes, once per visit; "How to use this page" opens it again.
  3. **The simulation**: 44 real seasons (1982 to 2025) of NASA POWER daily weather, USDA soils and yields for 14 Corn Belt counties, crop plans compared in harvest and dollars, a chat for what-ifs, a 44-season strip, and a 30-day outlook.
- **About us**: the team.

This is a working prototype. Simulation results are estimates for comparing options, not guaranteed predictions.

## Run it on your computer

1. Install **Node.js 18 or newer** from https://nodejs.org (no `npm install` needed; there are no packages).
2. Optional, for the AI parts (fitting the data to your farm from your land answers, and the daily outlook note): copy `.env.example` to `.env` and put your Gemini key after `GEMINI_API_KEY=` (get one at https://aistudio.google.com/apikey). Without a key everything else works.
3. In a terminal, in this folder:

   ```bash
   npm start
   ```

4. Open **http://localhost:8787** (or the `PORT` you set in `.env`, e.g. http://localhost:3000).

Stop it with Ctrl+C.

Optional, for the "Farm map" view: Python 3 and `pip install -r farmmap/requirements.txt`. Without it the farm map shows a message and everything else works.

**Never commit or upload `.env`.** It is in `.gitignore`, but GitHub's "Add files via upload" does not read `.gitignore`: delete or leave out `.env` before uploading through the website.

What needs the server and internet: the address search, fitting the data to your own farm (NASA POWER, USDA NRCS soils, USDA NASS yields, FCC county lookup), the 30-day forecast (Open-Meteo) and the farm map (USGS / Sentinel-2 imagery). The simulator itself also opens as a plain file (`public/deepdive/index.html`) and works offline on the county data.

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

## Hosting

- **Memory: at least 1 GB RAM.** One farm-map conversion peaks at about 415 MB (up to 2 run at once). A 512 MB host will run out of memory on the first "Farm map" click. Uploaded photos over 50 megapixels are refused to protect the server.
- **Python packages:** the farm map needs Python 3 and `pip install -r farmmap/requirements.txt` on the host. Without them everything else still works.
- **Secrets:** set `GEMINI_API_KEY` as a secret or environment variable in the host's settings. Never upload `.env` (also set `GEMINI_MODEL` there if you want a specific model). `.dockerignore` leaves `.env` out of the image.
- **`TRUST_PROXY`:** the per-visitor rate limits use the connection's address by default. If the host puts its own proxy or load balancer in front of the server (Render, Fly, Heroku, Cloudflare and similar), every visitor would look the same, so set `TRUST_PROXY` to the number of proxies in front of the server (1 for a single host proxy, 2 for Cloudflare in front of such a host). The server then reads the visitor's address from the `X-Forwarded-For` header, that many entries from the right. Leave it unset when visitors connect directly: the header can be faked, so it is ignored unless `TRUST_PROXY` is set.
- **Port:** the server listens on `PORT` (default 8787). Health check: `GET /`.
- **Docker:** a `Dockerfile` (Node 20, Python 3 and the converter's packages) and `.dockerignore` are included. **They were written without Docker available and have not been built or run.** Build and test the image before depending on it.
- Static pages are gzip-compressed by the server and cached by browsers for 5 minutes.
