'use strict';
// Run with: node --test tests/engine.test.js
// Covers CONTRACT.md + API_V2.md shape, determinism, timing, sourced management effects, scenarios, temperature response
// and the presence of the NASS validation numbers. Uses the real NASA POWER data in src/climate.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
global.window = global;
const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'data.js'));
require(path.join(SRC, 'climate.js'));
require(path.join(SRC, 'store.js'));
require(path.join(SRC, 'engine.js'));

const clone = (o) => JSON.parse(JSON.stringify(o));
function controls(id, ts, rain, priority) {
  const c = clone(FS.data.initialControls); c.weather.scenario = id || 'typical';
  if (ts) c.weather.tempShift = ts; if (rain) c.weather.rainChange = rain; if (priority) c.other.priority = priority; return c;
}
const run = (c, base) => FS.engine.run({ farm: FS.data.farm, controls: c, baseline: base || null });
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const STAGES = ['bare', 'residue', 'planted', 'emerged', 'vegetative', 'flowering', 'grainfill', 'mature', 'harvested', 'cover'];
const CROPS = ['corn', 'soybean', 'rye', 'oats', 'none'];
const FLAGS = ['heat', 'drought', 'frost', 'waterlogged', 'erosion', 'planting-delay'];
const SOURCES = () => Object.keys(FS.data.sources);
const C = FS.data.climate, YEARS = C.meta.years;
const ids = FS.data.farm.fields.map((f) => f.id);
const CARD = ['why', 'evidence', 'benefits', 'gaps', 'risks'];

// timing first, so the caches and the JIT are cold (API_V2 section 6)
test('0. timing: warm + first run, later runs, compare', () => {
  let t = process.hrtime.bigint(); FS.engine.warm(); const warmMs = ms(t);
  t = process.hrtime.bigint(); run(controls('typical')); const firstMs = ms(t);
  const later = [];
  for (let i = 0; i < 10; i++) { t = process.hrtime.bigint(); run(controls(i % 2 ? 'drought2012' : 'y2019')); later.push(ms(t)); }
  t = process.hrtime.bigint(); FS.engine.compare('creek', controls('typical')); const cmpMs = ms(t);
  t = process.hrtime.bigint(); run(controls('typical', 2, -10)); const newShiftMs = ms(t);
  later.sort((a, b) => a - b);
  console.log('warm ms', warmMs.toFixed(0), '| first run ms', firstMs.toFixed(1), '| warm + first', (warmMs + firstMs).toFixed(0),
    '| later runs median/max ms', later[5].toFixed(1), later[9].toFixed(1), '| compare ms', cmpMs.toFixed(1), '| run with a new weather shift ms', newShiftMs.toFixed(0));
  assert.ok(warmMs + firstMs < 250, 'warm + first run should be well under 250 ms (target 150), got ' + (warmMs + firstMs));
  assert.ok(later[9] < 50, 'later runs < 50 ms, got ' + later[9]);
  assert.ok(cmpMs < 100, 'compare < 100 ms, got ' + cmpMs);
});

test('1. result format matches CONTRACT.md and API_V2.md', () => {
  const base = run(controls('typical'));
  const r = run(controls('drought2012', 1, -10), base);
  for (const k of ['runId', 'label', 'sample', 'inputs', 'weeks', 'summary']) assert.ok(k in r, 'missing ' + k);
  assert.equal(typeof r.label, 'string'); assert.equal(r.weeks.length, 53);
  r.weeks.forEach((w) => {
    assert.match(w.date, /^\d{4}-\d\d-\d\d$/); assert.equal(typeof w.label, 'string');
    ['tmaxC', 'rainMm'].forEach((k) => assert.ok(Number.isFinite(w.weather[k]), k));
    ['heavyRain', 'frost', 'heat'].forEach((k) => assert.equal(typeof w.weather[k], 'boolean'));
    ids.forEach((id) => {
      const f = w.fields[id]; assert.ok(f, 'field ' + id);
      assert.ok(CROPS.includes(f.crop), f.crop); assert.ok(STAGES.includes(f.stage), f.stage);
      ['green', 'soilWater', 'stress'].forEach((k) => assert.ok(Number.isFinite(f[k]) && f[k] >= 0 && f[k] <= 1, k + '=' + f[k]));
      f.flags.forEach((x) => assert.ok(FLAGS.includes(x), x));
    });
  });
  assert.equal(r.weeks[0].date, '2026-11-16'); assert.equal(r.weeks[52].date, '2027-11-15');
  const s = r.summary;
  ['acres', 'returnTotal', 'returnVsBaselineTotal'].forEach((k) => assert.ok(Number.isFinite(s.farm[k]), k));
  ids.forEach((id) => {
    const f = s.fields[id]; assert.ok(f);
    ['acres', 'trialAcres', 'yieldPctOfNormal', 'yieldBuPerAcre', 'returnPerAcre', 'returnVsBaselinePerAcre', 'greenCoverMonths'].forEach((k) => assert.ok(Number.isFinite(f[k]), id + '.' + k));
    ['plan', 'planLabel', 'crop', 'note'].forEach((k) => assert.equal(typeof f[k], 'string', k));
    assert.ok(f.moneyNote === null || typeof f.moneyNote === 'string');
    assert.ok(f.worstWeek === null || /^\d{4}-\d\d-\d\d$/.test(f.worstWeek));
  });
  assert.ok(Array.isArray(s.events));
  s.events.forEach((e) => {
    assert.match(e.date, /^\d{4}/); assert.equal(typeof e.type, 'string'); assert.equal(typeof e.text, 'string'); assert.ok(SOURCES().includes(e.source), e.source);
    assert.ok(e.fieldId === null || ids.includes(e.fieldId));
  });
  assert.ok(s.why.length >= 2);
  s.why.forEach((w) => { assert.equal(typeof w.text, 'string'); assert.ok(SOURCES().includes(w.source)); });
  assert.match(s.why[1].text, /NASA POWER/); assert.match(s.why[1].text, /not a forecast/);
  assert.equal(typeof s.validation.text, 'string'); assert.ok(s.validation.text.length > 20);
  assert.ok(s.recommendationNote === null || typeof s.recommendationNote === 'string');
  assert.ok(s.recommendations.length <= 3);
  if (!s.recommendations.length) assert.equal(typeof s.recommendationNote, 'string', 'empty recommendations need a note');
  // JSON-safe (no NaN / undefined)
  assert.ok(!/NaN|undefined/.test(JSON.stringify(r)));
  // baseline against itself is zero
  Object.values(base.summary.fields).forEach((f) => assert.equal(f.returnVsBaselinePerAcre, 0));
});

