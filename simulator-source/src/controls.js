/* The three control boxes. Every change goes through FS.actions.setControl; the boxes re-render from 'controls:change'
   so changes made by the chat show up here too. */
(function () {
  'use strict';
  var FS = window.FS, D = FS.data, A = FS.actions, S = FS.store;
  var root = {}, shownField = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pathGet(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }
  function baseline(path) { return pathGet(D.initialControls, path); }
  function field(id) { return D.farm.fields.filter(function (f) { return f.id === id; })[0]; }
  function years() { var c = D.climate && D.climate.meta; return (c && c.years) || []; }
  var PRIOS = [['balanced', 'Balanced'], ['profit', 'Profit'], ['risk', 'Lowest risk'], ['cover', 'Most ground cover']];
  function sign(n, unit) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + unit; }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // Plain words for a weather event, without an article: "Dry July", "Severe drought in July", "Heat wave in July".
  FS.eventPhrase = function (e) {
    var m = MONTHS[(e && e.month) - 1] || '', sev = e && e.severity === 'severe';
    if (!m) return '';
    if (e.type === 'dryspell') return sev ? 'Severe drought in ' + m : 'Dry ' + m;
    if (e.type === 'wetspell') return (sev ? 'Very wet ' : 'Wet ') + m;
    if (e.type === 'heatwave') return (sev ? 'Severe heat wave in ' : 'Heat wave in ') + m;
    return '';
  };
  FS.plantWords = function (v) { v = Number(v) || 0; return v === 0 ? 'On time' : Math.abs(v) + ' days ' + (v < 0 ? 'earlier' : 'later'); };
  function events(c) { var e = c && c.weather && c.weather.events; return Array.isArray(e) ? e : []; }
  function dflt(path) { return path === 'crops.plantShiftDays' ? 0 : path === 'other.priority' ? 'balanced' : path === 'crops.irrigation' ? 'none' : undefined; }
  // Irrigation (API_V4 section 3): one inch a week, spread over the season months chosen.
  var IRRIG = [['none', 'None'], ['july', 'In July'], ['july-aug', 'July and August'], ['jun-aug', 'June to August']];
  var IRRIG_SAY = { july: 'an inch a week in July', 'july-aug': 'an inch a week in July and August', 'jun-aug': 'an inch a week from June to August' };
  FS.irrigationPhrase = function (v) { return IRRIG_SAY[v] || ''; };                       // '' for none
  FS.irrigationWords = function (v) { return IRRIG_SAY[v] ? 'irrigating ' + IRRIG_SAY[v] : ''; };
  FS.farmSetup = FS.farmSetup || {};

  var FMT = {
    plant: function (v) { return FS.plantWords(v); },
    temp: function (v) { return sign(v, ' °C'); },
    pct: function (v) { return sign(v, ' %'); },
    plain: function (v) { return v + ' %'; },
    acres: function (v) { return v === 0 ? '0 ac (current plan)' : v + ' ac'; },
    prio: function (v) { return v; }
  };

  function head(title, resetId) {
    // The title is a disclosure button: the box starts collapsed and opens to show its sliders.
    var bodyId = resetId.replace('fs-reset-', 'fs-body-');
    return '<div class="fs-panel-head"><h2 class="fs-panel-title"><button type="button" class="fs-ctl-toggle" aria-expanded="false" aria-controls="' + bodyId + '">' +
      '<span>' + title + '</span><svg class="fs-chev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
      '</button></h2></div>';
  }
  function slider(id, label, path, min, max, step, fmt) {
    return '<div class="fs-row" data-path="' + path + '" data-fmt="' + fmt + '">' +
      '<div class="fs-row-head"><label for="' + id + '">' + label + '</label>' +
      '<output class="fs-val" for="' + id + '"></output></div>' +
      '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '"></div>';
  }

  function setOpen(box, open) {
    var btn = box.querySelector('.fs-ctl-toggle'), body = box.querySelector('.fs-panel-body');
    box.classList.toggle('is-collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
  }
  function wireToggles() {
    ['weather', 'crops', 'other'].forEach(function (k) {
      var box = root[k], body = box.querySelector('.fs-panel-body');
      body.id = 'fs-body-' + k;
      setOpen(box, false);
      box.querySelector('.fs-ctl-toggle').addEventListener('click', function () {
        setOpen(box, box.classList.contains('is-collapsed'));
        window.dispatchEvent(new Event('resize')); // the map redraws at its new size
      });
    });
  }
  // Escape closes the open box you are working in and puts focus back on its title.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['weather', 'crops', 'other'].forEach(function (k) {
      var box = root[k]; if (!box || box.classList.contains('is-collapsed') || !box.contains(document.activeElement)) return;
      setOpen(box, false); box.querySelector('.fs-ctl-toggle').focus(); window.dispatchEvent(new Event('resize'));
    });
  });
  FS.controlsOpen = function (k, open) { if (root[k]) { setOpen(root[k], open !== false); window.dispatchEvent(new Event('resize')); } };

  function scenarioOptions() {
    return D.weatherScenarios.map(function (s) { return '<option value="' + s.id + '">' + esc(s.label) + '</option>'; }).join('') +
      (years().length ? '<optgroup label="Any past season">' + years().filter(function (y) { return !namedFor(y); }).map(function (y) { return '<option value="y' + y + '">' + y + ' season</option>'; }).join('') + '</optgroup>' : '');
  }
  function fieldOptions() { return D.farm.fields.map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + ' · ' + f.acres + ' ac</option>'; }).join(''); }

  function build() {
    root.weather.innerHTML = head('Weather / Season', 'fs-reset-weather') + '<div class="fs-panel-body">' +
      '<div class="fs-row" data-path="weather.scenario"><div class="fs-row-head"><label for="fs-weather-scenario">Scenario</label></div>' +
      '<select id="fs-weather-scenario" class="fs-select">' + scenarioOptions() + '</select></div>' +
      slider('fs-weather-temp', 'Temperature shift', 'weather.tempShift', -2, 4, 0.5, 'temp') +
      slider('fs-weather-rain', 'Rain change', 'weather.rainChange', -50, 50, 5, 'pct') +
      '<div class="fs-chips" id="fs-weather-chips" hidden></div></div>';

    root.crops.innerHTML = head('Crops', 'fs-reset-crops') + '<div class="fs-panel-body">' +
      '<div class="fs-row"><div class="fs-row-head"><label for="fs-crops-field">Field</label></div>' +
      '<select id="fs-crops-field" class="fs-select">' + fieldOptions() + '</select></div>' +
      '<div class="fs-row" id="fs-plan-row"><div class="fs-row-head"><label for="fs-crops-plan">Plan for next season</label></div>' +
      '<select id="fs-crops-plan" name="fs-plan" class="fs-select"></select></div>' +
      '<div id="fs-acres-slot"></div>' +
      slider('fs-crops-plant', 'Planting date, all fields', 'crops.plantShiftDays', -21, 21, 7, 'plant') +
      '<div class="fs-row" id="fs-irrig-row" data-path="crops.irrigation" hidden><div class="fs-row-head"><label for="fs-crops-irrigation">Irrigation, 1 inch a week</label></div>' +
      '<select id="fs-crops-irrigation" class="fs-select">' + IRRIG.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('') + '</select></div></div>';

    root.other.innerHTML = head('Other Conditions', 'fs-reset-other') + '<div class="fs-panel-body">' +
      slider('fs-other-price', 'Crop price', 'other.priceChange', -40, 40, 5, 'pct') +
      slider('fs-other-nitrogen', 'Nitrogen price', 'other.nitrogenChange', -30, 80, 5, 'pct') +
      slider('fs-other-contracted', 'Already contracted', 'other.contracted', 0, 100, 5, 'plain') +
      '<div class="fs-row" data-path="other.costShare"><label class="fs-check" for="fs-other-costshare">' +
      '<input type="checkbox" id="fs-other-costshare"><span>Iowa cover-crop cost-share ($30/acre, Iowa farms only)</span></label></div>' +
      '<div class="fs-row" data-path="other.priority" data-fmt="prio"><div class="fs-row-head"><label for="fs-other-priority">Rank options by</label></div>' +
      '<select id="fs-other-priority" class="fs-select">' + PRIOS.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('') + '</select></div></div>';
  }

  // Rebuild only the parts of the Crops box that depend on the selected field.
  function buildFieldParts(id) {
    var f = field(id), list = root.crops.querySelector('#fs-crops-plan');
    var current = D.initialControls.crops.plans[id];
    var ex = (D.initialControls.other && D.initialControls.other.exclude) || [], chosen = S.get().controls.crops.plans[id];   // plans the farmer will not grow are not offered (the current plan stays)
    list.innerHTML = D.planOptions[f.lastCrop].filter(function (pid) { return pid === current || pid === chosen || ex.indexOf(pid) < 0; }).map(function (pid) {
      var name = D.plans[pid].label.replace(/\s*\(current plan\)/, '');
      return '<option value="' + pid + '">' + esc(name) + (pid === current ? ' (current)' : '') + '</option>';
    }).join('');
    root.crops.querySelector('#fs-acres-slot').innerHTML =
      slider('fs-crops-acres', 'Acres to try', 'crops.trialAcres.' + id, 0, f.acres, 5, 'acres');
    shownField = id;
  }

  // a year that already has a named scenario is listed once, under its name
  function namedFor(y) { return (D.weatherScenarios || []).filter(function (q) { return q.year === Number(y); })[0] || null; }
  function sync() {
    var sel = S.get().selectedField;
    if (sel !== shownField) buildFieldParts(sel);
    var c = S.get().controls;
    root.crops.querySelector('#fs-crops-field').value = sel;
    var planPath = 'crops.plans.' + sel;
    root.crops.querySelector('#fs-crops-plan').value = c.crops.plans[sel];
    root.crops.querySelector('#fs-plan-row').classList.toggle('is-changed', pathGet(c, planPath) !== baseline(planPath));

    Object.keys(root).forEach(function (k) {
      root[k].querySelectorAll('.fs-row[data-path]').forEach(function (row) {
        var path = row.getAttribute('data-path'), v = pathGet(c, path);
        if (v == null && dflt(path) !== undefined) v = dflt(path);
        if (path === 'weather.scenario' && /^y\d{4}$/.test(String(v)) && namedFor(String(v).slice(1))) v = namedFor(String(v).slice(1)).id;
        var input = row.querySelector('input, select');
        if (input.type === 'checkbox') input.checked = !!v;
        else if (input.value !== String(v)) input.value = v;
        var out = row.querySelector('output');
        if (out) out.textContent = FMT[row.getAttribute('data-fmt')](Number(v));
        row.classList.toggle('is-changed', v !== (baseline(path) == null ? dflt(path) : baseline(path)));
      });
    });
    drawChips(c);
    var ir = root.crops.querySelector('#fs-irrig-row'), irv = pathGet(c, 'crops.irrigation');
    if (ir) ir.hidden = !(FS.farmSetup.canIrrigate || (irv && irv !== 'none'));
  }
  function drawChips(c) {
    var box = root.weather.querySelector('#fs-weather-chips'), list = events(c);
    box.hidden = !list.length;
    box.innerHTML = list.map(function (e, i) {
      var t = FS.eventPhrase(e);
      return '<button type="button" class="fs-chip" data-i="' + i + '" aria-label="Remove ' + esc(t) + '"><span>' + esc(t) + '</span><span aria-hidden="true">×</span></button>';
    }).join('');
  }

  function resetPaths(paths) {
    paths.forEach(function (p) {
      if (p === 'crops.irrigation' && pathGet(S.get().controls, p) == null) return;
      if (p === 'weather.events') { if (events(S.get().controls).length) A.setControl(p, [], 'ui'); return; }
      var b = baseline(p); if (b == null) b = dflt(p); A.setControl(p, b, 'ui');
    });
  }

  function wire() {
    function onRange(e) {
      var t = e.target, row = t.closest && t.closest('.fs-row[data-path]');
      if (t.type === 'range' && row) A.setControl(row.getAttribute('data-path'), Number(t.value), 'ui');
    }
    root.weather.addEventListener('input', onRange);
    root.other.addEventListener('input', onRange);
    root.crops.addEventListener('input', onRange);
    root.weather.querySelector('#fs-weather-chips').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.fs-chip'); if (!b) return;
      var i = Number(b.getAttribute('data-i')), list = events(S.get().controls).slice();
      list.splice(i, 1); A.setControl('weather.events', list, 'ui');
    });
    root.weather.querySelector('#fs-weather-scenario').addEventListener('change', function (e) { A.setControl('weather.scenario', e.target.value, 'ui'); });
    root.other.querySelector('#fs-other-priority').addEventListener('change', function (e) {
      A.setControl('other.priority', e.target.value, 'ui'); A.runSimulation('priority', 'Ranked by ' + e.target.options[e.target.selectedIndex].text.toLowerCase());
    });
    root.other.querySelector('#fs-other-costshare').addEventListener('change', function (e) { A.setControl('other.costShare', e.target.checked, 'ui'); });
    root.crops.querySelector('#fs-crops-field').addEventListener('change', function (e) { A.selectField(e.target.value, 'ui'); });
    root.crops.addEventListener('change', function (e) {
      if (e.target.name === 'fs-plan') A.setControl('crops.plans.' + S.get().selectedField, e.target.value, 'ui');
      if (e.target.id === 'fs-crops-irrigation') A.setControl('crops.irrigation', e.target.value, 'ui');
    });
    root.weather.querySelector('#fs-reset-weather').addEventListener('click', function () {
      resetPaths(['weather.scenario', 'weather.tempShift', 'weather.rainChange', 'weather.events']);
    });
    root.other.querySelector('#fs-reset-other').addEventListener('click', function () {
      resetPaths(['other.priceChange', 'other.nitrogenChange', 'other.contracted', 'other.costShare', 'other.priority']);
    });
    root.crops.querySelector('#fs-reset-crops').addEventListener('click', function () {
      resetPaths(D.farm.fields.reduce(function (a, f) { return a.concat(['crops.plans.' + f.id, 'crops.trialAcres.' + f.id]); }, ['crops.plantShiftDays', 'crops.irrigation']));
    });
    S.on('controls:change', sync);
    S.on('field:select', sync);
  }

  FS.controls = {
    // After a new farm is set up: new field names and acres, the plan list for each field, the season list.
    rebuild: function () {
      if (!root.crops) return;
      root.weather.querySelector('#fs-weather-scenario').innerHTML = scenarioOptions();
      root.crops.querySelector('#fs-crops-field').innerHTML = fieldOptions();
      shownField = null; sync();
    },
    mount: function (els) {
      root = els;
      build();
      // Reset lives inside each open box (top right), so the title bar only holds the title and the open/close arrow.
      [['weather', 'Weather / Season'], ['crops', 'Crops'], ['other', 'Other Conditions']].forEach(function (p) {
        root[p[0]].querySelector('.fs-panel-body').insertAdjacentHTML('afterbegin',
          '<div class="fs-body-tools"><button type="button" class="fs-linkbtn fs-reset" id="fs-reset-' + p[0] + '" aria-label="Reset ' + p[1] + '">Reset</button></div>');
      });
      wire(); wireToggles(); sync();
    }
  };
})();
