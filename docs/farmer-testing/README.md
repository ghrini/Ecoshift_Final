# Farmer Testing Plan

This folder is the plan for testing EcoShift with real farmers and extension specialists. **No sessions have been run yet.** Nothing here reports results. When sessions happen, the numbers go into a filled-in copy of [`results-summary-template.md`](results-summary-template.md).

Live site: https://ecoshift-final-8dsi.vercel.app/

## Purpose

We do not want to know whether people like EcoShift. We want to know whether it helps a farmer make a better-informed decision about a crop rotation. So each session asks people to do realistic tasks on the live site and we measure:

- Can they finish each task, and how long does it take?
- Where do they get confused or make mistakes?
- Which results do they trust, and which do they doubt?
- What information would they still need before acting on a real field?
- Would anything about their decision change after using it?

The six tasks follow the way a farmer would really use the tool:

1. Import a field.
2. Evaluate a current crop rotation.
3. Compare it against an alternative.
4. Investigate a historical drought.
5. Interpret the financial results.
6. Say what they would do differently after using the tool.

## Who to recruit

| Group | How many | Why |
|---|---|---|
| Farmers who grow corn, soybeans or other row crops and choose rotations | 5 to 8 | They are the people the tool is for. Try for a mix of sizes, owners and renters, and experience levels. |
| Agricultural extension specialists (agronomists, crop advisers, farm management advisers) | 1 to 2 | They can judge whether the advice is sound and what a farmer would need to see before trusting it. |

Do not count friends and family who do not farm. Do not pay people in ways that could pressure them to be positive. A thank-you note is fine.

## How to reach extension offices

We will ask, not assume. A short, polite email or phone call from the team, copied to a teacher or parent, works best. Say who we are (high school students), what we built, that we want honest criticism, and that the session is about 45 minutes and can be on video.

- **UC Cooperative Extension, Santa Clara County** (closest to the Emerald High School and Dougherty Valley High School area). Start from the University of California Agriculture and Natural Resources site, https://ucanr.edu/ , and look for the Santa Clara County office. Ask for a farm advisor or program staff member who works with growers and who might pass our invitation to local farmers. Check that the contact details on the page are current before writing.
- **Iowa State University Extension and Outreach** (Iowa is where our model was checked). Start from https://www.extension.iastate.edu/ and look for the county office for Story County (the county our weather data comes from) or a field agronomist. Iowa State is also where the crop budgets in our model come from, so ask whether a crop or farm management specialist would give 45 minutes.
- Other options: a local Farm Bureau, a Natural Resources Conservation Service (NRCS) field office, a Certified Crop Adviser, a farmers market grower group, a 4-H or FFA adviser who knows local growers.

Write down who was contacted, on what date, and the answer in a recruitment log (a simple table in the filled-in results summary). Keep contact details out of the public repo.

## Session length and format

- 45 minutes per person, one facilitator and one note taker. In person on a laptop, or on video with screen sharing. Phone-sized screens are worth one session because farmers may use a phone.
- Roughly: 5 minutes introduction and consent, 30 minutes for the six tasks, 10 minutes for follow-up questions and the survey.
- Run a practice session with a teammate first to fix the script and timings.

## Materials

| File | What it is |
|---|---|
| [`facilitator-guide.md`](facilitator-guide.md) | The 45-minute script, with the exact wording to read for each task |
| [`observation-sheet.csv`](observation-sheet.csv) | One row per participant and task, filled in live by the note taker |
| [`post-session-survey.md`](post-session-survey.md) | Decision-focused questions and the 10-item System Usability Scale |
| [`consent-and-quote-permission.md`](consent-and-quote-permission.md) | Consent text for recording and for quoting by name; have a parent or teacher review it first |
| [`results-summary-template.md`](results-summary-template.md) | How to report success rates, confusions and what we changed |

Also bring: a laptop with the live site open, a screen recorder (only with consent), a timer, printed consent forms, and a notebook. Use a code (P1, P2, ...) in all files. Keep the name-to-code list somewhere private, not in the repo.

## Rules for the team

- Read the prompts exactly as written. Do not explain the tool, do not hint at where to click, and do not defend it.
- If a participant is stuck, wait. After the time limit for a task, say "Let's move on" and mark the task as not completed or partly completed.
- Do not ask "Did you like it?". Ask what they did and what they would do next.
- Record bad news with the same care as good news.
- Do not change the tool between sessions unless a bug blocks the task. If we do, write down the change and the date.
- Be clear that results are estimates from a model, not advice. We are not agronomists.