function checkItem(x, withRank) {
  if (withRank) { assert.ok(ids.includes(x.fieldId)); assert.equal(typeof x.title, 'string'); assert.ok(SOURCES().includes(x.source)); }
  assert.ok(FS.data.plans[x.plan], x.plan);
  ['deltaPerAcre', 'deltaThisSeason', 'betterSeasons', 'nSeasons', 'worst5PerAcre', 'greenCoverMonthsAdded'].forEach((k) => assert.ok(Number.isFinite(x[k]), k + '=' + x[k]));
  assert.ok(x.betterSeasons >= 0 && x.betterSeasons <= x.nSeasons); assert.equal(x.nSeasons, YEARS.length);
  assert.ok(['low', 'medium', 'high'].includes(x.risk)); assert.equal(typeof x.tooClose, 'boolean');
  CARD.forEach((k) => { assert.equal(typeof x.card[k], 'string', 'card.' + k); assert.ok(x.card[k].length > 10, 'card.' + k); });
  assert.ok(x.moneyNote === null || typeof x.moneyNote === 'string');
}

test('2. recommendations follow the priority, are honest and exclude oats', () => {
  for (const pr of ['balanced', 'profit', 'risk', 'cover']) {
    const s = run(controls('typical', 0, 0, pr)).summary;
    s.recommendations.forEach((x, i) => {
      checkItem(x, true); assert.equal(x.rank, i + 1);
      assert.notEqual(FS.data.plans[x.plan].label.indexOf('Oats'), 0, 'oats must not be ranked');
      if (pr === 'profit') assert.ok(x.deltaPerAcre > 0, 'profit recommendations must earn more on average');
      if (pr === 'cover') assert.ok(x.greenCoverMonthsAdded > 0, 'cover recommendations must add ground cover');
    });
    if (pr === 'profit') for (let i = 1; i < s.recommendations.length; i++) assert.ok(s.recommendations[i - 1].deltaPerAcre >= s.recommendations[i].deltaPerAcre);
    if (!s.recommendations.length) assert.match(s.recommendationNote, /current plans/);
    console.log(pr, '->', s.recommendations.map((x) => x.title + ' ' + x.deltaPerAcre + '$ ' + x.betterSeasons + '/' + x.nSeasons + (x.tooClose ? ' close' : '')).join('; ') || s.recommendationNote);
  }
});

test('3. compare(fieldId, controls) lists every plan, current first', () => {
  ids.forEach((id) => {
    const f = FS.data.farm.fields.find((x) => x.id === id), rows = FS.engine.compare(id, controls('drought2012'));
    const opts = FS.data.planOptions[f.lastCrop];
    assert.equal(rows.length, opts.length);
    assert.equal(rows[0].isCurrent, true); assert.equal(rows[0].plan, FS.data.initialControls.crops.plans[id]);
    assert.equal(rows[0].deltaPerAcre, 0); assert.equal(rows[0].deltaThisSeason, 0);
    rows.forEach((x) => { checkItem(x, false); assert.equal(typeof x.label, 'string'); assert.ok(Number.isFinite(x.yieldPctThisSeason)); });
    rows.filter((x) => FS.data.plans[x.plan].sequence.some((s) => s.crop === 'oats')).forEach((x) => assert.match(x.moneyNote, /rough guesses with no source/));
  });
});

test('4. scenarios: named list, any-year replay, scenario() helper', () => {
  const named = ['typical', 'drought2012', 'drought1988', 'wetSpring', 'dry2023', 'lateFreeze', 'earlyFrost'];
  assert.deepEqual(FS.data.weatherScenarios.map((s) => s.id), named);
  FS.data.weatherScenarios.forEach((s) => {
    ['label', 'phrase', 'note'].forEach((k) => assert.equal(typeof s[k], 'string', s.id + '.' + k));
    assert.ok(YEARS.includes(s.year));
    assert.deepEqual(FS.engine.scenario(s.id), { id: s.id, label: s.label, phrase: s.phrase, year: s.year, note: s.note });
    assert.equal(run(controls(s.id)).weeks.length, 53);
  });
  const y = FS.engine.scenario('y2019');
  assert.equal(y.id, 'y2019'); assert.equal(y.year, 2019); assert.equal(y.label, '2019 season'); assert.equal(y.phrase, 'the 2019 season');
  YEARS.forEach((yr) => assert.equal(FS.engine.scenario('y' + yr).year, yr));
  // the years behind the named scenarios, recomputed from the data
  const S0 = Date.UTC(2026, 10, 16), idx = (md) => { const m = +md.slice(0, 2); return Math.round((Date.UTC(m >= 11 ? 2026 : 2027, m - 1, +md.slice(3)) - S0) / 864e5); };
  const sum = (y, a, b) => { let t = 0; for (let d = idx(a); d <= idx(b); d++) t += C.seasons[y].rain[d] / 10; return t; };
  const wettest = YEARS.reduce((b, y) => (sum(y, '04-01', '06-30') > sum(b, '04-01', '06-30') ? y : b), YEARS[0]);
  assert.equal(FS.engine.scenario('wetSpring').year, wettest);
  let late = null, early = null;
  YEARS.forEach((y) => {
    const s = C.seasons[y]; let ls = -1, ef = -1;
    for (let d = idx('03-01'); d < idx('07-01'); d++) if (s.tmin[d] <= 0) ls = d;
    for (let d = idx('07-01'); d < 365; d++) if (s.tmin[d] <= 0) { ef = d; break; }
    if (!late || ls > late[1]) late = [y, ls]; if (ef >= 0 && (!early || ef < early[1])) early = [y, ef];
  });
  assert.equal(FS.engine.scenario('lateFreeze').year, late[0]); assert.equal(FS.engine.scenario('earlyFrost').year, early[0]);
});

test('5. deterministic', () => {
  const a = JSON.stringify(run(controls('wetSpring', 2, 10))), b = JSON.stringify(run(controls('wetSpring', 2, 10)));
  assert.equal(a, b);
  assert.equal(JSON.stringify(FS.engine.compare('north', controls('y2017'))), JSON.stringify(FS.engine.compare('north', controls('y2017'))));
});

test('6. corn after corn costs the sourced ~8.5% (between 5 and 10%)', () => {
  // creek (corn last) vs west (soybean last): same soil (AWC 180, slope 1, poorly drained), so the rotation is the difference
  const cc = YEARS.map((y) => FS.engine.evalYear('creek', 'corn-corn', y).pct), cs = YEARS.map((y) => FS.engine.evalYear('west', 'corn', y).pct);
  const ratio = cc.reduce((a, b) => a + b, 0) / cs.reduce((a, b) => a + b, 0), typ = FS.engine.scenario('typical').year, k = YEARS.indexOf(typ);
  console.log('corn after corn / corn after soybean, mean over seasons:', ratio.toFixed(3), '| typical year', (cc[k] / cs[k]).toFixed(3), '(ISU budgets 193/211 = 0.915)');
  assert.ok(ratio >= 0.90 && ratio <= 0.95, 'penalty 5-10%, got ' + ((1 - ratio) * 100).toFixed(1) + '%');
  assert.ok(cc.filter((v, i) => v < cs[i]).length >= YEARS.length - 1);
});

