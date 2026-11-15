// Dump the process model's per-season components for the reference rotation (county soil) so tools/validate.py can fit
// and test it. Usage: node tools/validate_model.js > out.json
// For every structural setting in the grid (rooting depth, how each season starts) it runs the engine itself, so the
// numbers are exactly what the simulator computes. Parameters that act after the daily model (gamma, heat slope b,
// grain-fill exponent eDur) are fitted in Python from these components.
'use strict';
const path = require('path');
global.window = global;
const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'data.js'));
require(path.join(SRC, 'climate.js'));
require(path.join(SRC, 'store.js'));
require(path.join(SRC, 'engine.js'));
const FS = global.FS;

const GRID = process.env.FS_GRID ? JSON.parse(process.env.FS_GRID) : { zMaxCorn: [1.2, 1.5], startMode: ['fixed', 'spinup'], crMax: [0, 2, 4, 6] };
const keep = FS.engine._setParams();            // current values, restored at the end
const out = { grid: [], years: FS.data.climate.meta.years, heatMatch: FS.data.climate.meta.heatMatch, features: {} };
for (const z of GRID.zMaxCorn) for (const sm of GRID.startMode) for (const cr of GRID.crMax) {
  FS.engine._setParams({ zMaxCorn: z, startMode: sm, crMax: cr });
  const c = FS.engine._components();
  out.grid.push({ zMaxCorn: z, startMode: sm, crMax: cr, hybrid: c.hybrid, corn: c.corn, soybean: c.soybean });
}
FS.engine._setParams(keep);

// season weather features for the statistical models (same NASA POWER grid cell)
const C = FS.data.climate, sc = C.meta.scale, S0 = Date.UTC(2026, 10, 16);
const idx = (md) => { const m = +md.slice(0, 2); return Math.round((Date.UTC(m >= 11 ? 2026 : 2027, m - 1, +md.slice(3)) - S0) / 864e5); };
const gdd = (tx, tn) => Math.max(0, ((Math.min(tx * 1.8 + 32, 86) + Math.max(tn * 1.8 + 32, 50)) / 2) - 50);
const sum = (s, k, a, b, f) => { let t = 0; for (let d = idx(a); d <= idx(b); d++) t += f ? f(s, d) : s[k][d] / sc[k]; return t; };
for (const y of out.years) {
  const s = C.seasons[y];
  const tx = (d) => s.tmax[d] / sc.tmax, tn = (d) => s.tmin[d] / sc.tmin;
  out.features[y] = {
    rainJJA: sum(s, 'rain', '06-01', '08-31'),
    rainAJ: sum(s, 'rain', '04-01', '06-30'),
    rainJul: sum(s, 'rain', '07-01', '07-31'),
    rainAug: sum(s, 'rain', '08-01', '08-31'),
    hddJA: sum(s, null, '07-01', '08-31', (_, d) => Math.max(0, tx(d) - C.meta.heatMatch.c29)),
    gddMS: sum(s, null, '05-01', '09-30', (_, d) => gdd(tx(d), tn(d))),
    tmeanJul: sum(s, null, '07-01', '07-31', (_, d) => (tx(d) + tn(d)) / 2) / 31,
    tmeanAug: sum(s, null, '08-01', '08-31', (_, d) => (tx(d) + tn(d)) / 2) / 31,
    et0JJA: sum(s, 'et0', '06-01', '08-31'),
    gwrJA: sum(s, 'gwr', '07-01', '08-31') / 62
  };
}
process.stdout.write(JSON.stringify(out));
