# Facilitator Guide: 45-Minute Session

Two people run each session: a **facilitator** who talks and a **note taker** who fills in [`observation-sheet.csv`](observation-sheet.csv). Read the text in quote marks exactly. Do not add hints.

Live site: https://ecoshift-final-8dsi.vercel.app/

Before the session: open the site in a fresh private browser window on the participant's device or a shared screen. Check that the Iowa sample button and the example farm load. Do a dry run with a teammate to confirm the button names below still match the site, because the site can change.

## Time plan

| Minutes | Part |
|---|---|
| 0 to 5 | Introduction, consent, think-aloud practice |
| 5 to 35 | Six tasks (the time limit is printed in each task) |
| 35 to 40 | Follow-up conversation |
| 40 to 45 | Survey (decision questions and SUS) |

The task limits add up to 29 minutes. Stop a task at its limit even if the participant is still working.

## 1. Introduction (about 2 minutes)

Say:

"Thank you for helping. We are three high school students and we built a tool called EcoShift. We are not testing you. We are testing the tool, and we want to find what is wrong with it. Nothing you say or do can be wrong. Please be critical. The tool is a prototype, so some things may not work."

"The tool makes estimates from past weather. It is not advice and it does not replace your own knowledge or an adviser."

## 2. Consent (about 2 minutes)

Hand over [`consent-and-quote-permission.md`](consent-and-quote-permission.md). Read the key points aloud, then ask each question separately and write the answers on the form:

1. "May we take part notes during the session?" (needed to continue)
2. "May we record the screen and your voice? You can say no and still take part."
3. "May we quote things you say in our report? Please choose one: by your name, by your role only (for example, 'a corn and soybean farmer'), or not at all."

If the answer to question 1 is no, thank them and stop. If any other answer is no, mark it in the sheet and respect it. Start recording only after a yes to question 2.

## 3. Think-aloud instructions (about 1 minute)

Say:

"While you use the tool, please say out loud what you are looking at, what you are thinking and what you expect to happen. If you are confused, say so. If something looks wrong, say that too. I will stay quiet most of the time. If you ask me how something works I may say 'what would you try?'. That is not to be rude. We need to see what happens when we are not there."

Practice: "Let's try it first. Please tell me out loud what you see on this page." (Use the home page for 20 seconds. Not scored.)

## 4. The six tasks

For every task: set the starting state, read the prompt, start the timer, observe, stop at the time limit. Mark completed as **yes** (met all success criteria without help), **partly** (met some, or needed a hint), or **no**. Count each facilitator hint and write down what it was.

If a participant asks for help, say "What would you try?" once. Only give a hint after 60 seconds of silence, and record it.

The button names below come from the README of the live site at the time of writing. Check them in the dry run.

### Task 1: Import a field

- **Starting state:** The live site home page, nothing open.
- **Say:** "Imagine you want to look at one of your own fields. Please bring a field into the tool so it is ready to use."
- **If the participant has no field file:** Say "There is a sample field you can use if you like." Do not say where it is. (The Simulation tab has an "Import your real field" box at the top with an Iowa sample and a California sample button. A GeoJSON or KML file also works.)
- **Success criteria:** A field outline appears in the simulation, and the participant can say what the tool now knows about the field (for example its weather, soil or slope).
- **Time limit:** 5 minutes.
- **Observe:** Where do they look first? Do they find the Simulation tab and the import box? Do they understand what a field outline file is? Do they use the sample or their own? Do they notice the wait (about 30 seconds on a cold start)? Do they understand any message shown?
- **Follow-up:** "What do you think the tool knows about this field now?" "What would you want it to know that it does not?"

### Task 2: Evaluate a current crop rotation

- **Starting state:** The simulation with the imported field. If the import failed, use the example farm and note it in the sheet.
- **Say:** "Suppose you plan to keep the rotation this field is in now. Please find out how that plan would do and tell me what the tool says."
- **Success criteria:** The participant finds the current plan's result for the field (harvest and money, in a typical season and in bad seasons) and states in their own words at least one figure or verdict correctly, including that it is an estimate.
- **Time limit:** 5 minutes.
- **Observe:** Which part of the screen do they read? Do they use the season timeline, the verdict text or the numbers? Do they notice the error range ("give or take about 10 points")? Do they misread a percent of a normal crop as bushels or dollars?
- **Follow-up:** "How much do you trust that number? What makes you say that?" "What is missing for you to believe it?"