test('7. cereal rye adds months with living roots (crop alive in the field)', () => {
  const typ = FS.engine.scenario('typical').year;
  const soy = FS.engine.evalYear('creek', 'soy', typ).res.rootDays / 30.4, rye = FS.engine.evalYear('creek', 'rye-soy', typ).res.rootDays / 30.4;
  console.log('living-root months creek: soybean', soy.toFixed(1), '| rye then soybean', rye.toFixed(1));
  assert.ok(rye > soy + 2);
  assert.ok(soy > 2 && soy < 6, 'a soybean crop is alive roughly 3-5 months, got ' + soy);
  const cornM = FS.engine.evalYear('west', 'corn', typ).res.rootDays / 30.4; assert.ok(cornM > soy && cornM < 7, 'corn ' + cornM);
  const c = controls('typical'); c.crops.plans.creek = 'rye-soy';
  assert.ok(run(c).summary.fields.creek.greenCoverMonths > run(controls('typical')).summary.fields.creek.greenCoverMonths + 2);
  const row = FS.engine.compare('creek', controls('typical')).find((x) => x.plan === 'rye-soy');
  assert.ok(row.greenCoverMonthsAdded > 2);
  assert.ok(Math.abs(FS.engine.evalYear('creek', 'rye-soy', typ).pct - FS.engine.evalYear('creek', 'soy', typ).pct) < 5);
});

test('8. frost scenarios emit frost events and flags on the frost date and explain them', () => {
  for (const id of ['lateFreeze', 'earlyFrost']) {
    const r = run(controls(id)), s = r.summary, fe = s.events.filter((e) => e.type === 'frost');
    assert.ok(fe.length >= 1, id + ' needs a frost event');
    const date = id === 'lateFreeze' ? '2027-05-15' : '2027-09-19';
    assert.ok(fe.some((e) => e.date === date), id + ' frost event on ' + date + ': ' + fe.map((e) => e.date).join(','));
    const w = r.weeks.find((x) => x.date <= date && date < new Date(Date.parse(x.date) + 7 * 864e5).toISOString().slice(0, 10));
    assert.ok(Object.values(w.fields).some((f) => f.flags.includes('frost')), id + ' frost flag in the week of ' + date);
    assert.ok(w.weather.frost);
    assert.match(s.why[0].text, id === 'lateFreeze' ? /15 May 1997/ : /19 September 1991/);
    console.log(id, '| why[0]:', s.why[0].text);
  }
});

test('9. a wet spring delays planting because the soil is too wet to work', () => {
  const r = run(controls('wetSpring')), s = r.summary;
  const pd = s.events.filter((e) => e.type === 'planting-delay');
  assert.ok(pd.length >= 1, 'planting-delay event'); assert.ok(pd.some((e) => /wet/.test(e.text)), pd.map((e) => e.text).join(' | '));
  assert.ok(r.weeks.some((w) => Object.values(w.fields).some((f) => f.flags.includes('planting-delay'))));
  console.log('wet spring:', pd.map((e) => e.text).join(' | '));
  const y19 = run(controls('y2019')).summary.events.filter((e) => e.type === 'planting-delay');
  assert.ok(y19.length >= 2);
});

test('10. temperature response: no gain from heating in a typical year, no cliff for 1 C cooler', () => {
  const typ = FS.engine.scenario('typical').year, shifts = [-2, -1, 0, 1, 2, 4], tab = {};
  for (const y of [typ, 2012]) tab[y] = shifts.map((ts) => Math.round(FS.engine.evalYear('west', 'corn', y, { tempShift: ts }).pct));
  console.log('corn % of normal on West 40 at', shifts.join('/'), 'C:', JSON.stringify(tab));
  const t = tab[typ], z = t[2];
  assert.ok(t[3] <= z + 2 && t[4] <= z + 2 && t[5] <= z + 2, 'heating must not raise typical-year corn by more than 2 points');
  assert.ok(t[5] <= t[4] + 1 && t[4] <= t[3] + 1, 'warmer is not better');
  assert.ok(t[1] >= z - 5, '1 C cooler must not cost more than 5 points, got ' + (t[1] - z));
  const d12 = tab[2012]; assert.ok(d12[5] < d12[2] && d12[4] <= d12[2], '2012 gets worse when hotter');
});

test('11. real-data behaviour: 2012 among the worst, 2023 milder, typical near 100', () => {
  const typ = FS.engine.scenario('typical').year, base = FS.data.initialControls.crops.plans;
  FS.data.farm.fields.forEach((f) => {
    const p = base[f.id], all = YEARS.map((y) => FS.engine.evalYear(f.id, p, y).pct), k12 = YEARS.indexOf(2012);
    const rank = all.filter((v) => v < all[k12]).length + 1;
    assert.ok(rank <= 5, f.id + ' 2012 should be among the 5 lowest, rank ' + rank);
    assert.ok(all[YEARS.indexOf(2023)] > all[k12], f.id + ' 2023 milder than 2012');
    const pt = all[YEARS.indexOf(typ)]; assert.ok(pt >= 90 && pt <= 110, f.id + ' typical ' + pt);
  });
});

test('12. validation numbers are present and honest', () => {
  const v = FS.engine.validation();
  assert.ok(v && v.corn && v.soybean, 'VALIDATION block written by tools/validate.py');
  for (const c of ['corn', 'soybean']) for (const m of ['process', 'ridge', 'gbm']) {
    const x = v[c][m]; ['r', 'rho', 'rmsePct', 'rmseTrendPct', 'skill'].forEach((k) => assert.ok(Number.isFinite(x[k]), c + '.' + m + '.' + k));
  }
  assert.match(v.text, /NASS/); assert.match(v.text, /big droughts/); assert.match(v.text, /no better than the long-term yield trend/); assert.match(v.text, /typical error of \d+ points/);
  assert.ok(!/correlation/.test(v.text), 'the headline must not quote a correlation');
  assert.ok(v.riskK && v.riskK.corn > 1 && v.riskK.soybean > 1, 'riskK written by tools/validate.py');
  assert.equal(run(controls('typical')).summary.validation.text, v.text);
  console.log('validation:', v.text);
});

test('13. money rules: cost-share cap, 0 trial acres, no single-dataset temperatures', () => {
  const base = run(controls('typical'));
  const c = controls('typical'); c.crops.plans = { north: 'rye-soy', creek: 'rye-soy', west: 'rye-corn', south: 'rye-corn' };
  c.other.costShare = true; const on = run(c, base); c.other.costShare = false; const off = run(c, base);
  assert.equal(on.summary.farm.returnTotal - off.summary.farm.returnTotal, 160 * FS.data.economics.costShareRye, 'cost-share paid on at most 160 acres');
  const z = controls('typical'); z.crops.plans.creek = 'rye-soy'; z.crops.trialAcres.creek = 0;
  const r = run(z, base), f = r.summary.fields.creek;
  assert.equal(f.trialAcres, 0); assert.equal(f.plan, 'soy'); assert.equal(f.returnVsBaselinePerAcre, 0);
  assert.notEqual(r.weeks[2].fields.creek.crop, 'rye', '0 trial acres: weeks show the current plan');
  for (const id of ['typical', 'drought2012', 'drought1988', 'dry2023']) {
    const s = run(controls(id, 4)).summary, txt = JSON.stringify(s.events) + JSON.stringify(s.why);
    assert.ok(!/\d\s*°?\s*C\b(?! or colder)/.test(txt.replace(/[+−-]\d°C/g, '')), id + ': no printed temperatures in events/why');
  }
  const oats = controls('typical'); oats.crops.plans.north = 'oats-cover';
  assert.match(run(oats).summary.fields.north.moneyNote, /rough guesses with no source/);
});

