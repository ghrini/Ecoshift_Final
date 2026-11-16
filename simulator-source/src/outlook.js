/* 30-day outlook: the live forecast (days 1-16) and a rough long-range estimate (days 17-30) for the farm's own point,
   fixed-rule warnings, and what those days do to next year's harvest in the engine (FS.engine.outlook).
   Needs the EcoShift server (/api/outlook, /api/outlooknote); opened as a file it says so and stays quiet. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var DAY = 864e5, N_DAYS = 365;
  var el = null, data = null, dataKey = '', err = null, loading = false, seq = 0, model = null, note = null, noteErr = null, warnList = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function r0(x) { return Math.round(x); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function apiBase() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  function t(d) { return Date.parse(d + 'T00:00:00Z'); }
  function fmt(d, o) { try { return new Date(t(d)).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, o || { month: 'short', day: 'numeric' })); } catch (e) { return d; } }
  function month(d) { return new Date(t(d)).getUTCMonth() + 1; }
  function quant(xs, p) { var a = xs.filter(isFinite).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }

  // where the outlook is for: the farm's own point, or the data county's point
  function where() {
    var s = FS.farmSetup && FS.farmSetup.setup, p = s && !s.example && s.point;
    if (p && isFinite(p.lat) && isFinite(p.lon)) return { lat: +p.lat, lon: +p.lon, label: p.label || 'your farm', own: true };
    var site = (FS.farmSetup && FS.farmSetup.site) || {}, farm = FS.data.farm || {};
    var lat = site.lat != null ? site.lat : farm.lat, lon = site.lon != null ? site.lon : farm.lon;
    return { lat: +lat, lon: +lon, label: site.name || farm.place || 'the county', own: false };
  }

  // season day index of a date (the model's calendar starts at seasonStart and has no 29 Feb); null for 29 Feb itself
  function dayIndex(date, start) {
    var a = t(start), b = t(date), n = Math.round((b - a) / DAY);
    var d = new Date(b); if (d.getUTCMonth() === 1 && d.getUTCDate() === 29) return null;
    for (var y = new Date(a).getUTCFullYear(); y <= d.getUTCFullYear(); y++) {
      var f = Date.UTC(y, 1, 29);
      if (new Date(f).getUTCMonth() === 1 && f > a && f < b) n -= 1;
    }
    return n;
  }

  // the fitted county's normal for one season day (mean over every past season)
  var normCache = { c: null, v: null };
  function normals() {
    var C = FS.data.climate; if (!C || !C.seasons) return null;
    if (normCache.c === C) return normCache.v;
    var ys = Object.keys(C.seasons), sc = C.meta.scale, v = { tmax: [], tmin: [], rain: [] };
    for (var d = 0; d < N_DAYS; d++) {
      var a = 0, b = 0, r = 0;
      ys.forEach(function (y) { var S = C.seasons[y]; a += S.tmax[d]; b += S.tmin[d]; r += S.rain[d]; });
      v.tmax.push(a / ys.length / sc.tmax); v.tmin.push(b / ys.length / sc.tmin); v.rain.push(r / ys.length / sc.rain);
    }
    normCache = { c: C, v: v };
    return v;
  }
  function normOf(i) { var N = normals(); if (!N || i == null) return null; var k = ((i % N_DAYS) + N_DAYS) % N_DAYS; return { tmax: N.tmax[k], tmin: N.tmin[k], rain: N.rain[k] }; }

  // ---------------------------------------------------------------- the 30 days
  function strip() {
    if (!data) return [];
    var out = [];
    (data.forecast || []).forEach(function (d) { out.push(Object.assign({ kind: 'fc' }, d)); });
    (data.extended || []).forEach(function (d) { out.push(Object.assign({ kind: 'ext' }, d)); });
    out = out.slice(0, 30);
    out.forEach(function (d, i) { d.n = i + 1; d.est = d.kind === 'ext'; d.idx = dayIndex(d.date, data.seasonStart); d.norm = normOf(d.idx); });
    return out;
  }

  // ---------------------------------------------------------------- warnings (fixed rules)
  function warnings(days) {
    var W = [];
    function add(kind, title, text, hit) {
      var first = hit[0];
      W.push({ kind: kind, title: title, text: text, date: first.date, est: hit.every(function (d) { return d.est; }), days: hit.map(function (d) { return d.n; }) });
    }
    function when(hit) { var a = hit[0], b = hit[hit.length - 1]; return a === b ? fmt(a.date) : fmt(a.date) + '–' + fmt(b.date); }
    function ok(v) { return v != null && isFinite(v); }
    function runs(test, minLen) {   // consecutive stretches of days meeting the test
      var res = [], cur = [];
      days.forEach(function (d) { if (test(d)) cur.push(d); else { if (cur.length >= minLen) res.push(cur); cur = []; } });
      if (cur.length >= minLen) res.push(cur);
      return res;
    }
    var grow = function (d) { var m = month(d.date); return m >= 4 && m <= 10; };
    var frost = days.filter(function (d) { return grow(d) && ok(d.tmin) && d.tmin <= 0; });
    if (frost.length) add('frost', 'Frost in the growing season', 'Lows at or below 0 °C on ' + frost.length + ' day' + (frost.length > 1 ? 's' : '') + ' from ' + fmt(frost[0].date) + ' (coldest ' + r1(Math.min.apply(null, frost.map(function (d) { return d.tmin; }))) + ' °C). Protect emerged or unfinished crops.', frost);
    var heat = days.filter(function (d) { return ok(d.tmax) && d.tmax >= 35; });
    if (heat.length) add('heat', 'Heat', 'Highs of 35 °C or more on ' + heat.length + ' day' + (heat.length > 1 ? 's' : '') + ' from ' + fmt(heat[0].date) + '. Hot days at flowering cost the most yield.', heat);
    runs(function (d) { var m = month(d.date); return m >= 5 && m <= 9 && ok(d.rain) && d.rain < 2; }, 10).forEach(function (r) {
      add('dry', 'Dry spell', r.length + ' days in a row with under 2 mm of rain (' + when(r) + ').', r);
    });
    var heavy = days.filter(function (d) { return ok(d.rain) && d.rain >= 25; });
    for (var i = 0; i + 2 < days.length; i++) {
      var three = days.slice(i, i + 3), sum = three.reduce(function (a, d) { return a + (ok(d.rain) ? d.rain : 0); }, 0);
      if (sum >= 50 && !three.some(function (d) { return heavy.indexOf(d) >= 0; })) { heavy.push(three[0]); }
    }
    if (heavy.length) {
      heavy.sort(function (a, b) { return a.n - b.n; });
      var most = Math.max.apply(null, days.map(function (d) { return ok(d.rain) ? d.rain : 0; }));
      add('rain', 'Heavy rain', 'Heavy rain (25 mm or more in a day, or 50 mm over 3 days) from ' + fmt(heavy[0].date) + '; wettest day ' + r0(most) + ' mm. Expect ponding on poorly drained fields and runoff on bare slopes.', heavy);
    }
    var gust = days.filter(function (d) { return ok(d.gust) && d.gust >= 60; });
    if (gust.length) add('wind', 'Strong gusts', 'Gusts up to ' + r0(Math.max.apply(null, gust.map(function (d) { return d.gust; }))) + ' km/h from ' + fmt(gust[0].date) + '. Check bins, lids and standing crop.', gust);
    var snow = days.filter(function (d) { return ok(d.snow) && d.snow >= 5; });
    if (snow.length) add('snow', 'Snow', 'Snowfall of 5 cm or more on ' + snow.length + ' day' + (snow.length > 1 ? 's' : '') + ' from ' + fmt(snow[0].date) + ' (most ' + r0(Math.max.apply(null, snow.map(function (d) { return d.snow; }))) + ' cm in a day).', snow);
    runs(function (d) { return ok(d.tmax) && d.tmax < 0; }, 3).forEach(function (r) {
      add('freeze', 'Ground freezing', r.length + ' days in a row with highs below 0 °C (' + when(r) + '): the top soil will freeze. Finish fall tillage and fall nitrogen before then.', r);
    });
    var cold = days.filter(function (d) { return ok(d.tmin) && d.tmin <= -18; });
    if (cold.length) add('cold', 'Extreme cold', 'Lows of −18 °C or colder from ' + fmt(cold[0].date) + ' (coldest ' + r1(Math.min.apply(null, cold.map(function (d) { return d.tmin; }))) + ' °C). Livestock need shelter, bedding and open water.', cold);
    // fall nitrogen: the first 5-day stretch (Sep-Dec) whose average temperature is under 10 °C
    for (var k = 0; k + 4 < days.length; k++) {
      var five = days.slice(k, k + 5); if (!five.every(function (d) { var m = month(d.date); return (m >= 9 || m === 12) && ok(d.tmax) && ok(d.tmin); })) continue;
      var avg = five.reduce(function (a, d) { return a + (d.tmax + d.tmin) / 2; }, 0) / 5;
      if (avg < 10) { add('nitrogen', 'Cool enough for fall nitrogen', 'From ' + fmt(five[0].date) + ' the 5-day average air temperature is ' + r1(avg) + ' °C, under 10 °C. Check that soil at 4 inches stays below 10 °C (50 °F) before fall anhydrous, and use a stabilizer.', five); break; }
    }
    W.sort(function (a, b) { return a.days[0] - b.days[0]; });
    return W;
  }

  // ---------------------------------------------------------------- the model: what these days do to next year's harvest
  function modelDays() {
    var days = {}, start = data.seasonStart;
    function put(d) {
      var i = dayIndex(d.date, start); if (i == null || i < 0 || i >= N_DAYS) return;
      days[i] = { tmax: d.tmax, tmin: d.tmin, rain: d.rain, et0: d.et0 != null ? d.et0 : null };
    }
    (data.observed || []).forEach(put); (data.forecast || []).forEach(put); (data.extended || []).forEach(put);
    return days;
  }
  function runModel() {
    model = null;
    if (!data || !FS.engine || !FS.engine.outlook) return;
    try {
      var o = FS.engine.outlook(modelDays()), year = new Date(t(data.seasonStart)).getUTCFullYear() + 1;
      model = { year: year, days: o.days || 0, fields: o.normal.map(function (n, i) {
        var f = o.outlook[i], grain = n.crop === 'corn' || n.crop === 'soybean' || n.crop === 'oats';
        var nm = quant(n.bu, 0.5), om = quant(f.bu, 0.5);
        return { name: n.name, acres: n.acres, plan: n.planLabel, crop: n.crop, grain: grain, normal: nm, med: om, p10: quant(f.bu, 0.1), p90: quant(f.bu, 0.9),
                 pct: nm > 0 ? (om - nm) / nm * 100 : null };
      }) };
    } catch (e) { console.error('[Field Shift] outlook model failed:', e); model = { error: 'The simulator could not replay the seasons with these days.' }; }
  }

  // ---------------------------------------------------------------- the Gemini note (once a day per spot)
  function getNote(w) {
    var base = apiBase(); if (!base || !data || !model || model.error) return;
    var key = 'fieldshift.outlooknote.' + data.today + '.' + w.lat.toFixed(2) + ',' + w.lon.toFixed(2) + '.' + (model.fields || []).map(function (f) { return f.plan; }).join('|');
    try { var c = sessionStorage.getItem(key); if (c) { note = JSON.parse(c); render(); return; } } catch (e) { /* no storage: ask again */ }
    var my = seq, body = {
      place: w.label, today: data.today, season: model.year,
      warnings: warnList.map(function (x) { return { title: x.title, text: x.text, estimate: x.est }; }),
      harvest: (model.fields || []).filter(function (f) { return f.grain; }).map(function (f) { return { field: f.name, plan: f.plan, crop: f.crop, normalBu: f.normal && r0(f.normal), withForecastBu: f.med && r0(f.med), changePct: f.pct != null ? r1(f.pct) : null }; }),
      next30: strip().map(function (d) { return { date: d.date, tmax: d.tmax, tmin: d.tmin, rain: d.rain, estimate: d.est }; })
    };
    fetch(base + '/api/outlooknote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (my !== seq) return;
        if (x.ok && x.j && x.j.off) return;   // the server has no AI key: leave the note out quietly
        if (!x.ok) { noteErr = x.j && x.j.error || 'The AI helper could not write a note just now.'; render(); return; }
        note = x.j; try { sessionStorage.setItem(key, JSON.stringify(note)); } catch (e) { /* ignore */ }
        render();
      })
      .catch(function () { if (my === seq) { noteErr = 'The AI helper could not be reached.'; render(); } });
  }

  // ---------------------------------------------------------------- drawing
  function stripHTML(days) {
    var all = []; days.forEach(function (d) {
      [d.tmax, d.tmin].concat(d.range ? d.range.tmax.concat(d.range.tmin) : []).concat(d.norm ? [d.norm.tmax, d.norm.tmin] : []).forEach(function (v) { if (v != null && isFinite(v)) all.push(v); });
    });
    var lo = Math.floor(Math.min.apply(null, all) - 2), hi = Math.ceil(Math.max.apply(null, all) + 2), span = Math.max(1, hi - lo);
    var rmax = Math.max(15, Math.max.apply(null, days.map(function (d) { return Math.max(d.rain || 0, d.range ? d.range.rain[1] || 0 : 0); })));
    function y(v) { return (hi - v) / span * 100; }
    var nFc = days.filter(function (d) { return !d.est; }).length, nEx = days.length - nFc;
    var cols = days.map(function (d) {
      var tip = fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' }) + (d.est ? ' (estimate)' : '') + ': high ' + r1(d.tmax) + ' °C, low ' + r1(d.tmin) + ' °C, rain ' + r1(d.rain || 0) + ' mm' +
        (d.rainChance != null ? ' (' + d.rainChance + '% chance)' : '') + (d.norm ? '. Normal ' + r1(d.norm.tmax) + ' / ' + r1(d.norm.tmin) + ' °C, ' + r1(d.norm.rain) + ' mm' : '');
      var h = '<div class="fs-ol-day' + (d.est ? ' is-est' : '') + '" title="' + esc(tip) + '"><div class="fs-ol-t">';
      if (d.range) h += '<i class="fs-ol-band" style="top:' + y(d.range.tmax[1]) + '%;bottom:' + (100 - y(d.range.tmin[0])) + '%"></i>';
      if (d.norm) h += '<i class="fs-ol-norm" style="top:' + y(d.norm.tmax) + '%"></i><i class="fs-ol-norm" style="top:' + y(d.norm.tmin) + '%"></i>';
      if (isFinite(d.tmax) && isFinite(d.tmin)) h += '<i class="fs-ol-bar" style="top:' + y(d.tmax) + '%;bottom:' + (100 - y(d.tmin)) + '%"></i>';
      h += '</div><div class="fs-ol-r">';
      if (d.range) h += '<i class="fs-ol-rband" style="height:' + Math.min(100, (d.range.rain[1] || 0) / rmax * 100) + '%"></i>';
      h += '<i class="fs-ol-rain" style="height:' + Math.min(100, (d.rain || 0) / rmax * 100) + '%"></i></div>';
      h += '<span class="fs-ol-lab">' + (d.n === 1 || (d.n % 5 === 0 && d.n < days.length) ? esc(fmt(d.date)) : '') + '</span></div>';
      return h;
    }).join('');
    var head = '<div class="fs-ol-phase" style="grid-column:span ' + nFc + '">Forecast · days 1–' + nFc + '</div>' + (nEx ? '<div class="fs-ol-phase is-est" style="grid-column:span ' + nEx + '">Estimate · days ' + (nFc + 1) + '–' + days.length + '</div>' : '');
    var sum = days.length + ' days from ' + fmt(days[0].date) + ': highs ' + r0(Math.min.apply(null, days.map(function (d) { return d.tmax; }))) + ' to ' + r0(Math.max.apply(null, days.map(function (d) { return d.tmax; }))) + ' °C, ' +
      r0(days.reduce(function (a, d) { return a + (d.rain || 0); }, 0)) + ' mm of rain in all (normal ' + r0(days.reduce(function (a, d) { return a + (d.norm ? d.norm.rain : 0); }, 0)) + ' mm). Day-by-day numbers are in the table below.';
    return '<p class="fs-ol-axis">Temperature scale ' + String(lo).replace('-', '−') + ' to ' + hi + ' °C · rain bars up to ' + r0(rmax) + ' mm a day</p>' +
      '<div class="fs-ol-wrap"><div class="fs-ol-grid" style="grid-template-columns:repeat(' + days.length + ',minmax(0,1fr))">' + head + '</div>' +
      '<div class="fs-ol-strip" role="img" aria-label="' + esc(sum) + '" style="grid-template-columns:repeat(' + days.length + ',minmax(0,1fr))">' + cols + '</div></div>' +
      '<p class="fs-ol-key"><span><i class="k-bar"></i>Daily high to low</span><span><i class="k-norm"></i>Normal high and low</span><span><i class="k-rain"></i>Rain</span>' + (nEx ? '<span><i class="k-band"></i>Estimate range (10th–90th percentile)</span>' : '') + '</p>';
  }
  function tableHTML(days) {
    return '<details class="fs-ol-details"><summary>Day by day</summary><div class="fs-ol-tablewrap"><table class="fs-ol-table"><thead><tr><th scope="col">Day</th><th scope="col">High / low °C</th><th scope="col">Normal °C</th><th scope="col">Rain mm</th><th scope="col">Normal mm</th><th scope="col">Other</th></tr></thead><tbody>' +
      days.map(function (d) {
        var other = [];
        if (d.rainChance != null) other.push(d.rainChance + '% rain chance');
        if (d.gust != null) other.push('gusts ' + r0(d.gust) + ' km/h');
        if (d.snow) other.push('snow ' + r1(d.snow) + ' cm');
        if (d.range) other.push('range ' + r0(d.range.tmin[0]) + ' to ' + r0(d.range.tmax[1]) + ' °C, rain up to ' + r1(d.range.rain[1]) + ' mm');
        return '<tr' + (d.est ? ' class="is-est"' : '') + '><th scope="row">' + esc(fmt(d.date, { weekday: 'short', month: 'short', day: 'numeric' })) + (d.est ? ' <span class="fs-ol-tag">estimate</span>' : '') + '</th><td>' + r1(d.tmax) + ' / ' + r1(d.tmin) + '</td><td>' +
          (d.norm ? r1(d.norm.tmax) + ' / ' + r1(d.norm.tmin) : '–') + '</td><td>' + r1(d.rain || 0) + '</td><td>' + (d.norm ? r1(d.norm.rain) : '–') + '</td><td>' + esc(other.join(', ')) + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
  }
  function warnHTML() {
    if (!warnList.length) return '<p class="fs-ol-none">No warnings: none of the fixed rules (frost in the growing season, heat, dry spell, heavy rain, strong gusts, snow, frozen ground, extreme cold) trips in the next 30 days.</p>';
    return '<ul class="fs-ol-warns">' + warnList.map(function (w) {
      return '<li class="fs-ol-warn k-' + w.kind + (w.est ? ' is-est' : '') + '"><b>' + esc(w.title) + (w.est ? ' <span class="fs-ol-tag">estimate, days 17–30</span>' : '') + '</b> ' + esc(w.text) + '</li>';
    }).join('') + '</ul>';
  }
  function harvestHTML() {
    if (!model) return '';
    if (model.error) return '<p class="fs-ol-err">' + esc(model.error) + '</p>';
    var m0 = month(data.today), early = m0 >= 10 || m0 <= 2;
    var nY = (FS.data.climate.meta.years || []).length;
    if (early) {   // before planting the model does not let these days change the harvest, so no "change" column is shown
      var rowsE = model.fields.map(function (f) {
        if (!f.grain || !(f.normal > 0)) return '<tr><th scope="row">' + esc(f.name) + '</th><td>' + esc(f.plan) + '</td><td colspan="2">No grain harvest on this plan</td></tr>';
        return '<tr><th scope="row">' + esc(f.name) + '</th><td>' + esc(f.plan) + '</td><td>' + r0(f.normal) + '</td><td>' + r0(f.p10) + '–' + r0(f.p90) + '</td></tr>';
      }).join('');
      return '<h3 class="fs-ol-h">Next Harvest (' + model.year + '), Bushels Per Acre</h3>' +
        '<div class="fs-ol-tablewrap"><table class="fs-ol-table fs-ol-harvest"><thead><tr><th scope="col">Field</th><th scope="col">Plan</th><th scope="col">Normal (median)</th><th scope="col">Range (10th–90th)</th></tr></thead><tbody>' + rowsE + '</tbody></table></div>' +
        '<p class="fs-ol-plain">Plainly: these 30 days come before planting. In this model, weather before spring does not change the ' + model.year + ' harvest (each season starts from the same spring soil water), so this table is the spread of all ' + nY + ' past seasons on your current plan, not a forecast. Check back in spring.</p>';
    }
    var rows = model.fields.map(function (f) {
      if (!f.grain || !(f.normal > 0)) return '<tr><th scope="row">' + esc(f.name) + '</th><td>' + esc(f.plan) + '</td><td colspan="4">No grain harvest on this plan</td></tr>';
      var pr = f.pct == null ? null : r1(f.pct), pc = pr == null ? '–' : (pr > 0 ? '+' : pr < 0 ? '−' : '') + Math.abs(pr) + '%';
      return '<tr><th scope="row">' + esc(f.name) + '</th><td>' + esc(f.plan) + '</td><td>' + r0(f.normal) + '</td><td>' + r0(f.med) + '</td><td>' + r0(f.p10) + '–' + r0(f.p90) + '</td><td class="' + (f.pct <= -1 ? 'is-down' : f.pct >= 1 ? 'is-up' : '') + '">' + pc + '</td></tr>';
    }).join('');
    return '<h3 class="fs-ol-h">Next Harvest (' + model.year + '), Bushels Per Acre</h3>' +
      '<div class="fs-ol-tablewrap"><table class="fs-ol-table fs-ol-harvest"><thead><tr><th scope="col">Field</th><th scope="col">Plan</th><th scope="col">Normal (median)</th><th scope="col">With these 30 days (median)</th><th scope="col">Range (10th–90th)</th><th scope="col">Change</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="fs-ol-plain">Only these 30 days are known; the rest of the season comes from replaying every past season (' + nY + ' of them), which is where most of the range comes from.' +
      ' Each field keeps its current plan. Days 17–30 are a rough average of many forecasts, so a single frost, heat wave or downpour on those days will not show.</p>';
  }
  function noteHTML() {
    if (note && note.summary) return '<div class="fs-ol-note"><h3 class="fs-ol-h">What This Means <span class="fs-ol-tag">written by Gemini from the numbers above</span></h3><p>' + esc(note.summary) + '</p>' +
      (note.actions && note.actions.length ? '<ul>' + note.actions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    if (noteErr) return '<p class="fs-ol-faint">' + esc(noteErr) + '</p>';
    return model && !model.error && apiBase() ? '<p class="fs-ol-faint">Asking the AI helper for a short note…</p>' : '';
  }
  function sourcesHTML(w) {
    var C = FS.data.climate, ys = (C && C.meta && C.meta.years) || [], loc = FS.engine && FS.engine.site ? FS.engine.site().local : null, site = (FS.farmSetup && FS.farmSetup.site) || {};
    var li = (data.sources || []).filter(Boolean).map(function (s) { return '<li>' + esc(s) + '</li>'; });
    if (data.obsGap) li.push('<li>' + esc(data.obsGap) + '</li>');
    li.push('<li>Normals: the mean of NASA POWER daily weather, ' + (ys.length ? ys[0] + '–' + ys[ys.length - 1] : '') + ', for ' + esc(site.name || 'the county') + (loc ? ', shifted month by month to your farm (NASA POWER climatology)' : '') + '.</li>');
    li.push('<li>Harvest: the Field Shift crop model' + (loc ? ' fitted to your farm (not checked against your own harvests)' : '') + '; yields measured against the farm\'s normal of ' + r0(FS.data.economics.normalYield.corn) + ' bu corn and ' + r0(FS.data.economics.normalYield.soybean) + ' bu soybeans. Only Story County, Iowa was checked against real harvests.</li>');
    li.push('<li>Warnings: fixed rules applied to the numbers above, not official alerts. Check the National Weather Service for watches and warnings.</li>');
    return '<details class="fs-ol-details"><summary>Where these numbers come from</summary><ul class="fs-ol-src">' + li.join('') + '</ul></details>';
  }

  function render() {
    if (!el) return;
    var body = el.querySelector('.fs-panel-body'), w = where();
    var place = '<p class="fs-ol-where">' + (w.own ? 'For your farm near ' + esc(w.label) : 'For ' + esc(w.label) + ' (the county point: add your farm\'s address under “Your farm · Change” for your own spot)') +
      (data ? ' · ' + esc(fmt(data.today, { weekday: 'long', month: 'long', day: 'numeric' })) : '') + '</p>';
    if (!apiBase()) { body.innerHTML = place + '<p class="fs-ol-faint">Open this page through the EcoShift server for the live forecast (run <code>npm start</code>, then open http://localhost:8787).</p>'; return; }
    if (err) { body.innerHTML = place + '<p class="fs-ol-err">' + esc(err) + '</p><button type="button" class="fs-ol-retry">Try again</button>'; body.querySelector('.fs-ol-retry').onclick = function () { dataKey = ''; refresh(); }; return; }
    if (!data) { body.innerHTML = place + '<p class="fs-ol-faint">' + (loading ? 'Getting the forecast…' : '') + '</p>'; return; }
    var days = strip();
    if (!days.length) { body.innerHTML = place + '<p class="fs-ol-err">The forecast came back empty.</p>'; return; }
    body.innerHTML = place + stripHTML(days) + tableHTML(days) + '<h3 class="fs-ol-h">Warnings</h3>' + warnHTML() + harvestHTML() + noteHTML() + sourcesHTML(w);
  }

  // ---------------------------------------------------------------- public
  function refresh() {
    if (!el) return;
    var w = where(), key = w.lat.toFixed(3) + ',' + w.lon.toFixed(3), base = apiBase();
    seq++; note = null; noteErr = null;
    if (!base || !isFinite(w.lat) || !isFinite(w.lon)) { data = null; render(); return; }
    if (data && key === dataKey) {   // same spot: only the model (the farm or its fit changed)
      runModel(); render(); getNote(w); return;
    }
    var my = seq; data = null; err = null; loading = true; dataKey = key; render();
    fetch(base + '/api/outlook?lat=' + w.lat.toFixed(4) + '&lon=' + w.lon.toFixed(4))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (my !== seq) return;
        loading = false;
        if (!x.ok) { err = (x.j && x.j.error) || 'Couldn\'t get the forecast right now.'; dataKey = ''; render(); return; }
        data = x.j; warnList = warnings(strip());
        render();   // the forecast first, then the slower model replay
        setTimeout(function () { if (my !== seq) return; runModel(); render(); getNote(w); }, 30);
      })
      .catch(function () { if (my !== seq) return; loading = false; dataKey = ''; err = 'Couldn\'t reach the EcoShift server for the forecast.'; render(); });
  }
  function mount(node) {
    el = node; if (!el) return;
    el.innerHTML = '<div class="fs-panel-head"><h2 class="fs-panel-title">Next 30 Days</h2></div><div class="fs-panel-body" aria-live="polite"></div>';
    refresh();
  }

  FS.outlook = { mount: mount, refresh: refresh, _warnings: warnings, _dayIndex: dayIndex };
})();
