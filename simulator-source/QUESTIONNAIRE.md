# Questionnaire round: EcoShifters' farm questionnaire inside the simulator

The single "Set up your farm" panel becomes EcoShifters' step-by-step questionnaire, in the simulator's own style (black page, dark grey panel, Raw Umber #9E6438 accents, 22px text, one question per screen, a thin progress bar, Back / Skip / Next, "Use the example farm" always available). English only (EcoShifters translated with an AI service the simulator does not have). Every answer either changes the simulation or changes the advice text; an answer that changes nothing must not be asked, or the review screen must say "noted, not used by the simulator".

Skip the questionnaire when the URL hash has from=ecoshifters (EcoShifters already asked). Save answers in localStorage (try/catch) and restore them; "Your farm: … · Change" in the header reopens the questionnaire at the review screen.

## Steps (wording from EcoShifters, adapted)
0. Welcome — "Let's get to know your farm". "About 12 quick questions. Most are optional. Then the simulator replays 44 real seasons of NASA weather on your farm." Buttons: Start, Use the example farm.
1. Name — "What should we call you?" optional; used to greet in the chat.
2. Location — "Where is your farm?" The 8 counties grouped by state (Story County IA marked "tested against USDA yields"), plus "Use my location to find the nearest county" (navigator.geolocation in try/catch; show "<County> is the nearest, about N km away"; if blocked, say so plainly). One line: "We have real NASA weather and USDA soils for these 8 Corn Belt counties."
3. Fields — "Your four fields": acres (10–640) and last year's crop (Corn / Soybeans) for North, Creek, West, South (as now).
4. You and your farm — own/rent (TENURE), lease length (LEASE), years on this land (EXPERIENCE), practices you already do (PRACTICES: no-till, cover crops, certified organic, moving to organic, manure or compost, bought fertilizer, mostly hand work, none), animals (LIVESTOCK).
5. Water — "Is your farm irrigated or rain-fed?" (Irrigated / Rain-fed / Partly irrigated / Not sure).
6. Land — drainage after heavy rain (Drains well / Wet for a few days / Often waterlogged / Not sure), "Is it tile drained?" (Yes / No / Not sure), slope (Flat / Gentle / Steep in places), soil test in the last 3 years (Yes / No / Not sure). Show the USDA soil survey's name and drainage class for each field as a read-only line ("USDA soil survey: Coland clay loam, poorly drained").
7. Limits — EcoShifters' LIMIT_GROUPS checkboxes (water, land and soil, equipment, money/time/people, rules and access) + "Anything else?" text.
8. Crops — "Crops you won't grow or won't try": Corn after corn, Soybeans after soybeans, Cereal rye cover crop, Oats (checkboxes).
9. Contracts — "How much of next year's crop is already contracted?" 0–100% slider.
10. Budget and cost-share — BUDGETS tiles (No extra spending / Under $50 / $50–150 / Over $150 / Not sure) + "Would you use a cost-share payment?" (Yes / Maybe / No / I didn't know that existed).
11. Priorities — up to 3 in order from EcoShifters' PRIORITIES list; "If you tried something new, how much would you start with?" (TRIAL: small test patch / one field / about half the farm / all of it / not ready to change yet); "Any worries?" text.
12. Buyers — BUYERS checkboxes.
13. Anything else — free text.
14. Review — a short summary of every answer (with "Change" links back to each step), marking which answers are only noted, then Start.

## What each answer does
- Location, fields -> FS.engine.setFarm({ site, fields }) (as now).
- Practices "I already plant cover crops" -> the current plans include the rye cover: after corn 'rye-soy', after soybeans 'rye-corn' (MODEL: setFarm accepts an optional `currentPlan` per field; the baseline then uses it).
- Water: Irrigated -> crops.irrigation 'july-aug' as the farm's normal practice (baseline and options alike) and the irrigation control shown; Partly irrigated -> control shown, 'none' by default; Rain-fed / Not sure / limit "No irrigation equipment" -> irrigation off and the control hidden.
- Won't grow -> `controls.other.exclude` (MODEL: an array of plan ids never recommended and left out of compare lists, except a field's current plan). Cereal rye -> 'rye-soy','rye-corn'; Oats -> 'oats-cover'; Corn after corn -> 'corn-corn'; Soybeans after soybeans -> 'soy-soy'. Also limit "No drill for small seeds" with no broadcast option -> note only (rye can be broadcast).
- Contracts -> other.contracted. Cost-share Yes -> other.costShare true; Maybe -> false plus a note in rye cards ("you said maybe: it pays $30 an acre the first year").
- Priorities: the first maps to the ranking (Profit -> profit; Low risk / steady income, Handling extreme weather -> risk; Soil health, Less erosion -> cover; anything else -> balanced). Others appear in the review and in the opening advice.
- Trial size -> crops.trialAcres for the selected field: small patch = 10% of the field (min 5 acres), one field = the whole field, about half the farm / all of it = the whole field (and say "on every field you choose"), not ready = keep current plans and say "you can still compare options without changing anything".
- Advice notes (UI, plain, short, max 4 in the opening chat message, under "Based on your answers:"; and added to the matching card's "Check with your adviser" or "Extra work" line):
  - No sprayer, certified organic or moving to organic -> rye cards: end the rye by roller-crimping, mowing or tillage instead of a herbicide.
  - Renting with a lease of 1 year or less or a handshake -> look at this season's result more than the 44-season average; cover crops pay off slowly.
  - Landlord must approve changes -> talk to your landlord before changing a field.
  - New to this land (first season / 1-3 years) -> start small.
  - Budget "No extra spending" or "Under $50" -> rye costs about $37 an acre (less $30 with first-time cost-share).
  - Short on labor or time / health limits -> rye adds two passes (seeding and ending it).
  - Keeps animals or "Feed for my animals" -> rye can be grazed in spring; that value is not counted here.
  - No on-farm storage -> you sell at harvest prices; contracts help.
  - Often waterlogged / poorly drained without tile -> wet springs delay planting; the model uses the USDA drainage class.
  - Already no-till -> fits rye; tillage is not modelled.
  - No buyer yet / Direct sales -> oats need a local buyer.
- Name -> the chat greets the farmer once ("Hi Sam.").
- Soil test No -> a cheap first step: "a soil test (about $15–30 a sample) before changing fertility".
- Worries, limits note, buyers note, anything else -> shown in the review as "noted"; not used by the simulator (say so).

## Tests
Engine: `currentPlan` and `exclude` default to today's behaviour (byte-identical); excluded plans never appear in recommendations or compare (except current); a rye current plan changes the baseline. UI: full questionnaire by keyboard and mouse at 1440x900, 1366x768 and iPhone 13; every step's Skip; review "Change" links; Start applies everything (labels, plans, irrigation, priority, cost-share, contracted, trial acres, excluded plans gone, notes shown); reload restores; "Use the example farm" restores Story exactly; from=ecoshifters skips it; no page errors, no horizontal overflow. Keep chat_test (205) and setup_test passing (update setup_test for the new flow).