test('14. warming slider: published floor on the loss, shift 0 and cooling unchanged', () => {
  const RATE = { corn: 0.074, soybean: 0.031 };
  for (const [f, p, crop] of [['west', 'corn', 'corn'], ['north', 'soy', 'soybean'], ['south', 'corn', 'corn'], ['creek', 'rye-soy', 'soybean']]) {
    for (const y of [2011, 2012, 1988, 2023]) {
      const y0 = FS.engine.evalYear(f, p, y).pct;
      assert.equal(FS.engine.evalYear(f, p, y, { tempShift: 0 }).pct, y0, 'shift 0 is the plain replay');
      for (const ts of [1, 2, 4]) {
        const w = FS.engine.evalYear(f, p, y, { tempShift: ts }).pct;
        assert.ok(w <= y0 * (1 - RATE[crop] * ts) + 1e-6, f + ' ' + y + ' +' + ts + ': ' + w.toFixed(1) + ' vs ' + y0.toFixed(1));
      }
    }
  }
  assert.ok(FS.engine.evalYear('west', 'corn', 2012, { tempShift: -2 }).pct > FS.engine.evalYear('west', 'corn', 2012).pct, 'cooling is the model only: a cooler drought year does better');
  // the compare() table and run() agree on the warmed yield
  const c = controls('typical', 4), r = run(c).summary.fields.west, e = FS.engine.evalYear('west', 'corn', 2011, { tempShift: 4 });
  assert.equal(r.yieldPctOfNormal, Math.round(e.pct));
  const rows = FS.engine.compare('west', c); assert.ok(rows[0].yieldPctThisSeason <= Math.round(FS.engine.evalYear('west', 'corn', 2011).pct * (1 - 0.074 * 4)) + 1);
  assert.match(run(c).summary.why.map((w) => w.text).join(' '), /published average loss/);
  assert.ok(!/published average loss/.test(run(controls('typical')).summary.why.map((w) => w.text).join(' ')));
  console.log('+4 C typical year: corn West 40', e.pct.toFixed(1), 'soy North 80', FS.engine.evalYear('north', 'soy', 2011, { tempShift: 4 }).pct.toFixed(1));
});

test('15. risk numbers: widened to the observed spread, label consistent with the ranking, worst-5 close to observed', () => {
  const val = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'data', 'validation.json'), 'utf8')), v = FS.engine.validation(), ref = FS.engine._ref();
  for (const crop of ['corn', 'soybean']) {
    const k = v.riskK[crop], p = ref.pct[crop], s = p.slice().sort((a, b) => a - b), m = (s[21] + s[22]) / 2;
    const w = p.map((x) => 1 + (x / m - 1) * k).sort((a, b) => a - b).slice(0, 5), w5 = w.reduce((a, b) => a + b, 0) / 5, obs = val[crop].risk.worst5Obs;
    console.log(crop, 'k', k, 'widened worst-5 mean', w5.toFixed(2), 'observed', obs, 'unwidened', (p.slice().sort((a, b) => a - b).slice(0, 5).reduce((a, b) => a + b, 0) / 500).toFixed(2));
    assert.ok(Math.abs(w5 - obs) < 0.06, crop + ' worst-5 ' + w5 + ' vs observed ' + obs);
  }
  for (const pr of ['risk', 'balanced', 'cover', 'profit']) for (const id of ['typical', 'drought2012']) {
    const rows = FS.engine.compare('south', controls(id, 0, 0, pr));
    rows.forEach((x) => { if (!x.isCurrent) assert.equal(x.risk, x.worst5PerAcre < -100 ? 'high' : x.worst5PerAcre < -30 ? 'medium' : 'low', 'risk label follows worst5PerAcre'); });
  }
  const rec = run(controls('typical', 0, 0, 'risk')).summary.recommendations;
  for (let i = 1; i < rec.length; i++) assert.ok(rec[i - 1].worst5PerAcre >= rec[i].worst5PerAcre, 'risk ranking follows worst5PerAcre');
});

test('16. too close to call: flips under price ratio, drags, costs; says why; cost-share counted once in the average', () => {
  let flipped = 0, total = 0;
  for (const id of ids) FS.engine.compare(id, controls('typical')).forEach((x) => {
    if (x.isCurrent) return; total++;
    if (x.tooClose) { flipped++; assert.match(x.card.why, /Too close to call/); }
    else assert.ok(!/Too close to call/.test(x.card.why));
  });
  console.log('options too close to call at default settings:', flipped, 'of', total);
  const sw = FS.engine.compare('south', controls('typical')).find((x) => x.plan === 'soy-soy');
  assert.ok(sw.tooClose); assert.match(sw.card.why, /Too close to call: the answer flips if the corn to soybean price ratio moves by 10%/);
  assert.ok(flipped >= 1 && flipped < total, 'some but not all options are close calls');
  // an option that is much worse never flips (corn after corn on North 80 is about -$135)
  assert.ok(!FS.engine.compare('north', controls('typical')).find((x) => x.plan === 'corn-corn').tooClose);
  // cost-share: one-time payment, full in this season, 1/44 in the average
  const a = FS.engine.compare('creek', controls('typical')).find((x) => x.plan === 'rye-soy'), c = controls('typical'); c.other.costShare = true;
  const b = FS.engine.compare('creek', c).find((x) => x.plan === 'rye-soy');
  assert.equal(b.deltaThisSeason - a.deltaThisSeason, 30); assert.ok(b.deltaPerAcre - a.deltaPerAcre <= 1 && b.deltaPerAcre - a.deltaPerAcre >= 0);
});

