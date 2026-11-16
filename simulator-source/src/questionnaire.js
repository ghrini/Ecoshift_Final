/* The farm questionnaire (QUESTIONNAIRE.md): EcoShift' questions, one per screen, inside the simulator.
   FS.questionnaire.blank(), normalize(raw), derive(answers) are plain functions (no page needed).
   FS.questionnaire.create(host, hooks) draws the dialog; app.js owns opening, closing, saving and applying the answers. English only. */
(function () {
  'use strict';
  var FS = window.FS, Q = FS.questionnaire = {};
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------------------------------------------------------------- options (wording from EcoShift, adapted)
  var POS = [['north', 'North'], ['creek', 'Creek'], ['west', 'West'], ['south', 'South']];
  var TENURE = [['own', 'I own it'], ['rent', 'I rent it'], ['both', 'Some owned, some rented'], ['shared', 'Family or shared land'], ['unsure', 'Not sure']];
  var LEASE = [['short', '1 year or less'], ['mid', '2–5 years'], ['long', 'More than 5 years'], ['handshake', 'No written lease', 'Handshake deal'], ['na', "Doesn't apply", "I don't rent"]];
  var EXPERIENCE = [['new', 'This is my first season'], ['few', '1–3 years'], ['some', '4–10 years'], ['long', 'More than 10 years']];
  var PRACTICES = [['notill', 'No-till or less tilling'], ['covers', 'I already plant cover crops'], ['organic', 'Certified organic', 'No synthetic sprays or fertilizer'], ['transition', 'Moving to organic'],
    ['manure', 'I spread manure or compost'], ['fertilizer', 'I use bought fertilizer'], ['hand', 'Most work is done by hand'], ['none', 'None of these']];
  var LIVESTOCK = [['none', 'No animals'], ['cattle', 'Cattle'], ['smallrum', 'Sheep or goats'], ['pigs', 'Pigs'], ['poultry', 'Chickens or other poultry'], ['other', 'Other animals', 'Horses, donkeys, and so on']];
  var WATER = [['irrigated', 'Irrigated', 'I can water when I need to'], ['rainfed', 'Rain-fed', 'Only rainfall'], ['partial', 'Partly irrigated', 'Some acres, or only in some years'], ['unsure', 'Not sure']];
  var DRAINAGE = [['good', 'Drains well', 'Dry soon after rain'], ['sometimes', 'Wet for a few days after big rains'], ['poor', 'Often waterlogged'], ['unsure', 'Not sure']];
  var YESNO = [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']];
  var SLOPE = [['flat', 'Flat'], ['gentle', 'Gentle slope'], ['steep', 'Steep in places'], ['unsure', 'Not sure']];
  var LIMIT_GROUPS = [
    ['Water', [['water', 'Limited water', "Wells, allocation or rain I can't count on"], ['irrigation', 'No irrigation equipment'], ['flooding', 'Fields flood or stay wet', 'Poor drainage, standing water']]],
    ['Land and soil', [['slope', 'Steep or hilly land', 'Soil washes away easily'], ['poorsoil', 'Poor or worn-out soil', 'Low fertility, hard or packed down'], ['salty', 'Salty or alkaline soil'], ['smallfield', 'Small or oddly shaped fields', 'Hard to use big machines']]],
    ['Equipment', [['notractor', 'No tractor, or only small machines', 'Most work done by hand or with animals'], ['planter', 'No drill for small seeds', "Can't plant cover crops or small grains"], ['sprayer', 'No sprayer', "Can't spray to end a cover crop"],
      ['hay', 'No hay equipment', "Can't cut, rake or bale"], ['storage', 'No on-farm grain storage', 'Must sell at harvest'], ['fencing', 'No fencing for grazing']]],
    ['Money, time and people', [['credit', 'Hard to get credit or loans'], ['labor', 'Short on labor or time'], ['health', 'Health or age limits heavy work']]],
    ['Rules and access', [['insurance', 'Crop insurance or program rules', 'Limit when I can plant or end crops'], ['landlord', 'Landlord must approve changes'], ['seed', 'Hard to find seed nearby'], ['market', 'Far from buyers, or bad roads']]]
  ];
  var WONT = [['corn-corn', 'Corn after corn'], ['soy-soy', 'Soybeans after soybeans'], ['rye', 'Cereal rye cover crop'], ['oats', 'Oats']];
  var WONT_PLANS = { 'corn-corn': ['corn-corn'], 'soy-soy': ['soy-soy'], rye: ['rye-soy', 'rye-corn'], oats: ['oats-cover'] };
  var BUDGETS = [['none', 'No extra spending', 'Changes must cost nothing up front'], ['low', 'Under $50 per acre'], ['mid', '$50–150 per acre'], ['high', 'Over $150 per acre'], ['unsure', 'Not sure yet']];
  var COST_SHARE = [['yes', 'Yes'], ['maybe', 'Maybe', "If it isn't too much paperwork"], ['no', 'No'], ['unknown', "I didn't know that existed"]];
  var PRIORITIES = ['Profit', 'Saving water', 'Soil health', 'Low risk / steady income', 'Less erosion', 'Fewer pests and diseases', 'Less work and time', 'Handling extreme weather', 'Feed for my animals', 'Food for my family', 'Trying something new'];
  var PRIO_MAP = { 'Profit': 'profit', 'Low risk / steady income': 'risk', 'Handling extreme weather': 'risk', 'Soil health': 'cover', 'Less erosion': 'cover' };
  var PRIO_WORDS = { balanced: 'a balance of profit and risk', profit: 'profit', risk: 'lowest risk', cover: 'ground cover' };
  var TRIAL = [['patch', 'A small test patch'], ['field', 'One field'], ['half', 'About half the farm'], ['all', 'All of it'], ['notyet', "I'm not ready to change yet"]];
  var BUYERS = [['elevator', 'Grain elevator or co-op'], ['contract', 'Contract buyer', 'Seed, processor or specialty contract'], ['livestock', 'Livestock', "My own animals or a neighbor's"],
    ['direct', 'Direct sales', "Farmers' market, CSA, farm stand"], ['home', 'My family eats it', 'Home use or local trading'], ['nobuyer', 'No buyer yet', 'Still looking'], ['other', 'Other']];
  var STATES = { IA: 'Iowa', IL: 'Illinois', IN: 'Indiana', MN: 'Minnesota', NE: 'Nebraska', SD: 'South Dakota', OH: 'Ohio', WI: 'Wisconsin', MO: 'Missouri', KS: 'Kansas', ND: 'North Dakota', MI: 'Michigan', KY: 'Kentucky' };
  // the farm's own point (address search or the browser's location): { lat, lon, label, county, state }
  function normPoint(p) {
    if (!p || typeof p !== 'object') return null;
    var lat = Number(p.lat), lon = Number(p.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, label: text(p.label, 120), county: text(p.county, 60), state: text(p.state, 40) };
  }
  Q.normPoint = normPoint;
  Q.options = { TENURE: TENURE, LEASE: LEASE, EXPERIENCE: EXPERIENCE, PRACTICES: PRACTICES, LIVESTOCK: LIVESTOCK, WATER: WATER, DRAINAGE: DRAINAGE, YESNO: YESNO, SLOPE: SLOPE, LIMIT_GROUPS: LIMIT_GROUPS, WONT: WONT, BUDGETS: BUDGETS, COST_SHARE: COST_SHARE, PRIORITIES: PRIORITIES, TRIAL: TRIAL, BUYERS: BUYERS };
  function labelOf(list, v) { for (var i = 0; i < list.length; i++) if (list[i][0] === v) return list[i][1]; return v; }
  function vals(list) { return list.map(function (x) { return x[0]; }); }
  var LIMITS = []; LIMIT_GROUPS.forEach(function (g) { LIMITS = LIMITS.concat(g[1]); });

  // ---------------------------------------------------------------- answers
  var DEFAULT_FIELDS = null;
  Q.setDefaultFields = function (f) { DEFAULT_FIELDS = f.map(function (x) { return { id: x.id, acres: x.acres, lastCrop: x.lastCrop }; }); };
  function defaultFields() { return clone(DEFAULT_FIELDS || [{ id: 'north', acres: 80, lastCrop: 'corn' }, { id: 'creek', acres: 40, lastCrop: 'corn' }, { id: 'west', acres: 40, lastCrop: 'soybean' }, { id: 'south', acres: 120, lastCrop: 'soybean' }]); }
  Q.blank = function () {
    return { v: 2, example: false, name: '', site: 'story-ia', point: null, fit: null, fields: defaultFields(), tenure: '', lease: '', experience: '', practices: [], livestock: [], water: '', drainage: '', tile: '', slope: '', soilTest: '',
      limits: [], limitsNote: '', wont: [], contracted: null, budget: '', costShare: '', priorities: [], trial: '', worries: '', buyers: [], buyersNote: '', other: '' };
  };
  Q.example = function () { var a = Q.blank(); a.example = true; return a; };
  function sites() { return Array.isArray(FS.data.sites) && FS.data.sites.length ? FS.data.sites : [{ id: 'story-ia', name: 'Story County, Iowa', short: 'Story Co., IA', state: 'IA', validated: true }]; }
  function siteById(id) { return sites().filter(function (s) { return s.id === id; })[0] || null; }
  function pick(v, list) { return typeof v === 'string' && vals(list).indexOf(v) >= 0 ? v : ''; }
  function pickMany(v, list) { var ok = vals(list); return Array.isArray(v) ? v.filter(function (x, i) { return ok.indexOf(x) >= 0 && v.indexOf(x) === i; }) : []; }
  function text(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : ''; }

  // Anything stored or linked is checked here; returns answers or null when it is not a usable farm. Old saves (one panel) are converted.
  Q.normalize = function (raw) {
    try {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.example) return Q.example();
      var a = Q.blank();
      if (!siteById(raw.site) || !Array.isArray(raw.fields) || raw.fields.length !== 4) return null;
      var okF = POS.every(function (p) { var f = raw.fields.filter(function (x) { return x && x.id === p[0]; })[0]; return f && f.acres >= 10 && f.acres <= 640 && (f.lastCrop === 'corn' || f.lastCrop === 'soybean'); });
      if (!okF) return null;
      a.site = raw.site;
      a.point = normPoint(raw.point);
      a.fit = a.point && raw.fit && typeof raw.fit === 'object' && raw.fit.local && typeof raw.fit.key === 'string' ? raw.fit : null;   // checked again against the answers in app.js
      a.fields = POS.map(function (p) { var f = raw.fields.filter(function (x) { return x.id === p[0]; })[0]; return { id: p[0], acres: Math.round(f.acres), lastCrop: f.lastCrop }; });
      if (raw.v !== 2) {   // the one-panel save: priority, costShare, irrigate
        var lp = { profit: ['Profit'], risk: ['Low risk / steady income'], cover: ['Soil health'] }[raw.priority];
        a.priorities = lp || []; a.costShare = raw.costShare ? 'yes' : ''; a.water = raw.irrigate ? 'irrigated' : '';
        return a;
      }
      a.name = text(raw.name, 40); a.tenure = pick(raw.tenure, TENURE); a.lease = pick(raw.lease, LEASE); a.experience = pick(raw.experience, EXPERIENCE);
      a.practices = pickMany(raw.practices, PRACTICES); a.livestock = pickMany(raw.livestock, LIVESTOCK); a.water = pick(raw.water, WATER);
      a.drainage = pick(raw.drainage, DRAINAGE); a.tile = pick(raw.tile, YESNO); a.slope = pick(raw.slope, SLOPE); a.soilTest = pick(raw.soilTest, YESNO);
      a.limits = pickMany(raw.limits, LIMITS); a.limitsNote = text(raw.limitsNote, 300); a.wont = pickMany(raw.wont, WONT);
      var c = Number(raw.contracted); a.contracted = raw.contracted != null && raw.contracted !== '' && isFinite(c) ? Math.max(0, Math.min(100, Math.round(c / 5) * 5)) : null;
      a.budget = pick(raw.budget, BUDGETS); a.costShare = pick(raw.costShare, COST_SHARE);
      a.priorities = (Array.isArray(raw.priorities) ? raw.priorities : []).filter(function (x, i, l) { return PRIORITIES.indexOf(x) >= 0 && l.indexOf(x) === i; }).slice(0, 3);
      a.trial = pick(raw.trial, TRIAL); a.worries = text(raw.worries, 600); a.buyers = pickMany(raw.buyers, BUYERS); a.buyersNote = text(raw.buyersNote, 300); a.other = text(raw.other, 600);
      return a;
    } catch (e) { return null; }
  };

  // ---------------------------------------------------------------- what the answers do
  function has(a, k, v) { return Array.isArray(a[k]) && a[k].indexOf(v) >= 0; }
  Q.derive = function (a) {
    var d = { site: a.site, fields: [], canIrrigate: false, irrigation: 'none', exclude: [], contracted: a.contracted, costShare: a.costShare === 'yes', priority: 'balanced', trial: a.trial || '',
      greeting: a.name ? 'Hi ' + a.name + '.' : '', lines: [], notes: [], card: { rye: { work: [], risks: [] }, oats: { work: [], risks: [] }, any: { work: [], risks: [] } }, sim: {}, advice: {} };
    var covers = has(a, 'practices', 'covers'), sim = d.sim, adv = d.advice;
    d.fields = a.fields.map(function (f) { var o = { id: f.id, acres: f.acres, lastCrop: f.lastCrop }; if (covers) o.currentPlan = f.lastCrop === 'corn' ? 'rye-soy' : 'rye-corn'; return o; });
    if (covers) sim['practices:covers'] = 1;
    // water
    var noIrrig = has(a, 'limits', 'irrigation');
    if (a.water === 'irrigated' && !noIrrig) { d.canIrrigate = true; d.irrigation = 'july-aug'; }
    else if (a.water === 'partial' && !noIrrig) d.canIrrigate = true;
    if (a.water) sim['water:' + a.water] = 1;
    if (noIrrig) sim['limits:irrigation'] = 1;
    // crops you won't grow
    a.wont.forEach(function (w) { (WONT_PLANS[w] || []).forEach(function (p) { if (d.exclude.indexOf(p) < 0) d.exclude.push(p); }); sim['wont:' + w] = 1; });
    if (a.contracted != null) sim.contracted = 1;
    if (a.costShare === 'yes') sim['costShare:yes'] = 1;
    // priorities
    var first = a.priorities[0];
    if (first) { d.priority = PRIO_MAP[first] || 'balanced'; sim['priorities:' + first] = 1; }
    if (a.trial === 'patch' || a.trial === 'field' || a.trial === 'half' || a.trial === 'all') sim['trial:' + a.trial] = 1;
    if (a.site) sim.site = 1; sim.fields = 1;
    if (a.name) adv.name = 1;

    // advice notes, most useful first; the opening message shows at most 4, every note also goes on the matching card
    var ryeOut = d.exclude.indexOf('rye-soy') >= 0 && !covers, oatsOut = d.exclude.indexOf('oats-cover') >= 0;
    function note(text, srcs, card, open) {
      d.notes.push({ text: text, src: srcs, group: card && card[0], line: card && card[1], open: open !== false });
      srcs.forEach(function (s) { adv[s] = 1; });
    }
    if (first) {
      var rest = a.priorities.slice(1), pr = PRIO_MAP[first] ? 'Ranked by ' + PRIO_WORDS[d.priority] + ', because you put ' + first + ' first.' : 'You put ' + first + ' first. The simulator has no ranking for that, so options are ranked by ' + PRIO_WORDS.balanced + '.';
      note(pr + (rest.length ? ' Next: ' + rest.join(', ') + '.' : ''), a.priorities.slice(1).map(function (p) { return 'priorities:' + p; }), null);
    }
    if (a.trial === 'half' || a.trial === 'all') note('You would start with ' + (a.trial === 'all' ? 'all of it' : 'about half the farm') + ': the trial covers the whole field, on every field you choose.', ['trial:' + a.trial], null);
    if (a.trial === 'notyet') note('You are not ready to change yet: you can still compare options without changing anything.', ['trial:notyet'], null);
    if (!ryeOut && (has(a, 'limits', 'sprayer') || has(a, 'practices', 'organic') || has(a, 'practices', 'transition'))) {
      var s1 = []; if (has(a, 'limits', 'sprayer')) s1.push('limits:sprayer'); if (has(a, 'practices', 'organic')) s1.push('practices:organic'); if (has(a, 'practices', 'transition')) s1.push('practices:transition');
      note('End the rye by roller-crimping, mowing or tillage instead of a herbicide.', s1, ['rye', 'work']);
    }
    if ((a.lease === 'short' || a.lease === 'handshake') && a.tenure !== 'own') note("You rent on a short lease: look at this season's result more than the 44-season average. Cover crops pay off slowly.", ['tenure:' + a.tenure, 'lease:' + a.lease], ['any', 'risks']);
    if (has(a, 'limits', 'landlord')) note('Talk to your landlord before changing a field.', ['limits:landlord'], ['any', 'risks']);
    if (a.experience === 'new' || a.experience === 'few') note('You are new to this land, so start small.', ['experience:' + a.experience], ['any', 'risks']);
    if (!ryeOut && (a.budget === 'none' || a.budget === 'low')) note('Rye costs about $37 an acre (less $30 with first-time cost-share).', ['budget:' + a.budget], ['rye', 'risks']);
    if (!ryeOut && (has(a, 'limits', 'labor') || has(a, 'limits', 'health'))) note('Rye adds two passes: seeding it and ending it.', ['limits:labor', 'limits:health'].filter(function (s) { return has(a, 'limits', s.split(':')[1]); }), ['rye', 'work']);
    if (a.drainage === 'poor' && a.tile !== 'yes') note('Wet springs can delay planting here. The model uses the USDA drainage class for each field.', ['drainage:poor', 'tile:' + a.tile], ['any', 'risks']);
    if (has(a, 'limits', 'storage')) note('With no grain storage you sell at harvest prices. Contracts help.', ['limits:storage'], ['any', 'risks']);
    if (!oatsOut && (has(a, 'buyers', 'nobuyer') || has(a, 'buyers', 'direct'))) note('Oats need a local buyer.', ['buyers:nobuyer', 'buyers:direct'].filter(function (s) { return has(a, 'buyers', s.split(':')[1]); }), ['oats', 'risks']);
    if (a.soilTest === 'no') note('A soil test (about $15–30 a sample) is a cheap first step before changing fertility.', ['soilTest:no'], ['any', 'risks']);
    var animals = a.livestock.filter(function (x) { return x !== 'none'; });
    if (!ryeOut && (animals.length || has({ p: a.priorities }, 'p', 'Feed for my animals'))) note('Rye can be grazed in spring. That value is not counted here.', animals.map(function (x) { return 'livestock:' + x; }).concat(has({ p: a.priorities }, 'p', 'Feed for my animals') ? ['priorities:Feed for my animals'] : []), ['rye', 'risks']);
    if (!ryeOut && has(a, 'practices', 'notill')) note('You already farm no-till, which fits rye. Tillage is not modelled.', ['practices:notill'], ['rye', 'work']);
    if (!ryeOut && a.costShare === 'maybe') note('You said maybe to cost-share: it pays $30 an acre the first year.', ['costShare:maybe'], ['rye', 'risks']);
    if (!ryeOut && has(a, 'limits', 'planter')) note('No drill: rye can be broadcast (spread on the surface) instead.', ['limits:planter'], ['rye', 'work'], false);
    d.notes.forEach(function (n) { if (n.group) d.card[n.group][n.line].push(n.text); if (n.open) d.lines.push(n.text); });
    d.lines = d.lines.slice(0, 4);
    return d;
  };

  // ---------------------------------------------------------------- review text
  function soilLine(siteId, fid) {
    var s = siteById(siteId), x = s && s.soils && s.soils[fid]; if (!x || !x.name) return '';
    return 'USDA soil survey: ' + x.name.split(',')[0] + (x.drainage ? ', ' + String(x.drainage).toLowerCase() : '');
  }
  Q.soilLine = soilLine;
  function fieldName(f) { return labelOf(POS, f.id) + ' ' + f.acres; }
  function countyName(id) { var s = siteById(id); return s ? s.name : id; }
  Q.review = function (a) {
    var d = Q.derive(a), rows = [], PLAIN = { none: 1, unsure: 1, na: 1 };
    function st(key, val) { var k = key + ':' + val; return d.sim[k] ? 'sim' : d.advice[k] ? 'advice' : PLAIN[val] ? 'sim' : 'noted'; }
    function row(step, label, value, status, adv, noted) { rows.push({ step: step, label: label, value: value || '', status: value ? status : '', adv: adv || '', noted: noted || '' }); }
    function single(step, label, key, list) { var v = a[key]; row(step, label, v ? labelOf(list, v) : '', v ? st(key, v) : ''); }
    function many(step, label, key, list) {
      var used = [], noted = [], adv = [];
      (a[key] || []).forEach(function (x) { var s = st(key, x), t = labelOf(list, x); (s === 'sim' ? used : s === 'advice' ? adv : noted).push(t); });
      row(step, label, used.join(', '), 'sim', adv.join(', '), noted.join(', '));
    }
    row('name', 'Name', a.name, 'advice');
    row('location', 'Farm', a.point ? (a.point.label || 'Your location') + ' (nearest data: ' + countyName(a.site) + ')' : countyName(a.site), 'sim');
    row('fields', 'Fields', a.fields.map(function (f) { return fieldName(f) + ' acres, ' + (f.lastCrop === 'corn' ? 'corn' : 'soybeans') + ' last year'; }).join('; '), 'sim');
    single('you', 'Own or rent', 'tenure', TENURE); single('you', 'Lease', 'lease', LEASE); single('you', 'Years on this land', 'experience', EXPERIENCE);
    many('you', 'Already doing', 'practices', PRACTICES); many('you', 'Animals', 'livestock', LIVESTOCK);
    single('water', 'Water', 'water', WATER);
    single('land', 'Drainage', 'drainage', DRAINAGE); single('land', 'Tile drained', 'tile', YESNO); single('land', 'Slope', 'slope', SLOPE); single('land', 'Soil test in 3 years', 'soilTest', YESNO);
    many('limits', 'Limits', 'limits', LIMITS); row('limits', 'Limits, in your words', a.limitsNote, 'noted');
    many('crops', "Won't grow", 'wont', WONT);
    row('contracts', 'Already contracted', a.contracted != null ? a.contracted + '%' : '', 'sim');
    single('budget', 'Budget to try something new', 'budget', BUDGETS); single('budget', 'Would use cost-share', 'costShare', COST_SHARE);
    row('priorities', 'What matters most', a.priorities.slice(0, 1).map(function (p) { return '1. ' + p; }).join(''), 'sim', a.priorities.slice(1).map(function (p, i) { return (i + 2) + '. ' + p; }).join('  '));
    single('priorities', 'Starting size', 'trial', TRIAL); row('priorities', 'Worries', a.worries, 'noted');
    many('buyers', 'Buyers', 'buyers', BUYERS); row('buyers', 'Buyer details', a.buyersNote, 'noted');
    row('other', 'Anything else', a.other, 'noted');
    return rows;
  };

  // ---------------------------------------------------------------- the dialog
  function tiles(name, list, type, sel, cls) {
    return '<div class="fs-q-tiles ' + (cls || '') + '">' + list.map(function (o) {
      var on = (Array.isArray(sel) ? sel.indexOf(o[0]) >= 0 : sel === o[0]);
      return '<label class="fs-q-tile"><input type="' + type + '" name="' + name + '" value="' + esc(o[0]) + '"' + (on ? ' checked' : '') + '><span class="fs-q-t">' + esc(o[1]) + '</span>' + (o[2] ? '<span class="fs-q-h">' + esc(o[2]) + '</span>' : '') + '</label>';
    }).join('') + '</div>';
  }
  function group(legend, inner) { return '<fieldset class="fs-q-group"><legend>' + esc(legend) + '</legend>' + inner + '</fieldset>'; }
  function checked(root, name) { return Array.prototype.map.call(root.querySelectorAll('input[name="' + name + '"]:checked'), function (i) { return i.value; }); }
  function one(root, name) { return checked(root, name)[0] || ''; }
  function val(root, id) { var e = root.querySelector('#' + id); return e ? e.value : ''; }
  function years() { var c = FS.data.climate && FS.data.climate.meta; return (c && c.years && c.years.length) || 44; }
  function dist(la1, lo1, la2, lo2) { var R = 6371, r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r, h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2); return 2 * R * Math.asin(Math.sqrt(h)); }
  Q.nearest = function (lat, lon) {
    var best = null; sites().forEach(function (s) { if (typeof s.lat !== 'number') return; var k = dist(lat, lon, s.lat, s.lon); if (!best || k < best.km) best = { site: s, km: k }; });
    return best;
  };

  var STEPS = [
    { id: 'welcome', title: "Let's get to know your farm", noSkip: true, next: 'Start',
      hint: function () { return STEPS.filter(function (q) { return !q.noSkip; }).length + ' quick questions. Most are optional. Then the simulator replays ' + years() + ' real seasons of NASA weather on your farm.'; },
      render: function () { return (FS.i18n && /^https?:$/.test(location.protocol) ? '<div class="fs-q-langrow">' + FS.i18n.selectHTML('fs-q-lang') + '<span class="fs-q-langhint" translate="no">Choose your language · Elige tu idioma · Escolha seu idioma · Choisissez votre langue</span></div>' : '') + '<p class="fs-q-plain">Your answers are saved in this browser. To fit the data to your farm, its location is sent to NASA POWER, USDA (soils and yields), ISRIC SoilGrids, the FCC and US Census lookups and the Open-Meteo forecast. Addresses you type go to the Photon address search (OpenStreetMap). If the server has an AI key, your land answers go to Google Gemini.</p>'; } },
    { id: 'name', short: 'Name', title: 'What should we call you?', hint: 'Optional. Just used to say hello in the chat.',
      render: function (a) { return '<label class="fs-q-label" for="fs-q-name">Name or farm name</label><input type="text" id="fs-q-name" class="fs-q-text" maxlength="40" autocomplete="name" value="' + esc(a.name) + '">'; },
      collect: function (a, r) { a.name = text(val(r, 'fs-q-name'), 40); } },
    { id: 'location', title: 'Where is your farm?', hint: 'Use your precise location, or start typing your address (anywhere in the world) and pick it from the list.',
      render: function (a) {
        var p = a.point;
        return '<div class="fs-q-geo">' +
          '<button type="button" class="fs-q-locbtn" id="fs-q-locate"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>Use my precise location</button>' +
          '<p class="fs-q-or" aria-hidden="true"><span>or</span></p>' +
          '<label class="fs-q-label" for="fs-q-addr">Enter your farm address</label>' +
          '<div class="fs-q-combo"><input type="text" id="fs-q-addr" class="fs-q-text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fs-q-hits" autocomplete="off" spellcheck="false" placeholder="Start typing, e.g. 1200 County Rd E, Boone, IA" value="' + esc(p ? p.label : '') + '">' +
          '<ul class="fs-q-hits" id="fs-q-hits" role="listbox" aria-label="Matching addresses" hidden></ul></div>' +
          '<input type="hidden" id="fs-q-point" value="' + esc(p ? JSON.stringify(p) : '') + '">' +
          '<input type="hidden" id="fs-q-site" value="' + esc(a.site || '') + '">' +
          '<p id="fs-q-geo" class="fs-q-status" role="status" aria-live="polite"></p></div>';
      },
      collect: function (a, r) {
        var v = val(r, 'fs-q-site'); if (v && siteById(v)) a.site = v;
        var raw = val(r, 'fs-q-point'), p = null; try { p = raw ? normPoint(JSON.parse(raw)) : null; } catch (e) { p = null; }
        if (JSON.stringify(p) !== JSON.stringify(a.point)) a.fit = null;
        a.point = p;
      },
      mount: function (r) {
        var out = r.querySelector('#fs-q-geo'), list = r.querySelector('#fs-q-hits'), addr = r.querySelector('#fs-q-addr'), hidden = r.querySelector('#fs-q-point'), siteIn = r.querySelector('#fs-q-site'), loc = r.querySelector('#fs-q-locate');
        var hits = [], active = -1, timer = null, seqN = 0, chosen = addr.value;
        function say(t) { out.textContent = t; }
        function us(p) { return (p.countrycode || '').toUpperCase() === 'US'; }
        function county(p) { return String(p.county || '').replace(/\s+County$/i, ''); }
        function place(p) {
          var street = p.street ? (p.housenumber ? p.housenumber + ' ' : '') + p.street : null, town = p.city || p.town || p.village || p.district;
          return [p.name && p.name !== p.street ? p.name : null, street, p.postcode && street ? (town ? town + ' ' + p.postcode : p.postcode) : town, p.county && !town ? p.county : null, p.state, us(p) ? null : p.country].filter(function (x, i, l) { return x && l.indexOf(x) === i; }).join(', ');
        }
        function toHit(f) { var p = f.properties || {}; return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: place(p), county: county(p), state: p.state || '', us: us(p) }; }
        function setPoint(pt) {
          pt = normPoint(pt); if (!pt) return;
          hidden.value = JSON.stringify(pt);
          var n = Q.nearest(pt.lat, pt.lon);
          if (n) siteIn.value = n.site.id;
          var km = n ? Math.round(n.km) : null;
          say('✓ ' + (pt.label || pt.lat + ', ' + pt.lon) + (n ? '. Starting from ' + n.site.name + ' (' + km.toLocaleString('en-US') + ' km away), fitted to your exact spot.' : '') +
            (km != null && km > 400 ? ' That is far: the weather and soils are fitted to your spot, but the crop model and yields come from the US Corn Belt, so read the results as a rough guide.' : ''));
        }
        function close() { list.hidden = true; list.innerHTML = ''; addr.setAttribute('aria-expanded', 'false'); addr.removeAttribute('aria-activedescendant'); active = -1; }
        function highlight(i) {
          active = i;
          Array.prototype.forEach.call(list.children, function (li, k) { li.classList.toggle('is-active', k === i); li.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
          if (i >= 0 && list.children[i]) { addr.setAttribute('aria-activedescendant', list.children[i].id); list.children[i].scrollIntoView({ block: 'nearest' }); } else addr.removeAttribute('aria-activedescendant');
        }
        function pick(i) { var h = hits[i]; if (!h) return; addr.value = h.label; chosen = h.label; close(); setPoint(h); }
        function show() {
          if (!hits.length) { close(); return; }
          list.innerHTML = hits.map(function (h, i) {
            var parts = h.label.split(', ');
            return '<li role="option" id="fs-q-hit-' + i + '" class="fs-q-hit" aria-selected="false" data-i="' + i + '"><span class="fs-q-hit1">' + esc(parts[0]) + (h.exact ? ' <span class="fs-q-exact">exact address</span>' : '') + '</span><span class="fs-q-hit2">' + esc(parts.slice(1).join(', ')) + '</span></li>';
          }).join('');
          list.hidden = false; addr.setAttribute('aria-expanded', 'true'); active = -1;
          try { list.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
        }
        // a street address with a house number: the US Census geocoder (through the EcoShift server) finds the exact house
        var census = [], photon = [];
        function merge(my) {
          if (my !== seqN) return;
          var seen = {}, all = census.concat(photon)
            .filter(function (h) { var k = h.label.toLowerCase(); if (!h.label || seen[k]) return false; seen[k] = 1; return true; }).slice(0, 6);
          hits = all; show();
          if (!all.length) say('No match yet. Keep typing, or add the town and state.'); else if (out.textContent.indexOf('No match') === 0) say('');
        }
        function searchCensus(q, my) {
          census = [];
          if (!/^\d+[a-z]?\s+\S+\s+\S+/i.test(q) || !/^https?:$/.test(location.protocol)) return;
          fetch(location.origin + '/api/geocode?q=' + encodeURIComponent(q)).then(function (res) { return res.ok ? res.json() : { hits: [] }; }).then(function (j) {
            if (my !== seqN) return;
            census = (j.hits || []).map(function (h) { return { lat: h.lat, lon: h.lon, label: h.label, county: h.county || '', state: h.state || '', us: true, exact: true }; });
            if (census.length) merge(my);
          }).catch(function () { /* Photon alone still works */ });
        }
        function search() {
          var q = addr.value.trim(), my = ++seqN;
          if (q.length < 3) { hits = []; close(); return; }
          searchCensus(q, my);
          fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=8&lang=en')
            .then(function (res) { return res.json(); })
            .then(function (j) {
              if (my !== seqN) return;   // a newer keystroke already asked
              photon = (j.features || []).map(toHit); merge(my);
            })
            .catch(function () { if (my === seqN) say('Address search is not answering right now. Use your precise location instead.'); });
        }
        addr.addEventListener('input', function () {
          if (addr.value !== chosen && hidden.value) { hidden.value = ''; say(''); }   // typing again clears the old pick
          clearTimeout(timer); timer = setTimeout(search, 220);
        });
        addr.addEventListener('keydown', function (e) {
          var open = !list.hidden && hits.length;
          if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight((active + 1) % hits.length); }
          else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(active <= 0 ? hits.length - 1 : active - 1); }
          else if (e.key === 'Enter') { e.preventDefault(); if (open) pick(active >= 0 ? active : 0); }
          else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); }
        });
        addr.addEventListener('focus', function () { if (hits.length && !hidden.value) show(); });
        addr.addEventListener('blur', function () { setTimeout(close, 150); });
        list.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep focus in the field while clicking a suggestion
        list.addEventListener('click', function (e) { var li = e.target.closest('[data-i]'); if (li) pick(+li.getAttribute('data-i')); });
        list.addEventListener('mousemove', function (e) { var li = e.target.closest('[data-i]'); if (li && +li.getAttribute('data-i') !== active) highlight(+li.getAttribute('data-i')); });
        if (hidden.value) { try { setPoint(JSON.parse(hidden.value)); } catch (e) { /* ignore */ } }
        loc.addEventListener('click', function () {
          if (!navigator.geolocation) { say('This browser cannot share your location. Type your address instead.'); return; }
          say('Finding your location…'); loc.disabled = true;
          try {
            navigator.geolocation.getCurrentPosition(function (pos) {
              loc.disabled = false;
              var lat = pos.coords.latitude, lon = pos.coords.longitude, pt = { lat: lat, lon: lon, label: 'Your location' };
              addr.value = ''; chosen = ''; close(); setPoint(pt);
              // a readable name, county and state (the reverse lookup is optional)
              fetch('https://photon.komoot.io/reverse?lat=' + lat + '&lon=' + lon + '&lang=en').then(function (res) { return res.json(); }).then(function (j) {
                var p = j.features && j.features[0] && j.features[0].properties; if (!p) return;
                pt.label = 'Near ' + [p.city || p.town || p.village || p.name, p.state, us(p) ? null : p.country].filter(Boolean).join(', '); pt.county = county(p); pt.state = p.state || '';
                addr.value = pt.label; chosen = pt.label; setPoint(pt);
              }).catch(function () { /* the point alone still works */ });
            }, function (err) {
              loc.disabled = false;
              say(err && err.code === 1 ? 'Location is blocked in this browser. Type your address instead.' : 'We could not find your location. Type your address instead.');
            }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
          } catch (e) { loc.disabled = false; say('We could not get your location. Type your address instead.'); }
        });
      } },
    { id: 'fields', title: 'Your four fields', hint: 'Acres (10 to 640) and last year\'s crop for each.',
      render: function (a) {
        return a.fields.map(function (f) {
          var n = labelOf(POS, f.id);
          return '<div class="fs-q-field" role="group" aria-label="' + n + ' field"><span class="fs-q-pos">' + n + '</span>' +
            '<label class="fs-sr" for="fs-q-acres-' + f.id + '">' + n + ' field, acres</label><input type="number" class="fs-q-num" id="fs-q-acres-' + f.id + '" min="10" max="640" step="1" inputmode="numeric" value="' + f.acres + '"><span class="fs-q-unit" aria-hidden="true">acres</span>' +
            '<label class="fs-sr" for="fs-q-crop-' + f.id + '">' + n + " field, last year's crop</label><select class=\"fs-select fs-q-crop\" id=\"fs-q-crop-" + f.id + '"><option value="corn"' + (f.lastCrop === 'corn' ? ' selected' : '') + '>Corn last year</option><option value="soybean"' + (f.lastCrop === 'soybean' ? ' selected' : '') + '>Soybeans last year</option></select></div>';
        }).join('');
      },
      collect: function (a, r) { a.fields.forEach(function (f) { var i = r.querySelector('#fs-q-acres-' + f.id); if (!i) return; f.raw = i.value; f.lastCrop = val(r, 'fs-q-crop-' + f.id) === 'soybean' ? 'soybean' : 'corn'; }); },
      validate: function (a, r) {
        for (var i = 0; i < a.fields.length; i++) {
          var f = a.fields[i], v = Number(f.raw);
          if (f.raw === undefined) continue;
          if (f.raw === '' || !isFinite(v) || v < 10 || v > 640 || Math.round(v) !== v) return { msg: 'Acres for the ' + labelOf(POS, f.id) + ' field must be a whole number from 10 to 640.', el: r.querySelector('#fs-q-acres-' + f.id) };
        }
        a.fields.forEach(function (f) { if (f.raw !== undefined) { f.acres = Math.round(Number(f.raw)); delete f.raw; } });
        return null;
      } },
    { id: 'you', short: 'You and your farm', title: 'You and your farm', hint: 'This helps us suggest changes that fit how you work. Skip anything you would rather not answer.',
      render: function (a) {
        return group('Do you own or rent this land?', tiles('tenure', TENURE, 'radio', a.tenure)) + group('If you rent: how long is your lease?', tiles('lease', LEASE, 'radio', a.lease)) +
          group('How long have you farmed this land?', tiles('experience', EXPERIENCE, 'radio', a.experience)) + group('Which of these do you already do?', tiles('practices', PRACTICES, 'checkbox', a.practices)) +
          group('Do you keep animals?', tiles('livestock', LIVESTOCK, 'checkbox', a.livestock));
      },
      collect: function (a, r) { a.tenure = one(r, 'tenure'); a.lease = one(r, 'lease'); a.experience = one(r, 'experience'); a.practices = checked(r, 'practices'); a.livestock = checked(r, 'livestock'); } },
    { id: 'water', short: 'Water', title: 'Is your farm irrigated or rain-fed?', hint: 'This changes whether the irrigation setting is offered.',
      render: function (a) { return tiles('water', WATER, 'radio', a.water); },
      collect: function (a, r) { a.water = one(r, 'water'); } },
    { id: 'land', short: 'Land', title: 'Your land', hint: 'Your best guess is fine. Pick Not sure for anything you do not know.',
      render: function (a) {
        var soil = a.fields.map(function (f) { var l = soilLine(a.site, f.id); return l ? '<li><strong>' + esc(fieldName(f)) + ':</strong> ' + esc(l) + '</li>' : ''; }).join('');
        return (soil ? '<ul class="fs-q-soil" aria-label="USDA soil survey for each field">' + soil + '</ul>' : '') +
          group('How does it drain after heavy rain?', tiles('drainage', DRAINAGE, 'radio', a.drainage)) + group('Is it tile drained?', tiles('tile', YESNO, 'radio', a.tile)) +
          group('Is the land flat or sloped?', tiles('slope', SLOPE, 'radio', a.slope)) + group('Have you had a soil test in the last 3 years?', tiles('soilTest', YESNO, 'radio', a.soilTest));
      },
      collect: function (a, r) { a.drainage = one(r, 'drainage'); a.tile = one(r, 'tile'); a.slope = one(r, 'slope'); a.soilTest = one(r, 'soilTest'); } },
    { id: 'limits', short: 'Limits', title: 'What limits you?', hint: 'Pick everything that applies. This keeps us from suggesting things you cannot do.',
      render: function (a) {
        return LIMIT_GROUPS.map(function (g) { return group(g[0], tiles('limits', g[1], 'checkbox', a.limits)); }).join('') +
          '<label class="fs-q-label" for="fs-q-limnote">Anything else?</label><input type="text" id="fs-q-limnote" class="fs-q-text" maxlength="300" value="' + esc(a.limitsNote) + '">';
      },
      collect: function (a, r) { a.limits = checked(r, 'limits'); a.limitsNote = text(val(r, 'fs-q-limnote'), 300); } },
    { id: 'crops', short: "Crops you won't grow", title: "Crops you won't grow or won't try", hint: 'These are left out of the options and the recommendations. Your current plans stay.',
      render: function (a) { return tiles('wont', WONT, 'checkbox', a.wont); },
      collect: function (a, r) { a.wont = checked(r, 'wont'); } },
    { id: 'contracts', short: 'Contracts', title: "How much of next year's crop is already contracted?", hint: 'Contracted grain is sold at a set price, so price changes hurt or help less. Not sure? Leave it as it is: the simulator assumes 30%.',
      render: function (a) {
        var v = a.contracted == null ? 30 : a.contracted;
        return '<div class="fs-q-slider"><label class="fs-sr" for="fs-q-contracted">Percent contracted</label><input type="range" id="fs-q-contracted" min="0" max="100" step="5" value="' + v + '"><output id="fs-q-contracted-out" for="fs-q-contracted">' + v + '%</output></div>';
      },
      collect: function (a, r) { var v = Number(val(r, 'fs-q-contracted')); a.contracted = isFinite(v) ? v : null; },
      mount: function (r) { var i = r.querySelector('#fs-q-contracted'), o = r.querySelector('#fs-q-contracted-out'); i.addEventListener('input', function () { o.textContent = i.value + '%'; }); } },
    { id: 'budget', short: 'Budget', title: 'What could you spend to try something new?', hint: 'A rough amount for changes like seed or a cover crop, per acre.',
      render: function (a) { return tiles('budget', BUDGETS, 'radio', a.budget) + group('Would you use a cost-share payment?', tiles('costShare', COST_SHARE, 'radio', a.costShare)); },
      collect: function (a, r) { a.budget = one(r, 'budget'); a.costShare = one(r, 'costShare'); } },
    { id: 'priorities', short: 'Priorities', title: 'What matters most to you?', hint: 'Tap up to 3, in order of importance. Tap again to remove. The first one decides how options are ranked.',
      render: function (a) {
        return '<div class="fs-q-rank" role="group" aria-label="What matters most, up to 3 in order">' + PRIORITIES.map(function (p) {
          var i = a.priorities.indexOf(p);
          return '<button type="button" class="fs-q-rankbtn" data-p="' + esc(p) + '" aria-pressed="' + (i >= 0) + '"><span class="fs-q-badge" aria-hidden="true">' + (i >= 0 ? i + 1 : '') + '</span><span>' + esc(p) + '</span><span class="fs-sr">' + (i >= 0 ? ', number ' + (i + 1) : '') + '</span></button>';
        }).join('') + '</div><p class="fs-sr" id="fs-q-rank-live" role="status" aria-live="polite"></p>' +
          group('If you tried something new, how much would you start with?', tiles('trial', TRIAL, 'radio', a.trial)) +
          '<label class="fs-q-label" for="fs-q-worries">Any worries?</label><textarea id="fs-q-worries" class="fs-q-text" rows="3" maxlength="600">' + esc(a.worries) + '</textarea>';
      },
      collect: function (a, r) { a.trial = one(r, 'trial'); a.worries = text(val(r, 'fs-q-worries'), 600); },
      mount: function (r, ctx) {
        var a = ctx.draft(), live = r.querySelector('#fs-q-rank-live');
        function paint() {
          Array.prototype.forEach.call(r.querySelectorAll('.fs-q-rankbtn'), function (b) {
            var i = a.priorities.indexOf(b.getAttribute('data-p'));
            b.setAttribute('aria-pressed', i >= 0 ? 'true' : 'false'); b.querySelector('.fs-q-badge').textContent = i >= 0 ? String(i + 1) : ''; b.querySelector('.fs-sr').textContent = i >= 0 ? ', number ' + (i + 1) : '';
          });
        }
        r.querySelector('.fs-q-rank').addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('.fs-q-rankbtn'); if (!b) return;
          var p = b.getAttribute('data-p'), i = a.priorities.indexOf(p);
          if (i >= 0) { a.priorities.splice(i, 1); live.textContent = p + ' removed.'; }
          else if (a.priorities.length < 3) { a.priorities.push(p); live.textContent = p + ' added as number ' + a.priorities.length + '.'; }
          else { live.textContent = 'You can pick up to 3. Tap one to remove it first.'; }
          paint();
        });
      } },
    { id: 'buyers', short: 'Buyers', title: 'Who are your buyers?', hint: 'Pick all that apply.',
      render: function (a) { return tiles('buyers', BUYERS, 'checkbox', a.buyers) + '<label class="fs-q-label" for="fs-q-buyernote">Names or details (optional)</label><input type="text" id="fs-q-buyernote" class="fs-q-text" maxlength="300" value="' + esc(a.buyersNote) + '">'; },
      collect: function (a, r) { a.buyers = checked(r, 'buyers'); a.buyersNote = text(val(r, 'fs-q-buyernote'), 300); } },
    { id: 'other', short: 'Anything else', title: 'Anything else?', hint: 'Plans, history, something a neighbor tried. Anything that helps.',
      render: function (a) { return '<label class="fs-sr" for="fs-q-other">Anything else</label><textarea id="fs-q-other" class="fs-q-text" rows="5" maxlength="600">' + esc(a.other) + '</textarea>'; },
      collect: function (a, r) { a.other = text(val(r, 'fs-q-other'), 600); } },
    { id: 'review', title: 'Your farm, in short', noSkip: true, next: 'Start',
      hint: function (a) { return a.example ? 'This is the example farm. Change any answer to make it yours. Everything not marked is used by the simulator.' : 'Everything not marked below is used by the simulator.'; },
      render: function (a) {
        var rows = Q.review(a), done = {}, html = '';
        rows.forEach(function (r) { if (r.value || r.adv || r.noted) done[r.step] = 1; });
        rows.forEach(function (r) {
          if (!(r.value || r.adv || r.noted)) return;   // unanswered rows are listed together below
          var parts = [];
          if (r.value) parts.push(esc(r.value) + (r.status === 'advice' ? ' <span class="fs-q-tag">shapes the advice</span>' : r.status === 'noted' ? ' <span class="fs-q-tag">noted, not used by the simulator</span>' : ''));
          if (r.adv) parts.push('<span class="fs-q-tag">shapes the advice:</span> ' + esc(r.adv));
          if (r.noted) parts.push('<span class="fs-q-tag">noted, not used by the simulator:</span> ' + esc(r.noted));
          html += '<li><span class="fs-q-rl">' + esc(r.label) + '</span><span class="fs-q-rv">' + parts.join('<br>') + '</span>' +
            '<button type="button" class="fs-linkbtn fs-q-change" data-step="' + r.step + '" aria-label="Change ' + esc(r.label) + '">Change</button></li>';
        });
        var skipped = STEPS.filter(function (x) { return x.short && !done[x.id]; });
        if (skipped.length) html += '<li class="fs-q-skiprow"><span class="fs-q-rl">Not answered</span><span class="fs-q-rv">' + skipped.map(function (x) {
          return '<button type="button" class="fs-linkbtn fs-q-change" data-step="' + x.id + '">' + esc(x.short) + '</button>';
        }).join('<span aria-hidden="true"> · </span>') + '</span></li>';
        return '<ul class="fs-q-review">' + html + '</ul>';
      } }
  ];
  Q.steps = STEPS.map(function (s) { return s.id; });

  Q.create = function (host, hooks) {
    var draft = null, idx = 0, first = false, fromReview = false, root, card;
    host.innerHTML = '<div class="fs-setup-card fs-q" role="dialog" aria-modal="true" aria-labelledby="fs-q-title">' +
      '<div class="fs-q-top"><div class="fs-q-bar" id="fs-q-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><i></i></div><p class="fs-q-count" id="fs-q-count"></p></div>' +
      '<form class="fs-q-form" id="fs-setup-form" novalidate><div class="fs-q-scroll" id="fs-q-scroll"><h2 id="fs-q-title" tabindex="-1"></h2><p class="fs-q-hint" id="fs-q-hint"></p><div class="fs-q-body" id="fs-q-body"></div>' +
      '<p id="fs-setup-err" class="fs-setup-err" role="alert" hidden></p></div>' +
      '<div class="fs-q-nav"><button type="button" class="fs-q-btn" id="fs-q-back">Back</button><button type="button" class="fs-q-btn" id="fs-q-skip">Skip</button><span class="fs-q-spacer"></span>' +
      '<button type="submit" class="fs-btn-primary fs-setup-go" id="fs-q-next">Next</button></div>' +
      '<div class="fs-q-foot"><button type="button" class="fs-setup-alt" id="fs-setup-example">Use the example farm</button></div></form></div>';
    card = host.querySelector('.fs-q'); root = host.querySelector('#fs-q-body');
    function $(id) { return host.querySelector('#' + id); }
    function err(msg, el) { var e = $('fs-setup-err'); e.textContent = msg || ''; e.hidden = !msg; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } }
    function collect() { var s = STEPS[idx]; if (s.collect) s.collect(draft, root); }
    function show(i, focus) {
      idx = Math.max(0, Math.min(STEPS.length - 1, i)); var s = STEPS[idx];
      err('');
      $('fs-q-title').textContent = s.title; $('fs-q-hint').textContent = typeof s.hint === 'function' ? s.hint(draft) : (s.hint || ''); $('fs-q-hint').hidden = !$('fs-q-hint').textContent;
      root.innerHTML = s.render(draft);
      if (s.mount) s.mount(root, { draft: function () { return draft; } });
      var inner = idx > 0 && idx < STEPS.length - 1, n = STEPS.length - 2;
      $('fs-q-count').textContent = inner ? 'Question ' + idx + ' of ' + n : ''; $('fs-q-count').hidden = !inner;
      var bar = $('fs-q-bar'), pct = Math.round(idx / (STEPS.length - 1) * 100);
      bar.firstChild.style.width = pct + '%'; bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', s.id === 'welcome' ? 'Start' : s.id === 'review' ? 'Last step' : 'Question ' + idx + ' of ' + n);
      $('fs-q-back').hidden = idx === 0 || fromReview; $('fs-q-skip').hidden = !!s.noSkip;
      $('fs-q-next').textContent = fromReview && s.id !== 'review' ? 'Back to review' : s.next || 'Next';
      $('fs-q-skip').textContent = fromReview ? 'Skip' : 'Skip';
      var sc = $('fs-q-scroll'); sc.scrollTop = 0; host.scrollTop = 0;
      if (focus !== false) $('fs-q-title').focus();
    }
    function go(i) { show(i); }
    function leave(skip) {   // collect and validate; false = stay here
      if (skip) return true;
      collect(); var s = STEPS[idx];
      if (s.validate) { var bad = s.validate(draft, root); if (bad) { err(bad.msg, bad.el); return false; } }
      return true;
    }
    function next(skip) {
      var s = STEPS[idx];
      if (s.id === 'review') { start(); return; }
      if (!leave(skip)) return;
      if (fromReview) { fromReview = false; go(STEPS.length - 1); return; }
      go(idx + 1);
    }
    function start() {
      draft.example = false;   // pressing Start makes it the farmer's own farm, even if every answer was skipped
      var r = hooks.onStart ? hooks.onStart(clone(draft)) : { ok: true };
      if (r && r.ok === false) err(r.error || 'That farm could not be set up.');
    }
    $('fs-setup-form').addEventListener('submit', function (e) { e.preventDefault(); next(false); });
    $('fs-q-skip').addEventListener('click', function () { next(true); });
    $('fs-q-back').addEventListener('click', function () { if (!leave(false)) return; go(idx - 1); });
    $('fs-setup-example').addEventListener('click', function () { if (hooks.onExample) hooks.onExample(); });
    root.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.fs-q-change'); if (!b) return;
      fromReview = true; go(Math.max(0, Q.steps.indexOf(b.getAttribute('data-step'))));
    });
    host.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (hooks.onEscape) hooks.onEscape(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(host.querySelectorAll('input, select, button, textarea'), function (x) { return !x.disabled && x.offsetParent !== null && x.type !== 'hidden'; });
      if (!f.length) return; var a0 = f[0], z = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === a0 || document.activeElement.id === 'fs-q-title' || !host.contains(document.activeElement))) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && (document.activeElement === z || !host.contains(document.activeElement))) { e.preventDefault(); a0.focus(); }
    });
    return {
      // answers: the working copy; stepId: where to open ('welcome' on the first run, 'review' from the header)
      show: function (answers, o) { o = o || {}; draft = clone(answers); first = !!o.first; fromReview = false; show(Math.max(0, Q.steps.indexOf(o.step || 'welcome'))); },
      error: function (msg) { err(msg); },
      current: function () { return STEPS[idx].id; }
    };
  };
})();
