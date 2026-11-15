# Field Shift simulator: framework contract

This is the shared contract for the simulator page. Two developers work in parallel; follow it exactly so the parts fit.

## The page (from the team's wireframe)

```
+-------------------------------------------------------------------------------------------+
| header: app name · location ("Story County, Iowa · 4 fields") · Sample data badge · Run     |
+--------------------+--------------------+--------------------+-----------------------------+
| Weather / season   | Crops              | Other conditions   | Sim analysis                |
| dropdown + sliders | field + plan +     | price, nitrogen,   | what happened in the last   |
|                    | trial acres slider | contracted, toggle | run, per field, why         |
+--------------------+--------------------+--------------------+                             |
| Bird's-eye view of the farm (main box)                        +-----------------------------+
|  - legend / field list overlay (top-left)                     | Chat                        |
|  - fields drawn from above, animated week by week             |  - opens with 3             |
|  - playback bar (play/pause, week scrubber, speed)            |    recommendations          |
|                                                               |  - "ask me to simulate…"    |
|                                                               |  - input + send             |
+---------------------------------------------------------------+-----------------------------+
```
Desktop: CSS grid with a left area (~70%) and a right column (~30%). Left area = the three control boxes in one row, then the bird's-eye view filling the remaining height. Right column = Sim analysis on top (taller than the control row), Chat below filling the rest. Below ~1000px wide everything stacks in one column: controls, view, analysis, chat.

## Load order (build.py concatenates in this order; everything hangs off the global `FS`)
1. `src/data.js`      (exists) sample farm, plans, scenarios, economics, sources, initial controls
2. `src/store.js`     (exists) `FS.store`, `FS.actions`, `FS.computeBaseline`
3. `src/engine.js`    (developer B) `FS.engine.run(input) -> result`
4. `src/fieldview.js` (developer B) `FS.fieldView.mount(el)`
5. `src/controls.js`  (developer A) `FS.controls.mount({weather, crops, other})`
6. `src/analysis.js`  (developer A) `FS.analysis.mount(el)`
7. `src/chat.js`      (developer A) `FS.chat.mount(el)`, `FS.chat.interpret(text, state)`
8. `src/app.js`       (developer A) boots everything in order: `FS.computeBaseline()`, mount all modules, post the opening recommendations, run the first simulation.

CSS order: `tokens.css` (exists) → `app.css` (developer A) → `view.css` (developer B).

## DOM mounts (developer A creates these in index.html; developer B renders only inside #fs-view)
- `#fs-header` header bar
- `#fs-ctl-weather`, `#fs-ctl-crops`, `#fs-ctl-other` the three control boxes
- `#fs-view` the bird's-eye view box (developer B owns everything inside it, including the legend overlay and playback bar)
- `#fs-analysis` the Sim analysis box
- `#fs-chat` the chat box
Developer A must not style anything inside `#fs-view`. Developer B's CSS selectors must all be scoped under `#fs-view` or start with `.fv-`.

## Events and actions (see src/store.js)
- Change state only through `FS.actions.*` (setControl, selectField, runSimulation, addChat).
- Listen with `FS.store.on(event, fn)`: `controls:change`, `field:select`, `sim:start`, `sim:done`, `chat:message`.
- Clicking a field in the view calls `FS.actions.selectField(id, 'map')`; the Crops box then shows that field.
- Running: the header Run button, a Run button in the view's playback bar, and chat commands all call `FS.actions.runSimulation(source, label)`. On `sim:done` the view starts playing the new timeline from week 0, the analysis box shows the summary, and the controls clear their "changed since last run" state.

## Engine input
`FS.engine.run({ farm, controls, baseline })` where `controls` is the shape of `FS.data.initialControls` and `baseline` is the earlier baseline result or null. Synchronous, deterministic (same input, same output), fast (< 50 ms).