test('17. user-visible texts: benefits, cards and events say what the model computed', () => {
  const E = FS.data.economics, rows = [].concat(...ids.map((id) => FS.engine.compare(id, controls('typical'))));
  const by = (p) => rows.find((x) => x.plan === p);
  assert.match(by('soy-soy').card.benefits, new RegExp('\\$' + Math.round(E.nitrogen.lbPerAcreCornAfterSoy * E.nitrogen.dollarsPerLb) + ' per acre'));
  assert.ok(!/\$232 lower/.test(by('soy-soy').card.benefits));
  assert.match(by('rye-soy').card.benefits, /living roots/); assert.match(by('rye-soy').card.benefits, /31%/); assert.ok(!/green|holds soil and nitrogen/.test(by('rye-soy').card.benefits));
  assert.ok(!/bushels/.test(by('corn-corn').card.benefits));
  assert.match(by('corn').card.gaps, /tile drainage is not modelled/); assert.match(by('corn').card.gaps, /Heat damage cannot be estimated/);
  rows.forEach((x) => assert.ok(!/ground (is )?green|green cover|keeps the (ground|field) green/.test(JSON.stringify(x.card)), x.plan));
  const bad = [];
  for (const y of YEARS) {
    const s = run(controls('y' + y)).summary;
    s.events.forEach((e) => {
      const m = new Date(e.date).getUTCMonth();
      if (/soil water|%\s*soil/.test(e.text)) bad.push('soil water ' + e.text);
      if (e.type === 'erosion' && [11, 0, 1, 2].includes(m) && !/snowmelt/.test(e.text)) bad.push('winter rain ' + e.text);
      if (e.type === 'heat' && /lost|loss of|% of/.test(e.text)) bad.push('heat claim ' + e.text);
      if (e.type === 'heavy-rain') assert.match(e.text, /\d+ mm in (a|one) day/);
      if (e.type === 'frost' && e.fieldId && !/lost/.test(e.text)) bad.push('frost without loss ' + e.text);
      if (e.type === 'waterlogged') assert.match(e.text, /tile drainage is not modelled/);
    });
  }
  assert.deepEqual(bad, []);
  const why12 = run(controls('drought2012')).summary.why.map((w) => w.text).join(' ');
  assert.match(why12, /Prices are held at today's level/);
  assert.match(FS.data.weatherScenarios[0].note, /322 mm/);
});

// ---------------------------------------------------------------- API_V3: planting shift, weather events, season strip
const evc = (sc, events, pd, plans) => {
  const c = controls(sc); if (events) c.weather.events = events; if (pd) c.crops.plantShiftDays = pd;
  if (plans) Object.assign(c.crops.plans, plans); return c;
};
const pctOf = (r, id) => r.summary.fields[id].yieldPctOfNormal;
const strip = (r) => { const x = clone(r); delete x.inputs; return x; };

test('18. defaults: plantShiftDays 0 and events [] are in initialControls and change nothing', () => {
  assert.equal(FS.data.initialControls.crops.plantShiftDays, 0);
  assert.deepEqual(FS.data.initialControls.weather.events, []);
  for (const sc of ['typical', 'drought2012', 'wetSpring']) {
    const a = controls(sc), b = clone(a);
    delete b.crops.plantShiftDays; delete b.weather.events;
    assert.deepEqual(strip(run(a)), strip(run(b)), sc + ': missing fields behave as 0 and []');
  }
  // a shifted run must not pollute the caches of the unshifted run
  const before = JSON.stringify(strip(run(controls('typical'))));
  run(evc('typical', [{ type: 'dryspell', month: 7, severity: 'severe' }], 14)); run(evc('typical', null, -7));
  assert.equal(JSON.stringify(strip(run(controls('typical')))), before);
  const e = FS.engine.evalYear('west', 'corn', 2011, {}), e0 = FS.engine.evalYear('west', 'corn', 2011, { plantShiftDays: 0, events: [] });
  assert.equal(e.pct, e0.pct);
});

test('19. planting shift: earlier planting matures earlier, later planting costs yield, no gain beyond the sourced curves', () => {
  let earlier = 0, later = 0;
  YEARS.forEach((y) => {
    ['west', 'north'].forEach((id) => {
      const plan = id === 'west' ? 'corn' : 'soy', a = FS.engine.evalYear(id, plan, y, { plantShiftDays: -14 }), b = FS.engine.evalYear(id, plan, y, {});
      assert.ok(a.res.plantDay <= b.res.plantDay, 'earlier target never plants later');
      if (a.res.matDay < b.res.matDay) earlier++; if (a.res.matDay > b.res.matDay) later++;
    });
  });
  assert.ok(earlier >= 20, 'earlier planting moves maturity earlier in many seasons, got ' + earlier);
  assert.equal(later, 0, 'and never later');
  const a12 = FS.engine.evalYear('west', 'corn', 2012, { plantShiftDays: -14 }), b12 = FS.engine.evalYear('west', 'corn', 2012, {});
  assert.ok(a12.res.matDay < b12.res.matDay, '2012: planting and maturity are earlier');
  // later: the ISU planting-date curve applies, so a three-week delay cannot raise corn or soybean yield in a typical year
  const base = run(controls('typical')), late = run(evc('typical', null, 21));
  ['west', 'south'].forEach((id) => assert.ok(pctOf(late, id) < pctOf(base, id) - 3, id + ' corn 21 days later loses at least 3 points'));
  ['north', 'creek'].forEach((id) => assert.ok(pctOf(late, id) < pctOf(base, id) - 3, id + ' soybean 21 days later loses at least 3 points'));
  // the corn planting-date curve is never beaten by an earlier date: yields stay within a few points of normal
  const early = run(evc('typical', null, -14));
  ids.forEach((id) => assert.ok(pctOf(early, id) <= pctOf(base, id) + 4, id + ' earlier planting is not a large gain'));
  assert.ok(run(evc('typical', null, 7)).summary.why.some((w) => /7 days later than usual on every field/.test(w.text)));
  assert.ok(run(evc('typical', null, -7)).summary.why.some((w) => /7 days earlier than usual on every field/.test(w.text)));
  assert.ok(!run(controls('typical')).summary.why.some((w) => /than usual on every field/.test(w.text)));
});

test('20. weather events: dry July lowers corn, wet June in a wet year does not inflate, heat wave adds no heat penalty', () => {
  const base = run(controls('typical')), dry = run(evc('typical', [{ type: 'dryspell', month: 7, severity: 'severe' }]));
  const mod = run(evc('typical', [{ type: 'dryspell', month: 7, severity: 'moderate' }]));
  assert.ok(pctOf(dry, 'south') < pctOf(base, 'south'), 'severe dry July lowers corn in a typical year');
  ids.forEach((id) => { assert.ok(pctOf(dry, id) <= pctOf(base, id), id + ' never gains from a dry July'); assert.ok(pctOf(dry, id) <= pctOf(mod, id), id + ': severe is at least as bad as moderate'); });
  assert.ok(dry.summary.why.some((w) => /severe dry July/.test(w.text)));
  const d12 = run(evc('drought2012', [{ type: 'dryspell', month: 7, severity: 'severe' }])), b12 = run(controls('drought2012'));
  ids.forEach((id) => assert.ok(pctOf(d12, id) <= pctOf(b12, id), id + ' 2012 plus a severe dry July is no better'));
  // wet June in the wet year: no absurd rise (waterlogging can only cost, never add)
  const wb = run(controls('wetSpring')), ww = run(evc('wetSpring', [{ type: 'wetspell', month: 6, severity: 'severe' }]));
  ids.forEach((id) => assert.ok(pctOf(ww, id) <= pctOf(wb, id) + 1, id + ' wet June in 2008 does not raise yield'));
  const wt = run(evc('typical', [{ type: 'wetspell', month: 6, severity: 'severe' }]));
  ids.forEach((id) => assert.ok(pctOf(wt, id) <= pctOf(base, id) + 2, id + ' wet June in a typical year does not raise yield much'));
  // heat wave: no heat-damage penalty (Yh unchanged), only extra water use; says so plainly
  const hw = [{ type: 'heatwave', month: 7, severity: 'severe' }];
  const h = FS.engine.evalYear('south', 'corn', 2012, { events: hw }), h0 = FS.engine.evalYear('south', 'corn', 2012, {});
  assert.equal(h.res.Yh, h0.res.Yh, 'heat damage factor untouched');
  assert.ok(h.res.etc.reduce((a, b) => a + b, 0) > h0.res.etc.reduce((a, b) => a + b, 0), 'ET demand rises');
  assert.ok(h.pct <= h0.pct + 1e-9, 'a heat wave cannot raise yield');
  const hr = run(evc('drought2012', hw));
  assert.ok(hr.summary.why.some((w) => /cannot show how much yield heat itself costs/.test(w.text) && /extra water use/.test(w.text)));
  // events are capped at 3 and bad entries are ignored
  const many = [1, 2, 3, 4, 5].map((m) => ({ type: 'dryspell', month: m, severity: 'moderate' }));
  assert.deepEqual(strip(run(evc('typical', many))), strip(run(evc('typical', many.slice(0, 3)))));
  assert.deepEqual(strip(run(evc('typical', [{ type: 'flood', month: 7, severity: 'severe' }, { type: 'dryspell', month: 13, severity: 'severe' }, null]))), strip(base));
  // events change the label and the weekly weather
  assert.ok(/severe dry Jul/.test(dry.label));
  const jul = (r) => r.weeks.filter((w) => w.date >= '2027-07-01' && w.date <= '2027-07-31').reduce((s, w) => s + w.weather.rainMm, 0);
  assert.ok(jul(dry) < jul(base) * 0.5, 'July rain in the weekly weather drops');
});

test('21. seasons(fieldId, controls): shape, 44 seasons, current equals plan when unchanged, oats money hidden, fast', () => {
  const t0 = process.hrtime.bigint(); const s0 = FS.engine.seasons('north', controls('typical')); const first = ms(t0);
  assert.equal(s0.fieldId, 'north'); assert.equal(s0.years.length, 44); assert.equal(s0.years[0], 1982); assert.equal(s0.years[43], 2025);
  ['current', 'plan'].forEach((k) => { assert.equal(s0[k].pct.length, 44); assert.equal(s0[k].perAcre.length, 44); assert.equal(typeof s0[k].plan, 'string'); });
  assert.equal(s0.diffPerAcre.length, 44);
  assert.equal(s0.current.plan, 'soy'); assert.equal(s0.plan.plan, 'soy');
  assert.deepEqual(s0.plan, s0.current); s0.diffPerAcre.forEach((d) => assert.equal(d, 0));
  s0.current.pct.forEach((p) => assert.ok(p >= 0 && p <= 125));
  // current plan matches run() for the selected season (rounded)
  const k = YEARS.indexOf(2012), r12 = run(controls('drought2012'));
  assert.ok(Math.abs(s0.current.pct[k] - pctOf(r12, 'north')) <= 0.51); assert.ok(Math.abs(s0.current.perAcre[k] - r12.summary.fields.north.returnPerAcre) <= 1);
  // a different plan: diff = plan - current, and it agrees with compare()
  const c = controls('typical'); c.crops.plans.north = 'rye-soy';
  const s1 = FS.engine.seasons('north', c);
  assert.equal(s1.current.plan, 'soy'); assert.equal(s1.plan.plan, 'rye-soy'); assert.deepEqual(s1.current, s0.current);
  s1.diffPerAcre.forEach((d, i) => assert.equal(d, s1.plan.perAcre[i] - s1.current.perAcre[i]));
  const cmp = FS.engine.compare('north', c).filter((x) => x.plan === 'rye-soy')[0], mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mean(s1.diffPerAcre) - cmp.deltaPerAcre) <= 1.5, 'mean difference matches compare()');
  // shifts and events flow through
  const e = evc('typical', [{ type: 'dryspell', month: 7, severity: 'severe' }], 7), s2 = FS.engine.seasons('south', e), s3 = FS.engine.seasons('south', controls('typical'));
  assert.notDeepEqual(s2.current.pct, s3.current.pct);
  // oats: money hidden (null), yield percent shown
  c.crops.plans.north = 'oats-cover'; const so = FS.engine.seasons('north', c);
  assert.ok(so.plan.perAcre.every((v) => v === null)); assert.ok(so.diffPerAcre.every((v) => v === null)); assert.ok(so.plan.pct.every((v) => Number.isFinite(v)));
  assert.ok(so.current.perAcre.every((v) => Number.isFinite(v)));
  assert.equal(FS.engine.seasons('nowhere', c), null);
  // timing: warmed, repeated calls
  FS.engine.seasons('west', controls('typical')); const t = process.hrtime.bigint(); for (let i = 0; i < 10; i++) FS.engine.seasons('west', controls('typical')); const per = ms(t) / 10;
  console.log('seasons() first call ms', first.toFixed(1), '| warm per call ms', per.toFixed(2));
  assert.ok(per < 50 && first < 50, 'seasons() under 50 ms');
});

