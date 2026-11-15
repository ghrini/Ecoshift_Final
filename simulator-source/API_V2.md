# API v2: shared contract for the fix round

Two developers work in parallel. The MODEL developer owns src/engine.js, src/data.js (scenarios, initialControls, economics), tests/, tools/validate*, data/ and VALIDATION.md. The UI developer owns src/chat.js, src/analysis.js, src/controls.js, src/app.js, src/app.css, src/view.css, src/fieldview.js and src/index.html. Neither edits the other's files. Everything in CONTRACT.md still holds unless changed here.

## 1. Scenarios (data.js + engine)
- `FS.data.weatherScenarios` = the NAMED list shown first in the dropdown. Each entry: `{ id, label, phrase, year, note }`.
  - `label`: dropdown text, e.g. `'2012 drought and heat'`.
  - `phrase`: used inside sentences after "In ...", e.g. `'a 2012-style drought'`, `'a typical year (1984 weather)'`, `'the 1997 season, the latest spring frost here'`.
  - Named set (ids are fixed; years computed/confirmed by the model developer from the data):
    `typical` (1984), `drought2012` (2012), `drought1988` (1988), `wetSpring` (the wettest April-June season in this grid cell; 2008 per earlier analysis), `dry2023` (2023), `lateFreeze` (1997), `earlyFrost` (1991).
    The old id `wet2019` is REMOVED (2019 was not a wet spring in this grid cell); 2019 stays reachable as an any-year replay.
- Any season can be replayed: id `'y' + year` for every year in `FS.data.climate.meta.years` (e.g. `'y2019'`).
- `FS.engine.scenario(id)` -> `{ id, label, phrase, year, note }` for named AND any-year ids (any-year: label `'2019 season'`, phrase `'the 2019 season'`). The UI must use this helper for all scenario wording.

## 2. Priorities
- New control `controls.other.priority`: one of `'balanced' | 'profit' | 'risk' | 'cover'` (default `'balanced'`), added to `initialControls`.
  - profit = rank by average $/acre vs the current plan over all seasons; risk = rank by the average of the 5 worst seasons; cover = rank by months of green ground cover added (money as tie-break); balanced = a documented blend.

## 3. Recommendations (summary.recommendations) and the keep-current note
Each item:
```
{ rank, fieldId, plan, title,
  deltaPerAcre,            // mean $/acre vs current plan over all seasons (same prices/shifts)
  deltaThisSeason,         // $/acre vs current plan in the selected scenario
  betterSeasons, nSeasons, // seasons where this plan beat the current plan
  worst5PerAcre,           // average of the 5 worst seasons' differences
  greenCoverMonthsAdded,   // signed; negative = less ground cover
  risk,                    // 'low' | 'medium' | 'high'
  tooClose,                // true when the difference is within the model's typical error
  card: { why, evidence, benefits, gaps, risks },  // each one or two plain sentences for a farmer
  source }
```
- `summary.recommendationNote`: a plain sentence when no alternative beats the current plans on the chosen priority, e.g. "At today's prices, keeping your current plans earns the most in most past seasons." (null otherwise).
- Recommendations ranked by `controls.other.priority`; at most 3; oats excluded while its prices are placeholders.

## 4. Per-field comparison
`FS.engine.compare(fieldId, controls)` -> array of every valid plan for that field INCLUDING the current one (current first, `isCurrent: true`, deltas 0):
`{ plan, label, isCurrent, deltaPerAcre, deltaThisSeason, betterSeasons, nSeasons, worst5PerAcre, greenCoverMonthsAdded, yieldPctThisSeason, risk, tooClose, card, moneyNote }`. Must run in under 100 ms (cache).

## 5. Other summary additions
- `summary.fields[id].moneyNote`: null, or a plain sentence when money is not reliable (oats: "Oats price and cost are placeholders, so money is not shown.").
- `summary.validation`: `{ text }`, one plain sentence for "Show details", e.g. "Checked against Iowa corn yields 1982-2025 without using each year to tune itself: correlation 0.6." or, if no validation could be run, "Calibrated so 2012 matches Iowa's real loss; not yet checked against other years."
- `why[0]` = main cause in plain words (frost scenarios must talk about the frost date and its small effect); `why[1]` = data-and-limits sentence; further why items allowed. The UI shows ALL why items plus `summary.validation.text` in details.
- Events must not print a single dataset's temperature as fact (no "42 C high"); describe heat in words ("a heat wave during corn flowering").
- `summary.fields[id].trialAcres` = 0 means the field stays on its current plan (weeks show the current plan).

## 6. Performance
First run (including caches) under 150 ms; later runs under 50 ms. `FS.engine.warm()` is called by app.js at boot before the first run.