## Result format (developer B produces it; developer A reads `summary`, developer B's view reads `weeks`)
```js
{
  runId: 3,                     // set by store
  label: 'Run 3',               // engine sets a descriptive label, e.g. '2012 flash drought · +1°C'
  sample: true,
  inputs: { /* controls snapshot */ },
  weeks: [                      // weekly, 2026-11-16 .. 2027-11-15 (52 or 53 entries)
    { date: '2027-07-12', label: 'Jul 12',
      weather: { tmaxC: 33.1, rainMm: 4.2, heavyRain: false, frost: false, heat: true },
      fields: {
        north: { crop: 'soybean',               // 'corn' | 'soybean' | 'rye' | 'oats' | 'none'
                 stage: 'flowering',            // 'bare' | 'residue' | 'planted' | 'emerged' | 'vegetative' | 'flowering' | 'grainfill' | 'mature' | 'harvested' | 'cover'
                 green: 0.82,                   // 0..1 how green it looks from above
                 soilWater: 0.41,               // 0..1 share of soil water capacity
                 stress: 0.30,                  // 0..1 crop stress this week
                 flags: ['heat'] }              // any of 'heat','drought','frost','waterlogged','erosion','planting-delay'
      } }
  ],
  summary: {
    farm: { acres: 280, returnTotal: 12345, returnVsBaselineTotal: -2345 },   // dollars, sample
    fields: {
      north: { plan: 'soy', planLabel: 'Soybean (current plan)', crop: 'soybean', acres: 80, trialAcres: 80,
               yieldPctOfNormal: 92, yieldBuPerAcre: 55.2, returnPerAcre: -18, returnVsBaselinePerAcre: -14,
               greenCoverMonths: 5.0, worstWeek: '2027-07-12', note: 'Heat during flowering' }
    },
    events: [ { date: '2027-07-12', fieldId: 'north', type: 'heat', text: 'Heat during soybean flowering on North 80', source: 'power' } ],
    why: [ { text: 'Rain June to August was 38% below normal in this scenario.', source: 'imerg' } ],
    recommendations: [   // ranked options for the chat to present (engine computes these by trying each field's plan options)
      { rank: 1, fieldId: 'creek', plan: 'rye-soy', title: 'Cereal rye before soybean on Creek 40',
        deltaPerAcre: -12, greenCoverMonthsAdded: 5.5, risk: 'low', why: 'Field has low green cover Nov-Apr', source: 'modis' }
    ]
  }
}
```
`source` values are keys of `FS.data.sources`.

## Honesty rules
- Every number shown is SAMPLE until real data replaces data.js and engine.js. Keep a visible "Sample data" badge in the header and the word "sample" near money numbers.
- The bird's-eye view is a drawn illustration of the fields, not satellite imagery: label it "Illustrative aerial view · real build uses satellite imagery".
- No NASA logo. Dataset names only.

## Technical rules (the page is published as a sandboxed artifact)
- No external requests except Google Fonts (Inter, JetBrains Mono). No fetch, no images from the web, no iframes, no alert/confirm/prompt, no window.print, no <a download>.
- Single global `FS`; each JS file is an IIFE that attaches its module to `FS`. No `</script` in any JS file.
- Colors only from tokens.css (canvas code reads them with `getComputedStyle(document.documentElement).getPropertyValue('--crop-corn')` and must re-read on theme change: listen to `matchMedia('(prefers-color-scheme: dark)')` change).
- Must work at 400px wide with no horizontal page scroll. Respect prefers-reduced-motion (no autoplay animation; playback still works on demand). Visible keyboard focus. Stable ids on every control.

## Build and test
- `python3 build.py` → `dist/simulator.html` (the publishable fragment) and `dist/simulator.test.html` (wrapped for local tests). `python3 build.py --only view` builds a harness with just the view + engine; `--only ui` builds the full page with a stub engine/view if developer B's files are missing.
- `node tools/shot.js dist/<file>.test.html <out-prefix>` → screenshots at desktop dark, phone dark, desktop light; prints horizontal overflow and page errors.
