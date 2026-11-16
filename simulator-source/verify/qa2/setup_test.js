// Usage: node verify/qa2/setup_test.js <dist/simulator.test.html> [shots-dir]
// The farm questionnaire (QUESTIONNAIRE.md): first open, focus trap, Escape, review + Change links, a full run with non-default answers
// for a non-Story county (every effect checked), Skip everything, keyboard only, reload restore, old one-panel save, example restores Story
// exactly, from=ecoshifters skips it, phone and laptop sizes. Prints PASS/FAIL lines; exit code 1 on any failure.
const { chromium } = require('playwright');
const path = require('path');
const file = process.argv[2], shots = process.argv[3];
let bad = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) bad++; };
async function open(ctx, hash) {
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
  await page.goto('file://' + path.resolve(file) + (hash || '')); await page.waitForTimeout(700); page.errs = errs; return page;
}
const summary = page => page.evaluate(() => JSON.stringify(FS.store.get().current.summary));
const title = page => page.textContent('#fs-q-title');
const next = async page => { await page.click('#fs-q-next'); await page.waitForTimeout(60); };
const skip = async page => { await page.click('#fs-q-skip'); await page.waitForTimeout(60); };
const pick = (page, name, value) => page.check('input[name="' + name + '"][value="' + value + '"]');
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png') }); };
async function tabTo(page, id, max = 80) { for (let i = 0; i < max; i++) { if (await page.evaluate(i2 => document.activeElement && document.activeElement.id === i2, id)) return true; await page.keyboard.press('Tab'); } return false; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  let page = await open(ctx);

  // ================================================================ first open
  ok(await page.isVisible('#fs-setup'), 'questionnaire shows on first open');
  ok(await title(page) === "Let's Get To Know Your Farm", 'it opens on the welcome screen');
  ok(await page.getAttribute('#fs-setup .fs-setup-card', 'role') === 'dialog' && await page.getAttribute('#fs-setup .fs-setup-card', 'aria-modal') === 'true', 'it is a modal dialog');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'fs-q-title'), 'focus starts on the step heading');
  ok(/\d+ quick questions\. Most are optional\. Then the simulator replays 44 real seasons of NASA weather on your farm\./.test(await page.textContent('#fs-setup')), 'welcome text');
  ok(await page.isVisible('#fs-setup-example') && await page.isVisible('#fs-q-next'), 'Start and Use the example farm are both there');
  let inside = true; for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); inside = inside && await page.evaluate(() => document.getElementById('fs-setup').contains(document.activeElement)); }
  ok(inside, 'Tab stays inside (12 presses)');
  inside = true; for (let i = 0; i < 12; i++) { await page.keyboard.press('Shift+Tab'); inside = inside && await page.evaluate(() => document.getElementById('fs-setup').contains(document.activeElement)); }
  ok(inside, 'Shift+Tab stays inside');
  ok(await page.evaluate(() => document.getElementById('fs-app').hasAttribute('inert')), 'page behind is inert');
  await shot(page, 'q-01-welcome');
  const story = await summary(page);
  const sites = await page.evaluate(() => (FS.data.sites || []).map(s => s.id));
  ok(sites.length === 14, '14 counties: ' + sites.join(','));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok(!(await page.isVisible('#fs-setup')), 'Escape closes it on the first run (= the example farm)');
  ok(await summary(page) === story, 'example farm results unchanged after Escape');
  ok(await page.evaluate(() => localStorage.getItem('fieldshift.farm.v1')) === '{"example":true}', 'choice saved in localStorage');
  ok(await page.evaluate(() => !document.getElementById('fs-app').hasAttribute('inert')), 'page is live again');
  const fb = await page.textContent('#fs-farm-btn');
  ok(fb.includes('Your farm: Story Co., IA') && fb.includes('Change'), 'header shows "Your farm: ... Change"');
  ok(!/Based on your answers/.test(await page.textContent('#fs-chat-list')), 'the example farm gets no advice message');

  // ---- Change opens the review; its links go to the step and come back
  await page.click('#fs-farm-btn'); await page.waitForTimeout(150);
  ok(await title(page) === 'Your Farm, In Short', 'Change opens the review step');
  ok(/Everything not marked is used by the simulator/.test(await page.textContent('#fs-setup')) && /Not answered/.test(await page.textContent('#fs-setup')), 'review explains marks and lists unanswered steps');
  await page.click('#fs-setup .fs-q-change[data-step="water"]'); await page.waitForTimeout(100);
  ok(/irrigated or rain-fed/i.test(await title(page)), 'a Change link opens that step');
  ok(await page.evaluate(() => document.activeElement.id) === 'fs-q-title', 'focus moves to the new step heading');
  ok((await page.textContent('#fs-q-next')) === 'Back to review', 'its Next button says Back to review');
  await pick(page, 'water', 'rainfed'); await next(page);
  ok(await title(page) === 'Your Farm, In Short', 'Next returns to the review');
  ok(/Rain-fed/.test(await page.textContent('#fs-setup .fs-q-review')), 'the review shows the new answer');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ok(!(await page.isVisible('#fs-setup')) && await summary(page) === story, 'Escape from Change closes without applying anything');
  ok(await page.evaluate(() => document.activeElement.id) === 'fs-farm-btn', 'focus returns to the header button');
  await page.click('#fs-farm-btn'); await page.waitForTimeout(100);
  ok(!/Rain-fed/.test(await page.textContent('#fs-setup .fs-q-review')), 'the unapplied answer was thrown away');
  await page.click('#fs-setup-example'); await page.waitForTimeout(500);
  ok(!(await page.isVisible('#fs-setup')) && await summary(page) === story, 'Use the example farm closes it and keeps Story exactly');
  ok(page.errs.length === 0, 'no page errors: ' + page.errs.join('|'));
  await page.close(); await ctx.close();

  // ================================================================ a full run with non-default answers, by mouse
  const other = 'champaign-il';
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', geolocation: { latitude: 40.12, longitude: -88.25 }, permissions: ['geolocation'] });
  page = await open(ctx2);
  await next(page); ok(/What should we call you/i.test(await title(page)), 'step 1: name');
  await page.fill('#fs-q-name', 'Sam'); await next(page);
  ok(await title(page) === 'Where Is Your Farm?', 'step 2: location');
  ok(/precise location|address/.test(await page.textContent('#fs-q-hint')), 'location line: use your location or type an address');
  ok(await page.isVisible('#fs-q-locate') && await page.isVisible('#fs-q-addr'), 'location step offers use-my-location and an address box');
  ok(!!(await page.$('#fs-q-site')), 'the nearest data county is kept for the farm');
  await page.click('#fs-q-locate'); await page.waitForTimeout(400);
  const geo = await page.textContent('#fs-q-geo');
  ok(/Champaign County, Illinois \(\d+ km away\), fitted to your exact spot/.test(geo) && await page.inputValue('#fs-q-site') === 'champaign-il', 'geolocation picks the nearest county: ' + geo);
  await shot(page, 'q-02-location');
  await next(page);
  ok(await title(page) === 'Your Four Fields', 'step 3: fields');
  await page.fill('#fs-q-acres-north', '5'); await next(page);
  ok(await title(page) === 'Your Four Fields' && await page.isVisible('#fs-setup-err'), 'acres below 10 is refused with a message');
  ok(await page.evaluate(() => document.activeElement.id) === 'fs-q-acres-north', 'focus goes to the bad field');
  const acres = { north: 60, creek: 30, west: 200, south: 100 }, crops = { north: 'soybean', creek: 'soybean', west: 'corn', south: 'corn' };
  for (const k of Object.keys(acres)) { await page.fill('#fs-q-acres-' + k, String(acres[k])); await page.selectOption('#fs-q-crop-' + k, crops[k]); }
  await shot(page, 'q-03-fields');
  await next(page);
  ok(await title(page) === 'You And Your Farm', 'step 4: you and your farm');
  await pick(page, 'tenure', 'rent'); await pick(page, 'lease', 'short'); await pick(page, 'practices', 'covers'); await shot(page, 'q-04-you'); await next(page);
  ok(/irrigated or rain-fed/i.test(await title(page)), 'step 5: water');
  await pick(page, 'water', 'irrigated'); await next(page);
  ok(await title(page) === 'Your Land', 'step 6: land');
  const soil = await page.textContent('.fs-q-soil');
  ok(/North 60:\s*USDA soil survey: Flanagan silt loam, somewhat poorly drained/.test(soil) && /South 100/.test(soil), 'USDA soil survey line per field: ' + soil.replace(/\s+/g, ' ').slice(0, 110));
  await pick(page, 'drainage', 'good'); await pick(page, 'tile', 'no'); await pick(page, 'slope', 'flat'); await pick(page, 'soilTest', 'yes'); await shot(page, 'q-06-land'); await next(page);
  ok(await title(page) === 'What Limits You?', 'step 7: limits');
  ok((await page.$$('#fs-q-body input[name="limits"]')).length === 20, 'all 20 EcoShifters limits');
  await pick(page, 'limits', 'sprayer'); await next(page);
  ok(/won't grow/i.test(await title(page)), 'step 8: crops you won\'t grow');
  await pick(page, 'wont', 'oats'); await pick(page, 'wont', 'corn-corn'); await next(page);
  ok(/contracted/i.test(await title(page)), 'step 9: contracts');
  await page.fill('#fs-q-contracted', '40'); ok(await page.textContent('#fs-q-contracted-out') === '40%', 'slider shows 40%'); await next(page);
  ok(/spend to try something new/i.test(await title(page)), 'step 10: budget');
  await pick(page, 'budget', 'low'); await pick(page, 'costShare', 'yes'); await next(page);
  ok(await title(page) === 'What Matters Most To You?', 'step 11: priorities');
  await page.click('.fs-q-rankbtn[data-p="Soil health"]'); await page.click('.fs-q-rankbtn[data-p="Profit"]');
  ok(await page.textContent('.fs-q-rankbtn[data-p="Soil health"] .fs-q-badge') === '1' && await page.textContent('.fs-q-rankbtn[data-p="Profit"] .fs-q-badge') === '2', 'priorities are numbered in order');
  await page.click('.fs-q-rankbtn[data-p="Less erosion"]'); await page.click('.fs-q-rankbtn[data-p="Food for my family"]');
  ok((await page.$$('.fs-q-rankbtn[aria-pressed="true"]')).length === 3, 'at most 3 priorities');
  await page.click('.fs-q-rankbtn[data-p="Less erosion"]');
  await pick(page, 'trial', 'field'); await page.fill('#fs-q-worries', 'Last two summers were too dry'); await shot(page, 'q-11-priorities'); await next(page);
  ok(await title(page) === 'Who Are Your Buyers?', 'step 12: buyers');
  await pick(page, 'buyers', 'nobuyer'); await next(page);
  ok(await title(page) === 'Anything Else?', 'step 13: anything else');
  await page.fill('#fs-q-other', 'Thinking about cattle in two years'); await next(page);
  ok(await title(page) === 'Your Farm, In Short', 'step 14: review');
  const rv = await page.textContent('#fs-q-body');
  ok(/Champaign County, Illinois/.test(rv) && /I rent it/.test(rv) && /1 year or less/.test(rv) && /I already plant cover crops/.test(rv) && /Irrigated/.test(rv) && /No sprayer/.test(rv) && /40%/.test(rv) && /Under \$50 per acre/.test(rv) && /1\. Soil health/.test(rv) && /One field/.test(rv), 'review lists the answers');
  ok(/Last two summers were too dry/.test(rv) && /noted, not used by the simulator/.test(rv), 'worries are marked "noted, not used by the simulator"');
  ok(/Drains well/.test(rv) && /noted, not used by the simulator/.test(await page.textContent('.fs-q-review li:has(.fs-q-change[aria-label="Change Drainage"])')), 'land answers that change nothing are marked as noted');
  ok(/shapes the advice/.test(await page.textContent('.fs-q-review li:has(.fs-q-change[aria-label="Change Lease"])')) && /shapes the advice: 2\. Profit/.test(rv), 'answers that only change the advice say so');
  ok(/Thinking about cattle/.test(rv), 'anything else shown');
  await shot(page, 'q-14-review');
  await page.click('#fs-q-next'); await page.waitForTimeout(900);
  ok(!(await page.isVisible('#fs-setup')), 'Start closes it');
  const st = await page.evaluate(() => {
    const S = FS.store.get(), c = S.controls, ex = FS.data.initialControls.other.exclude || [];
    const cmp = {}; FS.data.farm.fields.forEach(f => { cmp[f.id] = FS.engine.compare(f.id, c).map(x => x.plan); });
    const chat = [...document.querySelectorAll('#fs-chat-list .fs-msg')].map(e => e.textContent);
    return { names: FS.data.farm.fields.map(f => f.name), acres: FS.data.farm.fields.map(f => f.acres), site: FS.engine.site().id, ic: FS.data.initialControls, plans: c.crops.plans, irr: c.crops.irrigation, irrVis: !document.getElementById('fs-irrig-row').hidden,
      ex, cex: c.other.exclude, prio: c.other.priority, contracted: c.other.contracted, cs: c.other.costShare, trial: c.crops.trialAcres, cmp, recs: S.current.summary.recommendations.map(r => r.plan),
      chatMsgs: chat, why: S.current.summary.why.map(w => w.text).join(' '), body: document.body.innerText, farmBtn: document.getElementById('fs-farm-btn').textContent, foot: document.getElementById('fs-foot').textContent,
      legend: [...document.querySelectorAll('.fv-fname')].map(e => e.textContent), opts: [...document.querySelectorAll('#fs-crops-field option')].map(o => o.textContent), planOpts: [...document.querySelectorAll('#fs-crops-plan option')].map(o => o.value),
      baseRye: FS.store.get().baseline.summary.fields.creek.greenCoverMonths, selected: S.selectedField, saved: localStorage.getItem('fieldshift.farm.v1') };
  });
  ok(st.site === other && st.names.join() === 'North 60,Creek 30,West 200,South 100', 'site and field names: ' + st.site + ' ' + st.names.join(', '));
  ok(st.legend.join() === st.names.join() && /West 200 · 200 ac/.test(st.opts.join()), 'map legend and field list follow');
  ok(/Champaign/.test(st.farmBtn) && /Champaign County/.test(st.foot), 'header and footer name the county: ' + st.farmBtn);
  ok(JSON.stringify(st.plans) === JSON.stringify({ north: 'rye-corn', creek: 'rye-corn', west: 'rye-soy', south: 'rye-soy' }) && JSON.stringify(st.ic.crops.plans) === JSON.stringify(st.plans), 'already plant cover crops: current plans are the rye plans: ' + JSON.stringify(st.plans));
  ok(st.baseRye > 0, 'baseline carries the rye cover (' + st.baseRye + ' months of roots)');
  ok(st.irr === 'july-aug' && st.ic.crops.irrigation === 'july-aug' && st.irrVis, 'irrigated: july-aug is the normal practice and the control is shown');
  ok(/Irrigating an inch a week in July and August/.test(st.why), 'the run says it is irrigating');
  ok(JSON.stringify(st.ex.slice().sort()) === JSON.stringify(['corn-corn', 'oats-cover']) && JSON.stringify(st.cex.slice().sort()) === JSON.stringify(['corn-corn', 'oats-cover']), 'exclude: oats and corn after corn');
  ok(st.prio === 'cover', 'first priority Soil health ranks by ground cover');
  ok(st.contracted === 40 && st.cs === true, 'contracted 40% and cost-share on');
  ok(st.trial.creek === 30 && st.trial.west === 200, 'one field: whole-field trial acres');
  const allPlans = [].concat(...Object.values(st.cmp), st.recs);
  ok(allPlans.length > 0 && !allPlans.some(p => p === 'oats-cover' || p === 'corn-corn'), 'no oats and no corn after corn in any compare list or recommendation: ' + [...new Set(allPlans)].join(','));
  ok(!st.planOpts.some(p => p === 'oats-cover' || p === 'corn-corn'), 'the plan list in the Crops box leaves them out too');
  const first = st.chatMsgs[0] || '';
  ok(/^Hi Sam\./.test(first) && /Based on your answers:/.test(first), 'opening message greets by name and says "Based on your answers:": ' + first.slice(0, 60));
  const bullets = (first.match(/•/g) || []).length;
  ok(bullets >= 1 && bullets <= 4, 'at most 4 advice lines (' + bullets + ')');
  ok(/Ranked by ground cover, because you put Soil health first\. Next: Profit\./.test(first), 'priorities line');
  ok(/End the rye by roller-crimping, mowing or tillage instead of a herbicide\./.test(first), 'no sprayer note');
  ok(/You rent on a short lease: look at this season's result more than the 44-season average\./.test(first), 'short lease note');
  ok(/Rye costs about \$37 an acre \(less \$30 with first-time cost-share\)\./.test(first), 'low budget note');
  ok(!/oats need a local buyer/i.test(first), 'no oats-buyer note when oats are excluded');
  ok(!/Hi Sam/.test(st.chatMsgs.slice(1).join(' ')), 'greeting only once');
  ok(JSON.parse(st.saved).v === 2 && JSON.parse(st.saved).name === 'Sam' && JSON.parse(st.saved).wont.length === 2, 'answers saved in localStorage');
  ok(!/NaN|undefined|Infinity/.test(st.body), 'no NaN / undefined on the page');
  // advice also lands on the matching card lines: compare shows the current (rye) plan's card with the rye notes and the any-plan notes
  await page.fill('#fs-chat-input', 'compare'); await page.press('#fs-chat-input', 'Enter'); await page.waitForTimeout(500);
  const chatText = await page.textContent('#fs-chat-list');
  ok((chatText.match(/short lease/g) || []).length >= 2 && /Check with your adviser:[^]*short lease: look at this season's result/.test(chatText), 'the lease note is also on the card, under "Check with your adviser"');
  ok(page.errs.length === 0, 'no page errors: ' + page.errs.join('|'));

  // ---- reload restores
  await page.close(); page = await open(ctx2);
  ok(!(await page.isVisible('#fs-setup')), 'reload: the questionnaire does not show again');
  const re = await page.evaluate(() => ({ names: FS.data.farm.fields.map(f => f.name).join(), plans: JSON.stringify(FS.store.get().controls.crops.plans), ex: (FS.data.initialControls.other.exclude || []).join(), irr: FS.store.get().controls.crops.irrigation, prio: FS.store.get().controls.other.priority, ct: FS.store.get().controls.other.contracted, first: document.querySelector('#fs-chat-list .fs-msg').textContent, irrVis: !document.getElementById('fs-irrig-row').hidden }));
  ok(re.names === 'North 60,Creek 30,West 200,South 100' && re.plans === JSON.stringify(st.plans) && re.ex.split(',').sort().join() === 'corn-corn,oats-cover' && re.irr === 'july-aug' && re.prio === 'cover' && re.ct === 40 && re.irrVis, 'reload: farm, plans, exclude, irrigation, priority, contracted restored');
  ok(/^Hi Sam\./.test(re.first) && /Based on your answers/.test(re.first), 'reload: the advice message is posted again');
  // header Change shows the saved answers on the review
  await page.click('#fs-farm-btn'); await page.waitForTimeout(150);
  ok(/Champaign County/.test(await page.textContent('#fs-q-body')) && /Sam/.test(await page.textContent('#fs-q-body')), 'Change: the review shows the saved answers');
  // ---- example restores Story exactly
  await page.click('#fs-setup-example'); await page.waitForTimeout(900);
  ok(!(await page.isVisible('#fs-setup')), 'example closes the questionnaire');
  ok(await summary(page) === story, 'example farm restores the Story results exactly (byte-identical summary)');
  const ex2 = await page.evaluate(() => ({ names: FS.data.farm.fields.map(f => f.name).join(), irrHidden: document.getElementById('fs-irrig-row').hidden, ex: FS.data.initialControls.other.exclude, ct: FS.store.get().controls.other.contracted, irr: FS.store.get().controls.crops.irrigation, plans: JSON.stringify(FS.store.get().controls.crops.plans), saved: localStorage.getItem('fieldshift.farm.v1'), chat: document.getElementById('fs-chat-list').textContent }));
  ok(ex2.names === 'North 80,Creek 40,West 40,South 120' && ex2.irrHidden && ex2.ex === undefined && ex2.ct === 30 && ex2.irr === undefined && ex2.plans === JSON.stringify({ north: 'soy', creek: 'soy', west: 'corn', south: 'corn' }), 'example: field names, irrigation, exclude, contracted, plans all back to the defaults');
  ok(ex2.saved === '{"example":true}' && !/Based on your answers|Hi Sam/.test(ex2.chat), 'example: saved as example and no advice message');
  ok(page.errs.length === 0, 'no page errors after reload and example: ' + page.errs.join('|'));
  await page.close();

  // ---- advice on the rye card itself (a farm that does not plant rye yet, so rye is an option)
  const ctx5 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await ctx5.addInitScript(() => { try { if (!sessionStorage.getItem('c')) { sessionStorage.setItem('c', '1'); localStorage.setItem('fieldshift.farm.v1', JSON.stringify({ v: 2, example: false, site: 'story-ia', fields: [{ id: 'north', acres: 80, lastCrop: 'corn' }, { id: 'creek', acres: 40, lastCrop: 'corn' }, { id: 'west', acres: 40, lastCrop: 'soybean' }, { id: 'south', acres: 120, lastCrop: 'soybean' }], limits: ['sprayer', 'labor'], costShare: 'maybe', buyers: ['nobuyer'], budget: 'none', soilTest: 'no', livestock: ['cattle'], priorities: ['Profit'], trial: 'notyet' })); } } catch (e) {} });
  page = await open(ctx5);
  const o5 = await page.textContent('#fs-chat-list .fs-msg');
  ok(/Based on your answers:/.test(o5) && (o5.match(/\u2022/g) || []).length === 4, 'opening message is capped at 4 lines');
  await page.fill('#fs-chat-input', 'compare Creek'); await page.press('#fs-chat-input', 'Enter'); await page.waitForTimeout(500);
  const rye = await page.evaluate(() => { const li = [...document.querySelectorAll('#fs-chat-list .fs-msg:last-child li')].filter(l => /rye/i.test(l.firstChild.textContent))[0]; return li ? li.textContent : ''; });
  ok(/Extra work:[^]*roller-crimping[^]*two passes/.test(rye), 'rye card: Extra work has the sprayer and labor notes');
  ok(/Check with your adviser:[^]*\$37 an acre[^]*grazed in spring[^]*you said maybe|Check with your adviser:[^]*maybe[^]*\$30 an acre/i.test(rye) || (/\$37 an acre/.test(rye) && /grazed in spring/.test(rye) && /said maybe/.test(rye)), 'rye card: budget, animals and cost-share-maybe notes under Check with your adviser');
  ok(/soil test \(about \$15–30 a sample\)/.test(rye), 'any card: soil test note');
  ok(/not ready to change yet: you can still compare options without changing anything/.test(o5) || /not ready to change yet/.test(await page.textContent('#fs-chat-list')), 'not-ready trial note');
  ok(page.errs.length === 0, 'card notes: no page errors');
  await page.close(); await ctx5.close();

  // ---- an old one-panel save still loads
  await ctx2.addInitScript(() => { try { if (!sessionStorage.getItem('old')) { sessionStorage.setItem('old', '1'); localStorage.setItem('fieldshift.farm.v1', JSON.stringify({ example: false, site: 'champaign-il', fields: [{ id: 'north', acres: 80, lastCrop: 'corn' }, { id: 'creek', acres: 40, lastCrop: 'corn' }, { id: 'west', acres: 40, lastCrop: 'soybean' }, { id: 'south', acres: 120, lastCrop: 'soybean' }], priority: 'profit', costShare: true, irrigate: true })); } } catch (e) {} });
  page = await open(ctx2);
  const old = await page.evaluate(() => ({ site: FS.engine.site().id, prio: FS.store.get().controls.other.priority, cs: FS.store.get().controls.other.costShare, irr: FS.store.get().controls.crops.irrigation, vis: !document.getElementById('fs-setup') || document.getElementById('fs-setup').hidden }));
  ok(old.site === 'champaign-il' && old.prio === 'profit' && old.cs === true && old.irr === 'july-aug' && old.vis, 'an old one-panel save is converted and skips the questionnaire');
  await page.close(); await ctx2.close();

  // ================================================================ Skip everything
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page = await open(ctx3);
  await next(page);
  let n = 0; while (await title(page) !== 'Your Farm, In Short' && n < 20) { await skip(page); n++; }
  ok(n === 13, 'Skip works on all 13 optional steps (' + n + ')');
  ok(/Not answered/.test(await page.textContent('#fs-q-body')), 'review lists the skipped steps');
  await page.click('#fs-q-next'); await page.waitForTimeout(900);
  ok(!(await page.isVisible('#fs-setup')), 'Start after skipping everything closes it');
  ok(await summary(page) === story, 'skipping everything gives the Story results exactly');
  ok(await page.evaluate(() => (FS.data.initialControls.other.exclude === undefined) && FS.store.get().controls.other.contracted === 30), 'skipped: no exclusions, contracted unchanged');
  ok(!/Based on your answers/.test(await page.textContent('#fs-chat-list')), 'skipped: no advice message');
  ok(page.errs.length === 0, 'skipped: no page errors');
  await page.close(); await ctx3.close();

  // ================================================================ keyboard only
  const ctx4 = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
  page = await open(ctx4);
  ok(await tabTo(page, 'fs-q-next'), 'keyboard: reach Start');
  await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  ok(/What should we call you/i.test(await title(page)) && await page.evaluate(() => document.activeElement.id) === 'fs-q-title', 'keyboard: Enter on Start goes to the next step, focus on its heading');
  await page.keyboard.press('Tab'); await page.keyboard.type('Kay'); await page.keyboard.press('Enter'); await page.waitForTimeout(80);
  ok(await title(page) === 'Where Is Your Farm?', 'keyboard: typing a name and pressing Enter moves on');
  await page.keyboard.press('Tab');      // the use-my-location button, then the address box
  ok(await page.evaluate(() => document.activeElement.id) === 'fs-q-locate', 'keyboard: Tab reaches use-my-location');
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement.id) === 'fs-q-addr', 'keyboard: Tab reaches the address box');
  ok(await tabTo(page, 'fs-q-next') && (await page.keyboard.press('Space'), true)); await page.waitForTimeout(80);
  ok(await title(page) === 'Your Four Fields', 'keyboard: Space on Next moves on');
  for (let i = 0; i < 9 && await title(page) !== 'What Matters Most To You?'; i++) { await tabTo(page, 'fs-q-skip'); await page.keyboard.press('Enter'); await page.waitForTimeout(60); }
  ok(await title(page) === 'What Matters Most To You?', 'keyboard: Skip by keyboard through the steps in between');
  await page.evaluate(() => document.querySelector('.fs-q-rankbtn').focus());
  await page.keyboard.press('Space'); await page.waitForTimeout(40);
  ok(await page.getAttribute('.fs-q-rankbtn[data-p="Profit"]', 'aria-pressed') === 'true' && /added as number 1/.test(await page.textContent('#fs-q-rank-live')), 'keyboard: Space picks a priority and announces it');
  ok(await tabTo(page, 'fs-q-next')); await page.keyboard.press('Enter'); await page.waitForTimeout(60);
  while (await title(page) !== 'Your Farm, In Short') { await tabTo(page, 'fs-q-skip'); await page.keyboard.press('Enter'); await page.waitForTimeout(60); }
  ok(await tabTo(page, 'fs-q-next')); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  const kb = await page.evaluate(() => ({ site: FS.engine.site().id, prio: FS.store.get().controls.other.priority, first: document.querySelector('#fs-chat-list .fs-msg').textContent, vis: document.getElementById('fs-setup').hidden, focus: document.activeElement && document.activeElement.id }));
  ok(kb.vis && kb.site === 'story-ia' && kb.prio === 'profit' && /^Hi Kay\./.test(kb.first), 'keyboard: the whole questionnaire can be done without a mouse: ' + JSON.stringify({ site: kb.site, prio: kb.prio }));
  ok(page.errs.length === 0, 'keyboard: no page errors');
  // laptop size: the buttons stay reachable on the longest step
  await page.click('#fs-farm-btn'); await page.waitForTimeout(100); await page.click('#fs-setup .fs-q-change[data-step="limits"]'); await page.waitForTimeout(100);
  const lap = await page.evaluate(() => { const sc = document.getElementById('fs-q-scroll'), nx = document.getElementById('fs-q-next').getBoundingClientRect(); return { scrolls: sc.scrollHeight > sc.clientHeight, nextVisible: nx.bottom <= innerHeight && nx.top >= 0, ox: document.documentElement.scrollWidth - innerWidth }; });
  ok(lap.scrolls && lap.nextVisible && lap.ox <= 0, '1366x768: the long step scrolls inside the card, Next stays in view');
  await page.close(); await ctx4.close();

  // ================================================================ link from EcoShifters skips it
  const hs = other;
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await open(c2, '#from=ecoshifters&site=' + hs + '&plan=rye-soy&irrigation=july&acres=60');
  ok(!(await page.isVisible('#fs-setup')), 'from=ecoshifters skips the questionnaire');
  const h = await page.evaluate(() => { const S = FS.store.get(); return { plans: S.controls.crops.plans, irr: S.controls.crops.irrigation, irrVis: !document.getElementById('fs-irrig-row').hidden, acres: FS.data.farm.fields.map(f => f.name + ':' + f.acres), sel: S.selectedField, foot: document.getElementById('fs-foot').textContent, back: !document.getElementById('fs-backrow').hidden, body: document.body.innerText, ex: FS.data.initialControls.other.exclude }; });
  ok(h.irr === 'july' && h.irrVis, 'hash: irrigation=july set and shown');
  ok(h.plans[h.sel] === 'rye-soy', 'hash: plan rye-soy on the selected field (' + h.sel + ')');
  ok(h.acres.some(a => /:60$/.test(a)), 'hash: acres=60 applied: ' + h.acres.join(', '));
  ok(!/NaN|undefined/.test(h.body) && h.back && h.ex === undefined, 'hash: no NaN, back link shown, no exclusions');
  ok(h.foot.includes('Champaign County'), 'hash: footer names the site');
  ok(page.errs.length === 0, 'hash: no page errors: ' + page.errs.join('|'));
  await page.click('#fs-farm-btn'); await page.waitForTimeout(100);
  ok(await title(page) === 'Your Farm, In Short' && /Champaign County/.test(await page.textContent('#fs-q-body')), 'hash: Change still opens the review, with the linked farm');
  await page.close();
  page = await open(c2, '#from=ecoshifters&site=nowhere&irrigation=flood&acres=abc');
  ok(!(await page.isVisible('#fs-setup')) && await page.evaluate(() => FS.store.get().controls.crops.irrigation || 'none') === 'none' && await page.evaluate(() => FS.data.farm.fields.map(f => f.acres).join()) === '80,40,40,120', 'bad hash values ignored');
  await page.close();

  // ================================================================ phone
  for (const [label, vp] of [['phone 400x700', { width: 400, height: 700 }], ['iPhone 13', { width: 390, height: 664 }]]) {
    const c3 = await browser.newContext({ viewport: vp, colorScheme: 'dark', isMobile: true, hasTouch: true });
    page = await open(c3);
    await next(page); await next(page); await next(page); await next(page);   // welcome, name, location, fields -> you and your farm
    ok(await title(page) === 'You And Your Farm', label + ': at the long step');
    const sc = await page.evaluate(() => { const s = document.getElementById('fs-q-scroll'), nx = document.getElementById('fs-q-next').getBoundingClientRect(), card = document.querySelector('.fs-setup-card').getBoundingClientRect(); return { sh: s.scrollHeight, ch: s.clientHeight, ox: document.documentElement.scrollWidth - innerWidth, nextIn: nx.bottom <= innerHeight && nx.top >= 0, cardIn: card.bottom <= innerHeight + 1 && card.top >= 0 }; });
    ok(sc.sh > sc.ch && sc.ox <= 0 && sc.nextIn && sc.cardIn, label + ': the card scrolls inside itself (' + sc.sh + ' > ' + sc.ch + '), no sideways scroll, Next in view');
    await shot(page, 'q-phone-' + vp.width + '-you');
    await page.evaluate(() => { document.getElementById('fs-q-scroll').scrollTop = 99999; }); await page.waitForTimeout(100);
    ok(await page.evaluate(() => { const r = document.getElementById('fs-q-next').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }), label + ': Next reachable after scrolling');
    await page.evaluate(() => { document.getElementById('fs-q-skip').click(); }); await page.waitForTimeout(80);
    ok(await page.evaluate(() => document.getElementById('fs-q-scroll').scrollTop) === 0, label + ': a new step starts at the top');
    while (await title(page) !== 'Your Farm, In Short') { await page.evaluate(() => { const b = document.getElementById('fs-q-skip'); (b && !b.hidden ? b : document.getElementById('fs-q-next')).click(); }); await page.waitForTimeout(40); }
    await shot(page, 'q-phone-' + vp.width + '-review');
    await page.click('#fs-q-next'); await page.waitForTimeout(800);
    ok(!(await page.isVisible('#fs-setup')) && await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, label + ': Start works, no sideways scroll');
    ok(page.errs.length === 0, label + ': no page errors');
    await page.close(); await c3.close();
  }
  await browser.close();
  console.log(bad ? bad + ' FAILED' : 'all passed'); process.exit(bad ? 1 : 0);
})();