test('22. sources: unused entries removed', () => {
  ['imerg', 'smap', 'modis', 'cdl'].forEach((k) => assert.ok(!(k in FS.data.sources), k));
  ['power', 'nrcs', 'isu'].forEach((k) => assert.ok(k in FS.data.sources, k));
});

// ---------------------------------------------------------------- API_V4: setFarm, irrigation, card lines
const DEFAULT_FIELDS = [{ id: 'north', acres: 80, lastCrop: 'corn' }, { id: 'creek', acres: 40, lastCrop: 'corn' }, { id: 'west', acres: 40, lastCrop: 'soybean' }, { id: 'south', acres: 120, lastCrop: 'soybean' }];
const snapshot = () => {
  const out = [];
  for (const sid of ['typical', 'drought2012', 'wetSpring']) {
    const c = controls(sid, sid === 'wetSpring' ? 2 : 0); c.other.costShare = true;
    out.push(run(c), ...ids.map((id) => FS.engine.compare(id, c)), ...ids.map((id) => FS.engine.seasons(id, c)));
  }
  return JSON.stringify(out);
};
// a second site for the tests: the real one from src/sites.js when it exists, else Story's weather with other soils (not validated)
function otherSite() {
  const real = (FS.data.sites || []).filter((s) => s.id !== 'story-ia')[0];
  if (real) return real.id;
  const soil = (n, a, d, g, sl) => ({ name: n, awcMmPerM: a, aws150cm: a * 0.15, drainage: d, hydgrp: g, slopePct: sl, point: [-97, 41] });
  FS.data.sites = (FS.data.sites || []).concat([{ id: 'synthetic-ne', name: 'Synthetic County, Nebraska', short: 'Synthetic, NE', state: 'NE', lat: 41, lon: -97, validated: false, climate: null,
    soils: { north: soil('Sandy loam', 110, 'Well drained', 'A', 3), creek: soil('Sandy loam', 120, 'Well drained', 'A', 2), west: soil('Silt loam', 200, 'Poorly drained', 'C', 1), south: soil('Loam', 150, 'Moderately well drained', 'B', 6) },
    normalYield: { corn: 190, soybean: 58 }, source: {} }]);
  return 'synthetic-ne';
}
const stripNew = (s) => s.replace(/,"work":"[^"]*","trySmall":"[^"]*"/g, '');

