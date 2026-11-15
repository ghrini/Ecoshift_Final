// Temperature response table for VALIDATION.md section 5: yield % of normal with the warming floor (what the app shows) and the model alone.
// Usage: node tools/temperature_table.js
'use strict';
const path = require('path');
global.window = global;
const SRC = path.join(__dirname, '..', 'src');
['data', 'climate', 'store', 'engine'].forEach((f) => require(path.join(SRC, f + '.js')));
const FS = global.FS, Y = FS.data.climate.meta.years, shifts = [-2, -1, 0, 1, 2, 4];
const W = FS.engine._const.WARM_LOSS, saved = Object.assign({}, W);
const rows = [['Typical (2011), corn West 40', 'west', 'corn', [2011]], ['Typical (2011), corn South 120', 'south', 'corn', [2011]], ['Typical (2011), soybean North 80', 'north', 'soy', [2011]],
  ['2012, corn West 40', 'west', 'corn', [2012]], ['2012, corn South 120', 'south', 'corn', [2012]], ['2012, soybean North 80', 'north', 'soy', [2012]],
  ['All 44 seasons, mean corn West 40', 'west', 'corn', Y], ['All 44 seasons, mean soybean North 80', 'north', 'soy', Y]];
const cell = (f, p, ys, ts) => Math.round(ys.reduce((a, y) => a + FS.engine.evalYear(f, p, y, ts ? { tempShift: ts } : null).pct, 0) / ys.length);
for (const [label, withFloor] of [['with the warming floor (what the app shows)', true], ['model alone (floor off)', false]]) {
  Object.keys(W).forEach((k) => delete W[k]); if (withFloor) Object.assign(W, saved);
  console.log('\n' + label + '\n| Season, field | ' + shifts.map((s) => (s > 0 ? '+' : '') + s + ' C').join(' | ') + ' |\n|---|' + shifts.map(() => '---').join('|') + '|');
  rows.forEach(([n, f, p, ys]) => console.log('| ' + n + ' | ' + shifts.map((s) => cell(f, p, ys, s)).join(' | ') + ' |'));
}
Object.assign(W, saved);
