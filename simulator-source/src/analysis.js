/* Sim analysis box: shows what happened in a run (summary only).  */
(function () {
  'use strict';
  var FS = window.FS, D = FS.data, S = FS.store, A = FS.actions;
  var el;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n, signed) {
    var r = Math.round(n), s = Math.abs(r).toLocaleString('en-US');
    return (r < 0 ? '−' : signed && r > 0 ? '+' : '') + '$' + s;
  }
  function cls(n) { return n > 0 ? 'fs-good' : n < 0 ? 'fs-bad' : ''; }
  function dateLabel(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  function srcName(key) { var s = D.sources[key]; return s ? s.label : ''; }

  var EXPAND_SVG = '<svg class="ic-expand" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>' +
    '<svg class="ic-collapse" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/></svg>';

  var listEl, runningEl = null, made = {};
  function chrome() {
    el.innerHTML = '<div class="fs-panel-head"><h2 class="fs-panel-title">Sim Analysis</h2><div class="fs-head-right">' +
      '<button type="button" class="fs-expand" data-expand="Sim analysis" aria-label="Expand Sim analysis">' + EXPAND_SVG + '</button></div></div>' +
      '<div class="fs-panel-body" id="fs-analysis-body" aria-live="polite"></div>';
    listEl = el.querySelector('#fs-analysis-body');
    listEl.addEventListener('click', function (e) {
      var q = e.target.closest && e.target.closest('.fs-sq');
      if (q) { var y = Number(q.getAttribute('data-year')); focusYear = y; A.setControl('weather.scenario', scenFor(y), 'ui'); A.runSimulation('strip', scen(scenFor(y)).label); return; }
      var b = e.target.closest && e.target.closest('.fs-linkbtn[data-toggle]'); if (!b) return;
      var d = b.parentNode.nextElementSibling, open = d.hidden;
      d.hidden = !open; b.textContent = open ? 'Hide details' : 'Show details'; b.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { var top = d.offsetTop - listEl.offsetTop - 60; if (top > listEl.scrollTop) listEl.scrollTo({ top: top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    });
  }
  function scrollEnd() { listEl.scrollTop = listEl.scrollHeight; }
  function addRun(r) {
    if (made[r.runId]) return;
    made[r.runId] = true;
    var empty = listEl.querySelector('.fs-empty'); if (empty) empty.remove();
    var d = document.createElement('div'); d.className = 'fs-msg assistant fs-run-msg'; d.innerHTML = runHtml(r);
    // Only the latest run is shown, so old numbers never sit next to new ones (the chat keeps the history).
    listEl.innerHTML = ''; listEl.appendChild(d); listEl.scrollTop = 0; drawStrip();
  }

  function scen(id) {
    try { if (FS.engine && FS.engine.scenario) { var x = FS.engine.scenario(id); if (x) return x; } } catch (e) { /* fall back */ }
    var f = (D.weatherScenarios || []).filter(function (q) { return q.id === id; })[0];
    if (f) return { id: f.id, label: f.label, phrase: f.phrase || ('the ' + f.label) };
    var m = /^y(\d{4})$/.exec(String(id)); if (m) return { id: id, label: m[1] + ' season', phrase: 'the ' + m[1] + ' season' };
    return { id: id, label: String(id), phrase: 'this scenario' };
  }
  // "a typical year (2011 weather), 2 °C warmer and with 50% more rain": the slider shifts are part of the weather, so say them
  function shiftWords(w) {
    var b = [], t = Number(w && w.tempShift) || 0, rn = Number(w && w.rainChange) || 0;
    if (t) b.push(Math.abs(t) + ' °C ' + (t > 0 ? 'warmer' : 'cooler'));
    if (rn) b.push('with ' + Math.abs(rn) + '% ' + (rn > 0 ? 'more' : 'less') + ' rain');
    var ev = (w && Array.isArray(w.events)) ? w.events : [];
    var evs = ev.map(function (e) { var t = FS.eventPhrase ? FS.eventPhrase(e) : ''; return t ? 'a ' + t.charAt(0).toLowerCase() + t.slice(1) : ''; }).filter(Boolean);
    if (evs.length) b.push('with ' + (evs.length < 2 ? evs[0] : evs.slice(0, -1).join(', ') + ' and ' + evs[evs.length - 1]));
    return b.length ? ', ' + b.join(' and ') : '';
  }
  FS.weatherPhrase = function (w) { return scen(w.scenario).phrase + shiftWords(w); };
  function scenarioPhrase(r) { return FS.weatherPhrase(r.inputs.weather); }
  function round10(n) { return Math.round(Math.abs(n) / 10) * 10; }
  function planName(x) { var t = x.planLabel.replace(/\s*\(current plan\)/, ''); return t.charAt(0).toLowerCase() + t.slice(1); }

  var PLAN_PHRASE = {
    'rye-soy': 'planting cereal rye before soybeans', 'rye-corn': 'planting cereal rye before corn',
    'corn-corn': 'planting corn after corn', 'oats-cover': 'planting oats with a summer cover crop',
    'soy-soy': 'planting soybeans after soybeans', 'corn': 'planting corn after soybeans', 'soy': 'planting soybeans after corn'
  };
  function planPhrase(id, x) { return PLAN_PHRASE[id] || ('going with ' + planName(x)); }
  function sentence(s) { s = String(s).trim(); return /[.!?]$/.test(s) ? s : s + '.'; }
  function perAcre(d) { return d === 0 ? 'about the same as your current plan' : 'about $' + Math.abs(d) + ' ' + (d < 0 ? 'less' : 'more') + ' per acre than your current plan'; }
  function joinAnd(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  // Outside Iowa the costs are still Iowa State budgets (Iowa land rent, Iowa yields), so a farm-wide dollar total would
  // mislead; differences between plans hold up much better and are still shown.
  FS.absMoneyOk = function () { try { var st = FS.engine && FS.engine.site && FS.engine.site(); return !st || !st.state || st.state === 'IA'; } catch (e) { return true; } };
  function earns(tot) { var v = round10(tot); return v < 50 ? 'about breaks even' : tot > 0 ? 'earns about ' + money(v) : 'loses about ' + money(v); }

  // One line per field in farmer words, from the same past-season table the strip uses: "North 80: keep soybeans · worst season 87% of normal"
  var CROP_OF = { 'soy': 'soybeans', 'soy-soy': 'soybeans', 'rye-soy': 'soybeans', 'corn': 'corn', 'corn-corn': 'corn', 'rye-corn': 'corn', 'oats-cover': 'oats' };
  function verdictsHtml(r, fields, cur0) {
    var rows = '';
    fields.forEach(function (f) {
      var plan = r.inputs.crops && r.inputs.crops.plans[f.id], data = null;
      try { if (FS.engine && FS.engine.seasons) data = FS.engine.seasons(f.id, r.inputs); } catch (e) { data = null; }
      if (!data || !data.years || !data.plan || !data.plan.pct) return;
      var worst = null, wy = null;
      data.plan.pct.forEach(function (v, i) { if (v != null && isFinite(v) && (worst == null || v < worst)) { worst = v; wy = data.years[i]; } });
      if (worst == null) return;
      var keep = !plan || plan === cur0[f.id];
      var what = keep ? 'keep ' + (CROP_OF[cur0[f.id]] || 'your plan') : 'try ' + (PLAN_SHORT[plan] || 'your plan');
      rows += '<li><b>' + esc(f.name) + ':</b> ' + esc(what) + ' \u00b7 <span title="The worst of the ' + data.years.length + ' past seasons (' + wy + ')">worst season ' + Math.round(worst) + '% of normal</span></li>';
    });
    return rows ? '<ul class="fs-verdicts" aria-label="One line per field">' + rows + '</ul>' : '';
  }

  function runHtml(r) {
    var s = r.summary, delta = s.farm.returnVsBaselineTotal, cur0 = D.initialControls.crops.plans;
    var all = D.farm.fields.filter(function (f) { return s.fields[f.id]; });
    // a field counts as "changed" only if its plan differs AND some acres are actually tried
    var changed = all.filter(function (f) { return r.inputs.crops && r.inputs.crops.plans[f.id] !== cur0[f.id] && s.fields[f.id].trialAcres !== 0; });
    var sc = scenarioPhrase(r), open, h, tot = 0, ac = 0;
    var ps = Number(r.inputs.crops && r.inputs.crops.plantShiftDays) || 0;
    if (ps) sc += ', planting ' + Math.abs(ps) + ' days ' + (ps < 0 ? 'earlier' : 'later');
    var irr = FS.irrigationWords ? FS.irrigationWords(r.inputs.crops && r.inputs.crops.irrigation) : '';
    if (irr) sc += ', ' + irr;
    all.forEach(function (f) { tot += s.fields[f.id].yieldPctOfNormal * s.fields[f.id].acres; ac += s.fields[f.id].acres; });
    var pctNormal = Math.round(tot / (ac || 1));
    // Visible part: ONE short sentence. Everything else sits behind "Show details".
    var oats = all.some(function (f) { return s.fields[f.id].moneyNote; });
    // group changed fields by plan: "planting corn after corn on North 80 and Creek 40"
    var groups = [], byPlan = {};
    changed.forEach(function (f) { var p = r.inputs.crops.plans[f.id]; if (!byPlan[p]) { byPlan[p] = { p: p, x: s.fields[f.id], names: [] }; groups.push(byPlan[p]); } byPlan[p].names.push(esc(f.name)); });
    var who = groups.length > 2 ? 'your changes on ' + changed.length + ' fields' : joinAnd(groups.map(function (g) { return planPhrase(g.p, g.x) + ' on ' + joinAnd(g.names); }));
    if (oats) {
      open = 'In ' + esc(sc) + ', your farm gets about ' + pctNormal + '% of a normal crop. Money is not shown while oats is in the plan, because oats price and cost are rough guesses with no source yet.';
    } else if (changed.length && Math.round(delta) !== 0) {
      open = 'In ' + esc(sc) + ', ' + who + (groups.length > 1 ? ' earn' : ' earns') + ' about ' + money(round10(delta)) + (delta < 0 ? ' less' : ' more') + ' than your current plan.';
    } else {
      open = 'In ' + esc(sc) + ', your farm gets about ' + pctNormal + '% of a normal crop' + (FS.absMoneyOk() ? ' and ' + earns(s.farm.returnTotal) : '') + (changed.length ? ', about the same as your current plan' : '') + '.';
      var errPts = (/typical error (?:of )?(\d+) points?/.exec((s.validation && s.validation.text) || '') || [])[1];
      if (errPts) open += ' Any one season can be off by about ' + errPts + ' points.';
    }
    h = verdictsHtml(r, all, cur0) + '<p>' + open + '</p><div class="fs-strip-wrap"></div>';

    // Details: plain sentences, a farmer can read them top to bottom.
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    function plainEvent(e) {
      var fl = FS.data.farm.fields.filter(function (x) { return x.id === e.fieldId; })[0];
      var where = fl ? fl.name : 'the farm', m = e.date ? MONTHS[Number(e.date.slice(5, 7)) - 1] : 'the season';
      var T = {
        'erosion': 'Heavy rain fell on ' + where + ' in ' + m + ' while little was growing, which raises the risk of soil washing away.',
        'heavy-rain': 'Heavy rain fell on ' + where + ' in ' + m + '.',
        'waterlogged': 'The soil on ' + where + ' stayed waterlogged after heavy rain in ' + m + '.',
        'heat': where + ' had a run of hot days in ' + m + '.',
        'drought': where + ' ran short of soil water in ' + m + '.',
        'frost': 'A frost reached ' + where + ' in ' + m + '.',
        'planting-delay': 'Wet weather delayed planting on ' + where + ' in ' + m + '.'
      };
      // The engine writes each event in plain words from what the model actually computed (e.g. a frost only
      // counts as damage if it cost yield), so its text wins; the generic lines are a fallback only.
      return e.text ? sentence(e.text) : (T[e.type] || '');
    }
    var ev = (s.events || []).filter(function (e) { return e.type !== 'harvest'; });
    var why = s.why || [], chips = [];
    why.forEach(function (w) { if (w.source && chips.indexOf(w.source) < 0) chips.push(w.source); });
    h += '<p><button type="button" class="fs-linkbtn" data-toggle="1" aria-expanded="false">Show details</button></p><div class="fs-details-body" hidden><ul class="fs-detail-list">';
    all.forEach(function (f) {
      var x = s.fields[f.id], d = Math.round(x.returnVsBaselinePerAcre);
      h += '<li>' + esc(f.name) + ': ' + Math.round(x.yieldPctOfNormal) + '% of a normal crop, ' + (x.moneyNote ? esc(sentence(x.moneyNote)) : perAcre(d) + '.') + '</li>';
    });
    var seen = {};
    ev.forEach(function (e) { var t = plainEvent(e); if (t && !seen[t] && Object.keys(seen).length < 6) { seen[t] = 1; h += '<li>' + esc(t) + '</li>'; } });
    why.forEach(function (w) { h += '<li>' + esc(sentence(w.text)) + '</li>'; });
    if (!FS.absMoneyOk()) h += '<li>Dollar totals for the whole farm are not shown here, because the costs are Iowa State budgets; differences between plans are shown instead.</li>';
    if (s.validation && s.validation.text) h += '<li>' + esc(sentence(s.validation.text)) + '</li>';
    if (chips.length) h += '<li>Sources: ' + esc(chips.map(srcName).filter(Boolean).join(', ')) + '.</li>';
    h += '</ul>';
    h += '</div>';
    return h;
  }

  // ---- season strip: one square per past season for the selected field (API_V3 section 3)
  var PLAN_SHORT = { 'rye-soy': 'rye then soybeans', 'rye-corn': 'rye then corn', 'corn-corn': 'corn after corn', 'soy-soy': 'soybeans after soybeans', 'oats-cover': 'oats then a cover crop', 'corn': 'corn', 'soy': 'soybeans' };
  var focusYear = null;
  function yearOf(id) {
    var sc = scen(id); if (sc && sc.year) return Number(sc.year);
    var m = /^y(\d{4})$/.exec(String(id)); return m ? Number(m[1]) : null;
  }
  function scenFor(y) { var n = (D.weatherScenarios || []).filter(function (q) { return q.year === y; })[0]; return n ? n.id : 'y' + y; }
  function drawStrip() {
    var wrap = listEl && listEl.querySelector('.fs-strip-wrap'), r = S.get().current; if (!wrap || !r) return;
    var data = null, fid = S.get().selectedField;
    try { if (FS.engine && FS.engine.seasons) data = FS.engine.seasons(fid, r.inputs); } catch (e) { console.error(e); }
    if (!data || !data.years || !data.years.length || !data.current) { wrap.innerHTML = ''; return; }
    var f = D.farm.fields.filter(function (x) { return x.id === fid; })[0], name = f ? f.name : 'this field';
    var diff = data.plan && data.plan.plan !== data.current.plan && data.diffPerAcre && data.diffPerAcre.some(function (v) { return v != null; });
    var sel = yearOf(r.inputs.weather.scenario), n = data.years.length;
    var planName = PLAN_SHORT[data.plan && data.plan.plan] || 'your plan';
    var h = '<div class="fs-strip" role="group" aria-label="Past seasons on ' + esc(name) + '">';
    data.years.forEach(function (y, i) {
      var cl, label, pct = data.plan && data.plan.pct ? data.plan.pct[i] : (data.current.pct || [])[i];
      if (diff) {
        var d = data.diffPerAcre[i];
        if (d == null) { cl = 'none'; label = y + ': money is not shown for this plan'; }
        else {
          var amt = Math.round(Math.abs(d));
          cl = d >= 10 ? 'up' : d <= -10 ? 'down' : 'same';
          label = y + ': ' + planName + (cl === 'same' ? ' earned about the same as your current plan' : ' earned $' + amt + ' per acre ' + (d > 0 ? 'more' : 'less') + ' than your current plan');
        }
      } else {
        var pc = pct == null ? null : Math.round(pct);
        cl = pc == null ? 'none' : pc >= 105 ? 'up' : pc <= 90 ? 'down' : 'same';
        label = y + ': about ' + pc + '% of a normal crop' + (cl === 'up' ? ', a good year' : cl === 'down' ? ', a bad year' : '');
        if (pc == null) label = y + ': no result';
      }
      h += '<button type="button" class="fs-sq is-' + cl + (y === sel ? ' is-sel' : '') + '" data-year="' + y + '" aria-pressed="' + (y === sel ? 'true' : 'false') + '" aria-label="' + esc(label) + '" title="' + esc(label) + '"></button>';
    });
    h += '</div><p class="fs-strip-cap">' + (diff ? data.years[0] + '–' + data.years[n - 1] + '. Olive: $10+ an acre more than your plan. Brown: $10+ less. Grey: about the same.' : data.years[0] + '–' + data.years[n - 1] + '. Olive: good year. Brown: bad year. Grey: about normal.') + '</p>';
    wrap.innerHTML = h;
    if (focusYear != null) { var b = wrap.querySelector('[data-year="' + focusYear + '"]'); if (b) b.focus(); focusYear = null; }
  }

  FS.analysis = {
    mount: function (mountEl) {
      el = mountEl; chrome();
      var runs = S.get().runs;
      if (!runs.length) listEl.innerHTML = '<p class="fs-empty">Run a simulation to see what happened.</p>';
      runs.forEach(addRun);
      S.on('sim:start', function () {
        if (runningEl) return;
        runningEl = document.createElement('p'); runningEl.className = 'fs-running'; runningEl.textContent = 'Running simulation…';
        var empty = listEl.querySelector('.fs-empty'); if (empty) empty.remove();
        listEl.appendChild(runningEl); scrollEnd();
      });
      S.on('field:select', function () { drawStrip(); });
      S.on('sim:done', function (r) { if (runningEl) { runningEl.remove(); runningEl = null; } addRun(r); });
    }
  };
})();
