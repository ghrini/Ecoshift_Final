/* Chat box. FS.chat.interpret(text, state) is a PURE rule-based function returning { reply, actions, items?, kind?, foot? }.
   The team will later replace it with an LLM that returns the same shape (tool calls -> actions).
   Action types: {type:'setControl', path, value} | {type:'selectField', id} | {type:'run', label}.
   items (optional): rows for the chat to draw as bullets that expand; kind is 'cmp' (compare one field) or 'rec' (top options). */
(function () {
  'use strict';
  var FS = window.FS, D = FS.data, A = FS.actions, S = FS.store;
  var listEl, inputEl;

  // ---------- small helpers ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n, signed) { var r = Math.round(n); return (r < 0 ? '−' : signed && r > 0 ? '+' : '') + '$' + Math.abs(r).toLocaleString('en-US'); }
  function fieldById(id) { return D.farm.fields.filter(function (f) { return f.id === id; })[0]; }
  function plain(label) { return String(label).replace(/\s*\(current plan\)/, ''); }
  function joinNames(a) { return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pathGet(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }
  function setIn(obj, path, v) { var k = path.split('.'), o = obj; for (var i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = v; }
  function signed(v, unit) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + unit; }

  // Scenario wording always comes from the engine's helper (named and any-year ids); local fallback if it is not there yet.
  function scen(id) {
    try { if (FS.engine && FS.engine.scenario) { var s = FS.engine.scenario(id); if (s) return s; } } catch (e) { /* fall through */ }
    var list = D.weatherScenarios || [], f = list.filter(function (x) { return x.id === id; })[0];
    if (f) return { id: f.id, label: f.label, phrase: f.phrase || ('the ' + f.label), year: f.year, note: f.note };
    var m = /^y(\d{4})$/.exec(String(id)); if (m) return { id: id, label: m[1] + ' season', phrase: 'the ' + m[1] + ' season', year: +m[1] };
    return { id: id, label: String(id), phrase: 'this scenario', year: null };
  }
  var NAMED = function () { return D.weatherScenarios || []; };
  function climYears() { var c = D.climate && D.climate.meta; return (c && c.years) || []; }

  var SHORT_PLAN = { 'soy': 'soybeans (current plan)', 'rye-soy': 'rye after harvest, then soybeans', 'corn-corn': 'corn after corn',
    'oats-cover': 'oats, then a summer cover crop', 'corn': 'corn (current plan)', 'rye-corn': 'rye after harvest, then corn', 'soy-soy': 'soybeans after soybeans' };
  var PLAN_PHRASE = {
    'soy': 'plant soybeans (your current plan)', 'rye-soy': 'plant cereal rye after harvest, then soybeans in spring', 'corn-corn': 'plant corn after corn (a second year of corn)',
    'oats-cover': 'plant oats in spring, then a summer cover crop', 'corn': 'plant corn (your current plan)',
    'rye-corn': 'plant cereal rye after harvest, then corn in spring', 'soy-soy': 'plant soybeans after soybeans (a second year of soybeans)'
  };
  // "(current plan)" is only true while some field is on that plan (a farmer who already plants rye has another current plan)
  function isCurrentSomewhere(p) { var pl = D.initialControls.crops.plans; return D.farm.fields.some(function (f) { return pl[f.id] === p; }); }
  function short(p) { var t = SHORT_PLAN[p]; if (t && !isCurrentSomewhere(p)) t = t.replace(/ \(current plan\)/, ''); return t || plain((D.plans[p] || {}).label || p); }
  function planPhrase(id) { var t = PLAN_PHRASE[id]; if (t && !isCurrentSomewhere(id)) t = t.replace(/ \(your current plan\)/, ''); return t || plain((D.plans[id] || {}).label || id); }
  function planPlain(p) { return short(p).replace(/ \(current plan\)/, ''); }
  var PRIO_LABEL = { balanced: 'Balanced', profit: 'Profit', risk: 'Lowest risk', cover: 'Most ground cover' };
  var PRIO_PHRASE = { balanced: 'a balance of profit and risk', profit: 'profit', risk: 'lowest risk', cover: 'ground cover' };

  function coverPhrase(m) {
    var v = Math.round((m || 0) * 10) / 10, a = Math.abs(v);
    // the engine counts months with a living crop in the field (living roots), not canopy greenness
    if (a < 0.1) return 'no change in months with living roots in the field';
    var txt = (a % 1 === 0 ? String(a) : a.toFixed(1));
    return 'about ' + txt + (a === 1 ? ' month' : ' months') + (v > 0 ? ' more' : ' fewer') + ' with living roots in the field';
  }
  function moneyVs(d, brief) {
    d = Math.round(d);
    if (Math.abs(d) < 2) return 'about the same profit as your current plan';
    var amt = '$' + Math.abs(d).toLocaleString('en-US');
    if (d < 0) return 'costs about ' + amt + ' per acre' + (brief ? '' : ' compared with your current plan, on average');
    return 'earns about ' + amt + ' per acre more' + (brief ? '' : ' than your current plan, on average');
  }

  // ---------- fuzzy words ----------
  function osa(a, b) {   // optimal string alignment distance (a swap of two letters counts 1)
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      var c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[m][n];
  }
  function fuzzy(w, dict, stop) {   // dict: [[canonical, entry], ...] ; <= 1 edit for 4-6 letters, <= 2 for 7+; very short words must match exactly
    if (w.length < 4 || (stop && stop.indexOf(w) >= 0)) return null;
    var lim = w.length >= 7 ? 2 : 1;
    for (var i = 0; i < dict.length; i++) {
      var e = dict[i][1]; if (e.length < 4 || Math.abs(e.length - w.length) > lim) continue;
      if (e.length < 7 && lim > 1) continue;
      if (osa(w, e) <= (e.length >= 7 ? 2 : 1)) return dict[i][0];
    }
    return null;
  }
  var CROP_EXACT = { corn: 'corn', maize: 'corn', soy: 'soy', soya: 'soy', soybean: 'soy', soybeans: 'soy', bean: 'soy', beans: 'soy', rye: 'rye', oat: 'oats', oats: 'oats' };
  var CROP_DICT = [['corn', 'corn'], ['soy', 'soybean'], ['soy', 'soybeans'], ['soy', 'soyabeans'], ['soy', 'beans']];
  var CROP_STOP = ['born', 'horn', 'torn', 'worn', 'morn', 'cord', 'core', 'cork', 'coin', 'corp', 'corny', 'cars', 'means', 'beams', 'bears', 'beats', 'leans', 'bands', 'beads', 'deans', 'bears', 'seans'];
  var FIELD_EXACT = { north: 'north', creek: 'creek', west: 'west', south: 'south' };
  var FIELD_DICT = [['north', 'north'], ['creek', 'creek'], ['south', 'south']];
  var FIELD_STOP = ['worth', 'forth', 'mouth', 'youth', 'sooth', 'greek', 'creed', 'creep', 'crook', 'greet', 'check', 'north'];
  function cropOf(w) {
    if (CROP_EXACT[w]) return CROP_EXACT[w];
    return fuzzy(w, CROP_DICT, CROP_STOP);
  }
  // imported fields have the farmer's own names ("Home quarter"): a word that belongs to one field's name finds it
  var NAME_SKIP = ['field', 'fields', 'the', 'and', 'farm', 'acre', 'acres', 'plot', 'lot'];
  function nameWords() {
    var seen = {}, out = {};
    D.farm.fields.forEach(function (f) {
      String(f.name || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) {
        if (w.length < 3 || NAME_SKIP.indexOf(w) >= 0 || /^\d+$/.test(w)) return;
        if (seen[w] && seen[w] !== f.id) out[w] = null; else { seen[w] = f.id; if (out[w] !== null) out[w] = f.id; }
      });
    });
    return out;
  }
  function fieldOf(w) {
    var nw = nameWords()[w]; if (nw) return nw;
    var id = FIELD_EXACT[w] || (FIELD_STOP.indexOf(w) >= 0 ? null : fuzzy(w, FIELD_DICT, FIELD_STOP));
    return id && fieldById(id) ? id : null;   // only fields this farm has
  }

  // ---------- vocabulary ----------
  var NEG = 'lower less down drop drops dropped dropping fall falls fell falling decrease decreased decreases reduce reduced reduction cut cuts minus cheaper fewer smaller decline declines dip dips lose loss negative below under shrink lighter slash crash'.split(' ');
  var POS = 'higher more up rise rises rose rising increase increased increases raise raised plus gain gains jump jumps climb climbs surge spike above over bigger heavier positive expensive'.split(' ');
  var IMPLICIT = { drier: ['RAIN', -1], wetter: ['RAIN', 1], hotter: ['TEMP', 1], warmer: ['TEMP', 1], hot: ['TEMP', 1], warm: ['TEMP', 1], cooler: ['TEMP', -1], colder: ['TEMP', -1], cold: ['TEMP', -1], cool: ['TEMP', -1] };
  var KW = { rain: 'RAIN', rains: 'RAIN', rainy: 'RAIN', rainfall: 'RAIN', raining: 'RAIN', rained: 'RAIN', precip: 'RAIN', precipitation: 'RAIN',
    nitrogen: 'NITRO', fertilizer: 'NITRO', fertiliser: 'NITRO', fert: 'NITRO', anhydrous: 'NITRO', urea: 'NITRO',
    price: 'PRICE', prices: 'PRICE', market: 'PRICE', markets: 'PRICE', commodity: 'PRICE',
    temperature: 'TEMP', temperatures: 'TEMP', temp: 'TEMP', temps: 'TEMP' };
  var LIMITS = { RAIN: { path: 'weather.rainChange', lo: -50, hi: 50, step: 5, name: 'Rain change', unit: '%', say: 'rain', dflt: 20 },
    NITRO: { path: 'other.nitrogenChange', lo: -30, hi: 80, step: 5, name: 'Nitrogen price', unit: '%', say: 'nitrogen price', dflt: 10 },
    PRICE: { path: 'other.priceChange', lo: -40, hi: 40, step: 5, name: 'Crop price', unit: '%', say: 'crop prices', dflt: 10 },
    TEMP: { path: 'weather.tempShift', lo: -2, hi: 4, step: 0.5, name: 'Temperature shift', unit: ' °C', say: 'temperatures', dflt: 2 } };
  var STOP = ('a an the my me i it is are was be to of on in for with what if about please can you could would will we lets let s show run simulate try test again happens happen does do how that this there then and so just like go make get have want see field fields year season weather by at from now also or but plan plans change changes tell give see look what ok okay yes thanks thank hi hey hello and then well maybe should might may think say seems rather ' +
    'sim simulation scenario case situation condition conditions during when while time next').split(' ');

  var NUMWORDS = { five: 5, ten: 10, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, hundred: 100, 'one hundred': 100 };

  function tokenize(text) {
    var s = String(text || '').toLowerCase().replace(/[−–—]/g, '-').replace(/[‘’`']/g, '');
    s = s.replace(/\b(\d+(?:\.\d+)?)\s*(?:percent|per cent|pct)\b/g, '$1%');
    s = s.replace(/\b(twenty five|one hundred|five|ten|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|hundred)\s*(%|percent|per cent|degrees?|deg\b)/g, function (m, w, u) { return NUMWORDS[w] + (u.charAt(0) === 'p' ? '%' : ' ' + u); });
    var re = /([+-]?)(\d+(?:\.\d+)?)\s*%|([+-]?)(\d+(?:\.\d+)?)\s*(°\s*[cf]?|degrees?(?:\s*(?:celsius|fahrenheit|c|f))?|deg\b\.?|celsius|fahrenheit|c|f)(?![a-z])|\b((?:19|20)\d\d)\b|(\d+(?:\.\d+)?)|([a-z]+)|([,;])/g;
    var out = [], m;
    while ((m = re.exec(s))) {
      if (m[2] != null) out.push({ k: 'pct', v: parseFloat(m[2]), sg: m[1] || '', raw: m[0] });
      else if (m[4] != null) out.push({ k: 'deg', v: parseFloat(m[4]), sg: m[3] || '', f: /f/.test(m[5]) && !/c/.test(m[5]) && !/degrees?\s*$/.test(m[5]), raw: m[0] });
      else if (m[6] != null) out.push({ k: 'year', v: parseInt(m[6], 10), w: m[6], raw: m[0] });
      else if (m[7] != null) out.push({ k: 'num', v: parseFloat(m[7]), w: m[7], raw: m[0] });
      else if (m[8] != null) out.push({ k: 'word', w: m[8], raw: m[0] });
      else out.push({ k: 'sep', w: ',', raw: m[0] });
    }
    return out;
  }

  function resetActions() {
    var acts = [];
    (function walk(obj, prefix) {
      Object.keys(obj).forEach(function (k) {
        var p = prefix ? prefix + '.' + k : k;
        if (Array.isArray(obj[k])) acts.push({ type: 'setControl', path: p, value: clone(obj[k]) });
        else if (obj[k] !== null && typeof obj[k] === 'object') walk(obj[k], p); else acts.push({ type: 'setControl', path: p, value: obj[k] });
      });
    })(D.initialControls, '');
    if (!acts.some(function (a) { return a.path === 'crops.plantShiftDays'; })) acts.push({ type: 'setControl', path: 'crops.plantShiftDays', value: 0 });
    if (!acts.some(function (a) { return a.path === 'weather.events'; })) acts.push({ type: 'setControl', path: 'weather.events', value: [] });
    if (!acts.some(function (a) { return a.path === 'crops.irrigation'; })) acts.push({ type: 'setControl', path: 'crops.irrigation', value: 'none' });
    if (!D.initialControls.other || D.initialControls.other.priority == null) acts.push({ type: 'setControl', path: 'other.priority', value: 'balanced' });
    return acts;
  }

  // ---------- comparison rows (from the engine, with graceful fallbacks) ----------
  function normCmp(c, fid) {
    return { fieldId: fid, plan: c.plan, isCurrent: !!c.isCurrent, deltaPerAcre: c.deltaPerAcre || 0, worst5: c.worst5PerAcre || 0, betterSeasons: c.betterSeasons, nSeasons: c.nSeasons,
      greenCoverMonthsAdded: c.greenCoverMonthsAdded || 0, card: c.card || null, moneyNote: c.moneyNote || null, tooClose: !!c.tooClose, risk: c.risk, label: c.label, mode: 'cmp' };
  }
  function normRec(r) {
    return { fieldId: r.fieldId, plan: r.plan, isCurrent: false, deltaPerAcre: r.deltaPerAcre || 0, betterSeasons: r.betterSeasons, nSeasons: r.nSeasons,
      greenCoverMonthsAdded: r.greenCoverMonthsAdded || 0, card: r.card || (r.why ? { why: r.why } : null), moneyNote: r.moneyNote || null, tooClose: !!r.tooClose, risk: r.risk, title: r.title, mode: 'rec' };
  }
  function compareRows(fid, controls) {
    try { if (FS.engine && FS.engine.compare) return FS.engine.compare(fid, controls).map(function (c) { return normCmp(c, fid); }); } catch (e) { console.error(e); }
    return null;
  }
  function recsFrom(summary) { return ((summary && summary.recommendations) || []).slice(0, 3).map(normRec); }

  function compareReply(fid, controls, state, lead) {
    var f = fieldById(fid), rows = compareRows(fid, controls);
    if (!rows) {
      var fb = recsFrom(state.current && state.current.summary).filter(function (r) { return r.fieldId === fid; });
      if (!fb.length) return { reply: 'I cannot compare plans for ' + f.name + ' yet. Run a simulation first.', actions: [] };
      return { reply: (lead || '') + 'Your current plan on ' + f.name + ': ' + planPlain(controls.crops.plans[fid]) + '.\nOther options:', actions: [], items: fb, kind: 'cmp' };
    }
    var cur = rows.filter(function (r) { return r.isCurrent; })[0], others = rows.filter(function (r) { return !r.isCurrent; });
    var sc = scen(controls.weather.scenario);
    var head = (lead || '') + 'Your current plan: ' + f.name + ', ' + planPlain(cur ? cur.plan : D.initialControls.crops.plans[fid]) + '.';
    return { reply: head + '\nOther options, compared with it (average over all past seasons; this run is ' + sc.phrase + '):', actions: [], items: others, kind: 'cmp' };
  }

  function plainSpeak(s) {
    return String(s || '').replace(/bad-year safety/g, 'how it does in bad years')
      .replace(/\bit makes about (\$[\d,]+) less per acre/g, 'it costs about $1 per acre').replace(/\bmakes about (\$[\d,]+) more per acre/g, 'earns about $1 more per acre')
      .replace(/\bmakes about (\$[\d,]+) less per acre/g, 'costs about $1 per acre').replace(/\bmakes about (\$[\d,]+) less\b/g, 'costs about $1');
  }
  function uniq(a) { var seen = {}; return a.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; }); }
  function moneyHidden(summary) {
    var f = (summary && summary.fields) || {};
    return Object.keys(f).some(function (id) { return f[id] && f[id].moneyNote; });
  }
  var OATS_MONEY = 'Money is not shown while oats is in the plan, because oats price and cost are rough guesses with no source yet.';
  function errPoints(summary) {
    var m = /typical error (?:of )?(\d+) points?/.exec((summary && summary.validation && summary.validation.text) || '');
    return m ? +m[1] : null;
  }
  function fieldFromText(t) { var m = /\b(north|creek|west|south)\b/.exec(t); return m ? m[1] : null; }

  // ---------- undo: snapshots of the controls taken before each chat-applied change ----------
  var undoStack = [];
  var LEAF_NAME = { 'weather.scenario': 'weather', 'weather.tempShift': 'temperature', 'weather.rainChange': 'rain', 'weather.rainSwing': 'rain swings', 'weather.hotDays': 'hot days', 'other.priceChange': 'crop prices', 'other.nitrogenChange': 'nitrogen price', 'other.priority': 'ranking' };
  function leaves(o, prefix, out) {
    Object.keys(o || {}).forEach(function (k) {
      var p = prefix ? prefix + '.' + k : k;
      if (Array.isArray(o[k])) out[p] = JSON.stringify(o[k]);
      else if (o[k] !== null && typeof o[k] === 'object') leaves(o[k], p, out); else out[p] = o[k];
    });
    if (!prefix) { if (!('weather.events' in out)) out['weather.events'] = '[]'; if (!('crops.plantShiftDays' in out)) out['crops.plantShiftDays'] = 0; if (!('crops.irrigation' in out)) out['crops.irrigation'] = 'none'; }
    return out;
  }
  // ---- weather events and planting date (API_V3 sections 1 and 2)
  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  var MONTH_RE = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
  function monthNo(w) { for (var i = 0; i < 12; i++) if (MONTHS[i].indexOf(w) === 0 && (w.length >= 3)) return i + 1; return 0; }
  function evPhrase(e) {
    if (FS.eventPhrase) return FS.eventPhrase(e);
    var m = cap(MONTHS[e.month - 1] || ''), sv = e.severity === 'severe';
    return e.type === 'dryspell' ? (sv ? 'Severe drought in ' : 'Dry ') + m : e.type === 'wetspell' ? (sv ? 'Very wet ' : 'Wet ') + m : (sv ? 'Severe heat wave in ' : 'Heat wave in ') + m;
  }
  function evList(ev) { return ev.map(function (e) { return evPhrase(e).replace(/^./, function (c) { return c.toLowerCase(); }); }); }
  function plantWords(v) { return v === 0 ? 'on time' : Math.abs(v) + ' days ' + (v < 0 ? 'earlier' : 'later'); }
  function eventsOf(c) { var e = c && c.weather && c.weather.events; return Array.isArray(e) ? e : []; }
  function describeValue(path, v) {
    if (path === 'weather.scenario') return scen(v).phrase;
    if (path === 'weather.events') { var ev = []; try { ev = JSON.parse(v); } catch (e) { /* none */ } return ev.length ? evList(ev).join(' and ') : 'no weather events'; }
    if (path === 'crops.plantShiftDays') return 'planting ' + plantWords(Number(v));
    if (path === 'crops.irrigation') return v === 'none' || v == null ? 'no irrigation' : FS.irrigationPhrase(v);
    if (path === 'weather.tempShift') return signed(v, ' °C') + ' temperature';
    if (path === 'weather.rainChange') return 'rain ' + signed(v, '%');
    if (path === 'weather.rainSwing') return Number(v) ? 'rain swings ' + v + '% bigger' : 'rain as observed';
    if (path === 'weather.hotDays') return Number(v) ? 'hot summer days ' + v + ' °C hotter' : 'hot days as observed';
    if (path === 'other.priceChange') return 'crop prices ' + signed(v, '%');
    if (path === 'other.nitrogenChange') return 'nitrogen price ' + signed(v, '%');
    if (path === 'crops.soilWaterPct') return Number(v) ? 'soil holding ' + signed(Number(v), '%') + ' water' : 'soil as surveyed';
    if (path === 'other.priority') return 'options ranked by ' + (PRIO_PHRASE[v] || v);
    var m = /^crops\.plans\.(\w+)$/.exec(path); if (m && fieldById(m[1])) return fieldById(m[1]).name + ' on ' + planPlain(v);
    m = /^crops\.trialAcres\.(\w+)$/.exec(path); if (m && fieldById(m[1])) return fieldById(m[1]).name + ' trial acres ' + v;
    return path + ' ' + v;
  }
  function undoDiff(cur, snap) {
    var a = leaves(cur, '', {}), b = leaves(snap, '', {}), out = [];
    Object.keys(b).forEach(function (p) { if (a[p] !== b[p] && !/trialAcres/.test(p)) out.push(describeValue(p, b[p])); });
    return out;
  }

  // ---------- questions: read-only answers built from the current run ----------
  var PLAN_WORDS = [[/\brye\b/, function (p) { return /^rye-/.test(p); }], [/\boats?\b/, function (p) { return p === 'oats-cover'; }],
    [/\bcorn (?:again|after corn|on corn)\b|\bcontinuous corn\b/, function (p) { return p === 'corn-corn'; }], [/\bsoy(?:beans?)? (?:again|after soy\w*|on soy\w*)\b/, function (p) { return p === 'soy-soy'; }]];
  function sentenceOne(s) { var m = /^[^.]*\.(?=\s|$)/.exec(String(s || '')); return m ? m[0] : String(s || ''); }
  function rankRows(kind, fid, state) {
    var controls = clone(state.controls); controls.other = controls.other || {}; controls.other.priority = kind;   // a copy: nothing is changed
    var rows = compareRows(fid, controls); if (!rows) return null;
    var ok = rows.filter(function (r) { return !r.moneyNote; }), rest = rows.filter(function (r) { return r.moneyNote; });
    var key = kind === 'risk' ? function (r) { return r.isCurrent ? 0 : r.worst5; } : function (r) { return r.isCurrent ? 0 : r.deltaPerAcre; };
    ok = ok.map(function (r, i) { return { r: r, i: i }; }).sort(function (x, y) { return (key(y.r) - key(x.r)) || (x.i - y.i); }).map(function (x) { return x.r; });
    return { ok: ok, all: ok.concat(rest), key: key };
  }
  function rankAnswer(kind, fid, state) {
    var f = fieldById(fid), rk = rankRows(kind, fid, state);
    if (!rk || !rk.ok.length) return { reply: 'Run a simulation first, then ask again.', actions: [] };
    var best = rk.ok[0], cur = rk.ok.filter(function (r) { return r.isCurrent; })[0], reply, n = (best.nSeasons || 44);
    if (kind === 'risk') {
      if (best.isCurrent) reply = 'On ' + f.name + ', your current plan (' + planPlain(best.plan) + ') is the safest: every other option does worse in bad years.';
      else reply = 'On ' + f.name + ', ' + planPlain(best.plan) + ' is the safest: in the worst 5 of ' + n + ' past seasons it does about $' + Math.abs(best.worst5).toLocaleString('en-US') + ' per acre better than your current plan.';
      reply += ' This ranks the options by how they do in bad years, and I changed nothing.';
    } else {
      if (best.isCurrent) reply = 'On ' + f.name + ', your current plan (' + planPlain(best.plan) + ') earns the most on average; every other option earns less.';
      else reply = 'On ' + f.name + ', ' + planPlain(best.plan) + ' earns the most: about $' + Math.abs(best.deltaPerAcre).toLocaleString('en-US') + ' per acre more than your current plan on average' + (best.tooClose ? ', but that is too close to call' : '') + '.';
      reply += ' This ranks the options by average profit, which already counts their costs, and I changed nothing.';
    }
    return { reply: reply, actions: [], items: rk.all.filter(function (r) { return !r.isCurrent; }), kind: 'cmp' };
  }
  function atRiskAnswer(state) {
    var r = state.current; if (!r) return { reply: 'Run a simulation first, then ask again.', actions: [] };
    var fs = r.summary.fields, list = D.farm.fields.map(function (f) { return { f: f, x: fs[f.id] }; }).filter(function (o) { return o.x; });
    list.sort(function (a, b) { return a.x.yieldPctOfNormal - b.x.yieldPctOfNormal; });
    var lo = list[0], hi = list[list.length - 1], sc = scen(r.inputs.weather.scenario);
    if (hi.x.yieldPctOfNormal - lo.x.yieldPctOfNormal < 2) return { reply: 'In ' + sc.phrase + ', no field stands out: all four make about ' + Math.round(lo.x.yieldPctOfNormal) + '% of a normal crop on the current plans.', actions: [] };
    var why = lo.x.note ? ' (' + String(lo.x.note).replace(/^./, function (c) { return c.toLowerCase(); }).replace(/\.$/, '') + ')' : '';
    return { reply: 'In ' + sc.phrase + ', ' + lo.f.name + ' is the most at risk: about ' + Math.round(lo.x.yieldPctOfNormal) + '% of a normal crop' + why + ', against ' + Math.round(list[1].x.yieldPctOfNormal) + '% on ' + list[1].f.name + ' and ' + Math.round(hi.x.yieldPctOfNormal) + '% on ' + hi.f.name + '. I changed nothing.', actions: [] };
  }
  function dataSourceReply() {
    var E = D.economics || {}, src = D.sources || {};
    function lab(k) { return src[k] ? src[k].label : null; }
    var prices = [lab('wasde') && 'crop prices from ' + lab('wasde'), lab('isu') && 'costs from the ' + lab('isu'), lab('rma') && 'price swings from ' + lab('rma')].filter(Boolean).join(', ');
    var ys = climYears(), span = ys.length ? ys[0] + '-' + ys[ys.length - 1] : '1982-2025', site = FS.farmSetup && FS.farmSetup.site;
    var notChecked = site && site.validated === false ? ' This location was not checked against its own county\'s harvests; the yield check was done for Story County, Iowa.' : '';
    return 'The weather is NASA POWER daily weather for ' + span + ' for this grid square (about 50 km wide), and the soils are from the USDA NRCS soil survey. The yield model is checked against USDA NASS Iowa yields.' + notChecked + ' ' +
      (prices ? cap(prices) + (E.asOf ? ' (as of ' + E.asOf + ')' : '') + '; oats and rye prices are rough guesses with no source yet.' : 'Prices and costs are listed in the data notes.');
  }
  function answerQuestion(t, state) {
    var r = state.current, sm = r && r.summary, fid = fieldFromText(t) || state.selectedField || D.farm.fields[0].id;
    var needRun = { reply: 'Run a simulation first, then ask again.', actions: [] };
    var ep = sm ? errPoints(sm) : null, off = ep ? ' One season can be off by about ' + ep + ' points of a normal crop.' : '';
    if (/\bwhich\b.*\b(?:field|one)\b.*\b(?:risk|risky|worst|vulnerable|weakest|exposed)\b|\bmost at risk\b|\bwhere am i (?:most )?(?:at risk|exposed)\b/.test(t)) return atRiskAnswer(state);
    if (/\b(?:safest|least risky|lowest risk|safer option|safe option|most stable)\b/.test(t)) return rankAnswer('risk', fid, state);
    if (/\b(?:cheapest|most profitable|highest profit|best profit|biggest profit|most money|most lucrative)\b/.test(t)) return rankAnswer('profit', fid, state);
    if (/\bwhat happens if i (?:do nothing|dont change|keep)\b|\bdo nothing\b|\b(?:keep|stay with|stick with|leave) (?:my |the )?(?:current|everything|it as|things)\b|\bif i change nothing\b/.test(t)) {
      if (!r) return needRun;
      return { reply: 'Your current plans are the baseline for every comparison. ' + farmLine(r), actions: [] };
    }
    if (/\b(?:guarantee|guaranteed|promise|for certain|for sure|sure thing|risk free)\b/.test(t)) return { reply: 'No. It replays past weather on your soils; it cannot promise a price or a season.' + off, actions: [] };
    if (/\b(?:reliable|reliability|accurate|accuracy|trust|trustworthy|confident|confidence|how good|how right|how sure|believe)\b/.test(t)) {
      if (!sm || !sm.validation) return needRun;
      return { reply: sm.validation.text + (ep ? ' So a single season can be off by about ' + ep + ' points of a normal crop.' : ''), actions: [] };
    }
    if (/\b(?:data|source|sources|come from|comes from|where.*from)\b/.test(t)) return { reply: dataSourceReply(), actions: [] };
    if (/\bwhy\b|\bexplain\b|\bhow come\b|\bhow risky\b/.test(t)) {
      if (!sm) return needRun;
      var parts = [], pw = PLAN_WORDS.filter(function (w) { return w[0].test(t); })[0];
      if (pw) {
        var rows = compareRows(fid, state.controls), row = rows && rows.filter(function (x) { return !x.isCurrent && pw[1](x.plan); })[0];
        if (row) { parts.push(cap(planPlain(row.plan)) + ' on ' + fieldById(fid).name + ' ' + (row.moneyNote ? 'has no reliable money figure (oats prices are rough guesses with no source yet)' : moneyVs(row.deltaPerAcre)) + '.'); }
      }
      var why = (sm.why || []).map(function (w) { return typeof w === 'string' ? w : w && w.text; }).filter(Boolean);
      if (!parts.length) parts = why.slice(0, 2); else if (why[0]) parts.push('For this run: ' + why[0].replace(/^./, function (c) { return c.toLowerCase(); }));
      return parts.length ? { reply: parts.slice(0, 3).join(' '), actions: [] } : needRun;
    }
    return null;
  }
  function farmYield(r) {
    var s = r.summary, sel = D.farm.fields.map(function (f) { return f.name + ' ' + Math.round(s.fields[f.id].yieldPctOfNormal) + '%'; });
    return 'yields are ' + sel.join(', ') + ' of a normal crop';
  }

  function examples() { return 'Type a change to the weather, crops or prices. Examples:\n• "What if 2012 happens again?"\n• "Try corn after corn on ' + D.farm.fields[0].name + '"\n• "Rain −20% and +2°C"\n• "What should I plant on ' + D.farm.fields[D.farm.fields.length > 1 ? 1 : 0].name + '?"\n• "I care most about profit"'; }

  // ================================================================= the interpreter
  FS.chat = FS.chat || {};
  FS.chat.interpret = function (text, state) {
    var raw = String(text || '');
    if (!raw.trim()) return { reply: '', actions: [] };
    if (raw.length > 300) {   // very long or repeated input: use one copy of a repeated phrase, else ask for something shorter
      var rp = raw.length <= 2000 ? /^\s*(.{3,120}?)(?:[\s.,;!?]*\1)+[\s.,;!?]*$/i.exec(raw) : null;
      if (rp) raw = rp[1];
      else return { reply: 'That message is too long for me to read. Please send one what-if at a time, for example "what if 2012 happens again?".', actions: [] };
    }
    var controls = state.controls || D.initialControls, t = raw.toLowerCase().replace(/[−–]/g, '-').replace(/['’]/g, '');
    var tk = tokenize(raw), n = tk.length, i;
    var actions = [], applied = [], notes = [], same = [], labelBits = [], parsed = false, assumed = [], planned = {};
    var wantsRun = /\b(simulate|run|what if|what-if|whatif|test|show me|show|try|what about)\b/.test(t);

    // crops the model does not have: say so plainly instead of answering about another crop
    var other = /\b(lavender|wheat|alfalfa|hay|hemp|sunflowers?|barley|sorghum|milo|canola|potato(?:es)?|vegetables?|pumpkins?|tomato(?:es)?|grapes?|clover|sugar ?beets?|peas|lentils|cotton|rice|tobacco|switchgrass|prairie|pasture|trees?|orchard|apples?|berries|strawberr(?:y|ies)|flax|buckwheat|millet|triticale|turnips?|radish(?:es)?)\b/.exec(t);
    if (other && !/\b(corn|soy\w*|beans?|rye|oats?)\b/.test(t) && /\b(plant|grow|try|switch|put|add|start|instead|what about|how about|should|could|can)\b/.test(t))
      return { reply: 'This simulator only knows corn, soybeans, oats and a rye cover crop, so it cannot say how ' + other[1] + ' would do on your fields. For ' + other[1] + ', ask your local extension office or a grower who already raises it. You can still compare the crops I know, for example "what if West 40 goes to soybeans?".', actions: [] };

    // quick intents on the whole text
    if (/\breset\b|start over|back to normal|clear (?:everything|all)(?! (?:the |my )?(?:weather )?(?:events?|spells?))|\bdefaults?\b/.test(t))
      return { reply: 'Reset all controls to your current plans in a typical season (2011 weather). Running.', actions: resetActions().concat([{ type: 'run', label: 'Typical season · current plans' }]) };
    if (/^\s*undo\b|\bundo (?:that|it|the last)|^\s*(?:go back|take that back|revert)\b/.test(t)) {
      if (!undoStack.length) return { reply: 'There is nothing to undo.', actions: [] };
      var what = undoDiff(controls, undoStack[undoStack.length - 1]);
      return { reply: 'Undid the last change' + (what.length ? ': back to ' + what.join('; ') : '') + '. Running it again.', actions: [{ type: 'undo' }] };
    }
    var CMD = /\b(?:what if|what-if|what about|how about|try|switch|put|plant|planting|make it|set|change|simulate|run|reset|compare|show me)\b/.test(t);
    var Q_LEAD = /^\s*(?:and |but |so |ok |okay )?(?:why|how|which|where|can you|could you|is it|is this|is that|are you|should i|what is|whats|what are|what happens|will it|will this|do you|does it|explain|tell me why)\b/.test(t);
    var SUP = /\b(?:safest|cheapest|most profitable|least risky|lowest risk|most money|highest profit)\b/.test(t) && !/\b(?:care|want|prefer|focus|rank|sort|priority|goal|worried|interested|optimi[sz]e)\b/.test(t) && (Q_LEAD || t.length < 45);
    if (!CMD && (Q_LEAD || SUP)) { var qa = answerQuestion(t, state); if (qa) return qa; }

    // ---- less water / irrigation cut: irrigation amounts are not modelled, so the closest real scenario is a dry July and August
    var waterCut = false;
    if (!(Q_LEAD && !CMD)) {
      var WC = /\b(?:(?:much |a lot |a little |a bit )?(?:less|lower|reduced?|fewer|cut|cuts|limited|restricted?|short on|low) (?:in |on |of )?(?:my |the |our )?(?:irrigation|irrigating|water(?: allocation| supply| rights?)?|allocation)(?! (?:use|usage|hungry|intensive|loss|runoff|holding))|(?:my |the |our )?(?:irrigation|water)(?: allocation| supply| rights?)? (?:is |are |was |got |gets |being |will be |has been )?(?:cut|reduced|lowered|restricted|limited|short|cut back)\b|\bwater (?:shortage|restrictions?|cutbacks?)\b|\bnot enough water\b|\bwater is (?:short|tight|scarce)\b|\birrigate (?:a lot |a little )?less\b)/i;
      var wm = WC.exec(raw);
      if (wm) {
        waterCut = true; var sev = /\b(?:much|a lot|severe\w*|drastic\w*|half|big)\b/i.test(wm[0]);
        raw = raw.replace(WC, sev ? 'severe dry July and severe dry August' : 'dry July and dry August');
        t = raw.toLowerCase().replace(/[−–]/g, '-').replace(/['’]/g, ''); tk = tokenize(raw); n = tk.length;
        notes.push('Irrigation amounts and water allocations are not modeled yet (irrigation here is one inch a week in set months). I used a ' + (sev ? 'severe ' : '') + 'dry July and August as the closest stand-in for having less water.');
      }
    }

    // ---- scenario presets said in plain words, with no numbers: "hotter future", "less rain", "more extreme weather", "climate change"
    if (FS.scenarios && !/\d/.test(t) && !(Q_LEAD && !CMD)) {
      var PRE = [['baseline', /\bhistorical baseline\b|\bobserved history\b/], ['drought', /\bhistorical drought\b/],
        ['combined', /\bclimate change\b|\bchanging climate\b|\bfuture climate\b|\bfuture weather\b|\bmore extreme weather\b|\bextreme weather\b|\bcombined future\b/],
        ['heat', /\bhotter future\b|\bhotter summers?\b|\bmore (?:frequent |extreme )?heat\b|\bextreme heat\b|\bmore (?:frequent )?heat ?waves?\b|\bmore hot days\b/],
        ['swing', /\bmore variable (?:rain|rainfall|precipitation|weather)\b|\brain(?:fall)? variability\b|\bprecipitation variability\b|\bwetter wets\b|\bbigger swings\b|\bmore erratic (?:rain|weather)\b/],
        ['rain', /\bless rain\b|\breduced (?:rain|rainfall|precipitation)\b|\bless precipitation\b|\bdrier future\b|\bdrier climate\b|\bdrier summers?\b/]];
      var pm = PRE.filter(function (x) { return x[1].test(t); })[0], pr = pm && FS.scenarios.byId(pm[0]);
      if (pr) {
        var pacts = [];
        Object.keys(pr.weather).forEach(function (k) {
          var v = pr.weather[k], cur = controls.weather[k];
          if (JSON.stringify(v) !== JSON.stringify(cur == null ? (Array.isArray(v) ? [] : 0) : cur)) pacts.push({ type: 'setControl', path: 'weather.' + k, value: Array.isArray(v) ? [] : v });
        });
        var asm = pr.kind === 'assumed';
        var say = asm ? 'Running the "' + pr.name + '" what-if: ' + pr.blurb.replace(/^./, function (c) { return c.toLowerCase(); }) + '\nThis is an assumption, not a forecast: the sizes are illustrative and say nothing about the chance of this happening next year.'
          : 'Running "' + pr.name + '": ' + pr.blurb.replace(/^./, function (c) { return c.toLowerCase(); }) + '\nThese are observed seasons, not a forecast.';
        pacts.push({ type: 'run', label: pr.name });
        return { reply: say, actions: pacts };
      }
    }

    // ---- token classification
    for (i = 0; i < n; i++) {
      var T = tk[i]; T.used = false;
      if (T.k !== 'word') continue;
      var w = T.w;
      if (w === 'cover' && tk[i + 1] && tk[i + 1].k === 'word' && /^crops?$/.test(tk[i + 1].w)) { T.c = 'rye'; tk[i + 1].c = '-'; T.coverCrop = true; continue; }
      if (tk[i].c) continue;
      var c = cropOf(w); if (c) { T.c = c; T.fuzzyFrom = (c === CROP_EXACT[w] ? null : w); continue; }
      var fo = fieldOf(w); if (fo) { T.f = fo; T.fuzzyFrom = (FIELD_EXACT[w] || nameWords()[w] ? null : w); continue; }
      if (KW[w]) T.kw = KW[w];
      if (/^(prices?|costs?)$/.test(w) && tk[i - 1] && tk[i - 1].kw === 'NITRO') { T.kw = null; T.used = true; T.w = '_'; continue; }   // "fertilizer prices" is one thing
      if (IMPLICIT[w]) { T.imp = IMPLICIT[w]; }
    }
    // second-word crop in "cover crop" is swallowed
    for (i = 0; i < n; i++) if (tk[i].c === '-') { tk[i].c = null; tk[i].used = true; tk[i].w = '_'; }
    // numeric field nicknames: "the 120", "the 80", "the 40" (ambiguous); and the number after a field name is swallowed ("north 80", "south forty")
    for (i = 0; i < n; i++) {
      var Q = tk[i];
      if (Q.f && !Q.numChecked) {
        var nx = tk[i + 1];
        if (nx && (nx.k === 'num' || (nx.k === 'word' && (nx.w === 'forty' || nx.w === 'eighty'))) && !(tk[i + 2] && /^(?:days?|weeks?|months?)$/.test(tk[i + 2].w || ''))) { nx.used = true; nx.w = '_'; }
        nx = tk[i + 1]; if (nx && nx.k === 'word' && /^(field|acres?|acre)$/.test(nx.w)) { nx.used = true; nx.w = '_'; }
        Q.numChecked = true;
      }
    }
    for (i = 0; i < n; i++) {
      var N = tk[i];
      // a size that matches one of the farm's fields ("the 120", "the 80"); several fields of that size are ambiguous
      var nv = N.k === 'num' && !N.used ? Number(N.w) : N.k === 'word' && !N.used && (N.w === 'forty' || N.w === 'eighty') ? NUMWORDS[N.w] : null;
      if (nv != null && !(tk[i - 1] && /^(by|of|than|about|around)$/.test(tk[i - 1].w || '')) && !(tk[i + 1] && /^(days?|weeks?|months?|years?|inch|inches|degrees?|bushels?|bu)$/.test(tk[i + 1].w || ''))) {
        var same40 = D.farm.fields.filter(function (f) { return f.acres === nv; });
        if (same40.length) {
          N.f = same40.length === 1 ? same40[0].id : 'ambig'; N.amb = same40; N.k = 'word'; N.nick = true;
          var nx2 = tk[i + 1]; if (nx2 && nx2.k === 'word' && /^(field|acres?|acre|acrer)$/.test(nx2.w)) { nx2.used = true; nx2.w = '_'; }
        }
      }
    }
    var prevCropRef = null;
    take(/\b(?:on|after|following|behind|into) (soy|corn) (?:ground|stubble|land|acres)\b/, function (m) { prevCropRef = m[1]; });
    var allFields = null;
    var tAll = /\b(?:all|every|each)(?: of)?(?: my| the)?(?: fields?| farm)|\bthe whole farm\b|\beverywhere\b|\banywhere\b|\bacross the farm\b/.exec(t);
    if (tAll) allFields = true;

    function S_() { return tk.map(function (x) { return x.used ? '_' : x.k === 'pct' ? 'PCT' : x.k === 'deg' ? 'DEG' : x.k === 'year' ? 'YEAR' : x.k === 'num' ? 'NUM' : x.k === 'sep' ? 'SEP' : x.f ? 'F:' + x.f : x.c ? x.c : x.w; }).join(' '); }
    function idxAt(s, off) { return (s.slice(0, off).match(/ /g) || []).length; }
    function take(re, cb) {   // consume every match; cb(m, a, b) with token indices
      var s = S_(), g = new RegExp(re.source, 'g'), m, out = [];
      while ((m = g.exec(s))) {
        if (!m[0]) { g.lastIndex++; continue; }
        var a = idxAt(s, m.index), b = a + (m[0].match(/ /g) || []).length;
        out.push({ m: m, a: a, b: b });
      }
      out.forEach(function (o) { for (var j = o.a; j <= o.b; j++) { tk[j].used = true; } if (cb) cb(o.m, o.a, o.b); });
      return out;
    }

    // ---- 0. irrigation ("an inch a week in July", "irrigate July and August", "irrigate June to August", "no irrigation")
    (function () {
      var IR_ON = /^(?:irrigat\w*|irrigation)$/, MON = { jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8 };
      var anchors = [], j;
      for (j = 0; j < n; j++) {
        var w0 = tk[j].k === 'word' && !tk[j].used ? tk[j].w : '';
        if (IR_ON.test(w0)) anchors.push(j);
        else if (/^inch(?:es)?$/.test(w0) && tk[j + 1] && /^(?:a|per|each|every)$/.test(tk[j + 1].w || '') && tk[j + 2] && /^(?:week|wk)$/.test(tk[j + 2].w || '')) anchors.push(j);
      }
      if (!anchors.length) return;
      var a0 = anchors[0], off = false;
      // "no irrigation", "stop irrigating", "without irrigation"
      for (j = Math.max(0, a0 - 4); j < a0; j++) if (tk[j].k === 'word' && /^(?:no|without|stop|skip|dont|cancel|remove|drop|off)$/.test(tk[j].w) && /^(?:irrigat\w*|irrigation)$/.test(tk[a0].w || '')) { off = true; }
      if (!off && /\b(?:turn|switch) (?:the )?irrigation off\b|\bnot irrigat\w*|\bdo not irrigate\b|\bwithout (?:any )?(?:irrigation|watering)\b/.test(t)) off = true;
      var value = null, ask = false, months = {}, range = false, touched = [];
      // the amount: "an inch", "1 inch", "one inch"; other amounts are not modelled
      for (j = 0; j < n; j++) if (tk[j].k === 'word' && /^inch(?:es)?$/.test(tk[j].w)) {
        touched.push(j); var pv = tk[j - 1];
        if (pv && pv.k === 'num') { touched.push(j - 1); if (pv.v !== 1) notes.push('Irrigation here is one inch a week; I cannot model ' + pv.w + ' inches.'); }
        else if (pv && /^(?:an|one|a)$/.test(pv.w || '')) touched.push(j - 1);
      }
      anchors.forEach(function (a) {
        touched.push(a);
        if (tk[a].w === 'inch' || tk[a].w === 'inches') { touched.push(a + 1, a + 2); }
        // months and joiners right after the anchor, else just before it
        var k = a + 1, okW = /^(?:in|during|for|from|and|to|through|thru|until|till|just|only|the|of|every|week|weekly|a|an|one|per|each|all|summer|months?|jun|june|jul|july|aug|august)$/;
        var found = [];
        while (k < n && k <= a + 9 && ((tk[k].k === 'word' && okW.test(tk[k].w)) || (tk[k].k === 'sep' && tk[k + 1] && MON[tk[k + 1].w]))) { if (tk[k].k === 'sep') { k++; continue; } if (MON[tk[k].w]) { found.push(k); months[MON[tk[k].w]] = 1; } if (/^(?:to|through|thru|until|till)$/.test(tk[k].w)) range = true; touched.push(k); k++; }
        if (!found.length) {
          // "in July irrigate"
          for (var q = Math.max(0, a - 3); q < a; q++) if (tk[q].k === 'word' && MON[tk[q].w] && !tk[q].used) { months[MON[tk[q].w]] = 1; touched.push(q); }
        }
      });
      var mk = Object.keys(months).map(Number).sort();
      if (off) value = 'none';
      else if (mk.length) {
        if (mk.indexOf(6) >= 0 && mk.indexOf(8) >= 0) value = 'jun-aug';
        else if (mk.length === 1 && mk[0] === 7) value = 'july';
        else if (mk.length === 2 && mk[0] === 7 && mk[1] === 8) value = 'july-aug';
        else notes.push('I can irrigate in July, in July and August, or from June to August. Say which one, for example "irrigate July and August".');
      } else ask = true;
      if (ask && !off && (Q_LEAD || /\b(?:care|prefer|priority|focus|most|important|matters?|rank)\b/.test(t))) return;   // a question or a ranking wish, not a change
      touched.forEach(function (ix) { if (tk[ix] && (tk[ix].k === 'word' || tk[ix].k === 'num')) tk[ix].used = true; });
      for (j = Math.max(0, a0 - 4); j < a0; j++) if (off && tk[j].k === 'word' && /^(?:no|without|stop|skip|dont|cancel|remove|drop|off|turn|switch|the|not|do)$/.test(tk[j].w)) tk[j].used = true;
      // a plain "irrigation on/off" word right after
      parsed = true;
      if (ask && !off) { notes.push('When should I irrigate: in July, in July and August, or from June to August? For example "irrigate July and August". "No irrigation" turns it off.'); return; }
      if (value == null) return;
      var curI = pathGet(controls, 'crops.irrigation') || 'none';
      if (curI === value) same.push(value === 'none' ? 'irrigation is already off' : 'irrigating ' + FS.irrigationPhrase(value) + ' is already set');
      else {
        actions.push({ type: 'setControl', path: 'crops.irrigation', value: value }); planned['crops.irrigation'] = value;
        applied.push(value === 'none' ? 'no irrigation' : 'irrigating ' + FS.irrigationPhrase(value) + ' on every field'); labelBits.push(value === 'none' ? 'No irrigation' : 'Irrigating ' + FS.irrigationPhrase(value));
        if (value !== 'none') notes.push('The pumping cost is a working value (energy only, no equipment or labour), so treat the money as rough.');
      }
    })();

    // ---- 1. priorities ("I care most about profit")
    var prio = null, prioWater = false;
    (function () {
      var trig = /\b(care|cares|matter|matters|important|priority|priorities|prefer|favou?r|focus|rank|ranked|sort|order|goal|want|worried|concerned|interested|optimi[sz]e|maxim[iy][sz]e|most|best|highest|lowest|least|minimi[sz]e)\b/.test(t);
      var risk = /\b(safe bet|play it safe|safer|safest|safe|risk|risks|risky|steady|stable|stability|bad years?|downside|volatil\w+|secure|worst case)\b/, profit = /\b(profit|profits|profitable|money|income|returns?|dollars?|cash|earn|earnings|revenue|cheapest|bottom line)\b/,
        cover = /\b(ground cover|soil cover|soil health|soil|erosion|runoff|green|greenness|cover)\b/, bal = /\bbalanced?\b|\ba bit of everything\b|\ball of the above\b/;
      var water = /\b(water|moisture|irrigation)\b/;
      var cand = null, re = null;
      if (/\bsafe bet\b|play it safe|lowest risk|least risk|less risky|minimi[sz]e risk/.test(t)) { cand = 'risk'; re = /safe bet|play it safe|lowest risk|least risk|less risky|minimi[sz]e risk/; }
      else if (trig || /\brank\b|\bby (?:profit|risk|cover)/.test(t)) {
        // "cover crop" is a plan phrase, not a priority
        var tt = t.replace(/cover crops?/g, ' '), found = [];
        [['risk', risk], ['profit', profit], ['cover', cover], ['balanced', bal]].forEach(function (c) { var m = c[1].exec(tt); if (m && !(c[0] === 'profit' && /\bwhat is the (?:profit|money)\b/.test(tt))) found.push({ k: c[0], at: m.index, re: c[1] }); });
        found.sort(function (x, y) { return x.at - y.at; });
        if (found.length) { cand = found[0].k; re = found[0].re; if (found.length > 1) notes.push('One ranking at a time: I used ' + PRIO_PHRASE[cand] + ', not ' + found.slice(1).map(function (x) { return PRIO_PHRASE[x.k]; }).join(' or ') + '.'); }
        if (!found.length && water.test(tt) && /\b(care|prefer|priority|focus|most|want|important|matters?)\b/.test(tt)) { prioWater = true; }
      }
      if (cand && /\b(care|prefer|priority|focus|rank|sort|order|goal|want|worried|concerned|interested|optimi[sz]e|maxim|most|best|highest|lowest|least|minimi[sz]e|safe bet|play it safe|important|matters?|by )\b/.test(t) || cand === 'risk' && /safe bet|play it safe|lowest risk/.test(t)) {
        prio = cand;
        // consume the words of the matching clause so the rest of the parser does not trip on them
        for (var j = 0; j < n; j++) if (tk[j].k === 'word' && /^(care|cares|matter|matters|important|priority|priorities|prefer|most|best|highest|lowest|rank|ranked|sort|order|by|about|saving|save|money|profit|profits|profitable|income|cash|safe|bet|risk|risks|risky|steady|soil|ground|cover|erosion|green|balanced|balance|safer|safest|play|it|lowest|least|less|minimize|minimise|optimize|optimise|maximize|maximise|goal|want|worried|concerned|interested|focus|my|is|are|the|a|i|really|mostly|primarily)$/.test(tk[j].w)) tk[j].used = true;
      }
    })();
    if (prio) {
      parsed = true; var cur = controls.other && controls.other.priority || 'balanced';
      if (prio !== cur) { actions.push({ type: 'setControl', path: 'other.priority', value: prio }); applied.push('options ranked by ' + PRIO_PHRASE[prio]); labelBits.push('Ranked by ' + PRIO_LABEL[prio].toLowerCase()); planned['other.priority'] = prio; }
      else same.push('options are already ranked by ' + PRIO_PHRASE[prio]);
    } else if (prioWater) {
      notes.push('I cannot rank options by water use yet. I can rank by profit, lowest risk, most ground cover or a balance of profit and risk. Say "I care most about ground cover", for example.');
      parsed = true;
    }

    // ---- 1b. events the model does not simulate
    var EVENT_NAME = { derecho: 'A derecho (wind storm)', windstorm: 'A wind storm', wind: 'A wind storm', hail: 'Hail', hailstorm: 'Hail', tornado: 'A tornado', tornadoes: 'A tornado', hurricane: 'A hurricane', tile: 'Drainage tile', tiling: 'Drainage tile',
      insects: 'Insects', insect: 'Insects', bugs: 'Insects', aphids: 'Insects', pests: 'Pests', disease: 'Crop disease', fire: 'Fire', wildfire: 'Fire', locusts: 'Locusts', blizzard: 'A blizzard', flood: 'A flood', flooding: 'A flood', floods: 'A flood', flooded: 'A flood', weeds: 'Weeds' };
    var events = [];
    take(/\b(?:derecho|wind ?storms?|hail ?(?:storm)?|tornado(?:es)?|hurricane|tiles?|tiling|insects?|bugs|aphids|pests?|disease|wild ?fire|locusts|blizzard|flood(?:s|ed|ing)?|weeds)\b/, function (m) {
      var key = m[0].replace(/\s+/g, '').replace(/^windstorms?$/, 'windstorm').replace(/^hailstorm$/, 'hail').replace(/^tiles$/, 'tile').replace(/^wildfire$/, 'wildfire');
      var nm = EVENT_NAME[key] || EVENT_NAME[key.replace(/s$/, '')] || cap(m[0]);
      if (events.indexOf(nm) < 0) events.push(nm);
    });
    var wantsFlood = events.indexOf('A flood') >= 0;

    // ---- 1c. weather events ("dry July", "heat wave in July") and the planting date ("plant 2 weeks earlier")
    (function () {
      var SEV = '(severe|extreme|serious|terrible|very|really|bad|worst)', KIND = 'heat ?waves?|heat spell|hot spell|heatwave|drought|dry|wet|rainy|hot';
      var REM_KIND = '(events?|spells?|droughts?|heat ?waves?|(?:dry|wet|hot|rainy) (?:spells?|periods?|' + MONTH_RE + '))';
      var kindOf = function (w) { return /heat|hot/.test(w) ? 'heatwave' : /wet|rain/.test(w) ? 'wetspell' : 'dryspell'; };
      var cur = eventsOf(controls).map(function (e) { return { type: e.type, month: e.month, severity: e.severity }; }), list = cur.slice();
      var adds = [], removes = [];
      take(new RegExp('\\b(?:remove|clear|no|drop|cancel|without|delete|stop|get rid of|take out|forget)(?: (?:the|all|any|my|that|an?))*(?: weather)? ' + REM_KIND + '(?: (?:in|for|of|during))?(?: ' + MONTH_RE + ')?\\b'), function (m) {
        var kw = m[1], mo = 0, mm = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/.exec(m[0]);
        if (mm) mo = monthNo(mm[1]);
        removes.push({ kind: /^(?:events?|spells?)$/.test(kw) ? null : kindOf(kw), month: mo });
      });
      function addEv(kindWord, sevWord, monthWord) {
        var mo = monthNo(monthWord); if (!mo) return;
        var type = kindOf(kindWord), sev = sevWord ? 'severe' : 'moderate';
        adds.push({ type: type, month: mo, severity: sev });
      }
      take(new RegExp('\\b(?:an? )?(?:' + SEV + ' )?(?:an? )?(' + KIND + ')(?: (?:spell|period|stretch|month|weather|summer|conditions))?(?: (?:in|during|for|of|this|next))? ' + MONTH_RE + '\\b'), function (m) { addEv(m[2], m[1], m[3]); });
      take(new RegExp('\\b(?:' + SEV + ' )?' + MONTH_RE + ' (' + KIND + ')(?: (?:spell|period|stretch))?\\b'), function (m) { addEv(m[3], m[1], m[2]); });
      // "heat wave" with no month: ask for the month instead of "did not catch"
      if (!adds.length && !removes.length && /\b(heat ?waves?|heatwave|heat spell|hot spell|dry spell|wet spell|rainy spell)\b/.test(t)) notes.push('Which month? For example "heat wave in July" or "dry spell in August".');
      if (removes.length) {
        parsed = true;
        removes.forEach(function (r) {
          var before = list.length;
          list = list.filter(function (e) { return !((!r.kind || e.type === r.kind) && (!r.month || e.month === r.month)); });
          if (list.length === before) same.push('there is no such weather event to remove');
        });
      }
      if (adds.length) {
        parsed = true; var dropped = [], newHeat = false;
        adds.forEach(function (e) {
          var k = -1; list.forEach(function (x, ix) { if (x.type === e.type && x.month === e.month) k = ix; });
          if (k >= 0) { if (list[k].severity === e.severity) same.push(evList([e])[0] + ' is already set'); else list[k] = e; }
          else if (list.length < 3) { list.push(e); if (e.type === 'heatwave') newHeat = true; }
          else dropped.push(evList([e])[0]);
        });
        if (dropped.length) notes.push('Three weather events at most, so I left out ' + dropped.join(' and ') + '. Say "remove the events" to start again.');
        if (newHeat) notes.push('A heat wave shows up in this model mostly as extra water use. The damage from the heat itself could not be measured from the data, so none is added. That is why heat alone changes little here: what moves yield in this model is water, and the extra heat only hurts when the soil is already running dry.');
      }
      if (JSON.stringify(list) !== JSON.stringify(cur)) {
        actions.push({ type: 'setControl', path: 'weather.events', value: list }); planned['weather.events'] = list;
        if (list.length) { var fresh = list.filter(function (e) { return !cur.some(function (x) { return x.type === e.type && x.month === e.month && x.severity === e.severity; }); }); applied.push((fresh.length ? fresh : list).map(function (e) { return 'a ' + evList([e])[0]; }).join(' and ')); labelBits.push(evList(list).join(' · ')); }
        else { applied.push('no weather events'); labelBits.push('No weather events'); }
      }
      // planting date, in steps of a week, up to 3 weeks either way
      var shift = null, pnote = null, amount = null;
      function setShift(sign, days, assumed) {
        var d = Math.round(days / 7) * 7, cl = Math.max(0, Math.min(21, d)), v = sign * cl;
        if (cl !== d) pnote = 'Planting can move up to 3 weeks; I used ' + Math.abs(v) + ' days ' + (sign < 0 ? 'earlier' : 'later') + '.';
        else if (d !== days && !assumed) pnote = 'Planting moves in steps of a week, so I used ' + (v === 0 ? 'on time' : Math.abs(v) + ' days ' + (sign < 0 ? 'earlier' : 'later')) + '.';
        if (assumed) pnote = 'No amount given, so I used a week ' + (sign < 0 ? 'earlier' : 'later') + '.';
        shift = v;
      }
      var UNIT = { day: 1, days: 1, week: 7, weeks: 7, month: 28, months: 28 };
      function amt(grp, a, b, unit) {
        var n = grp === 'NUM' ? null : /couple/.test(grp) ? 2 : /few/.test(grp) ? 3 : { a: 1, an: 1, one: 1, two: 2, three: 3 }[grp];
        if (grp === 'NUM') for (var j = a; j <= b; j++) if (tk[j].k === 'num') { n = tk[j].v; break; }
        return n == null ? null : n * (unit ? UNIT[unit] : 1);
      }
      var AMT = '(?: (NUM|a couple|a few|couple|few|an?|one|two|three))?(?: of)?(?: (days?|weeks?|months?))?', DIRW = '(earlier|later|sooner|early|late)';
      take(new RegExp('\\b(?:plant|planting|sow|sowing|seed|seeding)(?: dates?)?(?: (?:all|everything|everywhere|my|the|fields?|farm))*' + AMT + '(?: (?:a bit|a little|slightly|bit|little|much|well))? ' + DIRW + '\\b'), function (m, a, b) {
        var sign = /^(?:earlier|sooner|early)$/.test(m[3]) ? -1 : 1, days = m[1] ? amt(m[1], a, b, m[2]) : null;
        if (days == null || days === 0) setShift(sign, 7, true); else setShift(sign, days, false);
      });
      take(new RegExp('\\b' + DIRW + ' (?:planting|sowing)\\b'), function (m) { setShift(/^(?:earlier|sooner|early)$/.test(m[1]) ? -1 : 1, 7, true); });
      if (shift == null && /\b(?:plant\w*|sow\w*|seed\w*)\b/.test(t)) take(new RegExp('\\b(NUM|a couple|a few|couple|few|an?|one|two|three)(?: of)? (days?|weeks?|months?) ' + DIRW + '\\b'), function (m, a, b) {
        var days = amt(m[1], a, b, m[2]); if (days != null) setShift(/^(?:earlier|sooner|early)$/.test(m[3]) ? -1 : 1, days, false);
      });
      if (shift == null) take(/\b(?:(?:plant|planting|sow|sowing)(?: dates?)?(?: (?:all|everything|my|the|fields?))* (?:on time|as usual|as normal|normally|on schedule|at the usual time|on the usual dates?|on the normal dates?|usual|normal)|(?:usual|normal|regular) planting dates?)\b/, function () { shift = 0; });
      if (shift != null) {
        parsed = true; var curShift = Number(pathGet(controls, 'crops.plantShiftDays')) || 0;
        if (pnote) notes.push(pnote);
        if (curShift === shift) same.push('planting is already ' + plantWords(shift));
        else { actions.push({ type: 'setControl', path: 'crops.plantShiftDays', value: shift }); planned['crops.plantShiftDays'] = shift; applied.push('planting ' + plantWords(shift) + ' on all fields'); labelBits.push('planting ' + plantWords(shift)); }
      }
    })();

    // ---- 2. plan phrases (consumes tokens). Each mention: { plan, a, b, neg? }
    var mentions = [];
    function addPlan(plan, a, b, extra) { var o = { plan: plan, a: a, b: b }; if (extra) for (var k in extra) o[k] = extra[k]; mentions.push(o); }
    // negations of rye: "no more rye", "drop the rye", "don't plant rye", "without rye"
    take(/\b(?:no more|no|drop|dropping|remove|removing|skip|skipping|cancel|without|stop|forget|ditch|not|never|dont|do not|rather than|instead of|get rid of|take out|take off|forget about|scrap|scratch)(?: (?:the|that|any|a|planting|plant|using|use|growing|grow|more|of))* rye\b(?: (?:off|out|cover))?/, function (m, a, b) { addPlan('__norye', a, b); });
    take(/\brye (?:off|out)\b/, function (m, a, b) { addPlan('__norye', a, b); });
    take(/\b(?:no|without|skip|drop) (?:the )?(?:cover|covers)\b/, function (m, a, b) { addPlan('__norye', a, b); });
    // corn after corn / soybeans again
    take(/\b(?:corn (?:after|on|following|behind|into|then) corn|continuous corn|corn again|second year corn|corn corn|corn on corn|corn year two)\b/, function (m, a, b) { addPlan('corn-corn', a, b); });
    take(/\b(?:soy (?:after|on|following|behind|into|then) soy|continuous soy|soy again|soy soy|second year soy|soy on soy)\b/, function (m, a, b) { addPlan('soy-soy', a, b); });
    // "corn after soy" = corn, "soy after corn" = soy
    take(/\b(corn|soy) (?:after|following|behind) (?:corn|soy)\b/, function (m, a, b) { addPlan('__bare:' + m[1], a, b); });
    // rye with a named crop
    take(/\brye (?:then|before|ahead of|followed by|and then|and|going into|prior to|into|to) (corn|soy)\b/, function (m, a, b) { addPlan('__rye:' + m[1], a, b); });
    take(/\b(corn|soy) (?:after|following|behind) rye\b/, function (m, a, b) { addPlan('__rye:' + m[1], a, b); });
    take(/\brye\b/, function (m, a, b) { addPlan('__rye:', a, b); });
    take(/\boats?\b/, function (m, a, b) { addPlan('oats-cover', a, b); });
    // a bare crop with a plan verb or field next to it ("switch north to soybeans", "plant corn on north", "soybeens on south")
    var PV = /^(plant|planting|grow|growing|switch|change|go|going|move|try|put|set|use|sow|rotate|swap|convert|do|make|seed|farm|choose|pick|select|to|with|into|and|then)$/;
    for (i = 0; i < n; i++) {
      var Z = tk[i]; if (!Z.c || Z.used || Z.c === 'rye' || Z.c === 'oats') continue;
      var nextW = tk[i + 1] && tk[i + 1].w, prevW = tk[i - 1] && tk[i - 1].w;
      if (/^(price|prices|yield|yields|cost|costs|market|markets|harvest)$/.test(nextW || '') || /^(price|prices|market|crop)$/.test(prevW || '')) continue;
      var near = false, j2;
      for (j2 = Math.max(0, i - 3); j2 < i; j2++) if (!tk[j2].used && tk[j2].k === 'word' && PV.test(tk[j2].w)) near = true;
      for (j2 = Math.max(0, i - 3); j2 <= Math.min(n - 1, i + 3); j2++) if (tk[j2].f && !tk[j2].nick) near = true;
      if (!near) continue;
      Z.used = true; addPlan('__bare:' + Z.c, i, i);
    }
    // crop token right before price words is part of the price phrase ("corn prices fall 25%")
    for (i = 0; i < n; i++) if (tk[i].c && !tk[i].used && tk[i + 1] && /^(price|prices|market|markets)$/.test(tk[i + 1].w || '')) tk[i].used = true;

    // ---- 3. field mentions
    var fmentions = [];
    for (i = 0; i < n; i++) if (tk[i].f) {
      if (tk[i].f === 'ambig') { fmentions.push({ id: 'ambig', at: i, amb: tk[i].amb }); continue; }
      if (fmentions.some(function (x) { return x.id === tk[i].f; })) continue;
      fmentions.push({ id: tk[i].f, at: i }); tk[i].used = true;
    }
    fmentions.forEach(function (x) { if (x.id === 'ambig') tk[x.at].used = true; });
    var fieldsNamed = fmentions.filter(function (x) { return x.id !== 'ambig'; });
    var ambigM = fmentions.filter(function (x) { return x.id === 'ambig'; })[0], ambig = !!ambigM && !fieldsNamed.length;
    function ambigNote() { var l = ambigM.amb, w = ['', '', 'two', 'three', 'four'][l.length] || l.length; return 'There are ' + w + ' ' + l[0].acres + '-acre fields, ' + joinNames(l.map(function (f) { return f.name; })) + '. Which one do you mean?'; }
    if (allFields && mentions.length) fieldsNamed = D.farm.fields.map(function (f) { return { id: f.id, at: -1 }; });

    if (prevCropRef && !fieldsNamed.length) {
      var fol = D.farm.fields.filter(function (f) { return prevCropRef === 'soy' ? f.lastCrop === 'soybean' : f.lastCrop === 'corn'; }).map(function (f) { return f.name; });
      return { reply: 'Which field do you mean? ' + (fol.length ? 'The fields that followed ' + (prevCropRef === 'soy' ? 'soybeans' : 'corn') + ' are ' + fol.join(' and ') + '. ' : '') + 'Name one, for example "corn on ' + (fol[0] || D.farm.fields[D.farm.fields.length - 1].name) + '".', actions: [] };
    }
    // ---- 4. questions: compare / what should I plant
    var isCmp = /\bcompar\w*|\bversus\b|\bvs\b|side by side/.test(t);
    var isReco = /\bwhat should i\b|\bwhat do you (?:suggest|recommend)\b|\bwhat.?s the best\b|\bwhat is (?:the )?best\b|\bwhats best\b|\bwhich (?:is|plan|crop|option|rotation)\b|\bbest (?:plan|option|crop|rotation|choice|for)\b|\brecommend\w*|\bsuggest\w*|\badvice\b|\badvise\b|\boptions\b|\balternatives\b|\bwhat else\b|\bany ideas\b|\bshould i (?:plant|grow|switch|change|try|do)\b|\bworth a look\b/.test(t);
    if (isCmp || isReco) { for (i = 0; i < n; i++) if (tk[i].k === 'word' && /^(what|should|plant|best|plan|plans|options|compare|comparison|compared|recommend|suggest|which|option|alternatives|advice|current|for|with)$/.test(tk[i].w)) tk[i].used = true; parsed = true; }

    // ---- 5. weather scenario (named words, then years)
    var scenId = null, scenWords = null, scenNotes = [];
    var yearsAvail = climYears(), yrTokens = [];
    for (i = 0; i < n; i++) if (tk[i].k === 'year') yrTokens.push(i);
    var kwScen = [
      [['lateFreeze'], /\b(?:late (?:spring )?(?:freeze|frost)|spring (?:freeze|frost)|last frost)\b/],
      [['earlyFrost'], /\b(?:early (?:fall |autumn )?(?:freeze|frost)|(?:fall|autumn) (?:freeze|frost)|first frost)\b/],
      [['drought2012'], /\b(?:drought|flash)\b/],
      [['wetSpring', 'wet2019'], /\b(?:wet|wettest|rainy spring|soaked|too much rain|rain delay\w*|late planting|waterlogged)\b/],
      [['dry2023'], /\b(?:dry|dryness)\b/],
      [['typical'], /\b(?:typical|average|median)\b|\bnormal (?:year|season|weather|conditions)\b/]
    ];
    var kwHits = [];
    kwScen.forEach(function (ks) {
      var ids = ks[0].filter(function (id) { return NAMED().some(function (s) { return s.id === id; }); });
      var o = take(ks[1]); if (o.length) { var id = ids[0] || null; kwHits.push({ id: id, text: o[0].m[0] }); }
    });
    // a bare "frost" / "freeze" does not say which season
    var vague = take(/\b(?:frost|freeze|frosty)\b/);
    if (vague.length && !kwHits.some(function (h) { return /frost|freeze/.test(h.text); })) { notes.push('Which frost: "late spring frost" (1997) or "early fall frost" (1991)?'); parsed = true; }
    var yearHit = null, badYear = {};
    yrTokens.forEach(function (ix) {
      var y = tk[ix].v; tk[ix].used = true;
      if (yearsAvail.length && yearsAvail.indexOf(y) < 0) { if (!badYear[y]) scenNotes.push('I only have weather for ' + yearsAvail[0] + '–' + yearsAvail[yearsAvail.length - 1] + ', so I could not use ' + y + '.'); badYear[y] = 1; return; }
      if (yearHit === y) return;
      if (yearHit != null) { scenNotes.push('Only one season runs at a time: I used ' + yearHit + ', not ' + y + '.'); return; }
      yearHit = y;
    });
    if (yearHit != null) {
      var named = NAMED().filter(function (s) { return s.year === yearHit; })[0];
      scenId = named ? named.id : 'y' + yearHit;
      kwHits.forEach(function (h) { if (h.id && h.id !== scenId && h.id !== 'typical') scenNotes.push('I used the real ' + yearHit + ' weather, as you asked. If you meant the "' + scen(h.id).label + '" scenario, pick that instead.'); });
    } else if (kwHits.length) {
      scenId = kwHits[0].id; if (kwHits.length > 1) scenNotes.push('One season runs at a time: I used ' + scen(kwHits[0].id).phrase + ', not "' + kwHits[1].text + '".');
      if (!scenId) scenNotes.push('I do not have a season for "' + kwHits[0].text + '".');
    }
    if (scenNotes.length) { notes = notes.concat(scenNotes); parsed = true; }
    if (events.length) {
      parsed = true;
      var evTxt = events.length > 1 ? events.slice(0, -1).join(', ').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }) + ' and ' + events[events.length - 1].toLowerCase() : events[0];
      var evVerb = events.length > 1 || /^(Insects|Pests|Locusts|Weeds)$/.test(events[0]) ? ' are' : ' is';
      if (scenId || yearHit != null) notes.unshift(evTxt + evVerb + ' not modelled; I used ' + (yearHit != null ? 'the real ' + yearHit + ' weather' : scen(scenId).phrase) + '.');
      else notes.unshift(evTxt + evVerb + ' not modelled' + (wantsFlood ? '. The closest scenario is a wet spring: say "wet spring" to run it.' : '. I only model weather (temperature, rain), prices, nitrogen cost and crop plans, so try one of those or a past year such as "what if 2012 happens again?".'));
    }
    if (scenId) {
      parsed = true;
      if (controls.weather.scenario === scenId) same.push(scen(scenId).phrase + ' is already selected');
      else { actions.push({ type: 'setControl', path: 'weather.scenario', value: scenId }); planned['weather.scenario'] = scenId; applied.push(scen(scenId).phrase.replace(/^a /, 'a ')); labelBits.push(scen(scenId).label); }
    }

    // ---- 6. numbers: split what is left into clauses (and / then / commas), read each
    var qty = {}, conflicts = {}, KIND_NOUN = { RAIN: 'rain', NITRO: 'nitrogen price', PRICE: 'crop price', TEMP: 'temperature' };   // KIND -> {v, raw, assumed}
    function bind(kind, v, why, rawTxt) {
      if (qty[kind]) {
        if (Math.abs(qty[kind].v - v) > 1e-9 && !conflicts[kind]) { conflicts[kind] = 1; notes.push('You gave two ' + KIND_NOUN[kind] + ' changes; I used the first (' + signed(qty[kind].v, LIMITS[kind].unit) + ').'); }
        return;
      }
      qty[kind] = { v: v, why: why, raw: rawTxt };
    }
    var clauses = [], cs = 0;
    for (i = 0; i <= n; i++) {
      if (i === n || tk[i].k === 'sep' || (!tk[i].used && tk[i].k === 'word' && /^(and|then|also|but|while)$/.test(tk[i].w))) { if (i > cs) clauses.push([cs, i - 1]); cs = i + 1; }
    }
    function signWordAt(j) { var w = tk[j].w; return tk[j].k === 'word' && !tk[j].used ? (NEG.indexOf(w) >= 0 ? -1 : POS.indexOf(w) >= 0 ? 1 : (tk[j].imp ? tk[j].imp[1] : 0)) : 0; }
    clauses.forEach(function (cl) {
      var a = cl[0], b = cl[1], j, claimed = {};
      // temperature numbers (degrees)
      for (j = a; j <= b; j++) if (tk[j].k === 'deg' && !tk[j].used) {
        var v = tk[j].v; if (tk[j].f) v = Math.round(v / 1.8 * 2) / 2;
        var sg = tk[j].sg === '-' ? -1 : tk[j].sg === '+' ? 1 : 0, src = 'explicit';
        if (!sg) { var best = 9; for (var q = a; q <= b; q++) { var sw = signWordAt(q); if (sw && Math.abs(q - j) < best && Math.abs(q - j) <= 3) { best = Math.abs(q - j); sg = sw; claimed[q] = 1; } } src = 'word'; }
        var assumedUp = false; if (!sg) { sg = 1; assumedUp = true; }
        tk[j].used = true; for (q = a; q <= b; q++) if (tk[q].imp && tk[q].imp[0] === 'TEMP') tk[q].used = true;
        bind('TEMP', sg * v, assumedUp ? 'up' : src, tk[j].raw.trim());
      }
      // percentages
      for (j = a; j <= b; j++) if (tk[j].k === 'pct' && !tk[j].used) {
        var kwTok = -1, q2;
        for (q2 = j - 1; q2 >= Math.max(a, j - 4); q2--) { if (tk[q2].k === 'pct') break; if ((tk[q2].kw && tk[q2].kw !== 'TEMP' || (tk[q2].imp && tk[q2].imp[0] === 'RAIN')) && !claimed['k' + q2]) { kwTok = q2; break; } }
        if (kwTok < 0) for (q2 = j + 1; q2 <= Math.min(b, j + 4); q2++) { if (tk[q2].k === 'pct') break; if ((tk[q2].kw && tk[q2].kw !== 'TEMP' || (tk[q2].imp && tk[q2].imp[0] === 'RAIN')) && !claimed['k' + q2]) { kwTok = q2; break; } }
        if (kwTok < 0) { notes.push('I could not tell what the ' + tk[j].raw.trim() + ' applies to (rain, crop prices or nitrogen price).'); tk[j].used = true; continue; }
        claimed['k' + kwTok] = 1;
        var kind = tk[kwTok].kw || tk[kwTok].imp[0];
        var s2 = tk[j].sg === '-' ? -1 : tk[j].sg === '+' ? 1 : 0, assumedUp2 = false;
        if (!s2) {
          var bestD = 9; for (var q3 = a; q3 <= b; q3++) { var sw2 = signWordAt(q3); if (sw2 && q3 !== kwTok && Math.abs(q3 - j) < bestD && Math.abs(q3 - j) <= 3) { bestD = Math.abs(q3 - j); s2 = sw2; } }
          if (!s2 && tk[kwTok].imp) s2 = tk[kwTok].imp[1];
          if (!s2) { s2 = 1; assumedUp2 = true; }
        }
        tk[j].used = true; tk[kwTok].used = true;
        for (q3 = a; q3 <= b; q3++) { if (signWordAt(q3) && Math.abs(q3 - j) <= 3) tk[q3].used = true; if (tk[q3].imp && tk[q3].imp[0] === kind) tk[q3].used = true; }
        bind(kind, s2 * tk[j].v, assumedUp2 ? 'up' : 'ok', tk[j].raw.trim());
      }
      // "drier by 20" / "hotter by 3" without a unit
      for (j = a; j <= b; j++) if (tk[j].imp && !tk[j].used && tk[j + 1] && tk[j + 1].w === 'by' && tk[j + 2] && tk[j + 2].k === 'num' && j + 2 <= b) {
        var kd = tk[j].imp[0]; tk[j].used = tk[j + 1].used = tk[j + 2].used = true; bind(kd, tk[j].imp[1] * tk[j + 2].v, 'ok', tk[j + 2].w);
      }
      // words with no number: "hotter and drier", "less rain", "cheaper nitrogen"
      for (j = a; j <= b; j++) if (!tk[j].used && tk[j].imp) {
        var kk = tk[j].imp[0], dl = tk[j].imp[1] * (kk === 'TEMP' ? (dl0(kk, tk[j].imp[1])) : LIMITS[kk].dflt);
        tk[j].used = true; if (!qty[kk]) { qty[kk] = { v: dl, why: 'default', raw: tk[j].w }; assumed.push('"' + tk[j].w + '" = ' + signed(dl, LIMITS[kk].unit) + (kk === 'RAIN' ? ' rain' : '')); }
      }
      for (j = a; j <= b; j++) if (!tk[j].used && tk[j].kw && tk[j].kw !== 'TEMP') {
        var k3 = tk[j].kw, sgn = 0, bd = 9;
        for (var q4 = a; q4 <= b; q4++) { var s4 = signWordAt(q4); if (s4 && Math.abs(q4 - j) < bd && Math.abs(q4 - j) <= 3) { bd = Math.abs(q4 - j); sgn = s4; } }
        if (!sgn) continue;
        tk[j].used = true; for (q4 = a; q4 <= b; q4++) if (signWordAt(q4) && Math.abs(q4 - j) <= 3) tk[q4].used = true;
        if (!qty[k3]) { qty[k3] = { v: sgn * LIMITS[k3].dflt, why: 'default', raw: tk[j].w }; assumed.push(LIMITS[k3].say + ' ' + signed(sgn * LIMITS[k3].dflt, LIMITS[k3].unit)); }
      }
      for (j = a; j <= b; j++) if (!tk[j].used && tk[j].kw === 'TEMP') {
        var sg5 = 0, b5 = 9; for (var q5 = a; q5 <= b5 + a; q5++) { if (q5 > b) break; var s5 = signWordAt(q5); if (s5 && Math.abs(q5 - j) < b5) { b5 = Math.abs(q5 - j); sg5 = s5; } }
        if (sg5) { tk[j].used = true; if (!qty.TEMP) { qty.TEMP = { v: sg5 * 2, why: 'default', raw: 'temperature' }; assumed.push('temperature ' + signed(sg5 * 2, ' °C')); } }
      }
    });
    function dl0(k, sign) { return sign > 0 ? 2 : 1; }
    Object.keys(qty).forEach(function (k) {
      parsed = true;
      var L = LIMITS[k], q = qty[k], v = q.v, r = Math.round(v / L.step) * L.step, cl = Math.max(L.lo, Math.min(L.hi, r));
      if (r !== cl) notes.push(L.name + ' capped at ' + signed(cl, L.unit) + ', the limit of its slider.');
      else if (Math.abs(r - v) > 1e-9) notes.push(L.name + ' rounded to ' + signed(cl, L.unit) + '.');
      if (q.why === 'up') notes.push('You did not say up or down for ' + L.say + ', so I took ' + q.raw + ' as an increase.');
      var cur = pathGet(controls, L.path);
      if (cur === cl) { same.push(L.say + ' is already ' + signed(cl, L.unit)); return; }
      actions.push({ type: 'setControl', path: L.path, value: cl }); planned[L.path] = cl;
      applied.push(k === 'TEMP' ? 'temperatures ' + signed(cl, ' °C') : L.say + ' ' + signed(cl, L.unit));
      labelBits.push(L.say + ' ' + signed(cl, L.unit));
    });
    if (assumed.length) notes.push('No number given, so I assumed ' + assumed.join('; ') + '. Give a number if you want something different.');

    // ---- 7. fields and plans
    var def = state.selectedField || D.farm.fields[0].id, usedDefault = false, selectTo = null;
    if (mentions.length) {
      parsed = true;
      var fl = fieldsNamed.map(function (x) { return { id: x.id, at: x.at }; });
      if (!fl.length && mentions.every(function (m) { return m.plan === '__norye'; })) {
        fl = D.farm.fields.filter(function (f) { return /^rye-/.test(controls.crops.plans[f.id]); }).map(function (f) { return { id: f.id, at: -1 }; });
        if (!fl.length) { same.push('No field is on a rye plan right now'); mentions = []; }
      }
      if (!fl.length && mentions.length) {
        if (ambig) { notes.push(ambigNote()); mentions = []; }
        else { fl = [{ id: def, at: -1 }]; usedDefault = true; }
      }
      var pairs = [], assigned = {}, usedP = {}, fieldPlan = {};
      if (fl.length && mentions.length) {
        if (fl[0].at < 0) fl.forEach(function (f) { fieldPlan[f.id] = mentions[0]; if (mentions.length > 1 && f.at < 0) fieldPlan[f.id] = mentions[0]; });
        else {
          mentions.forEach(function (m, mi) { fl.forEach(function (f) { var d = f.at < m.a ? m.a - f.at : f.at > m.b ? f.at - m.b : 0; pairs.push({ mi: mi, f: f, d: d }); }); });
          pairs.sort(function (x, y) { return x.d - y.d; });
          pairs.forEach(function (p) { if (!usedP[p.mi] && !assigned[p.f.id]) { usedP[p.mi] = 1; assigned[p.f.id] = 1; fieldPlan[p.f.id] = mentions[p.mi]; } });
          fl.forEach(function (f) {   // a field with no plan of its own shares the nearest plan ("rye on north and creek")
            if (fieldPlan[f.id]) return; var bestM = null, bd2 = 1e9;
            mentions.forEach(function (m) { var d = f.at < m.a ? m.a - f.at : f.at > m.b ? f.at - m.b : 0; if (d < bd2) { bd2 = d; bestM = m; } });
            if (bestM) fieldPlan[f.id] = bestM;
          });
          mentions.forEach(function (m, mi) { if (!usedP[mi] && !Object.keys(fieldPlan).some(function (k) { return fieldPlan[k] === m; })) notes.push('I did not know which field "' + (m.plan.indexOf('__') === 0 ? m.plan.replace(/^__\w+:?/, '') || 'rye' : planPlain(m.plan)) + '" was for.'); });
        }
      }
      var order = fl.map(function (f) { return f.id; }), cantFit = {};
      order.forEach(function (fid) {
        var m = fieldPlan[fid]; if (!m) return; var f = fieldById(fid), opts = D.planOptions[f.lastCrop], cur = controls.crops.plans[fid], plan = m.plan, want = null;
        if (plan === '__norye') {
          if (/^rye-/.test(cur)) plan = cur.replace(/^rye-/, ''); else { same.push(f.name + ' is not on a rye plan'); return; }
        } else if (plan.indexOf('__rye:') === 0) {
          var cc = plan.slice(6); want = cc || (f.lastCrop === 'corn' ? 'soy' : 'corn'); plan = 'rye-' + want;
        } else if (plan.indexOf('__bare:') === 0) { want = plan.slice(7); plan = want; }
        if (opts.indexOf(plan) < 0 && order.length > 1) {
          var lc = f.lastCrop === 'soybean' ? 'soybeans' : f.lastCrop;
          (cantFit[plan] = cantFit[plan] || []).push({ name: f.name, lc: lc }); return;
        }
        if (opts.indexOf(plan) < 0) {
          var why = want ? (plan === want && (want === f.lastCrop || (want === 'soy' && f.lastCrop === 'soybean')) ? '"' + (want === 'soy' ? 'soybeans' : 'corn') + '" after ' + f.lastCrop + ' means ' + (want === 'soy' ? 'soybeans again' : 'corn again') + ' on ' + f.name + '. ' : '') : '';
          notes.push(why + 'That plan (' + planPlain(plan) + ') does not fit ' + f.name + ', which follows ' + (f.lastCrop === 'soybean' ? 'soybeans' : f.lastCrop) + '. Options there: ' + opts.map(function (p) { return short(p).replace(' (current plan)', ''); }).join('; ') + '.');
          return;
        }
        if (cur === plan) { same.push(f.name + ' is already on ' + planPlain(plan)); return; }
        actions.push({ type: 'setControl', path: 'crops.plans.' + fid, value: plan }); planned['crops.plans.' + fid] = plan;
        var tr = controls.crops.trialAcres && controls.crops.trialAcres[fid];
        if (tr === 0) { actions.push({ type: 'setControl', path: 'crops.trialAcres.' + fid, value: f.acres }); notes.push('"Acres to try" on ' + f.name + ' was 0, so I set it to all ' + f.acres + ' acres.'); }
        applied.push(f.name + ': ' + (plan === 'soy' || plan === 'corn' ? (m.plan === '__norye' ? 'back to ' : '') + short(plan) : short(plan)));
        labelBits.push(f.name + ' ' + plain(D.plans[plan].label));
        if (!selectTo) selectTo = fid;
      });
      Object.keys(cantFit).forEach(function (pl) {
        var lst = cantFit[pl], names = lst.map(function (x) { return x.name; }), lcs = uniq(lst.map(function (x) { return x.lc; }));
        notes.push(cap(planPlain(pl)) + ' is not an option on ' + names.join(' and ') + ', which follow ' + lcs.join(' and ') + ', so I left ' + (names.length > 1 ? 'them' : 'it') + ' as ' + (names.length > 1 ? 'they were' : 'it was') + '.');
      });
      if (usedDefault) notes.push('You did not name a field, so I used ' + fieldById(def).name + ' (the one selected).');
    } else if (fieldsNamed.length && !(isCmp || isReco) && /\b(?:show|select|open|view|display|go to|switch to|look at|focus on|pull up|see)\b/.test(t)) {
      // a field was named with a clear show/select/open intent: show it
      parsed = true;
      var fid0 = fieldsNamed[0].id;
      if (fid0 !== state.selectedField) { actions.push({ type: 'selectField', id: fid0 }); applied.push('selected ' + fieldById(fid0).name); } else same.push(fieldById(fid0).name + ' is already selected');
      if (fieldsNamed.length > 1) notes.push('Showing ' + fieldById(fid0).name + ' only; one field is open at a time.');
    } else if (ambig && !(isCmp || isReco)) { notes.push(ambigNote()); parsed = true; }
    if (selectTo && selectTo !== state.selectedField) actions.push({ type: 'selectField', id: selectTo });

    // fuzzy matches said back to the user
    var fz = []; tk.forEach(function (x) { if (x.fuzzyFrom && x.used) fz.push('"' + x.fuzzyFrom + '" as ' + (x.c ? (x.c === 'soy' ? 'soybeans' : x.c) : ((fieldById(x.f) || {}).name || x.f))); });
    if (fz.length && actions.length) notes.push('I read ' + fz.join(' and ') + '.');

    // ---- 8. answer
    var simState = clone(controls);
    actions.forEach(function (a) { if (a.type === 'setControl') try { setIn(simState, a.path, a.value); } catch (e) { /* ignore */ } });
    var effective = { controls: simState };
    function finish(res) {
      // anything in the text that none of the parsers touched is reported, never dropped silently
      var left = [];
      clauses.forEach(function (cl) {
        var any = false, words = [];
        for (var j = cl[0]; j <= cl[1]; j++) { if (tk[j].used) any = true; else if (tk[j].k === 'word' && STOP.indexOf(tk[j].w) < 0 && !tk[j].f && !tk[j].c) words.push(tk[j].raw); else if (tk[j].k === 'pct' || tk[j].k === 'deg') words.push(tk[j].raw.trim()); }
        if (!any && words.length) left.push(words.join(' '));
      });
      if (events.length) res.ai = true;
      // words the rules skipped inside a clause they half-read ("beetles are eating my soybeans on North 80"): the farmer meant more than a setting
      var stray = tk.filter(function (x) { return !x.used && x.k === 'word' && x.w.length > 2 && STOP.indexOf(x.w) < 0 && !x.f && !x.c; }).length;
      if (stray >= 2) res.ai = true;   // floods, pests, hail...: the model cannot run them, so the AI helper answers the farmer's real question
      if (left.length && (parsed || res.actions.length)) { res.reply += (res.reply ? '\n' : '') + 'I could not apply: "' + left.join('"; "') + '".'; res.ai = true; }
      return res;
    }
    var moneyQ = /\bhow much (?:money|profit|will i|do i|would i)\b|\bwhat.?s (?:my|the) (?:profit|return|income|bottom line)\b|\bhow (?:am i|will i|would i) do\b|\bhow (?:does|would) (?:it|that|this) look\b/.test(t);
    if (Q_LEAD && !CMD && !/\d/.test(t) && !(isCmp || isReco) && !moneyQ && !scenId && !Object.keys(qty).length) {
      return { ai: true, reply: 'That sounds like a question, so I changed nothing. I can answer "why", "how reliable is this", "where does the data come from", "which field is most at risk" or "what is the safest option". To try something, say what, for example "what if 2012 happens again?".', actions: [] };
    }
    if (isCmp || isReco) {
      var cfid = fieldsNamed.length ? fieldsNamed[0].id : null;
      var lead = applied.length ? 'Setting ' + applied.join('; ') + ' first.\n' : '';
      if (cfid || isCmp) {
        var useId = cfid || state.selectedField, lead2 = lead + (!cfid ? fieldById(useId).name + ' is the selected field.\n' : '');
        var res = compareReply(useId, simState, state, lead2); res.actions = actions.length ? actions.concat([{ type: 'run', label: labelBits.join(' · ') || 'Chat run' }]) : [];
        if (notes.length) res.reply = uniq(notes).slice(0, 3).join('\n') + '\n' + res.reply;
        return finish(res);
      }
      var sm = state.current && state.current.summary, recs = recsFrom(sm);
      var res2 = { reply: '', actions: [], kind: 'rec' };
      if (recs.length) { res2.items = recs; res2.reply = (lead || '') + (recs.length === 3 ? 'Three' : cap(['zero', 'one', 'two'][recs.length]) ) + ' options worth a look, ranked by ' + PRIO_PHRASE[(controls.other && controls.other.priority) || 'balanced'] + ':'; }
      else {
        var sf = (state.selectedField || D.farm.fields[0].id), cmpR = compareReply(sf, simState, state, '');
        res2.reply = (lead || '') + plainSpeak((sm && sm.recommendationNote) || 'No alternative beats your current plans on this ranking.') + '\nHere is how the other options on ' + fieldById(sf).name + ' compare:';
        if (cmpR.items && cmpR.items.length) { res2.items = cmpR.items; res2.kind = 'cmp'; }
        else res2.reply += ' Name a field to compare its plans, for example "compare plans for ' + D.farm.fields[0].name + '".';
      }
      if (actions.length) res2.actions = actions.concat([{ type: 'run', label: labelBits.join(' · ') || 'Chat run' }]);
      return finish(res2);
    }
    // money question
    if (!applied.length && moneyQ) {
      var cr = state.current;
      if (!cr) return { reply: 'Run a simulation first, then ask again.', actions: [] };
      return { reply: farmLine(cr) + '\nAsk "compare" to see the options for one field.', actions: [] };
    }

    var changedAny = actions.some(function (a) { return a.type !== 'selectField'; });
    var declinedOnly = (Object.keys(badYear).length || (events.length && !scenId && yearHit == null)) && !actions.length && !same.length;
    var needRun = !declinedOnly && ( changedAny || (wantsRun && !fieldsNamed.length && !actions.length && (parsed || !tk.some(function (x) { return x.k === 'word' && STOP.indexOf(x.w) < 0 && !x.used; }))) || (wantsRun && same.length && !actions.length));
    if (!parsed && !wantsRun) {
      var unk = notes.length ? uniq(notes).slice(0, 3).join('\n') : 'Sorry, I did not catch a change in that.\n' + examples();
      return { reply: unk, actions: [], ai: true };
    }
    var lines = [];
    if (applied.length) lines.push('Showing ' + applied.join('; ') + '.');
    else if (same.length) lines.push(cap(same.join('; ')) + (needRun ? '. Running it again.' : '.'));
    else if (needRun && !notes.length) lines.push('Running the simulation with the current controls.');
    if (applied.length && same.length) lines.push(cap(same.join('; ')) + '.');
    notes = uniq(notes); if (notes.length > 3) notes = notes.slice(0, 3);
    notes.forEach(function (x) { lines.push(x); });
    var out = { reply: lines.join('\n'), actions: actions };
    if (needRun) out.actions = out.actions.concat([{ type: 'run', label: labelBits.length ? labelBits.join(' · ') : 'Chat run' }]);
    if (!out.reply) { out.reply = examples(); out.ai = true; }
    return finish(out);
  };

  function farmLine(r) {
    var wp = FS.weatherPhrase ? FS.weatherPhrase(r.inputs.weather) : scen(r.inputs.weather.scenario).phrase;
    var irr = FS.irrigationWords && FS.irrigationWords(r.inputs.crops && r.inputs.crops.irrigation); if (irr) wp += ', ' + irr;
    var ps = Number(r.inputs.crops && r.inputs.crops.plantShiftDays) || 0; if (ps && FS.plantWords) wp += ', planting ' + FS.plantWords(ps);
    if (moneyHidden(r.summary)) return 'In ' + wp + ', ' + farmYield(r) + '. ' + OATS_MONEY;
    var s = r.summary, tot = Math.round(s.farm.returnTotal / 10) * 10, d = Math.round(s.farm.returnVsBaselineTotal / 10) * 10;
    var verb = Math.abs(tot) < 50 ? 'about breaks even' : tot > 0 ? 'earns about ' + money(tot) : 'loses about ' + money(Math.abs(tot));
    var cur0 = D.initialControls.crops.plans, plans = (r.inputs.crops && r.inputs.crops.plans) || {};
    var anyChange = Object.keys(cur0).some(function (k) { return plans[k] !== cur0[k] && !(s.fields[k] && s.fields[k].trialAcres === 0); });
    // only compare with the current plans when some plan was actually changed
    var vs = !anyChange ? '' : Math.abs(d) < 50 ? ', about the same as your current plans' : d < 0 ? ', and your changes cost about ' + money(Math.abs(d)) + ' compared with your current plans' : ', and your changes earn about ' + money(Math.abs(d)) + ' more than your current plans';
    if (FS.absMoneyOk && !FS.absMoneyOk()) return 'In ' + wp + ', ' + farmYield(r) + vs + '. (Costs here are Iowa State budgets, so only differences between plans are shown.)';
    return 'In ' + wp + ', your farm ' + verb + ' for the year' + vs + '.';
  }

  // ---------- advice from the farm questionnaire (FS.chat.advice, set by app.js) ----------
  // advice.card = { rye: {work:[], risks:[]}, oats: {...}, any: {...} }: plain notes added to the matching card lines. 'any' skips the current plan.
  function adviceFor(it) {
    var out = { work: [], risks: [] }, a = FS.chat.advice && FS.chat.advice.card; if (!a) return out;
    var groups = [];
    if (/^rye-/.test(it.plan)) groups.push('rye'); if (it.plan === 'oats-cover') groups.push('oats'); if (!it.isCurrent) groups.push('any');
    groups.forEach(function (g) { if (a[g]) { out.work = out.work.concat(a[g].work || []); out.risks = out.risks.concat(a[g].risks || []); } });
    return out;
  }
  FS.chat.setAdvice = function (adv) { FS.chat.advice = adv && (adv.lines && adv.lines.length || adv.greeting || adv.card) ? { greeting: adv.greeting || '', lines: (adv.lines || []).slice(0, 4), card: adv.card || null, used: false } : null; };

  // ---------- rendering ----------
  function cardLines(it, kind) {
    var c = it.card; if (!c) return '';
    var an = adviceFor(it), work = c.work, risks = c.risks;
    if (an.work.length) work = (work ? work + ' ' : '') + an.work.join(' ');
    if (an.risks.length) risks = (risks ? risks + ' ' : '') + an.risks.join(' ');
    var rows = [[kind === 'cmp' ? 'How it compares' : 'Why suggested', plainSpeak(c.why)], ['Evidence', c.evidence], ['Benefits', c.benefits], ['Extra work', work], ['Try it small', c.trySmall], ['Information gaps', c.gaps], ['Check with your adviser', risks]];
    return rows.filter(function (r) { return r[1]; }).map(function (r) { return '<li><strong>' + r[0] + ':</strong> ' + esc(plainSpeak(r[1])) + '</li>'; }).join('');
  }
  function bits(it) {
    // Season counts are money comparisons, so they are left out when money is not shown (oats placeholders).
    if (it.moneyNote) return '';
    if (it.isCurrent || it.betterSeasons == null || !it.nSeasons) return '';
    return it.betterSeasons === 0 ? 'earned less than your current plan in every one of the ' + it.nSeasons + ' past seasons the model replayed (a model estimate; small gaps are within its error)'
      : 'earned more than your current plan in ' + it.betterSeasons + ' of ' + it.nSeasons + ' past seasons the model replayed';
  }
  function itemHtml(it, idx, kind) {
    var f = fieldById(it.fieldId), seasons = bits(it), lead, more = [];
    if (kind === 'cmp') {
      var m = it.moneyNote ? it.moneyNote.replace(/\.$/, '') : moneyVs(it.deltaPerAcre);
      lead = esc(cap(planPlain(it.plan))) + ': ' + esc(m) + (it.tooClose && !it.moneyNote ? ' (too close to call)' : '') + (seasons ? '; ' + esc(seasons) : '') + '.';
      more.push('<li>' + esc(cap(coverPhrase(it.greenCoverMonthsAdded))) + ' compared with your current plan.</li>');
      if (!it.moneyNote && !it.isCurrent && it.worst5) more.push('<li>In the worst 5 past seasons: about $' + esc(Math.abs(Math.round(it.worst5)).toLocaleString('en-US')) + ' per acre ' + (it.worst5 < 0 ? 'worse' : 'better') + ' than your current plan.</li>');
    } else {
      lead = esc(f.name) + ': ' + esc(planPlain(it.plan));
      more.push('<li>' + (it.moneyNote ? esc(it.moneyNote) + ' ' : 'Compared with your current plan: ' + esc(moneyVs(it.deltaPerAcre, true)) + (it.tooClose ? ' (too close to call)' : '') + ', ') + (it.moneyNote ? esc(cap(coverPhrase(it.greenCoverMonthsAdded))) : esc(coverPhrase(it.greenCoverMonthsAdded))) + '.</li>');
      if (seasons) more.push('<li>' + esc(cap(seasons)) + '.</li>');
    }
    var finLine = '', finMore = '';
    try { if (FS.finUI && it.fieldId) { finLine = FS.finUI.cardLine(it.fieldId, it.plan); finMore = FS.finUI.cardMore(it.fieldId, it.plan); } } catch (e) { console.error(e); }
    return '<li>' + lead + ' <button type="button" class="fs-linkbtn" data-act="more" aria-expanded="false">More</button>' + finLine +
      '<div class="fs-rec-more" hidden><ul class="fs-detail-list">' + more.join('') + cardLines(it, kind) + '</ul>' + finMore +
      '<button type="button" class="fs-linkbtn" data-act="sim" data-i="' + idx + '">Show on map</button></div></li>';
  }
  // ---------- the helper trace: which helpers ran for one reply, recorded as the code runs ----------
  var turn = null, turnStart = 0;
  function beginTurn(first) { turn = { steps: first ? [first] : [], done: false }; turnStart = S.get().chat.length; }
  function step(s) { if (turn && s && turn.steps.indexOf(s) < 0) turn.steps.push(s); }
  function traceHtml(steps) { return '<div class="fs-trace"><span class="fs-trace-label">How This Answer Was Made</span> ' + steps.map(esc).join(' <span class="fs-trace-arrow" aria-hidden="true">\u2192</span> ') + '</div>'; }
  function seasonCount() { return climYears().length || 44; }
  function attachTrace() {
    if (!turn || turn.done || !turn.steps.length) return;
    var chat = S.get().chat; if (chat.length <= turnStart) return;
    var m = chat[chat.length - 1]; if (m.role !== 'assistant') return;
    turn.done = true; m.trace = turn.steps.slice();
    var els = listEl ? listEl.querySelectorAll('.fs-msg.assistant:not(.fs-thinking)') : [];
    var el = els[els.length - 1];
    if (el && !el.querySelector('.fs-trace')) el.insertAdjacentHTML('beforeend', traceHtml(m.trace));
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function renderMessage(m) {
    var d = document.createElement('div');
    d.className = 'fs-msg ' + m.role;
    var h = '';
    if (m.lead) h += '<p class="fs-lead">' + esc(m.lead) + '</p>';
    if (m.note) h += '<p>' + esc(m.note) + '</p>';
    h += '<p>' + esc(m.text) + '</p>';
    var items = m.items || m.recs;
    if (items && items.length) { h += '<ul class="fs-recs">' + items.map(function (r, i) { return itemHtml(r, i, m.kind || (m.recs ? 'rec' : 'cmp')); }).join('') + '</ul>'; d._items = items; }
    if (m.foot) h += '<p>' + esc(m.foot) + '</p>';
    if (m.trace && m.trace.length) h += traceHtml(m.trace);
    d.innerHTML = h;
    return d;
  }
  function append(m) {
    if (!listEl) return;
    var d = listEl.appendChild(renderMessage(m));
    // A long answer opens at its first line, not its last; short ones scroll to the bottom as usual.
    if (m.role === 'assistant' && d.offsetHeight > listEl.clientHeight * 0.8) listEl.scrollTop = Math.max(0, listEl.scrollTop + d.getBoundingClientRect().top - listEl.getBoundingClientRect().top - 8);
    else listEl.scrollTop = listEl.scrollHeight;
  }

  // ---------- opening / re-ranked recommendations ----------
  var lastRecPriority = null;
  FS.chat.postRecs = function (intro) {
    var cur = S.get().current; if (!cur) return;
    var sm = cur.summary, recs = recsFrom(sm), pr = (cur.inputs.other && cur.inputs.other.priority) || 'balanced';
    lastRecPriority = pr;
    var msg;
    if (recs.length) msg = { role: 'assistant', text: (recs.length === 3 ? 'Three' : cap(['zero', 'one', 'two'][recs.length])) + ' option' + (recs.length === 1 ? '' : 's') + ' worth a look, ranked by ' + PRIO_PHRASE[pr] + ':', items: recs, kind: 'rec', note: sm.recommendationNote ? plainSpeak(sm.recommendationNote) : null, foot: intro === false ? null : 'Type a what-if below, or "compare" for one field.' };
    else {
      // Nothing beats the current plans: say so, then still show the side-by-side comparison for the selected field,
      // so the farmer always sees the current plan and its alternatives with their cards.
      var fid = S.get().selectedField, cmp = compareReply(fid, S.get().controls, S.get(), '');
      var note = plainSpeak(sm.recommendationNote || 'No alternative beats your current plans.');
      if (cmp && cmp.items && cmp.items.length) msg = { role: 'assistant', text: note + '\nHere is how the other options on ' + fieldById(fid).name + ' compare:', items: cmp.items, kind: 'cmp', foot: intro === false ? null : 'Type a what-if below, or "compare" for another field.' };
      else msg = { role: 'assistant', text: 'Ranked by ' + PRIO_PHRASE[pr] + ': ' + note, foot: intro === false ? null : 'Type a what-if below, or "compare" for one field.' };
    }
    var adv = FS.chat.advice;
    if (intro !== false && adv && !adv.used) {
      var lead = (adv.greeting ? adv.greeting + (adv.lines.length ? '\n' : '') : '') + (adv.lines.length ? 'Based on your answers:\n' + adv.lines.map(function (l) { return '\u2022 ' + l; }).join('\n') : '');
      if (lead) { msg.lead = lead; adv.used = true; }
    }
    A.addChat(msg);
  };

  // ---------- running actions ----------
  function resultLine(fid) {
    var r = S.get().current, s = r.summary, f = fieldById(fid || S.get().selectedField), x = s.fields[f.id];
    if (moneyHidden(s)) return 'Result: In ' + scen(r.inputs.weather.scenario).phrase + ', ' + f.name + ' makes ' + Math.round(x.yieldPctOfNormal) + '% of a normal crop. ' + OATS_MONEY;
    if (FS.absMoneyOk && !FS.absMoneyOk()) return 'Result: ' + farmLine(r);   // that line already lists every field's yield
    return 'Result: ' + farmLine(r) + ' ' + f.name + ': ' + Math.round(x.yieldPctOfNormal) + '% of a normal crop.';
  }
  // what-ifs that stay switched on after a run (weather, prices, planting date), so stacked changes are never invisible
  function activeChanges() {
    var init = D.initialControls; if (!init) return [];
    var a = leaves(S.get().controls, '', {}), b = leaves(init, '', {}), out = [];
    Object.keys(a).forEach(function (p) {
      if (!/^(weather\.(scenario|tempShift|rainChange|rainSwing|hotDays|events)|other\.(priceChange|nitrogenChange)|crops\.(plantShiftDays|soilWaterPct))$/.test(p)) return;
      if (String(a[p]) !== String(b[p] == null ? (p === 'weather.events' ? '[]' : 0) : b[p])) out.push(describeValue(p, a[p]));
    });
    return out;
  }
  function stackNote() { var act = activeChanges(); return act.length >= 2 ? ' Still in effect together: ' + act.join(', ') + '. Say "reset" to go back to a typical season (2011 weather).' : ''; }
  function stepAnalysis() {
    var cur = S.get().current, n = cur && cur.summary ? recsFrom(cur.summary).length : 0;
    step(n ? 'Analysis compared the plans and found ' + plural(n, 'option', 'options') + ' worth a look' : 'Analysis compared the plans and found nothing that beats your current ones');
  }
  function execute(actions) {
    var ran = null, prioBefore = (S.get().controls.other || {}).priority;
    if (actions.some(function (a) { return a.type === 'undo'; })) {
      var snap = undoStack.pop(), cur = leaves(S.get().controls, '', {}), tgt = leaves(snap, '', {});
      Object.keys(tgt).forEach(function (p) {
        if (cur[p] === tgt[p]) return;
        A.setControl(p, p === 'weather.events' ? JSON.parse(tgt[p]) : tgt[p], 'chat');
      });
      step('Undo put back the earlier settings'); A.runSimulation('chat', 'Undo'); step('Crop Model replayed ' + seasonCount() + ' NASA POWER seasons'); stepAnalysis();
      A.addChat({ role: 'assistant', text: resultLine() }); attachTrace();
      return;
    }
    if (actions.some(function (a) { return a.type === 'setControl'; })) undoStack.push(S.snapshot ? S.snapshot() : clone(S.get().controls));
    actions.forEach(function (a) {
      if (a.type === 'setControl') A.setControl(a.path, Array.isArray(a.value) ? clone(a.value) : a.value, 'chat');
      else if (a.type === 'selectField') A.selectField(a.id, 'chat');
      else if (a.type === 'run') { A.runSimulation('chat', a.label); ran = a.label; }
    });
    if (ran) {
      step('Crop Model replayed ' + seasonCount() + ' NASA POWER seasons'); stepAnalysis();
      A.addChat({ role: 'assistant', text: resultLine() + stackNote() }); attachTrace();
      var pNow = (S.get().controls.other || {}).priority; if (pNow !== lastRecPriority && pNow !== prioBefore || (pNow !== lastRecPriority && actions.some(function (a) { return a.path === 'other.priority'; }))) FS.chat.postRecs(false);
    }
  }
  function send(text) {
    text = String(text || '').trim(); if (!text) return;
    A.addChat({ role: 'user', text: text });
    if (FS.i18n && FS.i18n.active()) { FS.i18n.toEnglish(text).then(function (en) { answer(en, 'Translator read your message in English'); }); return; }   // the farmer's own language: read it in English
    answer(text);
  }
  function noAiText(out) {
    var keep = out && out.reply && !/^Sorry, I did not catch|^Sorry, I could not read|^Type a change to the weather/.test(out.reply) ? out.reply + '\n\n' : '';
    var f1 = D.farm.fields[0].name;
    return keep + 'I cannot answer open questions like that right now, because the AI helper is switched off. Without it I can still test what-ifs on your fields (weather, crops, prices), compare plans and explain your results. For example:\n\u2022 "What if 2012 happens again?"\n\u2022 "What if I put rye on ' + f1 + '?"\n\u2022 "Which field is most at risk?"';
  }
  function answer(text, first) {
    var out; beginTurn(first);
    try { out = FS.chat.interpret(text, S.get()); } catch (e) { console.error(e); out = { reply: 'Sorry, I could not read that.\n' + examples(), actions: [], ai: true }; }
    var acts = out.actions || [], nSet = acts.filter(function (a) { return a.type === 'setControl'; }).length;
    if (out.ai && aiAvailable()) { step('Chat Rules found no match for your question'); return askAI(text, out); }
    if (out.ai && !nSet) { step('Chat Rules could not turn your question into a change'); step('The AI helper is off, so built-in help answered'); out = { reply: noAiText(out), actions: [] }; }
    else if (nSet) step('Chat Rules read your question and found ' + plural(nSet, 'change', 'changes'));
    else if (out.items) { step('Chat Rules read your question'); step('Analysis lined up the options'); }
    else if (acts.some(function (a) { return a.type === 'selectField'; })) step('Chat Rules read your question and picked a field to show');
    else step('Chat Rules read your question and answered from your latest results');
    if (out.reply || out.items) A.addChat({ role: 'assistant', text: out.reply, items: out.items, kind: out.kind, foot: out.foot, actions: out.actions });
    execute(acts);
    attachTrace();
  }

  // ---------- AI helper (server /api/chat, Google Gemini with thinking) ----------
  // Used when the rules above do not understand a message. The reply is plain text; any setting changes it asks for are
  // checked here against the same ranges as the control boxes before they are applied and the simulation re-runs.
  var aiDown = false;
  function aiAvailable() { return !aiDown && /^https?:$/.test(location.protocol); }
  function num(v, lo, hi, step) { var n = Number(v); if (!isFinite(n) || n < lo || n > hi) return null; if (step) n = Math.round(n / step) * step; return Math.min(hi, Math.max(lo, +n.toFixed(2))); }   // out of range: skipped, never stretched to fit
  function checkedValue(path, raw) {
    var v = String(raw).trim(), m;
    switch (path) {
      case 'weather.scenario':
        if ((D.weatherScenarios || []).some(function (x) { return x.id === v; })) return v;
        m = /^y(\d{4})$/.exec(v); return m && climYears().indexOf(+m[1]) >= 0 ? v : null;
      case 'weather.tempShift': return num(v, -2, 4, 0.5);
      case 'weather.rainChange': return num(v, -50, 50, 5);
      case 'weather.rainSwing': return num(v, 0, 100, 10);
      case 'weather.hotDays': return num(v, 0, 6, 1);
      case 'weather.events':
        var ev; try { ev = JSON.parse(v); } catch (e) { return null; }
        if (!Array.isArray(ev)) return null;
        return ev.filter(function (e) { return e && /^(dryspell|wetspell|heatwave)$/.test(e.type) && +e.month >= 1 && +e.month <= 12; }).slice(0, 3)
          .map(function (e) { return { type: e.type, month: Math.round(+e.month), severity: e.severity === 'severe' ? 'severe' : 'moderate' }; });
      case 'crops.plantShiftDays': return num(v, -21, 21, 7);
      case 'crops.irrigation': return /^(none|july|july-aug|jun-aug)$/.test(v) ? v : null;
      case 'crops.soilWaterPct': return num(v, -60, 40, 5);
      case 'other.priceChange': return num(v, -40, 40, 5);
      case 'other.nitrogenChange': return num(v, -30, 80, 5);
      case 'other.contracted': return num(v, 0, 100, 5);
      case 'other.costShare': return v === 'true' ? true : v === 'false' ? false : null;
      case 'other.priority': return /^(balanced|profit|risk|cover)$/.test(v) ? v : null;
    }
    m = /^crops\.plans\.(\w+)$/.exec(path);
    if (m) { var f = fieldById(m[1]), ok = f && (D.planOptions[f.lastCrop] || []); return ok && ok.indexOf(v) >= 0 ? v : null; }
    m = /^crops\.trialAcres\.(\w+)$/.exec(path);
    if (m) { var f2 = fieldById(m[1]); return f2 ? num(v, 0, f2.acres, 1) : null; }
    return null;
  }
  function aiContext() {
    var st = S.get(), r = st.current, sm = r && r.summary, farm = D.farm, yrs = climYears();
    var fields = farm.fields.map(function (f) {
      var x = sm && sm.fields && sm.fields[f.id], so = f.soil || {};
      return { id: f.id, name: f.name, acres: f.acres, lastCrop: f.lastCrop, plannedNow: st.controls.crops.plans[f.id], currentPlan: D.initialControls.crops.plans[f.id],
        allowedPlans: (D.planOptions[f.lastCrop] || []).map(function (p) { return { id: p, label: plain((D.plans[p] || {}).label || p) }; }),
        soil: { name: so.name, drainage: so.drainage, waterHoldingMmPerM: so.awcMmPerM, slopePct: so.slopePct, tiled: !!so.tiled },
        lastRun: x ? { yieldPctOfNormal: Math.round(x.yieldPctOfNormal), note: x.note || null, moneyNote: x.moneyNote || null } : null };
    });
    var lastRun = null;
    try { if (r) lastRun = { weather: r.inputs && r.inputs.weather, farmSummary: farmLine(r), recommendationNote: (sm && sm.recommendationNote) || null }; } catch (e) { /* leave it out */ }
    return {
      farm: { name: farm.name, place: farm.place, lat: farm.lat, lon: farm.lon }, fields: fields, selectedField: st.selectedField,
      settingsNow: st.controls, seasonsAvailable: yrs.length ? yrs[0] + '-' + yrs[yrs.length - 1] : '1982-2025',
      namedWeather: (D.weatherScenarios || []).map(function (x) { return { id: x.id, label: x.label }; }),
      lastRun: lastRun, farmerNotes: FS.chat.advice ? FS.chat.advice.lines : [],
      economics: { pricePerBu: (D.economics || {}).price, normalYieldBuPerAcre: (D.economics || {}).normalYield, fullCostPerAcreIncludingLand: (D.economics || {}).costPerAcre,
        nitrogen: (D.economics || {}).nitrogen, coverCropCostShare: (D.economics || {}).costShareRye, sources: (D.economics || {}).sources }
    };
  }
  function askAI(text, ruleOut) {
    var wait = document.createElement('div'); wait.className = 'fs-msg assistant fs-thinking'; wait.innerHTML = '<p>Thinking it through…</p>';
    if (listEl) { listEl.appendChild(wait); listEl.scrollTop = listEl.scrollHeight; }
    var hist = S.get().chat.slice(-11, -1).map(function (m) { return { role: m.role, text: m.text || '' }; });
    var btn = document.getElementById('fs-chat-send'); if (btn) btn.disabled = true;
    function done() { if (wait.parentNode) wait.parentNode.removeChild(wait); if (btn) btn.disabled = false; }
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history: hist, context: aiContext() }) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; }); })
      .then(function (x) {
        done();
        if (!x.ok || !x.j.reply) {
          var off = x.status === 404 || x.status === 503;
          if (off) aiDown = true;   // no server route or no key: stay with the rules
          step(off ? 'Gemini Adviser is switched off, so built-in help answered' : 'Gemini Adviser could not answer this time');
          A.addChat({ role: 'assistant', text: off ? noAiText(ruleOut) : (ruleOut.reply && !/^Sorry, I did not catch/.test(ruleOut.reply) ? ruleOut.reply : 'The AI helper is busy right now, so I could not answer that.\n' + examples()) + (x.j.error ? '\n(' + x.j.error + ')' : '') });
          attachTrace();
          return;
        }
        var acts = [], skipped = 0;
        (x.j.changes || []).forEach(function (c) {
          var v = checkedValue(c.path, c.value);
          if (v === null || v === undefined) skipped++; else acts.push({ type: 'setControl', path: c.path, value: v });
        });
        var proposed = (x.j.changes || []).length;
        step(proposed ? 'Gemini Adviser proposed ' + plural(proposed, 'change', 'changes') : 'Gemini Adviser answered in words, with no setting change');
        if (proposed) step('Code Check kept ' + acts.length + (skipped ? ' and rejected ' + skipped + ' (out of range or not a setting)' : ''));
        A.addChat({ role: 'assistant', text: x.j.reply + (skipped ? '\n(' + skipped + ' of the changes could not be applied.)' : '') });
        if (!acts.length) attachTrace();
        if (acts.length) execute(acts.concat([{ type: 'run', label: 'Chat: ' + acts.map(function (a) { return describeValue(a.path, Array.isArray(a.value) ? JSON.stringify(a.value) : a.value); }).join(' · ') }]));
      })
      .catch(function (e) {
        console.error(e); done();
        step('Gemini Adviser could not be reached, so built-in help answered');
        A.addChat({ role: 'assistant', text: noAiText(ruleOut) }); attachTrace();
      });
  }

  function showOnMap(it) {
    var f = fieldById(it.fieldId);
    beginTurn('You pressed Show on the map for ' + f.name);
    A.addChat({ role: 'assistant', text: 'Showing ' + f.name + ': ' + planPlain(it.plan) + '.' });
    A.selectField(it.fieldId, 'chat');
    undoStack.push(clone(S.get().controls));
    A.setControl('crops.plans.' + it.fieldId, it.plan, 'chat');
    var tr = S.get().controls.crops.trialAcres; if (tr && tr[it.fieldId] === 0) A.setControl('crops.trialAcres.' + it.fieldId, f.acres, 'chat');
    A.runSimulation('chat', f.name + ' ' + planPlain(it.plan));
    step('Crop Model replayed ' + seasonCount() + ' NASA POWER seasons'); stepAnalysis();
    A.addChat({ role: 'assistant', text: resultLine(it.fieldId) }); attachTrace();
  }
  function onListClick(e) {
    var b = e.target.closest && e.target.closest('button[data-act]'); if (!b) return;
    if (b.getAttribute('data-act') === 'more') {
      var box = b.nextElementSibling, open = box.hidden;
      box.hidden = !open; b.textContent = open ? 'Less' : 'More'; b.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    var msg = b.closest('.fs-msg'), it = msg && msg._items && msg._items[+b.getAttribute('data-i')];
    if (it) showOnMap(it);
  }

  // A new farm was set up: forget the old conversation (it talked about other fields).
  FS.chat.reset = function () { undoStack = []; lastRecPriority = null; S.get().chat.length = 0; if (listEl) listEl.innerHTML = ''; };

  FS.chat.mount = function (el) {
    el.innerHTML = '<div class="fs-panel-head"><h2 class="fs-panel-title">Chat</h2><div class="fs-head-right"><button type="button" class="fs-expand" data-expand="Chat" aria-label="Expand Chat">' +
      '<svg class="ic-expand" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>' +
      '<svg class="ic-collapse" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/></svg></button></div></div>' +
      '<div class="fs-panel-body" id="fs-chat-list" aria-live="polite"></div>' +
      '<form class="fs-chat-form" id="fs-chat-form"><label for="fs-chat-input" style="position:absolute;left:-9999px">Type a what-if</label>' +
      '<textarea id="fs-chat-input" rows="1" placeholder="Type a what-if…"></textarea>' +
      '<button type="submit" id="fs-chat-send">Send</button></form>';
    listEl = el.querySelector('#fs-chat-list'); inputEl = el.querySelector('#fs-chat-input');
    S.get().chat.forEach(append);
    S.on('chat:message', append);
    S.on('controls:change', function (e) { if (!e || e.source !== 'chat') undoStack = []; });   // a manual change ends the undo history
    S.on('sim:done', function (r) {
      // the priority box in "Other conditions" re-ranks the options: post the new ranking
      if (r.source === 'priority') FS.chat.postRecs(false);
    });
    listEl.addEventListener('click', onListClick);
    el.querySelector('#fs-chat-form').addEventListener('submit', function (e) { e.preventDefault(); var v = inputEl.value; inputEl.value = ''; send(v); });
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.querySelector('#fs-chat-form').requestSubmit(); } });
  };
})();
