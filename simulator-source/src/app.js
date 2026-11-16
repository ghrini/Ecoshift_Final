/* Boot: header behaviour, mount every module (each guarded), first run, opening recommendations. */
(function () {
  'use strict';
  var FS = window.FS; FS.farmSetup = FS.farmSetup || {};
  function $(id) { return document.getElementById(id); }
  function guard(name, fn) { try { fn(); } catch (e) { console.error('[Field Shift] ' + name + ' failed:', e); } }

  function wireHeader() {
    var dirty = $('fs-dirty');
    $('fs-run').addEventListener('click', function () { FS.actions.runSimulation('ui'); });
    function refresh() { var d = !FS.store.get().dirty; dirty.hidden = d; $('fs-dirty-sr').hidden = d; $('fs-run').title = d ? '' : 'Changes not run yet'; }
    FS.store.on('controls:change', refresh); FS.store.on('sim:done', refresh); refresh();
  }

  // Expand one of Simulation / Sim analysis / Chat to fill the viewport. Only one at a time; Esc collapses.
  var panelOf = { 'Simulation': 'fs-view-panel', 'Sim analysis': 'fs-analysis', 'Chat': 'fs-chat' };
  function setExpanded(title) {
    Object.keys(panelOf).forEach(function (t) {
      var p = $(panelOf[t]); if (!p) return;
      var on = t === title; p.classList.toggle('fs-expanded', on);
      var b = p.querySelector('.fs-expand'); if (b) b.setAttribute('aria-label', (on ? 'Collapse ' : 'Expand ') + t);
    });
    window.dispatchEvent(new Event('resize'));
  }
  function wireExpand() {
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.fs-expand'); if (!b) return;
      var t = b.getAttribute('data-expand'), p = $(panelOf[t]);
      setExpanded(p.classList.contains('fs-expanded') ? null : t);
      var nb = p.querySelector('.fs-expand'); if (nb) nb.focus();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = Object.keys(panelOf).filter(function (t) { return $(panelOf[t]).classList.contains('fs-expanded'); })[0];
      if (open) { setExpanded(null); var nb = $(panelOf[open]).querySelector('.fs-expand'); if (nb) nb.focus(); }
    });
  }

  // ---------------------------------------------------------------- farm setup state (API_V4 section 5)
  var SETUP_KEY = 'fieldshift.farm.v1', mounted = false, fromEco = false, backDemo = false, hashP = {};
  var fromCounty = null;   // set when opened from one of the 14 example farms (?county=<id>)
  var POS = [['north', 'North'], ['creek', 'Creek'], ['west', 'West'], ['south', 'South']];
  var IRRIGS = ['none', 'july', 'july-aug', 'jun-aug'];
  var DEFAULT_FIELDS = null;   // the example farm's fields, taken before anything changes them
  var BASE_CONTRACTED = 30;    // the simulator's own "already contracted", before any answer changes it
  function Q() { return FS.questionnaire; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function STORY() { return { id: 'story-ia', name: (FS.data.farm && FS.data.farm.place) || 'Story County, Iowa', short: 'Story Co., IA', validated: true }; }
  function sites() { return Array.isArray(FS.data.sites) && FS.data.sites.length ? FS.data.sites : [STORY()]; }
  function siteById(id) { var l = sites().filter(function (x) { return x.id === id; })[0]; return l || (id === 'story-ia' ? STORY() : null); }
  function siteShort(x) { return x.short || x.name; }
  function exampleSetup() { return Q().example(); }
  function loadSetup() {
    try {
      var raw = localStorage.getItem(SETUP_KEY); if (!raw) return null;
      return Q().normalize(JSON.parse(raw));
    } catch (e) { return null; }
  }
  function saveSetup(setup) { try { localStorage.setItem(SETUP_KEY, JSON.stringify(setup.example ? { example: true, fieldCount: setup.fieldCount } : setup)); } catch (e) { /* storage may be blocked: the questionnaire just shows again next time */ } }

  function localOf() { var l = FS.engine && FS.engine.site ? FS.engine.site().local : null; return l && !FS.farmSetup.example ? l : null; }
  function shortLabel(s) { s = String(s || 'your location'); return s.split(',').slice(0, 2).join(',').slice(0, 48); }

  // ---------------------------------------------------------------- fitting the county's data to the farm's own point (/api/localfit)
  // The fit belongs to the point, the data county and the land answers; any change to those asks again.
  function fitKey(s) {
    var p = s && s.point; if (!p) return '';
    return JSON.stringify([Math.round(p.lat * 1e4) / 1e4, Math.round(p.lon * 1e4) / 1e4, s.site, s.drainage, s.tile, s.slope, s.soilTest, s.limits, s.limitsNote, s.practices]);
  }
  function fitOf(s) { return s && !s.example && s.point && s.fit && s.fit.local && s.fit.key === fitKey(s) ? s.fit.local : null; }
  // imported field outlines (fieldimport.js): the conditions measured at those fields replace the county fit
  function geoOf(s) { var g = s && !s.example && s.geo; return g && Array.isArray(g.fields) && g.fields.length && g.cond && g.cond.climate ? g : null; }
  function geoLocal(g) {
    var c = g.cond, soils = {};
    Object.keys(c.fields || {}).forEach(function (id) { var x = c.fields[id]; if (x && x.soil && x.soil.awcMmPerM) soils[id] = x.soil; });
    return { label: (c.county ? 'your fields in ' + c.county : 'your fields'), lat: c.center ? c.center[1] : null, lon: c.center ? c.center[0] : null, km: 0,
      soils: soils, normalYield: c.normalYield || null };
  }
  function apiBase() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  var fitting = '';
  var farTold = '';
  function maybeFit(setup) {
    if (!setup || setup.example || !setup.point || fitOf(setup) || geoOf(setup)) return;
    var key = fitKey(setup), base = apiBase(), site = siteById(setup.site) || STORY(), p = setup.point;
    if (!base) { guard('fit note', function () { FS.actions.addChat({ role: 'assistant', text: 'Your farm\'s spot is saved, but fitting ' + site.name + '\'s data to it needs the EcoShift server (run npm start and open http://localhost:8787). For now the county\'s data is used as it is.' }); }); return; }
    if (fitting === key) return;
    var lat = site.lat, lon = site.lon;
    if (lat == null) { var x = (FS.data.sites || []).filter(function (q) { return q.id === site.id; })[0]; if (x) { lat = x.lat; lon = x.lon; } }
    if (lat == null && site.id === 'story-ia') { lat = 42.03; lon = -93.47; }
    // far from every county we have (or south of the equator): the fit would stretch Corn Belt data too far, so it is not applied
    var R = Math.PI / 180, km = lat == null ? 0 : 6371 * 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p.lat - lat) * R / 2), 2) + Math.cos(p.lat * R) * Math.cos(lat * R) * Math.pow(Math.sin((p.lon - lon) * R / 2), 2)));
    if (p.lat < 0 || km > 400) {
      if (farTold === key) return; farTold = key;
      guard('fit far', function () { FS.actions.addChat({ role: 'assistant', text: 'Your farm is about ' + Math.round(km / 10) * 10 + ' km from ' + site.name + ', the nearest county this simulator has. The model is built for the US Corn Belt, so I am using ' + site.name + '\'s weather and soils as they are rather than stretching them to your spot. Read the results as a rough guide for your farm.' }); });
      return;
    }
    fitting = key;
    var body = { lat: p.lat, lon: p.lon, label: p.label || '', county: p.county || '', state: p.state || '', site: { id: site.id, name: site.name, lat: lat, lon: lon },
      answers: { drainage: setup.drainage, tile: setup.tile, slope: setup.slope, soilTest: setup.soilTest, limits: setup.limits, limitsNote: setup.limitsNote, practices: setup.practices } };
    fetch(base + '/api/localfit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) {
        if (fitting === key) fitting = '';
        var cur = FS.farmSetup.setup;
        if (!cur || fitKey(cur) !== key) return;   // the farm changed while we waited
        if (!x.ok || !x.j || !x.j.local) throw new Error((x.j && x.j.error) || 'the server could not fit the data just now');
        cur.fit = { key: key, local: x.j.local, sources: x.j.sources || [], gaps: x.j.gaps || [], at: new Date().toISOString().slice(0, 10) };
        saveSetup(cur);
        var r = applySetup(cur);
        if (!r.ok) throw new Error(r.error || 'the fitted farm could not be set up');
        guard('fit message', function () { FS.actions.addChat({ role: 'assistant', text: fitMessage(cur.fit, site) }); });
      })
      .catch(function (e) {
        if (fitting === key) fitting = '';
        guard('fit failed', function () { FS.actions.addChat({ role: 'assistant', text: 'I couldn\'t fit the data to your farm (' + String(e && e.message || e) + '). The simulator uses ' + site.name + '\'s data as it is; it will try again next time you open it.' }); });
      });
  }
  function fitMessage(fit, site) {
    var L = fit.local, ai = L.ai, t = [];
    function sg(x) { return (x > 0 ? '+' : '') + (x || 0); }
    t.push('I fitted ' + site.name + '\'s data to your farm near ' + shortLabel(L.label) + ' (' + L.km + ' km away).');
    if (fit.sources.length) t.push('Used: ' + fit.sources.join(' '));
    if (ai) {
      var bits = [];
      if (ai.tileDrained) bits.push('tile drained, so poorly drained soils are treated as moderately well drained');
      if (ai.drainageClass && ai.drainageClass !== 'keep') bits.push('drainage set to ' + String(ai.drainageClass).toLowerCase() + ' from your answer');
      if (ai.awcPct) bits.push('soil water-holding ' + sg(ai.awcPct) + '%');
      if (ai.yieldPct && (ai.yieldPct.corn || ai.yieldPct.soybean)) bits.push('normal yields corn ' + sg(ai.yieldPct.corn) + '%, soybeans ' + sg(ai.yieldPct.soybean) + '%');
      t.push('From your answers (Gemini, ' + ai.confidence + ' confidence): ' + (bits.length ? bits.join('; ') : 'no changes') + '.' + (ai.notes && ai.notes.length ? ' ' + ai.notes.join(' ') : ''));
    }
    if (fit.gaps.length) t.push('Gaps: ' + fit.gaps.join(' '));
    t.push('This fitted farm has not been checked against its own harvests.');
    return t.join(' ');
  }

  // One quiet line under the boxes: what the data is, how far it was checked, and who decides.
  function wireFooter() {
    var el = $('fs-foot'); if (!el) return;
    var site = FS.farmSetup.site || STORY(), m = FS.data.climate && FS.data.climate.meta, ys = (m && m.years) || [], span = ys.length ? ys[0] + '–' + ys[ys.length - 1] : '1982–2025';
    var demo = fromEco || FS.farmSetup.example, checked = site.validated !== false, loc = localOf();
    if (loc && !demo) {
      el.textContent = 'Real NASA POWER weather (' + span + ') and USDA soils · your farm near ' + loc.label + ' · data from ' + loc.dataFrom + ' (' + loc.km + ' km), fitted to your spot with NASA POWER, USDA soils and yields' +
        ' · the yield check was done for Story County, Iowa (see Show details); fitted farms are not checked against their own harvests · part of EcoShift · supports, not replaces, your judgment.';
      try { document.title = 'EcoShift · ' + loc.label; } catch (e) { /* ignore */ }
      return;
    }
    el.textContent = 'Real NASA POWER weather (' + span + ') and USDA soils · ' + (demo ? 'demonstration farm in ' : 'your farm in ') + site.name + ' · ' +
      (checked ? 'catches the 1988 and 2012 droughts, no better than the yield trend in ordinary years (see Show details)'
        : 'the yield check was done for Story County, Iowa (see Show details); this location is not checked against its own county\'s harvests') +
      ' · part of EcoShift · supports, not replaces, your judgment.';
    try { document.title = 'EcoShift · ' + site.name; } catch (e) { /* ignore */ }
  }
  function wireFarmLine() {
    var b = $('fs-farm-btn'); if (!b) return;
    var site = FS.farmSetup.site || STORY(), loc = localOf(), p = FS.farmSetup.setup && !FS.farmSetup.example && FS.farmSetup.setup.point;
    var dataName = String(site.name).split(',')[0];
    var g = geoOf(FS.farmSetup.setup), gs = g && FS.engine && FS.engine.site ? FS.engine.site().geo : null;
    var txt = gs ? 'Your ' + gs.fields + ' field' + (gs.fields === 1 ? '' : 's') + (g.cond.county ? ' in ' + g.cond.county : '') + ' · ' + ((g.cond.climate && g.cond.climate.meta && g.cond.climate.meta.short) || 'NASA POWER') + ' weather · Copernicus terrain' : loc ? 'Your farm near ' + shortLabel(loc.label) + ' · data from ' + dataName + ' (' + loc.km + ' km)'
      : p ? 'Your farm near ' + shortLabel(p.label) + ' · data from ' + dataName : 'Your farm: ' + siteShort(site);
    b.querySelector('.fs-farm-name').textContent = txt;
    b.setAttribute('aria-label', txt + '. Change');
  }

  // Put a setup (the questionnaire's answers) into effect. Before the page is mounted it only sets the data; after, it rebuilds every label and runs again.
  function applySetup(setup, o) {
    o = o || {};
    var site = siteById(setup.site) || STORY(), d = Q().derive(setup);
    var skipEngine = setup.example && !mounted && FS.farmSetup.site == null && !(setup.fieldCount < 4);   // the example is what is already loaded
    if (!skipEngine) {
      if (FS.engine && FS.engine.setFarm) {
        var res;
        var g = geoOf(setup);
        try { res = FS.engine.setFarm({ site: site.id, fields: d.fields, count: setup.fieldCount, local: g ? geoLocal(g) : fitOf(setup), geo: g ? { fields: g.fields, climate: g.cond.climate } : null }); }
        catch (e) { console.error(e); res = { ok: false, error: String(e && e.message || e) }; }
        if (res && res.ok === false) return { ok: false, error: res.error || 'That farm could not be set up.' };
      } else if (site.id !== 'story-ia') return { ok: false, error: 'This location is not available yet.' };
    }
    var st = FS.store.get(), ic = FS.data.initialControls;
    ic.other = ic.other || {}; ic.crops = ic.crops || {};
    ic.other.priority = d.priority; ic.other.costShare = !!d.costShare;
    ic.other.contracted = d.contracted != null ? d.contracted : BASE_CONTRACTED;
    if (d.exclude.length) ic.other.exclude = d.exclude.slice(); else delete ic.other.exclude;
    if (d.irrigation !== 'none') ic.crops.irrigation = d.irrigation; else delete ic.crops.irrigation;   // irrigated: the farm's normal practice, baseline and options alike
    var ff = FS.data.farm.fields;
    st.farm = FS.data.farm; st.controls = clone(ic); st.selectedField = ff[Math.min(1, ff.length - 1)].id; st.dirty = true;
    if (d.trial === 'patch') {   // a small test patch: 10% of the selected field, at least 5 acres
      var sf = FS.data.farm.fields.filter(function (f) { return f.id === st.selectedField; })[0];
      if (sf) st.controls.crops.trialAcres[sf.id] = Math.min(sf.acres, Math.max(5, Math.round(sf.acres * 0.1)));
    }
    FS.farmSetup.site = site; FS.farmSetup.canIrrigate = !!d.canIrrigate; FS.farmSetup.example = !!setup.example; FS.farmSetup.setup = setup;
    guard('advice', function () { if (FS.chat && FS.chat.setAdvice) FS.chat.setAdvice(setup.example ? null : { greeting: d.greeting, lines: d.lines, card: d.card }); });
    if (!mounted) return { ok: true };
    guard('baseline', function () { if (FS.engine && FS.engine.warm) FS.engine.warm(); FS.computeBaseline(); });
    guard('controls', function () { FS.controls.rebuild(); });
    guard('map', function () { FS.fieldView.refresh(); });
    guard('footer', function () { wireFooter(); wireFarmLine(); });
    guard('chat reset', function () { FS.chat.reset(); });
    guard('select', function () { FS.store.emit('field:select', { id: st.selectedField, source: 'setup' }); });
    guard('run', function () { FS.actions.runSimulation('setup', 'Typical season · current plans'); });
    guard('recs', function () { FS.chat.postRecs(); });
    guard('outlook', function () { if (FS.outlook) FS.outlook.refresh(); });
    guard('farm map', function () { if (FS.farmMap) FS.farmMap.refresh(); });
    guard('conditions', function () { if (FS.conditions) FS.conditions.refresh(); });
    return { ok: true };
  }

  // ---------------------------------------------------------------- the farm questionnaire (src/questionnaire.js draws it)
  var panel = null, ctrl = null, lastFocus = null, firstOpen = false;
  var INERT = ['fs-backrow', 'fs-header', 'fs-app', 'fs-outlook', 'fs-foot'];
  function setInert(on) { INERT.forEach(function (id) { var e = $(id); if (!e) return; if (on) { e.setAttribute('inert', ''); e.setAttribute('aria-hidden', 'true'); } else { e.removeAttribute('inert'); e.removeAttribute('aria-hidden'); } }); }
  function buildPanel() {
    var host = $('fs-setup'); if (!host || ctrl) return;
    ctrl = Q().create(host, { onStart: onStart, onExample: onExample, onEscape: function () { if (firstOpen && FS.farmSetup.example) onExample(); else closePanel(); } });
    panel = host;
  }
  // step: 'welcome' on the first run, 'review' from "Change" in the header
  function openPanel(first, step) {
    buildPanel(); if (!panel) return;
    firstOpen = !!first; lastFocus = document.activeElement;
    panel.hidden = false; setInert(true);
    ctrl.show(FS.farmSetup.setup || exampleSetup(), { first: !!first, step: step || (first ? 'welcome' : 'review') });
    panel.scrollTop = 0;
  }
  function closePanel() {
    if (!panel || panel.hidden) return;
    panel.hidden = true; setInert(false); firstOpen = false;
    var back = $('fs-farm-btn'); try { (lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : back).focus(); } catch (e) { /* ignore */ }
  }
  function onStart(setup) {
    var r = applySetup(setup);
    if (!r.ok) return r;
    saveSetup(setup); closePanel(); maybeFit(setup); return { ok: true };
  }
  // fieldimport.js hands over a whole setup (the farm's own outlines and the conditions at them)
  // an imported farm replaces the example, so a welcome screen that is still open closes (Escape then keeps that farm too)
  FS.farmSetup.use = function (setup) { var r = applySetup(setup); if (r.ok) { saveSetup(setup); closePanel(); } return r; };
  FS.farmSetup.blank = function () { return Q().blank(); };
  // the field list's + and − buttons: one field more or less (1 to 4), kept with the farm
  FS.farmSetup.setFieldCount = function (n) {
    var s = clone(FS.farmSetup.setup || exampleSetup()); s.fieldCount = Math.max(1, Math.min(4, Math.round(n)));
    var r = applySetup(s); if (r.ok) saveSetup(s); return r;
  };
  function onExample() {
    var wasFirst = firstOpen;
    // untouched example farm on first open: just close. From "Change" it restores the example and runs it again.
    var untouched = wasFirst && FS.farmSetup.example;
    if (!untouched) { var r = applySetup(exampleSetup()); if (!r.ok) { if (ctrl) ctrl.error(r.error || 'The example farm could not be loaded.'); return; } }
    saveSetup(exampleSetup()); closePanel();
  }

  // Link from EcoShift (API_V3 section 4): #from=ecoshifters&plan=rye-soy&temp=1&rain=-20&priority=profit&season=2012&costshare=1&plant=-7
  // Unknown keys and bad values are ignored silently. Runs after the boxes are mounted and before the first simulation.
  function readHash() {
    var raw = String(location.hash || '').replace(/^#\??/, ''), P = {}; if (!raw) return P;
    raw.split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 1) return;
      try { P[decodeURIComponent(kv.slice(0, i)).toLowerCase()] = decodeURIComponent(kv.slice(i + 1)).trim(); } catch (e) { /* ignore a bad piece */ }
    });
    return P;
  }
  // site=<id> and acres=<n> change the farm itself, so they are applied before anything is mounted.
  function hashSetup(P, base) {
    var site = P.site && Object.prototype.hasOwnProperty.call(P, 'site') && (FS.data.sites || []).filter(function (x) { return x.id === P.site; })[0] ? P.site : null;
    var n = P.acres != null && P.acres !== '' ? Number(P.acres) : null; n = n != null && isFinite(n) ? Math.max(10, Math.min(640, Math.round(n))) : null;
    if (!site && n == null) return null;
    var setup = base ? clone(base) : exampleSetup();
    if (site) { setup.site = site; setup.example = false; }
    if (n != null) {
      var D = FS.data, pl = P.plan, target = 'creek';
      if (pl && Object.prototype.hasOwnProperty.call(D.plans, pl)) {
        var fit = setup.fields.filter(function (f) { return (D.planOptions[f.lastCrop] || []).indexOf(pl) >= 0; })[0]; if (fit) target = fit.id;
      }
      setup.fields.forEach(function (f) { if (f.id === target) f.acres = Math.round(n); });
      setup.example = false;
    }
    return setup;
  }
  // ?county=<site id> (from the 14 example farms on the EcoShift home page): that county's example farm, opened
  // straight away with no questionnaire and nothing saved, so a farmer's own saved farm is untouched.
  function countyParam() {
    var id = null;
    try { id = new URLSearchParams(location.search).get('county'); } catch (e) { id = null; }
    if (!id && hashP) id = hashP.county;
    return id && (FS.data.sites || []).some(function (x) { return x.id === id; }) ? id : null;
  }
  function parseHash() {
    var P = hashP; if (!Object.keys(P).length) return;
    var A = FS.actions, D = FS.data;
    function num(k) { if (P[k] == null || P[k] === '') return null; var v = Number(P[k]); return isFinite(v) ? v : null; }
    function set(path, v) { A.setControl(path, v, 'link'); }
    if (P.from === 'ecoshifters') fromEco = true;
    if (P.demo === '1') backDemo = true;   // came from EcoShift' demo mode: going back keeps ?demo=1
    var t = num('temp'); if (t != null) set('weather.tempShift', Math.max(-2, Math.min(4, Math.round(t * 2) / 2)));
    var r = num('rain'); if (r != null) set('weather.rainChange', Math.max(-50, Math.min(50, Math.round(r / 5) * 5)));
    if (['balanced', 'profit', 'risk', 'cover'].indexOf(P.priority) >= 0) set('other.priority', P.priority);
    if (P.costshare === '1') set('other.costShare', true);
    if (IRRIGS.indexOf(P.irrigation) >= 0) { if (P.irrigation !== 'none') FS.farmSetup.canIrrigate = true; set('crops.irrigation', P.irrigation); }
    var pl = num('plant'); if (pl != null) set('crops.plantShiftDays', Math.max(-21, Math.min(21, Math.round(pl / 7) * 7)) || 0);
    var y = /^\d{4}$/.test(P.season || '') ? Number(P.season) : null, yrs = (D.climate && D.climate.meta && D.climate.meta.years) || [];
    if (y != null && yrs.indexOf(y) >= 0) {
      var named = (D.weatherScenarios || []).filter(function (q) { return q.year === y; })[0];
      set('weather.scenario', named ? named.id : 'y' + y);
    }
    var plan = P.plan;
    if (plan && Object.prototype.hasOwnProperty.call(D.plans, plan)) {
      var fit = D.farm.fields.filter(function (f) { return (D.planOptions[f.lastCrop] || []).indexOf(plan) >= 0; });
      fit.forEach(function (f) {
        set('crops.plans.' + f.id, plan);
        var tr = FS.store.get().controls.crops.trialAcres; if (tr && tr[f.id] === 0) set('crops.trialAcres.' + f.id, f.acres);
      });
      if (fit.length) A.selectField(fit[0].id, 'link');
    }
  }
  function wireBack() {
    var row = $('fs-backrow'), a = $('fs-back'); if (!row || !a) return;
    row.hidden = false;
    if (backDemo) a.setAttribute('href', '../index.html?demo=1');
    a.addEventListener('click', function (e) {
      var same = false;
      try { same = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (x) { same = false; }
      if (same && history.length > 1) { e.preventDefault(); history.back(); }
    });
  }

  function boot() {
    guard('expand', wireExpand);
    guard('header', wireHeader);
    guard('priority default', function () { var c = FS.store.get().controls; if (c.other && c.other.priority == null) c.other.priority = 'balanced'; if (FS.data.initialControls.other && FS.data.initialControls.other.priority == null) FS.data.initialControls.other.priority = 'balanced'; });
    // the example farm's fields, before anything can change them; the saved or linked farm is put in place before the first run
    var needPanel = true;
    guard('farm setup', function () {
      DEFAULT_FIELDS = FS.data.farm.fields.map(function (f) { return { id: f.id, acres: f.acres, lastCrop: f.lastCrop }; });
      BASE_CONTRACTED = FS.data.initialControls.other && FS.data.initialControls.other.contracted != null ? FS.data.initialControls.other.contracted : 30;
      Q().setDefaultFields(DEFAULT_FIELDS);
      hashP = readHash(); fromEco = hashP.from === 'ecoshifters'; backDemo = hashP.demo === '1';
      var setup = fromEco ? null : loadSetup();
      if (setup) needPanel = false;
      if (fromEco) needPanel = false;
      var hs = hashSetup(hashP, setup); if (hs) setup = hs;
      fromCounty = fromEco ? null : countyParam();
      if (fromCounty) { setup = exampleSetup(); setup.site = fromCounty; setup.example = fromCounty === 'story-ia'; needPanel = false; }
      if (setup) { var r = applySetup(setup); if (!r.ok) { console.error('[Field Shift] saved farm not applied:', r.error); setup = null; } }
      if (!setup) { FS.farmSetup.site = siteById('story-ia'); FS.farmSetup.example = true; FS.farmSetup.setup = exampleSetup(); FS.farmSetup.canIrrigate = false; }
    });
    guard('warm', function () { if (FS.engine && FS.engine.warm) FS.engine.warm(); });
    guard('baseline', function () { FS.computeBaseline(); });
    guard('controls', function () { FS.controls.mount({ weather: $('fs-ctl-weather'), crops: $('fs-ctl-crops'), other: $('fs-ctl-other') }); });
    guard('analysis', function () { FS.analysis.mount($('fs-analysis')); });
    guard('chat', function () { FS.chat.mount($('fs-chat')); });
    guard('fieldView', function () { FS.fieldView.mount($('fs-view')); FS.fieldView.refresh(); });
    mounted = true;
    guard('footer', function () { wireFooter(); wireFarmLine(); });
    guard('farm button', function () { var b = $('fs-farm-btn'); if (b) b.addEventListener('click', function () { openPanel(false, 'review'); }); });
    guard('link', function () { parseHash(); if (fromEco) wireBack(); });
    guard('first run', function () { FS.actions.runSimulation('boot', 'Typical season · current plans'); });
    guard('opening message', function () { FS.chat.postRecs(); });
    // last, so it is the line the farmer sees first in the chat (the chat scrolls to the newest message)
    guard('link line', function () {
      if (fromCounty) {
        var cs = FS.farmSetup.site || STORY();
        FS.actions.addChat({ role: 'assistant', text: 'This is the example farm near ' + cs.name + ': four example fields on that county\'s own NASA weather (44 seasons), USDA soils and county harvests. It is not a real farmer\'s farm. To set up your own, press "Your farm · Change".' + (cs.validated === false ? ' Only Story County, Iowa has been checked against real harvests so far.' : '') });
      }
      if (fromEco) {
        var site = FS.farmSetup.site || STORY(), story = site.id === 'story-ia';
        FS.actions.addChat({ role: 'assistant', text: (backDemo ? 'Opened from the EcoShift demo.' : 'Opened from your EcoShift brief.') + ' This is a demonstration farm in ' + site.name + ', not your field: it shows how the options behave on real ' + (story ? 'Iowa' : 'county') + ' weather and soils. Scroll up for how the options compare.' });
      }
    });
    guard('outlook', function () { if (FS.outlook) FS.outlook.mount($('fs-outlook')); });
    guard('farm map', function () { if (FS.farmMap) FS.farmMap.mount($('fs-view-panel')); });
    guard('setup panel', function () { if (needPanel) openPanel(true); });
    guard('fit', function () { if (!needPanel && !fromEco) maybeFit(FS.farmSetup.setup); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