test('23. setFarm with the defaults gives identical results; another site changes them; no stale caches', () => {
  const A = snapshot();
  assert.equal(FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS }).ok, true);
  assert.equal(snapshot(), A, 'defaults restored must be byte-identical');
  const other = otherSite();
  const t = process.hrtime.bigint();
  const r = FS.engine.setFarm({ site: other, fields: [{ id: 'north', acres: 160, lastCrop: 'soybean' }] });
  assert.equal(r.ok, true);
  const bFirst = run(controls('typical')); const firstMs = ms(t);
  const B = snapshot();
  assert.notEqual(B, A, 'another site must change the results');
  assert.equal(FS.data.farm.fields[0].name, 'North 160'); assert.equal(FS.data.initialControls.crops.plans.north, 'corn'); assert.equal(FS.data.initialControls.crops.trialAcres.north, 160);
  const why = bFirst.summary.why.map((w) => w.text).join(' ');
  if (!FS.engine.site().validated) assert.match(why, /not checked against its own county's harvests/);
  const t2 = process.hrtime.bigint(); run(controls('drought2012')); const laterMs = ms(t2);
  console.log('setFarm: first run after setFarm ms', firstMs.toFixed(0), '| later run ms', laterMs.toFixed(1));
  assert.ok(firstMs < 300, 'first run after setFarm < 300 ms, got ' + firstMs);
  assert.ok(laterMs < 50, 'later run < 50 ms, got ' + laterMs);
  // A, setFarm B, run, setFarm A, run == first run
  assert.equal(FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS }).ok, true);
  assert.equal(snapshot(), A, 'back to Story: identical to the first run (no stale cache)');
  assert.equal(FS.engine.setFarm({ site: 'no-such-site' }).ok, false);
});

test('24. other sites: notes do not quote Iowa numbers; costs gap; unvalidated line only for unvalidated sites', () => {
  const A = run(controls('typical')).summary.why.map((w) => w.text).join(' ');
  assert.doesNotMatch(A, /not checked against its own county/);
  const other = otherSite(); FS.engine.setFarm({ site: other });
  const st = FS.engine.site();
  FS.data.weatherScenarios.forEach((s) => { if (st.state !== 'IA') assert.doesNotMatch(s.note, /Iowa|bu\/acre/, s.id + ': ' + s.note); });
  const c = FS.engine.compare('creek', controls('typical'));
  if (st.state !== 'IA') c.forEach((it) => assert.match(it.card.gaps, /Costs are Iowa State budgets; check your local costs/));
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS });
  FS.engine.compare('creek', controls('typical')).forEach((it) => assert.doesNotMatch(it.card.gaps, /check your local costs/));
});

test('25. irrigation: none is identical; july raises 2012 corn and costs the pumping; wet year loses the cost', () => {
  const base = controls('drought2012'), irr = controls('drought2012'); irr.crops.irrigation = 'july';
  const none = controls('drought2012'); none.crops.irrigation = 'none';
  const rn = run(none), rb = run(base); assert.equal(JSON.stringify([rn.weeks, rn.summary]), JSON.stringify([rb.weeks, rb.summary]));
  const cost = FS.engine._irrigation().dollarsPerAcreInch * FS.engine._irrigation().inches.july;
  const a = FS.engine.evalYear('west', 'corn', 2012, {}), b = FS.engine.evalYear('west', 'corn', 2012, { irrigation: 'july' }), d = FS.engine.evalYear('west', 'corn', 2012, { irrigation: 'july-aug' });
  assert.ok(b.pct > a.pct + 3, 'july irrigation raises 2012 corn: ' + a.pct + ' -> ' + b.pct);
  assert.ok(d.pct >= b.pct - 0.5);
  assert.ok(Math.abs((b.m.cost - a.m.cost) - cost) < 1e-6, 'cost added = inches x $/inch');
  const wa = FS.engine.evalYear('west', 'corn', 2008, {}), wb = FS.engine.evalYear('west', 'corn', 2008, { irrigation: 'july' });
  assert.ok(Math.abs(wa.pct - wb.pct) < 0.5, 'a wet year gains no yield');
  assert.ok(Math.abs((wa.ret - wb.ret) - cost) < 1, 'a wet year loses the irrigation cost: ' + (wa.ret - wb.ret).toFixed(2) + ' vs ' + cost.toFixed(2));
  const r = run(irr);
  assert.match(r.summary.why.map((w) => w.text).join(' '), /Irrigating an inch a week in July on every field/);
  assert.ok(r.summary.fields.west.yieldPctOfNormal > run(base).summary.fields.west.yieldPctOfNormal);
  assert.match(FS.engine.compare('west', irr)[0].card.gaps, /working value/);
  for (const m of ['july-aug', 'jun-aug']) { const x = controls('typical'); x.crops.irrigation = m; assert.ok(Number.isFinite(run(x).summary.farm.returnTotal)); }
});

test('26. every card has work and trySmall (compare items and recommendations)', () => {
  const lines = (card, isCur, f) => {
    assert.equal(typeof card.work, 'string'); assert.ok(card.work.length > 10);
    assert.equal(typeof card.trySmall, 'string');
    if (isCur) { assert.equal(card.work, 'No change to your usual work.'); assert.equal(card.trySmall, 'Nothing to try: this is your current plan.'); }
    else assert.match(card.trySmall, new RegExp('^Try it on \\d+ acres of ' + f.name + ' next to your usual plan and compare at harvest\\.$'));
  };
  for (const pr of ['balanced', 'profit', 'risk', 'cover']) ids.forEach((id) => {
    const f = FS.data.farm.fields.filter((x) => x.id === id)[0];
    FS.engine.compare(id, controls('drought2012', 0, 0, pr)).forEach((it) => lines(it.card, it.isCurrent, f));
  });
  const c = controls('typical'); c.crops.trialAcres.creek = 10;
  assert.match(FS.engine.compare('creek', c)[1].card.trySmall, /^Try it on 10 acres of Creek 40/);
  assert.match(FS.engine.compare('creek', controls('typical'))[1].card.trySmall, /^Try it on 20 acres of Creek 40/);
  run(controls('drought2012')).summary.recommendations.forEach((rc) => { assert.ok(rc.card.work); assert.ok(rc.card.trySmall); });
});

