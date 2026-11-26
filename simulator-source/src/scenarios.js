/* Scenario analysis: what is observed, what is forecast and what is assumed.
   - FS.provenance: the five labels (badges) that say where a result comes from.
   - FS.scenarios: the six one-click presets in the Weather / Season box, the check for which one is on, and the side-by-side
     comparison of the current plans under observed history and under the chosen what-if.
   Replaying the 44 past seasons shows how a plan did under those conditions. It does not give the chance of any season next year,
   and it does not say that future weather will look like the record. The assumed scenarios are what-ifs with illustrative sizes. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {}, D = FS.data, S = FS.store, A = FS.actions;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------------------------------------------------------------- provenance labels
  var KINDS = {
    observed: { text: 'Observed history', tip: 'What actually happened in the past seasons (NASA POWER daily weather). It shows how a plan did under those conditions. It is not the chance of any season next year.' },
    current: { text: 'Current observations', tip: 'Recent satellite readings and weather estimates for your fields. They describe now, not the rest of the season.' },
    forecast: { text: 'Forecast (next 16 days)', tip: 'A weather-model forecast for the next 16 days. Useful for the coming days, not for the whole season.' },
    seasonal: { text: 'Seasonal outlook (days 17-30)', tip: 'A rough long-range estimate for days 17 to 30, an average of many model runs. Much less certain than the 16-day forecast.' },
    assumed: { text: 'Assumed scenario', tip: 'A what-if built on assumed changes with illustrative sizes. It is not a forecast and not a probability.' }
  };
  function badge(kind, more) {
    var k = KINDS[kind]; if (!k) return '';
    return '<span class="fs-prov is-' + kind + '" title="' + esc(k.tip) + '">' + esc(k.text) + (more ? ' ' + esc(more) : '') + '</span>';
  }
  FS.provenance = { kinds: KINDS, badge: badge, text: function (k) { return KINDS[k] ? KINDS[k].text : ''; } };

  // ---------------------------------------------------------------- the presets
  // Sizes: Zhao et al. 2017 (PNAS 114:9326) is the source of the warming yield loss in the engine (corn 7.4% and soybean 3.1% per degree C).
  // The direction of the Midwest changes (hotter summers with more very hot days, wetter springs, heavier downpours, less certain summer rain)
  // follows the U.S. Fifth National Climate Assessment (2023), Midwest chapter. The SIZES of the heat, rain and variability changes are illustrative,
  // chosen to stress-test a plan, and are not projections.
  var CLEAR = { scenario: 'typical', tempShift: 0, rainChange: 0, rainSwing: 0, hotDays: 0, events: [] };
  function w(o) { return Object.assign({}, CLEAR, o || {}); }
  var PRESETS = [
    { id: 'baseline', name: 'Historical Baseline', kind: 'observed', weather: w(),
      blurb: 'All 44 observed seasons (1982-2025), exactly as they happened. Nothing is changed.',
      basis: 'Observed: NASA POWER daily weather for this grid square.' },
    { id: 'drought', name: 'Historical Drought', kind: 'observed', weather: w({ scenario: 'drought2012' }), years: [1988, 2012],
      blurb: 'The 1988 and 2012 droughts, replayed as they happened.',
      basis: 'Observed: the 1988 and 2012 seasons from NASA POWER. Iowa corn made 84 and 137 bu/acre (USDA NASS). Prices are held at today\'s level.' },
    { id: 'heat', name: 'More Frequent Extreme Heat', kind: 'assumed', weather: w({ tempShift: 1, hotDays: 3 }),
      blurb: '1 °C warmer, and summer days that reach 30 °C or more get another 3 °C, so very hot days become more common.',
      basis: 'Assumed. Direction: hotter summers with more very hot days (U.S. Fifth National Climate Assessment, Midwest chapter). Size (+1 °C, +3 °C on hot days): illustrative, not a projection. Yield loss from warming: Zhao et al. 2017.' },
    { id: 'rain', name: 'Reduced Precipitation', kind: 'assumed', weather: w({ rainChange: -15 }),
      blurb: '15% less rain, spread over the whole season.',
      basis: 'Assumed. Illustrative, not a projection: assessments expect wetter springs in the Midwest and are less sure about summer rain, so this is a stress test.' },
    { id: 'swing', name: 'Increased Precipitation Variability', kind: 'assumed', weather: w({ rainSwing: 50 }),
      blurb: 'Wet stretches get wetter and dry stretches drier (swings 50% bigger). The season\'s total rain stays about the same.',
      basis: 'Assumed. Direction: heavier downpours and bigger swings between wet and dry spells (U.S. Fifth National Climate Assessment, Midwest chapter). Size (+50%): illustrative, not a projection.' },
    { id: 'combined', name: 'Combined Future', kind: 'assumed', weather: w({ tempShift: 2, rainChange: -10, rainSwing: 50 }),
      blurb: '2 °C warmer, 10% less rain and 50% bigger swings between wet and dry stretches.',
      basis: 'Assumed. Illustrative, not a projection: a hotter, drier, more erratic season for stress testing. Yield loss from warming: Zhao et al. 2017 (corn 7.4%, soybeans 3.1% per °C, no CO2 gain or adaptation).' }
  ];
  function byId(id) { return PRESETS.filter(function (p) { return p.id === id; })[0] || null; }
  var SAME = ['scenario', 'tempShift', 'rainChange', 'rainSwing', 'hotDays'];
  function num(v) { return Number(v) || 0; }
  function sameEvents(a, b) { return JSON.stringify(a || []) === JSON.stringify(b || []); }
  function matches(p, wc) {
    wc = wc || {};
    var drought = p.id === 'drought';
    return SAME.every(function (k) {
      if (k === 'scenario') return drought ? (wc.scenario === 'drought2012' || wc.scenario === 'drought1988') : (wc.scenario === 'typical' || wc.scenario == null);
      return num(wc[k]) === num(p.weather[k]);
    }) && sameEvents(wc.events, p.weather.events);
  }
  // which preset the weather controls match exactly (null when they are a custom mix)
  function active(wc) { for (var i = 0; i < PRESETS.length; i++) if (matches(PRESETS[i], wc)) return PRESETS[i].id; return null; }
  // true when the weather has any assumed change: sliders, events, variability or hot days (a replayed past season on its own is observed history)
  function isAssumed(wc) { wc = wc || {}; return !!(num(wc.tempShift) || num(wc.rainChange) || num(wc.rainSwing) || num(wc.hotDays) || (wc.events && wc.events.length)); }
  function apply(id, source) {
    var p = byId(id); if (!p) return false;
    Object.keys(p.weather).forEach(function (k) { A.setControl('weather.' + k, Array.isArray(p.weather[k]) ? [] : p.weather[k], source || 'ui'); });
    return true;
  }
  // plain words for the extra weather changes that the sliders did not have before
  function extraWords(wc) {
    var b = []; wc = wc || {};
    if (num(wc.rainSwing)) b.push('with ' + num(wc.rainSwing) + '% bigger swings between wet and dry stretches');
    if (num(wc.hotDays)) b.push('with hot summer days ' + num(wc.hotDays) + ' °C hotter');
    return b;
  }

  // ---------------------------------------------------------------- side by side: observed history and the chosen what-if, current plans
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  // whole-farm series, one value per past season: % of a normal crop (acre-weighted) and dollars (sum over fields), for the plan chosen on each field
  function series(controls) {
    var years = null, pct = null, usd = null, acres = 0, moneyOk = true;
    D.farm.fields.forEach(function (f) {
      var d = FS.engine.seasons(f.id, controls); if (!d || !d.plan) return;
      if (!years) { years = d.years.slice(); pct = years.map(function () { return 0; }); usd = years.map(function () { return 0; }); }
      acres += f.acres;
      d.plan.pct.forEach(function (v, i) { pct[i] += (v == null ? 0 : v) * f.acres; });
      d.plan.perAcre.forEach(function (v, i) { if (v == null) moneyOk = false; else usd[i] += v * f.acres; });
    });
    if (!years || !acres) return null;
    return { years: years, pct: pct.map(function (v) { return v / acres; }), usd: usd, moneyOk: moneyOk };
  }
  function pick(s, idx) { return { years: idx.map(function (i) { return s.years[i]; }), pct: idx.map(function (i) { return s.pct[i]; }), usd: idx.map(function (i) { return s.usd[i]; }), moneyOk: s.moneyOk }; }
  function stats(s, avg) {
    var t = avg ? mean : median, wi = 0;
    s.pct.forEach(function (v, i) { if (v < s.pct[wi]) wi = i; });
    return { typPct: t(s.pct), typUsd: t(s.usd), worstPct: s.pct[wi], worstUsd: s.usd[wi], worstYear: s.years[wi], n: s.years.length };
  }
  var cmpCache = { key: '', val: null };
  // returns null when the weather has nothing assumed and no drought preset (nothing to compare), else { base, scen, preset, moneyOk }
  function compare(controls) {
    if (!FS.engine || !FS.engine.seasons || !controls || !controls.weather) return null;
    var wc = controls.weather, id = active(wc), p = id ? byId(id) : null;
    if (!isAssumed(wc) && !(p && p.id === 'drought')) return null;
    var key = JSON.stringify([wc, controls.crops && controls.crops.plans, controls.crops && controls.crops.trialAcres, controls.crops && controls.crops.plantShiftDays, controls.crops && controls.crops.irrigation, controls.other, D.farm.fields.map(function (f) { return f.acres; })]);
    if (cmpCache.key === key) return cmpCache.val;
    var out = null;
    try {
      var bc = clone(controls); bc.weather = clone(CLEAR); bc.crops = bc.crops || {};
      var base = series(bc); if (!base) return null;
      var sc, avg = false, label = p ? p.name : 'Your what-if';
      if (p && p.id === 'drought') {
        var idx = p.years.map(function (y) { return base.years.indexOf(y); }).filter(function (i) { return i >= 0; });
        if (!idx.length) return null;
        sc = pick(base, idx); avg = true;
      } else sc = series(controls);
      if (!sc) return null;
      out = { preset: p ? p.id : null, label: label, assumed: isAssumed(wc), base: stats(base, false), scen: stats(sc, avg), avg: avg, moneyOk: base.moneyOk && sc.moneyOk && (!FS.absMoneyOk || FS.absMoneyOk()), nBase: base.years.length };
    } catch (e) { console.error('[Field Shift] scenario comparison failed:', e); out = null; }
    cmpCache = { key: key, val: out };
    return out;
  }
  function money(n) { var r = Math.round(n / 100) * 100, s = Math.abs(r).toLocaleString('en-US'); return (r < 0 ? '−' : '') + '$' + s; }
  function cell(pct, usd, ok) { return '<b>' + Math.round(pct) + '%</b>' + (ok ? '<span class="fs-scn-usd">' + money(usd) + '</span>' : ''); }
  function compareHtml(r) {
    var c = compare(r && r.inputs); if (!c) return '';
    var kind = c.assumed ? 'assumed' : 'observed', b = c.base, s = c.scen;
    var rows = '<tr><th scope="row">' + badge('observed') + '<span class="fs-scn-rl">All ' + b.n + ' past seasons</span></th><td>' + cell(b.typPct, b.typUsd, c.moneyOk) + '</td><td>' + cell(b.worstPct, b.worstUsd, c.moneyOk) + '<span class="fs-scn-yr">' + b.worstYear + '</span></td></tr>' +
      '<tr class="is-scen"><th scope="row">' + badge(kind) + '<span class="fs-scn-rl">' + esc(c.label) + '</span></th><td>' + cell(s.typPct, s.typUsd, c.moneyOk) + '</td><td>' + cell(s.worstPct, s.worstUsd, c.moneyOk) + '<span class="fs-scn-yr">' + s.worstYear + ' weather</span></td></tr>';
    return '<details class="fs-scn-cmp"><summary>Compare With History</summary>' +
      '<div class="fs-scn-tw"><table class="fs-scn-t"><thead><tr><th scope="col"><span class="fs-sr">Weather</span></th><th scope="col">' + (c.avg ? 'Average season' : 'Typical season') + '</th><th scope="col">Worst season</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="fs-scn-note">% of a normal crop' + (c.moneyOk ? ' and farm return after costs, at today\'s prices' : '') + ', current plans. ' +
      (c.assumed ? 'The scenario row is a what-if, not a prediction.' : 'Both rows are observed seasons, not a forecast.') + '</p></details>';
  }
  // the line at the top of a result: where the numbers come from, and "what-if, not a prediction" for assumed weather
  function runBanner(r) {
    var as = isAssumed(r && r.inputs && r.inputs.weather);
    return '<p class="fs-prov-line">' + badge(as ? 'assumed' : 'observed') + (as ? ' <span>What-if, not a prediction.</span>' : '') + '</p>';
  }

  // ---------------------------------------------------------------- the Scenarios section of the Weather / Season box
  var host = null;
  function sectionHtml() {
    var h = '<div class="fs-scn-head"><span class="fs-scn-title" id="fs-scn-title">Scenarios</span><span class="fs-scn-state" aria-live="polite"></span></div>' +
      '<div class="fs-scn-list" role="group" aria-labelledby="fs-scn-title">';
    PRESETS.forEach(function (p) {
      h += '<button type="button" class="fs-scn-btn" data-preset="' + p.id + '" aria-pressed="false" title="' + esc(p.blurb) + '">' + esc(p.name) + '</button>';
    });
    h += '</div><details class="fs-scn-det"><summary>About These Scenarios</summary><ul class="fs-scn-src">' +
      PRESETS.map(function (p) { return '<li><b>' + esc(p.name) + '.</b> ' + esc(p.blurb) + ' <i>' + esc(p.basis) + '</i></li>'; }).join('') +
      '<li><b>Labels.</b> ' + Object.keys(KINDS).map(function (k) { return '<b>' + esc(KINDS[k].text) + ':</b> ' + esc(KINDS[k].tip); }).join(' ') +
      ' History shows how a plan did under past conditions, not the chance of any season next year. EcoShift holds no long-term climate projections: the assumed scenarios are what-ifs.</li></ul></details>';
    return h;
  }
  function sync() {
    if (!host) return;
    var wc = S.get().controls.weather, id = active(wc);
    host.querySelectorAll('.fs-scn-btn').forEach(function (b) {
      var on = b.getAttribute('data-preset') === id; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var p = id && byId(id);
    host.querySelector('.fs-scn-state').innerHTML = badge(p ? p.kind : isAssumed(wc) ? 'assumed' : 'observed');
  }
  function mount(el) {
    host = el; el.innerHTML = sectionHtml();
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.fs-scn-btn'); if (!b) return;
      var p = byId(b.getAttribute('data-preset')); if (!p) return;
      apply(p.id, 'ui'); A.runSimulation('preset', p.name);
    });
    S.on('controls:change', sync); sync();
  }

  FS.scenarios = { presets: PRESETS, byId: byId, active: active, isAssumed: isAssumed, apply: apply, extraWords: extraWords, compare: compare, compareHtml: compareHtml,
                   runBanner: runBanner, mount: mount, clear: CLEAR };
})();
