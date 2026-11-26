// Dump the process model's per-season components for each of the 14 built-in counties, using the shipped settings
// (the engine's own FIT: rooting depth, season start, water-table term; nothing is refitted here) and each county's own
// NASA POWER weather and NRCS soil from src/sites.js. Used by tools/validate_counties.py.
// Usage: node tools/validate_counties_model.js > out.json
'use strict';
const path = require('path');
global.window = global;
const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'data.js'));
require(path.join(SRC, 'sites.js'));
require(path.join(SRC, 'climate.js'));
require(path.join(SRC, 'store.js'));
require(path.join(SRC, 'engine.js'));
const FS = global.FS;

const out = { shipped: FS.engine._setParams(), sites: {} };
const gdd = (tx, tn) => Math.max(0, ((Math.min(tx * 1.8 + 32, 86) + Math.max(tn * 1.8 + 32, 50)) / 2) - 50);
for (const st of FS.data.sites) {
  const r = FS.engine.setFarm({ site: st.id });
  if (!r.ok) throw new Error(st.id + ': ' + r.error);
  const C = FS.data.climate, sc = C.meta.scale, S0 = Date.UTC(2026, 10, 16);
  const idx = (md) => { const m = +md.slice(0, 2); return Math.round((Date.UTC(m >= 11 ? 2026 : 2027, m - 1, +md.slice(3)) - S0) / 864e5); };
  const sum = (s, k, a, b, f) => { let t = 0; for (let d = idx(a); d <= idx(b); d++) t += f ? f(s, d) : s[k][d] / sc[k]; return t; };
  const comp = FS.engine._components();
  const features = {};
  for (const y of C.meta.years) {
    const s = C.seasons[y], tx = (d) => s.tmax[d] / sc.tmax, tn = (d) => s.tmin[d] / sc.tmin;
    features[y] = {
      rainJJA: sum(s, 'rain', '06-01', '08-31'), rainAJ: sum(s, 'rain', '04-01', '06-30'),
      hddJA: sum(s, null, '07-01', '08-31', (_, d) => Math.max(0, tx(d) - C.meta.heatMatch.c29)),
      gddMS: sum(s, null, '05-01', '09-30', (_, d) => gdd(tx(d), tn(d))),
      tmaxJA: sum(s, null, '07-01', '08-31', (_, d) => tx(d)) / 62
    };
  }
  out.sites[st.id] = {
    name: st.name, short: st.short, state: st.state, lat: st.lat, lon: st.lon,
    years: C.meta.years, weather: { source: C.meta.source, elevation_m: C.meta.elevation_m, heatMatchFrom: C.meta.heatMatchFrom || 'Story County (page climate)', heatMatch: C.meta.heatMatch },
    countyAwcMmPerM: FS.data.farm.countyAwcMmPerM,
    soils: Object.fromEntries(Object.entries(st.soils).map(([k, v]) => [k, { name: v.name, awcMmPerM: v.awcMmPerM, aws150cm: v.aws150cm, drainage: v.drainage, hydgrp: v.hydgrp, slopePct: v.slopePct }])),
    hybrid: comp.hybrid, corn: comp.corn, soybean: comp.soybean, features
  };
}
process.stdout.write(JSON.stringify(out));