// ---------------------------------------------------------------- questionnaire: currentPlan and other.exclude
test('27. currentPlan and exclude: defaults identical; exclusion respected; a rye current plan changes the baseline', () => {
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS });
  const A = snapshot();
  // a missing, empty or invalid currentPlan changes nothing
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS.map((f) => Object.assign({}, f, { currentPlan: 'nonsense' })) });
  assert.equal(snapshot(), A, 'invalid currentPlan ignored');
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS.map((f) => Object.assign({}, f, { currentPlan: f.lastCrop === 'corn' ? 'rye-corn' : 'rye-soy' })) });
  assert.deepEqual(FS.data.initialControls.crops.plans, { north: 'soy', creek: 'soy', west: 'corn', south: 'corn' }, 'a plan for the other last crop is refused');
  // exclude: [] is identical to no exclude
  const e = controls('typical'); e.other.exclude = [];
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS });
  assert.equal(JSON.stringify(FS.engine.compare('creek', e)), JSON.stringify(FS.engine.compare('creek', controls('typical'))));
  assert.equal(JSON.stringify(run(e).summary.recommendations), JSON.stringify(run(controls('typical')).summary.recommendations));
  assert.equal(snapshot(), A);
  // exclusion respected in compare and recommendations, for every field, priority and scenario
  const ex = ['oats-cover', 'corn-corn', 'rye-soy', 'rye-corn', 'soy-soy'];
  for (const pr of ['balanced', 'profit', 'risk', 'cover']) for (const sid of ['typical', 'drought2012']) {
    const c = controls(sid, 0, 0, pr); c.other.exclude = ex.slice();
    ids.forEach((id) => FS.engine.compare(id, c).forEach((it) => assert.ok(!ex.includes(it.plan) || it.isCurrent, id + ' ' + it.plan + ' should be excluded')));
    run(c).summary.recommendations.forEach((r) => assert.ok(!ex.includes(r.plan), 'recommended ' + r.plan));
  }
  const rr = controls('typical', 0, 0, 'cover'); const withRye = run(rr).summary.recommendations.map((r) => r.plan);
  rr.other.exclude = ['rye-soy', 'rye-corn']; const noRye = run(rr).summary.recommendations.map((r) => r.plan);
  assert.ok(withRye.some((p) => /rye/.test(p)), 'cover ranking normally recommends rye: ' + withRye);
  assert.ok(!noRye.some((p) => /rye/.test(p)), 'no rye when excluded: ' + noRye);
  // a field's current plan is never dropped, even when excluded
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS.map((f) => Object.assign({}, f, { currentPlan: f.lastCrop === 'corn' ? 'rye-soy' : 'rye-corn' })) });
  const c2 = controls('typical'); Object.assign(c2.crops.plans, FS.data.initialControls.crops.plans); c2.other.exclude = ['rye-soy', 'rye-corn', 'oats-cover'];
  const cmp = FS.engine.compare('creek', c2);
  assert.equal(cmp[0].plan, 'rye-soy'); assert.equal(cmp[0].isCurrent, true);
  assert.ok(!cmp.some((x) => x.plan === 'oats-cover'));
  // a rye current plan changes the baseline
  assert.deepEqual(FS.data.initialControls.crops.plans, { north: 'rye-soy', creek: 'rye-soy', west: 'rye-corn', south: 'rye-corn' });
  const rye = run(Object.assign(controls('typical'), { crops: Object.assign(controls('typical').crops, { plans: clone(FS.data.initialControls.crops.plans) }) }));
  assert.equal(rye.summary.fields.creek.plan, 'rye-soy');
  FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS });
  const plain = run(controls('typical'));
  assert.notEqual(rye.summary.farm.returnTotal, plain.summary.farm.returnTotal, 'rye current plans change the farm baseline');
  assert.ok(rye.summary.fields.creek.greenCoverMonths > plain.summary.fields.creek.greenCoverMonths, 'rye adds ground cover');
  assert.equal(snapshot(), A, 'back to the defaults: identical');
});

test('28. local fit: shifts the weather by month, uses the farm soils and yields, applies tile drainage; empty fit is identical', () => {
  const A = snapshot();
  const story = FS.data.climate, y = String(YEARS[10]);
  // an empty local fit (no deltas, no soils, no yields) must not change results
  assert.equal(FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS, local: { label: '' } }).ok, true);
  assert.equal(snapshot(), A, 'empty local fit identical');
  const tempC = Array(12).fill(0); tempC[6] = 2;  // July +2 C
  const rainRatio = Array(12).fill(1); rainRatio[5] = 0.5;  // June half the rain
  const soil = { name: 'Test loam', awcMmPerM: 150, aws150cm: 22.5, drainage: 'Poorly drained', hydgrp: 'C/D', slopePct: 1, point: [-93.5, 42] };
  const r = FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS, local: { label: 'Near Boone, Iowa', km: 36, tempC, rainRatio,
    soils: { north: soil, creek: soil, west: soil, south: soil }, normalYield: { corn: 200, soybean: 60 },
    ai: { tileDrained: true, drainageClass: 'keep', awcPct: -10, yieldPct: { corn: 5, soybean: 0 } } } });
  assert.equal(r.ok, true);
  const L = FS.data.climate, sc = L.meta.scale;
  assert.notEqual(L, story);
  const jul = 227, jun = 200;  // 1 July and 2 June in the 16 Nov season calendar
  assert.equal(L.seasons[y].tmax[jul] - story.seasons[y].tmax[jul], 2 * sc.tmax, 'July Tmax +2 C');
  assert.equal(L.seasons[y].tmax[jun], story.seasons[y].tmax[jun], 'June temperature unchanged');
  assert.equal(L.seasons[y].rain[jun], Math.round(story.seasons[y].rain[jun] * 0.5), 'June rain halved');
  const f = FS.data.farm.fields[0];
  assert.equal(f.soil.name, 'Test loam'); assert.equal(f.soil.drainage, 'Moderately well drained'); assert.equal(f.soil.tiled, true); assert.equal(f.soil.awcMmPerM, 135);
  assert.equal(FS.data.economics.normalYield.corn, 210); assert.equal(FS.data.economics.normalYield.soybean, 60);
  assert.equal(FS.data.farm.place, 'Near Boone, Iowa'); assert.equal(FS.engine.site().local.km, 36);
  assert.notEqual(snapshot(), A, 'a real fit changes results');
  assert.equal(FS.engine.setFarm({ site: 'story-ia', fields: DEFAULT_FIELDS }).ok, true);
  assert.equal(snapshot(), A, 'back to the default farm: identical');
});

test('29. outlook: no days = normal; a very dry, hot summer cuts the estimate; the normal itself is unchanged', () => {
  const A = snapshot();
  const none = FS.engine.outlook({});
  assert.deepEqual(none.outlook, none.normal);
  assert.equal(none.normal.length, 4); assert.equal(none.normal[0].bu.length, YEARS.length);
  const days = {};
  for (let d = 210; d < 270; d++) days[d] = { tmax: 38, tmin: 22, rain: 0, et0: 8 };   // ~mid June to mid August
  const o = FS.engine.outlook(days);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const cornField = o.outlook.findIndex((x) => x.crop === 'corn');
  assert.ok(cornField >= 0);
  assert.ok(med(o.outlook[cornField].bu) < med(o.normal[cornField].bu) * 0.9, 'a drought summer lowers the median corn yield');
  assert.deepEqual(FS.engine.outlook({}).normal, none.normal, 'caches restored');
  assert.equal(snapshot(), A, 'runs afterwards identical');
});
