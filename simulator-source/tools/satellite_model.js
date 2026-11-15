// Prints the simulator's own per-season yield (% of normal) for the example farm, current plans, typical conditions, as JSON.
// Corn: field 'west' (current plan corn); soybean: field 'north' (current plan soybean). Used by tools/satellite_check.py.
'use strict';
const path = require('path');
global.window = global;
const SRC = path.join(__dirname, '..', 'src');
for (const f of ['data.js', 'climate.js', 'store.js', 'engine.js']) require(path.join(SRC, f));
const FS = global.FS, out = {};
for (const [crop, id] of [['corn', 'west'], ['soybean', 'north']]) {
  const s = FS.engine.seasons(id, FS.data.initialControls);
  out[crop] = { field: id, plan: s.current.plan, years: s.years, pct: s.current.pct };
}
process.stdout.write(JSON.stringify(out));
