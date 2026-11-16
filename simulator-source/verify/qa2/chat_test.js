// Usage: node verify/qa2/chat_test.js <dist/simulator.test.html> [out.md] [--json out.json]
// Types every phrase into the real chat box and compares the resulting control values with what the phrase means.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const WET = ['wetSpring', 'wet2019'];
// [phrase, expected, setup]; expected keys: scen, temp, rain, price, nitro, plans{}, prio, field, none, reply (regex), noreply
const P0 = [
 ['What if 2012 happens again?', { scen: 'drought2012' }], ['2012', { scen: 'drought2012' }], ['simulate the drought', { scen: 'drought2012' }], ['drought year', { scen: 'drought2012' }],
 ['what about a wet spring', { scen: WET }], ['2019', { scen: ['y2019', 'wet2019'] }], ['2023 dry summer', { scen: 'dry2023' }], ['dry summer', { scen: 'dry2023' }],
 ['late spring freeze', { scen: 'lateFreeze' }], ['early fall frost', { scen: 'earlyFrost' }], ['typical year', { scen: 'typical' }], ['average year', { scen: 'typical' }],
 ['hotter by 2 degrees', { temp: 2 }], ['2 degrees warmer', { temp: 2 }], ['+3C', { temp: 3 }], ['cooler by 1 degree', { temp: -1 }], ['4 degrees hotter in a drought', { scen: 'drought2012', temp: 4 }],
 ['20% less rain', { rain: -20 }], ['rain -30%', { rain: -30 }], ['30 percent less rain', { rain: -30 }], ['50% more rainfall', { rain: 50 }], ['drier by 20%', { rain: -20 }],
 ['switch creek to rye then soybeans', { plans: { creek: 'rye-soy' } }], ['put rye on creek', { plans: { creek: 'rye-soy' } }], ['cover crop on south', { plans: { south: 'rye-corn' } }],
 ['rye before corn on west', { plans: { west: 'rye-corn' } }], ['try oats on north', { plans: { north: 'oats-cover' } }], ['corn on corn for north 80', { plans: { north: 'corn-corn' } }],
 ['corn after corn on north', { plans: { north: 'corn-corn' } }], ['continuous corn on creek', { plans: { creek: 'corn-corn' } }],
 ['beans again on south', { plans: { south: 'soy-soy' } }], ['soybeans again on west', { plans: { west: 'soy-soy' } }], ['soy after soy on west', { plans: { west: 'soy-soy' } }],
 ['plant corn on north', { none: 1, reply: /corn|option/i }], ['switch north to soybeans', { plans: { north: 'soy' } }], ['soybeens on south', { none: 1, reply: /soybeans again|option/i }],
 ['prices drop 30%', { price: -30 }], ['corn price down 20%', { price: -20 }], ['crop prices up 10%', { price: 10 }], ['nitrogen up 50%', { nitro: 50 }],
 ['fertilizer prices rise 40%', { nitro: 40 }], ['nitrogen cost down 20%', { nitro: -20 }],
 ['reset', { none: 1 }, [['crops.plans.creek', 'rye-soy'], ['weather.tempShift', 2]]], ['start over', { none: 1 }, [['other.priceChange', 10]]],
 ['compare', { none: 1, reply: /current plan/i }], ['compare with my current plan', { none: 1, reply: /current plan/i }],
 ['what should I plant', { none: 1, reply: /option|current plan/i }], ['what is best for creek 40', { none: 1, reply: /Creek 40/ }],
 ['asdfghjkl', { none: 1 }], ['hello', { none: 1 }], ['', { none: 1, noreply: 1 }], ['    ', { none: 1, noreply: 1 }],
 ['WHAT IF 2012 HAPPENS AGAIN WITH 3 DEGREES HOTTER AND 30% LESS RAIN', { scen: 'drought2012', temp: 3, rain: -30 }],
 ['run', { none: 1 }], ['simulate', { none: 1 }], ['show me north', { none: 1, field: 'north' }],
 ['2012 and rye on south', { scen: 'drought2012', plans: { south: 'rye-corn' } }], ['drought with 20% less rain and corn on corn north', { scen: 'drought2012', rain: -20, plans: { north: 'corn-corn' } }],
 ['how much money will I make?', { none: 1, reply: /\$/ }], ['what if it rains 100%', { rain: 50, reply: /cap|limit/i }], ['rain minus 80%', { rain: -50, reply: /cap|limit/i }],
 ['hotter by 10 degrees', { temp: 4, reply: /cap|limit/i }], ['make it hot', { temp: 2 }], ['what if there is a flood', { none: 1, norun: 1, reply: /flood is not modelled.*wet spring/i }], ['north 80', { none: 1, field: 'south' }],
 ['2012 corn after corn on north', { scen: 'drought2012', plans: { north: 'corn-corn' } }], ['x'.repeat(5000), { none: 1 }], ['<script>window.__xss=1</script> 2012', { scen: 'drought2012', noxss: 1 }],
 ['What if corn prices fall 25% and rain is 15% lower?', { price: -25, rain: -15 }], ['rain is 15% lower', { rain: -15 }], ['15% lower rain', { rain: -15 }], ['25% reduction in rainfall', { rain: -25 }], ['rainfall down 20%', { rain: -20 }],
 ['no more rye', { plans: { creek: 'soy' } }, [['crops.plans.creek', 'rye-soy']]], ['undo', { none: 1 }], ['hotter and drier', { temp: 2, rain: -20 }], ['2 C hotter and 20% drier', { temp: 2, rain: -20 }],
 ['3 degrees cooler', { temp: -2, reply: /cap|limit/i }], ['what about 2012 with prices down 30%', { scen: 'drought2012', price: -30 }],
 ['wet spring corn after corn on north and creek to rye', { scen: WET, plans: { north: 'corn-corn', creek: 'rye-soy' } }], ['y'.repeat(600), { none: 1 }],
 // ---- new phrases (this round)
 ['15% less rain', { rain: -15 }], ['rain 15% higher', { rain: 15 }], ['20 percent more rain', { rain: 20 }], ['temperature up 2 degrees', { temp: 2 }], ['1.5 degrees warmer', { temp: 1.5 }],
 ['it will be cooler and wetter', { temp: -1, rain: 20 }], ['make it drier', { rain: -20 }], ['corn prices -25%', { price: -25 }],
 ['prices up 10 percent and nitrogen down 20 percent', { price: 10, nitro: -20 }], ['30 percent less rain and 2 degrees hotter, then corn on corn north', { rain: -30, temp: 2, plans: { north: 'corn-corn' } }],
 ['I care most about profit', { prio: 'profit' }], ['I care most about saving money', { prio: 'profit' }], ['I want a safe bet', { prio: 'risk' }], ['I care most about ground cover', { prio: 'cover' }],
 ['I care most about soil', { prio: 'cover' }], ['rank by risk', { prio: 'risk' }], ['I care most about saving water', { none: 1, reply: /water/i }],
 ['like 1988', { scen: 'drought1988' }], ['2019 season', { scen: 'y2019' }], ['what about 2008', { scen: WET }], ['2003', { scen: 'y2003' }], ['1984', { scen: 'y1984' }], ['2011', { scen: 'typical' }], ['typical year 2011 weather', { scen: 'typical' }], ['the 2030 season', { none: 1, reply: /1982|2025/ }],
 ['corm on corm north', { plans: { north: 'corn-corn' } }], ['soybeens again on south', { plans: { south: 'soy-soy' } }], ['nroth to soybeans', { plans: { north: 'soy' } }],
 ['no rye on creek', { plans: { creek: 'soy' } }, [['crops.plans.creek', 'rye-soy']]], ["don't plant rye on south", { plans: { south: 'corn' } }, [['crops.plans.south', 'rye-corn']]],
 ['drop the rye', { plans: { creek: 'soy' } }, [['crops.plans.creek', 'rye-soy']]], ['creek field to rye', { plans: { creek: 'rye-soy' } }], ['the 120 to rye', { plans: { south: 'rye-corn' } }],
 ['south forty rye', { plans: { south: 'rye-corn' } }], ['oats on the 80', { plans: { north: 'oats-cover' } }], ['oats', { none: 1, reply: /oats/i }],
 ['rye then soybeans', { none: 1, reply: /option|soybeans/i }], ['rye then soybeans on creek', { plans: { creek: 'rye-soy' } }], ['compare plans for north', { none: 1, reply: /North 80/ }],
 ['rye on north, creek and west', { plans: { north: 'rye-soy', creek: 'rye-soy', west: 'rye-corn' } }], ['frost', { none: 1, reply: /late|early/i }],
 ['beans again', { plans: { south: 'soy-soy' } }], ['2012 and 20% less rain and rye on creek', { scen: 'drought2012', rain: -20, plans: { creek: 'rye-soy' } }],
 ['hotter', { temp: 2 }], ['colder', { temp: -1 }], ['no more rye anywhere', { none: 1 }],
 // ---- questions are read-only (qa_report finding 1, 8)
 ['why is rye worse', { none: 1, norun: 1, reply: /rye/i }], ['which field is most at risk', { none: 1, norun: 1, reply: /most at risk|no field stands out/i }], ['why', { none: 1, norun: 1, reply: /weather|rain|season|stood out/i }],
 ['explain the risk', { none: 1, norun: 1, reply: /weather|rain|season|stood out/i }], ['how reliable is this', { none: 1, norun: 1, reply: /Checked against.*off by about \d+ points/i }], ['how accurate', { none: 1, norun: 1, reply: /off by about \d+ points/i }],
 ['where does the data come from', { none: 1, norun: 1, reply: /NASA POWER.*1982-2025.*NRCS.*NASS/i }], ['can you guarantee profit', { none: 1, norun: 1, reply: /^No\. It replays past weather on your soils; it cannot promise a price or a season\./ }],
 ['whats the safest option', { none: 1, norun: 1, reply: /safest|bad years/i }], ['cheapest option', { none: 1, norun: 1, reply: /earns|profit/i }], ['most profitable option', { none: 1, norun: 1, reply: /earns|profit/i }],
 ['what happens if I do nothing', { none: 1, norun: 1, reply: /baseline.*farm/i }], ['is it going to rain', { none: 1, norun: 1, reply: /question/i }],
 ['whats the safest option for creek', { none: 1, norun: 1, reply: /Creek 40/ }], ['which field is most at risk', { none: 1, norun: 1, reply: /most at risk|no field stands out/i, items: 0 }, [['weather.scenario', 'drought2012']]],
 ['what should I plant', { none: 1, reply: /option/i, items: 1 }], ['what is best for creek 40', { none: 1, reply: /Creek 40/, items: 1 }],
 // ---- real undo
 ['undo', { plans: { creek: 'soy' } }, [], ['switch creek to rye then soybeans']], ['undo', { none: 1, reply: /nothing to undo/i, norun: 1 }],
 ['undo', { temp: 0, scen: 'drought2012' }, [], ['2012', '3 degrees hotter']], ['undo', { none: 1, reply: /nothing to undo/i, norun: 1 }, [], ['rye on creek', ['weather.tempShift', 1]]],
 ['undo', { none: 1, reply: /Undid/ , scen: 'typical' }, [], ['2012']],
 // ---- garbled notes (finding 7)
 ['plant corn on soybean ground', { none: 1, norun: 1, reply: /Which field/i }], ['what about 1993 flood', { scen: 'y1993', reply: /flood is not modelled; I used the real 1993 weather\./i }],
 ['derecho 2020', { scen: 'y2020', reply: /derecho \(wind storm\) is not modelled; I used the real 2020 weather\./i }], ['2 degrees hotter and 2 degrees cooler', { temp: 2, reply: /two temperature changes; I used the first \(\+2 °C\)\./ }],
 ['what if 2012 happens again '.repeat(40), { scen: 'drought2012', maxreply: 400 }], ['what about 2050', { none: 1, norun: 1, reply: /1982.*2025/, noresult: 1 }],
 ['put all my fields in oats', { plans: { north: 'oats-cover', creek: 'oats-cover' }, reply: /West 40 and South 120.*follow soybeans/i, maxreply: 700 }],
 ['hail', { none: 1, norun: 1, reply: /not modelled/i }], ['what about tornado', { none: 1, norun: 1, reply: /not modelled/i }],
 ['rain 20% less and 30% less rain', { rain: -20, reply: /two rain changes/ }], ['2012 2012', { scen: 'drought2012', noreply_re: /not 2012/ }],
 // ---- oats money (finding 2)
 ['put all my fields in oats', { plans: { north: 'oats-cover', creek: 'oats-cover' }, reply: /Money is not shown while oats is in the plan, because oats prices are placeholders\./, nodollar: 1 }],

 // ---- planting date and weather events (API_V3)
 ['plant 2 weeks earlier', { plant: -14, reply: /14 days earlier/ }], ['plant a week later', { plant: 7, reply: /7 days later/ }], ['plant on time', { plant: 0 }, [['crops.plantShiftDays', 14]]],
 ['plant 3 weeks later', { plant: 21 }], ['plant 10 days earlier', { plant: -7, reply: /steps of a week/ }], ['plant 2 months later', { plant: 21, reply: /3 weeks/ }], ['plant earlier', { plant: -7, reply: /No amount given/ }],
 ['planting a week sooner', { plant: -7 }], ['plant rye on creek 2 weeks earlier', { plant: -14, plans: { creek: 'rye-soy' } }], ['plant normal', { none: 1, norun: 1, reply: /already/ }],
 ['dry July', { events: ['dryspell:7:moderate'] }], ['a dry spell in August', { events: ['dryspell:8:moderate'] }], ['wet June', { events: ['wetspell:6:moderate'] }], ['very wet June', { events: ['wetspell:6:severe'] }],
 ['heat wave in July', { events: ['heatwave:7:moderate'], reply: /extra water use.*could not be measured.*heat alone changes little/, trace: /Chat Rules.*Crop Model replayed 44 NASA POWER seasons.*Analysis/ }], ['severe drought in July', { events: ['dryspell:7:severe'] }], ['what if there is a dry July and 2012', { events: ['dryspell:7:moderate'], scen: 'drought2012' }],
 ['dry July and wet September', { events: ['dryspell:7:moderate', 'wetspell:9:moderate'] }], ['dry June, dry July, dry August and dry September', { events: ['dryspell:6:moderate', 'dryspell:7:moderate', 'dryspell:8:moderate'], reply: /Three weather events at most/ }],
 ['remove the events', { events: [] }, [['weather.events', [{ type: 'dryspell', month: 7, severity: 'moderate' }, { type: 'heatwave', month: 8, severity: 'moderate' }]]]],
 ['no heat wave', { events: ['dryspell:7:moderate'] }, [['weather.events', [{ type: 'dryspell', month: 7, severity: 'moderate' }, { type: 'heatwave', month: 8, severity: 'moderate' }]]]],
 ['no heat wave', { none: 1, norun: 1, reply: /no such weather event/i }], ['drought', { scen: 'drought2012' }], ['dry summer', { scen: 'dry2023' }],
 // ---- misroute, water, trace (this round)
 ['how do I fix compacted soil on my north 80?', { none: 1, norun: 1, field: 'south', reply: /^(?!.*Showing selected)(?!.*person who set up)(?=.*What if 2012)/i, trace: /Chat Rules.*AI helper is off/ }],
 ['show me north', { none: 1, field: 'north', trace: /Chat Rules.*picked a field/ }], ['open creek', { none: 1, field: 'creek' }], ['what is north 80 like', { none: 1, field: 'south' }],
 ['what if there is less water this year', { events: ['dryspell:7:moderate', 'dryspell:8:moderate'], reply: /not modeled yet.*dry July and August/, trace: /Chat Rules.*Crop Model replayed 44 NASA POWER seasons.*Analysis/ }],
 ['my water allocation is cut', { events: ['dryspell:7:moderate', 'dryspell:8:moderate'], reply: /not modeled yet/ }], ['less irrigation', { events: ['dryspell:7:moderate', 'dryspell:8:moderate'], reply: /not modeled yet/ }],
 ['water shortage this summer', { events: ['dryspell:7:moderate', 'dryspell:8:moderate'] }], ['much less water', { events: ['dryspell:7:severe', 'dryspell:8:severe'] }],
 ['reset', { none: 1, reply: /typical season \(2011 weather\)/ }, [['crops.plans.creek', 'rye-soy']]],
 ['What if 2012 happens again?', { scen: 'drought2012', trace: /Chat Rules read your question and found 1 change > Crop Model replayed 44 NASA POWER seasons > Analysis compared the plans/ }],
 // ---- irrigation (API_V4 section 3)
 ['an inch a week in July', { irrig: 'july', reply: /inch a week in July/ }], ['irrigate in July and August', { irrig: 'july-aug' }], ['irrigate June to August', { irrig: 'jun-aug' }],
 ['irrigate July', { irrig: 'july' }], ['1 inch a week in July and August', { irrig: 'july-aug' }], ['irrigate from June through August', { irrig: 'jun-aug' }],
 ['no irrigation', { irrig: 'none' }, [['crops.irrigation', 'july']]], ['stop irrigating', { irrig: 'none' }, [['crops.irrigation', 'jun-aug']]], ['no irrigation', { none: 1, norun: 0, reply: /already off/ }],
 ['irrigate', { none: 1, norun: 1, reply: /When should I irrigate/ }], ['irrigate in August only', { none: 1, norun: 1, reply: /July, in July and August, or from June to August/ }],
 ['what if 2012 happens again and irrigate July and August', { scen: 'drought2012', irrig: 'july-aug' }], ['dry July and irrigate in July', { events: ['dryspell:7:moderate'], irrig: 'july' }],
 ['irrigate July and August and rye on creek', { irrig: 'july-aug', plans: { creek: 'rye-soy' } }],
 ['undo', { irrig: 'none', reply: /Undid/ }, [], ['an inch a week in July']], ['reset', { irrig: 'none' }, [['crops.irrigation', 'july']]],
 ['how does irrigation work', { none: 1, norun: 1 }],
 ['undo', { events: [], reply: /Undid/ }, [], ['dry July']], ['undo', { plant: 0, reply: /Undid/ }, [], ['plant 2 weeks earlier']],
 ['reset', { events: [], plant: 0 }, [['weather.events', [{ type: 'dryspell', month: 7, severity: 'moderate' }]], ['crops.plantShiftDays', -14]]],
];
// the published list of farmer questions (verify/chat_rules.json) runs through the same checks
const PUB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chat_rules.json'), 'utf8')).cases.map(c => {
  const e = Object.assign({}, c.expect); ['reply', 'trace'].forEach(k => { if (typeof e[k] === 'string') e[k] = new RegExp(e[k], 'i'); });
  return [c.question, e];
});
const P = P0.concat(PUB);
function flat(c) { return { irrig: (c.crops && c.crops.irrigation) || 'none', plant: c.crops.plantShiftDays || 0, events: (c.weather.events || []).map(e => e.type + ':' + e.month + ':' + e.severity), scen: c.weather.scenario, temp: c.weather.tempShift, rain: c.weather.rainChange, price: c.other.priceChange, nitro: c.other.nitrogenChange, prio: c.other.priority || 'balanced', plans: c.crops.plans, acres: c.crops.trialAcres, cs: c.other.costShare, con: c.other.contracted }; }
(async () => {
  const file = process.argv[2], out = process.argv[3];
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // the first-open "Set up your farm" panel must not block the test: pretend the farmer already chose the example farm
  await ctx.addInitScript(() => { try { localStorage.setItem('fieldshift.farm.v1', '{"example":true}'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
  await page.goto('file://' + path.resolve(file)); await page.waitForTimeout(600);
  const init = await page.evaluate(() => JSON.parse(JSON.stringify(FS.data.initialControls)));
  const rows = []; let pass = 0;
  for (const [phrase, exp, setup, pre] of P) {
    await page.evaluate(([init, setup]) => {
      const A = FS.actions; (function walk(o, p) { Object.keys(o).forEach(k => { const q = p ? p + '.' + k : k; if (o[k] && typeof o[k] === 'object') walk(o[k], q); else A.setControl(q, o[k], 'test'); }); })(init, '');
      A.setControl('crops.plantShiftDays', 0, 'test'); A.setControl('weather.events', [], 'test'); A.setControl('crops.irrigation', 'none', 'test');
      A.setControl('other.priority', 'balanced', 'test'); A.selectField('south', 'test'); (setup || []).forEach(s => A.setControl(s[0], s[1], 'test')); window.__xss = 0;
      A.setControl('weather.tempShift', 1.5, 'test'); A.setControl('weather.tempShift', init.weather.tempShift, 'test');   // a non-chat change empties the undo stack
      FS.actions.runSimulation('test');
    }, [init, setup || null]);
    for (const step of (pre || [])) {
      if (Array.isArray(step)) await page.evaluate(([p, v]) => FS.actions.setControl(p, v, 'ui'), step);
      else { await page.fill('#fs-chat-input', step); await page.press('#fs-chat-input', 'Enter'); await page.waitForTimeout(40); }
    }
    const before = await page.evaluate(() => ({ n: FS.store.get().chat.length, runs: FS.store.get().runs.length, c: JSON.parse(JSON.stringify(FS.store.get().controls)) }));
    await page.fill('#fs-chat-input', phrase); await page.press('#fs-chat-input', 'Enter'); await page.waitForTimeout(40);
    const after = await page.evaluate(() => { const S = FS.store.get(); const lastA = S.chat.filter(m => m.role === 'assistant'); return { nItems: (lastA.length && lastA[lastA.length - 1].items || []).length, trace: lastA.length && lastA[lastA.length - 1].trace ? lastA[lastA.length - 1].trace.join(' > ') : '', chat: S.chat.map(m => m.text), runs: S.runs.length, c: JSON.parse(JSON.stringify(S.controls)), field: S.selectedField, xss: window.__xss, err: 0 }; });
    const a = flat(after.c), b = flat(before.c), i0 = flat(JSON.parse(JSON.stringify(init)));
    const replies = after.chat.slice(before.n); const reply = replies.slice(phrase.trim() ? 1 : 0).join(' / ').replace(/\s+/g, ' ');
    const probs = []; const e = exp;
    if (e.irrig !== undefined ? a.irrig !== e.irrig : a.irrig !== b.irrig) probs.push('irrigation=' + a.irrig + (e.irrig !== undefined ? ' (want ' + e.irrig + ')' : ' (unexpected)'));
    if (e.plant !== undefined ? a.plant !== e.plant : a.plant !== b.plant) probs.push('plant=' + a.plant + (e.plant !== undefined ? ' (want ' + e.plant + ')' : ' (unexpected)'));
    if (e.events !== undefined ? JSON.stringify(a.events) !== JSON.stringify(e.events) : JSON.stringify(a.events) !== JSON.stringify(b.events)) probs.push('events=' + JSON.stringify(a.events) + (e.events !== undefined ? ' (want ' + JSON.stringify(e.events) + ')' : ' (unexpected)'));
    const okv = (act, want) => Array.isArray(want) ? want.indexOf(act) >= 0 : act === want;
    // base for "expected value of everything else": state before typing
    const want = { scen: b.scen, temp: b.temp, rain: b.rain, price: b.price, nitro: b.nitro, prio: b.prio };
    if (setup && (e.none) && /reset|start over/.test(phrase)) { Object.assign(want, { scen: i0.scen, temp: i0.temp, rain: i0.rain, price: i0.price, nitro: i0.nitro }); }
    ['scen', 'temp', 'rain', 'price', 'nitro', 'prio'].forEach(k => { if (e[k] !== undefined) { if (!okv(a[k], e[k])) probs.push(k + '=' + a[k] + ' (want ' + JSON.stringify(e[k]) + ')'); } else if (a[k] !== want[k]) probs.push('unexpected ' + k + '=' + a[k]); });
    const planWant = Object.assign({}, b.plans, e.plans || {}); if (/reset|start over/.test(phrase)) Object.assign(planWant, i0.plans);
    Object.keys(planWant).forEach(f => { if (a.plans[f] !== planWant[f]) probs.push('plan ' + f + '=' + a.plans[f] + ' (want ' + planWant[f] + ')'); });
    if (JSON.stringify(a.acres) !== JSON.stringify(b.acres) && !/reset|start over/.test(phrase)) probs.push('acres changed');
    if (e.field && after.field !== e.field) probs.push('field=' + after.field + ' (want ' + e.field + ')');
    if (e.trace && !e.trace.test(after.trace)) probs.push('trace lacks ' + e.trace + ' (got: ' + after.trace + ')');
    if (e.reply && !e.reply.test(reply)) probs.push('reply lacks ' + e.reply);
    if (e.norun && after.runs > before.runs) probs.push('ran a simulation');
    if (e.items !== undefined && ((after.nItems > 0) !== !!e.items)) probs.push('items=' + after.nItems);
    if (e.maxreply && reply.length > e.maxreply) probs.push('reply too long (' + reply.length + ')');
    if (e.noreply_re && e.noreply_re.test(reply)) probs.push('reply has ' + e.noreply_re);
    if (e.noresult && /Result:/.test(reply)) probs.push('printed a Result line');
    if (e.nodollar && /Result:[^/]*\$/.test(reply)) probs.push('Result line has dollars');
    if (e.noreply && replies.length) probs.push('replied to empty input');
    if (e.noxss && after.xss) probs.push('XSS ran');
    // honesty: "Showing" only when something changed
    const changed = JSON.stringify(a) !== JSON.stringify(b) || after.field !== 'south';
    if (/^Showing /.test(reply) && !changed && !/reset|start over/.test(phrase) && !(e.scen && okv(b.scen, e.scen))) probs.push('says Showing but nothing changed');
    const ok = probs.length === 0; if (ok) pass++;
    const diff = []; ['scen', 'temp', 'rain', 'price', 'nitro', 'prio'].forEach(k => { if (a[k] !== b[k]) diff.push(k + '=' + a[k]); }); Object.keys(a.plans).forEach(f => { if (a.plans[f] !== b.plans[f]) diff.push('plan.' + f + '=' + a.plans[f]); });
    if (after.field !== 'south') diff.push('field->' + after.field);
    rows.push({ phrase: phrase.length > 60 ? phrase.slice(0, 40) + '…(' + phrase.length + ' chars)' : phrase, reply: reply.length > 230 ? reply.slice(0, 230) + '…' : reply, ran: after.runs > before.runs + 0 && after.runs - before.runs > 0 ? 'yes' : 'no', diff: diff.join('; ') || 'none', ok, probs: probs.join('; ') });
  }
  let md = '# Chat phrase results\n\nFile: ' + file + '\n\nPassed ' + pass + ' of ' + P.length + '. Page errors: ' + (errs.length ? errs.join(' | ') : 'none') + '\n\n| Phrase | Reply | Ran | Controls changed | Result |\n|---|---|---|---|---|\n';
  rows.forEach(r => { md += '| ' + r.phrase.replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' | ' + r.reply.replace(/\|/g, '\\|') + ' | ' + r.ran + ' | ' + r.diff + ' | ' + (r.ok ? 'PASS' : 'FAIL: ' + r.probs.replace(/\|/g, '\\|')) + ' |\n'; });
  if (out) fs.writeFileSync(out, md); else console.log(md);
  console.log('pass rate ' + (100 * pass / P.length).toFixed(1) + '%', '|', 'pass', pass, 'of', P.length, errs.length ? 'ERRORS ' + errs.join('|') : '');
  await browser.close();
})();