### Task 3: Compare it against an alternative

- **Starting state:** Same simulation, current plan already shown.
- **Say:** "Now suppose you are thinking about a different plan for this field. Please find out whether it would be better or worse than your current plan, and tell me which you would choose and why."
- **Success criteria:** The participant finds at least one alternative (for example soybeans, corn after corn, or cereal rye before the crop), says how it differs from the current plan in harvest or profit, and says whether the tool calls the difference clear or "too close to call".
- **Time limit:** 6 minutes.
- **Observe:** Do they find the alternatives without help? Do they understand "beat the current plan in N of 44 seasons"? Do they see the "too close to call" notes? Do they notice the extra work and evidence notes? Do they look at the worst seasons or only the average?
- **Follow-up:** "How different would two plans need to be for you to switch?" "What does the tool not say that you would want to know?"

### Task 4: Investigate a historical drought

- **Starting state:** The simulation with a plan showing.
- **Say:** "Please find out how your plan would have done in a bad drought year, and tell me what you learn."
- **Success criteria:** The participant brings up a drought season (for example by typing a what-if about 2012 in the chat, or by choosing a season in the controls or the 44-season strip), states the result for a field in that season, and says whether it was worse than a typical season. They do not need to know in advance that 2012 was a drought.
- **Time limit:** 5 minutes.
- **Observe:** Do they use the chat, the controls or the strip? Do they trust the chat? Do they read the "How This Answer Was Made" list under chat answers? Do they ask whether that drought was really like this on their farm?
- **Follow-up:** "Does this match what you remember about a bad year? What is different?" "Would you use a past year like this to plan? Why or why not?"

### Task 5: Interpret the financial results

- **Starting state:** The simulation with two plans compared.
- **Say:** "Please look at the money results and tell me, in your own words, what they mean for the plans you looked at."
- **Success criteria:** The participant correctly says what the dollar figures stand for (for example a typical season, a bad season or the 44-season average) and names at least one thing the money does not include or one assumption (for example prices held constant, or Iowa State budget costs).
- **Time limit:** 5 minutes.
- **Observe:** Do they understand that costs come from Iowa State budgets and prices are national, and that they can enter their own prices? Do they check whether the costs match their own? Do they see the loss in a drought and ask whether prices would rise in real life?
- **Follow-up:** "Which of these money numbers would you use? Which would you ignore?" "What would you change to match your farm?"

### Task 6: What would you do differently?

- **Starting state:** The simulation, with whatever they were looking at.
- **Say:** "Thinking about what you saw, is there anything you would do differently on this field next season? If so, what? If not, what is the reason?"
- **Success criteria:** The participant gives a decision (change, keep or wait) with at least one reason that refers to something in the tool, or says clearly why the tool did not change their view. Both a change and no change count as success. Mark "partly" if they give a decision without any reason.
- **Time limit:** 3 minutes.
- **Observe:** Is the decision based on the tool, on their own experience, or both? Do they mention risk, money, work or soil? Do they say what they would check next?
- **Follow-up:** "What would you need before acting on this for real?" "Who would you ask?"

## 5. Follow-up conversation (about 5 minutes)

Ask these in order, neutrally. Do not explain or defend the tool.

1. "What was the most confusing moment?"
2. "Which results did you trust, and which did you not? Why?"
3. "Was there anything you wanted to know that you could not find?"
4. "Describe how you make a rotation choice today. Where would this fit, if anywhere?"
5. "If a neighbour asked you about this, what would you tell them?"

## 6. Survey (about 5 minutes)

Hand over [`post-session-survey.md`](post-session-survey.md) on paper or a form. Look away while it is filled in.

## 7. Close

Thank them. Say what happens next: "We will write a summary and, with your permission, quote you the way you chose. We can send you the summary if you want." Remind them they can withdraw their data any time by contacting the teacher named on the consent form.

## Note taker's checklist

- One row per participant and task in the observation sheet, filled in during the session.
- Clock time for each task start and stop.
- Count facilitator hints and write what the hint was.
- Mark confusion points with the screen area and the exact words.
- Write exact quotes in quote marks. Do not tidy them.
- Do not record anything the participant did not agree to.
