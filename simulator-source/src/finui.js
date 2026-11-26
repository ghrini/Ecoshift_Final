/* Money and risk display: one compact range line for the selected field (Sim Analysis) and for each option card (chat), with the detail
   folded into <details> sections: Money Breakdown, Crop Insurance, About These Numbers. All numbers come from FS.engine.finance(). */
(function () {
  'use strict';
  var FS = window.FS, D = FS.data, S = FS.store, A = FS.actions;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function usd(n, signed) { var r = Math.round(n), s = Math.abs(r).toLocaleString('en-US'); return (r < 0 ? '−' : signed && r > 0 ? '+' : '') + '$' + (r === 0 ? '0' : s); }
  function pc(n) { return Math.round(n) + '%'; }
  var NAME = { 'soy': 'Soybeans', 'rye-soy': 'Rye, Then Soybeans', 'corn-corn': 'Corn After Corn', 'oats-cover': 'Oats, Then Cover', 'corn': 'Corn', 'rye-corn': 'Rye, Then Corn', 'soy-soy': 'Soybeans After Soybeans' };
  var HEAD = { 'soy': 'Soybeans', 'rye-soy': 'Rye + Soy', 'corn-corn': 'Corn After Corn', 'oats-cover': 'Oats', 'corn': 'Corn', 'rye-corn': 'Rye + Corn', 'soy-soy': 'Soy After Soy' };
  function planName(p) { return NAME[p] || p; }
  function moneyOk() { return !FS.absMoneyOk || FS.absMoneyOk(); }

  // ---- finance() with a small cache (the engine call is cheap but the panel and every card ask for it)
  var cache = {};
  function fin(fieldId, controls) {
    var key, r;
    try { key = fieldId + '|' + JSON.stringify(controls); } catch (e) { key = null; }
    if (key && cache[key]) return cache[key];
    try { r = FS.engine && FS.engine.finance ? FS.engine.finance(fieldId, controls) : null; } catch (e) { console.error(e); r = null; }
    if (key && r) { var ks = Object.keys(cache); if (ks.length > 12) delete cache[ks[0]]; cache[key] = r; }
    return r;
  }
  function itemOf(f, plan) { return f && f.items.filter(function (x) { return x.plan === plan; })[0] || null; }
  function ruleText(f) {
    var r = f.rule;
    return 'Safer Choice: an option that gives up no more than ' + usd(r.maxGiveUp) + ' an acre or ' + Math.round(r.maxGiveUpShare * 100) + '% of the best average (whichever is larger) in average net return, but whose stress-test worst season is at least ' + usd(r.minWorstGain) + ' an acre better, and at least ' + r.gainTimesGiveUp + ' times what it gives up.';
  }
  function badge(f, it) { return it && it.safer ? ' <span class="fs-badge" title="' + esc(ruleText(f)) + '">Safer Choice</span>' : ''; }

  // ---- the one compact line
  function lineText(f, it) {
    var p = it.pct, t = 'Range: worst ' + pc(p.worst) + ' · typical ' + pc(p.median) + ' · best ' + pc(p.best);
    if (!it.moneyHidden && moneyOk()) t += ' · net ' + usd(it.net.mean) + '/acre';
    return t;
  }
  function cardLine(fieldId, plan, controls) {
    var f = fin(fieldId, controls || S.get().controls), it = itemOf(f, plan);
    if (!it) return '';
    return '<div class="fs-fin-line" title="Over the ' + f.nSeasons + ' past seasons the model replayed, as a share of a normal crop (worst, typical = median, best). Net is the average net return per acre after all costs.">' + esc(lineText(f, it)) + badge(f, it) + '</div>';
  }
  function cardMore(fieldId, plan, controls) {
    var f = fin(fieldId, controls || S.get().controls), it = itemOf(f, plan);
    if (!it || it.moneyHidden || !moneyOk()) return '';
    var b = it.breakdown, rows = [
      ['Gross revenue', usd(b.revenue)], ['Seed', usd(b.seed)], ['Fertilizer', usd(b.fertilizer)], ['Fuel and machinery', usd(b.machinery)], ['Irrigation and water', usd(b.irrigation)],
      ['Cover crop establishment', usd(b.cover)], ['Labor', usd(b.labor)], ['Chemicals, interest, other', usd(b.other)], ['Land rent', usd(b.landRent)], ['Cost-share', usd(b.costShare)]];
    return '<details class="fs-fin-d"><summary>Money Breakdown</summary><ul class="fs-detail-list">' +
      rows.map(function (r) { return '<li>' + r[0] + ': ' + r[1] + ' per acre</li>'; }).join('') +
      '<li><strong>Net return:</strong> ' + usd(it.net.mean) + ' per acre on average; worst season ' + usd(it.net.worst) + ' (' + it.net.worstYear + '); a loss in ' + it.net.lossSeasons + ' of ' + f.nSeasons + ' seasons.</li></ul></details>';
  }

  // ---- compact range bar (worst to best, tick at the typical season)
  function rangeBar(p) {
    var lo = Math.min(40, Math.floor(p.worst / 10) * 10), hi = Math.max(120, Math.ceil(p.best / 10) * 10), sp = hi - lo;
    function x(v) { return Math.max(0, Math.min(100, (v - lo) / sp * 100)).toFixed(1) + '%'; }
    return '<div class="fs-rbar" role="img" aria-label="Worst ' + pc(p.worst) + ', typical ' + pc(p.median) + ', best ' + pc(p.best) + ' of a normal crop"><span class="fs-rbar-100" style="left:' + x(100) + '"></span>' +
      '<span class="fs-rbar-span" style="left:' + x(p.worst) + ';width:calc(' + x(p.best) + ' - ' + x(p.worst) + ')"></span><span class="fs-rbar-tick" style="left:' + x(p.median) + '"></span></div>' +
      '<div class="fs-rbar-cap"><span>' + lo + '%</span><span>100% = a normal crop</span><span>' + hi + '%</span></div>';
  }

  // ---- panel pieces
  function table(f, rowsSpec, items) {
    var h = '<div class="fs-fin-scroll"><table class="fs-fin-table"><thead><tr><th scope="col"></th>' + items.map(function (it) { return '<th scope="col">' + esc(HEAD[it.plan] || it.plan) + (it.isCurrent ? '<br><small>(current)</small>' : '') + (it.safer ? ' <span class="fs-badge">Safer Choice</span>' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
    rowsSpec.forEach(function (r) {
      if (r.head) { h += '<tr class="fs-fin-sub"><th scope="row" colspan="' + (items.length + 1) + '">' + r.head + '</th></tr>'; return; }
      h += '<tr' + (r.strong ? ' class="fs-fin-strong"' : '') + '><th scope="row">' + r.label + '</th>' + items.map(function (it) { var v = r.get(it); return '<td>' + (v == null ? '–' : v) + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }
  function num(id, label, val, ph, unit) {
    return '<label class="fs-fin-in" for="' + id + '"><span>' + label + '</span><input id="' + id + '" type="number" inputmode="decimal" min="0" step="any" value="' + (val == null ? '' : esc(val)) + '" placeholder="' + esc(ph) + '"><small>' + unit + '</small></label>';
  }
  function breakdownHtml(f) {
    var items = f.items.filter(function (x) { return !x.moneyHidden; });
    if (!items.length) return '<p>Money is not shown for this plan.</p>';
    var P = function (k) { return function (it) { return usd(it.breakdown[k]); }; };
    var rows = [
      { head: 'Gross Revenue' }, { label: 'Gross revenue (average of the ' + f.nSeasons + ' seasons)', get: P('revenue'), strong: 1 },
      { head: 'Operating Costs' }, { label: 'Seed', get: P('seed') }, { label: 'Fertilizer', get: P('fertilizer') }, { label: 'Chemicals, interest and other', get: P('other') },
      { label: 'Fuel and machinery', get: P('machinery') }, { label: 'Irrigation and water', get: P('irrigation') }, { label: 'Cover crop establishment', get: P('cover') }, { label: 'Labor', get: P('labor') },
      { label: 'Operating costs, total', get: P('operating'), strong: 1 },
      { head: 'Land And Help' }, { label: 'Land rent', get: P('landRent') }, { label: 'Cost-share received', get: function (it) { return it.breakdown.costShare ? usd(it.breakdown.costShare) : '$0'; } },
      { label: 'Estimated net return (no insurance)', get: function (it) { return usd(it.net.mean); }, strong: 1 },
      { head: 'Downside Risk' },
      { label: 'Worst season', get: function (it) { return usd(it.net.worst) + ' (' + it.net.worstYear + ')'; } },
      { label: 'Typical season', get: function (it) { return usd(it.net.median); } }, { label: 'Best season', get: function (it) { return usd(it.net.best) + ' (' + it.net.bestYear + ')'; } },
      { label: 'Seasons with a loss', get: function (it) { return it.net.lossSeasons + ' of ' + f.nSeasons; } },
      { label: 'Stress-test worst season', get: function (it) { return usd(it.stress.net.worst); } },
      { label: 'Gives up vs best average', get: function (it) { return it.leader ? '(best)' : usd(-it.giveUp); } },
      { label: 'Stress-test worst, vs best average', get: function (it) { return it.leader ? '–' : usd(it.worstGain, true); } },
      { head: 'Price Swing' },
      { label: 'Net at a low price', get: function (it) { return it.band ? usd(it.band.low) : null; } }, { label: 'Net at a high price', get: function (it) { return it.band ? usd(it.band.high) : null; } }
    ];
    var h = '<p class="fs-fin-note">Dollars per acre, ' + f.years[0] + '–' + f.years[f.years.length - 1] + ' seasons replayed with today’s prices and costs. Net return is after every cost, including land rent and labor, so a loss means the crop did not cover its full budget.</p>' + table(f, rows, items);
    var sf = f.safer ? 'Safer Choice on ' + esc(f.fieldName) + ': ' + esc(planName(f.safer)) + '.' : 'No option on ' + esc(f.fieldName) + ' qualifies as a Safer Choice.';
    h += '<p><b>' + sf + '</b> ' + esc(ruleText(f)) + '</p>';
    var v = f.volatility, lowHigh = [];
    if (v.corn) lowHigh.push('corn ±' + Math.round(v.corn * 100) + '%'); if (v.soybean) lowHigh.push('soybean ±' + Math.round(v.soybean * 100) + '%');
    h += '<p>Price swing: low and high price are one price-volatility step either side of today’s price (' + lowHigh.join(', ') + '; USDA RMA 2026 volatility factors). Yield and price are not linked here, though in real droughts prices often rise.</p>';
    h += '<p>Stress test: the model’s own seasons swing less than real Iowa yields do, so bad seasons are stretched to the observed spread (as the risk numbers elsewhere in this tool do).</p>';
    var I = f.inputs, d = f.defaults;
    h += '<p class="fs-fin-h">Your Own Numbers</p><div class="fs-fin-inputs">' +
      num('fs-fin-rent', 'Land rent', I.landRent, d.landRent.toFixed(2), '$/acre, default is Iowa State’s cash rent figure') +
      num('fs-fin-wage', 'Labor wage', I.wage, d.wage.toFixed(2), '$/hour, default is Iowa State’s wage') +
      num('fs-fin-cover', 'Cover crop seed and seeding', I.coverCost, d.coverCost.toFixed(2), '$/acre, example value, set your own') +
      '</div><p><button type="button" class="fs-linkbtn" data-fin-reset="1">Use the sourced numbers</button></p>';
    return h;
  }
  function insuranceHtml(f) {
    var items = f.items.filter(function (x) { return !x.moneyHidden && x.insurable; });
    var I = f.inputs, d = f.defaults, E = D.economics;
    var h = '<p class="fs-fin-note">Approximation of revenue protection: the guarantee is the coverage level × normal yield × projected price (corn ' + E.normalYield.corn + ' bu × ' + '$' + E.price.corn.toFixed(2) + '/bu, soybean ' + E.normalYield.soybean + ' bu × $' + E.price.soybean.toFixed(2) + '/bu here). When a season’s simulated revenue falls below it, the policy pays the gap. Real policies also have a harvest-price option, your own yield history, farm units and premium subsidies that are not modelled.</p>';
    h += '<div class="fs-fin-inputs"><label class="fs-fin-in" for="fs-fin-cov"><span>Coverage level</span><select id="fs-fin-cov">' + d.levels.map(function (l) { return '<option value="' + l + '"' + (l === f.level ? ' selected' : '') + '>' + l + '%</option>'; }).join('') + '</select><small>of expected revenue</small></label>' +
      num('fs-fin-pcorn', 'Corn premium', I.premiumCorn, d.premiumCorn.toFixed(2), '$/acre you pay') + num('fs-fin-psoy', 'Soybean premium', I.premiumSoybean, d.premiumSoybean.toFixed(2), '$/acre you pay') + '</div>';
    h += '<p class="fs-fin-note">Premium: Iowa State’s budgets carry $17.10 (corn) and $9.10 (soybean) an acre for 80% revenue protection. Premiums at 70, 75 and 85% are example values (a share of the 80% premium), not real rates: set your own from your agent’s quote.</p>';
    if (!items.length) return h + '<p>No insurable crop in these options.</p>';
    var rows = [
      { label: 'Premium you pay', get: function (it) { return usd(it.insurance.premium); } },
      { label: 'Seasons it pays out', get: function (it) { return it.insurance.payoutSeasons + ' of ' + f.nSeasons; } },
      { label: 'Average payout', get: function (it) { return usd(it.insurance.payoutMean); } },
      { head: 'Average Net Return' }, { label: 'Without insurance', get: function (it) { return usd(it.net.mean); } }, { label: 'With insurance', get: function (it) { return usd(it.netIns.mean); } },
      { head: 'Worst Season' }, { label: 'Without insurance', get: function (it) { return usd(it.net.worst); } }, { label: 'With insurance', get: function (it) { return usd(it.netIns.worst); } },
      { head: 'Seasons With A Loss' }, { label: 'Without insurance', get: function (it) { return it.net.lossSeasons + ' of ' + f.nSeasons; } }, { label: 'With insurance', get: function (it) { return it.netIns.lossSeasons + ' of ' + f.nSeasons; } },
      { head: 'Stress Test (Bad Seasons Stretched)' }, { label: 'Worst without insurance', get: function (it) { return usd(it.stress.net.worst); } }, { label: 'Worst with insurance', get: function (it) { return usd(it.stress.netIns.worst); } },
      { label: 'Seasons it pays out', get: function (it) { return it.stress.payoutSeasons + ' of ' + f.nSeasons; } },
      { head: 'Price Swing (Average Net)' }, { label: 'Low price, with insurance', get: function (it) { return it.band ? usd(it.band.lowIns) : null; } }, { label: 'High price, with insurance', get: function (it) { return it.band ? usd(it.band.highIns) : null; } }
    ];
    return h + table(f, rows, items) + '<p class="fs-fin-note">Insurance results are an approximation, not a quote. The ' + usd(d.premiumCorn) + ' / ' + usd(d.premiumSoybean) + ' premiums apply at ' + f.level + '% coverage.</p>';
  }
  function aboutHtml(f) {
    var v = f.validation, E = D.economics, src = D.sources, links = ['power', 'nrcs', 'isu', 'wasde', 'rma', 'idals', 'nass'].map(function (k) { return src[k] ? '<a href="' + esc(src[k].url) + '" target="_blank" rel="noopener">' + esc(src[k].label) + '</a>' : ''; }).filter(Boolean).join(', ');
    var c = v.corn, s = v.soybean, li = [];
    li.push('<li><b>What this is:</b> a replay of ' + f.nSeasons + ' past seasons (' + f.years[0] + '–' + f.years[f.years.length - 1] + ') of real weather on this field’s soil, using today’s prices and costs. It is not a forecast of next season.</li>');
    li.push('<li><b>How the model was checked:</b> each season’s yield was predicted with that season left out, then compared with USDA NASS Iowa state yields' + (c && s ? ': typical one-season error ' + c.rmsePct.toFixed(1) + ' points for corn and ' + s.rmsePct.toFixed(1) + ' for soybean, against ' + c.rmseTrendPct.toFixed(1) + ' and ' + s.rmseTrendPct.toFixed(1) + ' for just using the yield trend' : '') + '. It catches the big droughts (1988, 2012) but in ordinary years does little better than the trend. Details are in VALIDATION.md in the project files.</li>');
    li.push('<li><b>Uncertainty:</b> one season is uncertain by about ' + Math.round(Math.max(f.err.corn.points, f.err.soybean.points)) + ' points of a normal crop (about ' + usd(f.err.corn.dollars) + ' an acre of corn, ' + usd(f.err.soybean.dollars) + ' of soybean). No interval is put on the ' + f.nSeasons + '-season average, because averaging does not remove a bias shared by all seasons.</li>');
    li.push('<li><b>Validated on:</b> Iowa corn and soybean yields. Other counties use the same model but were not checked; oats and cover crops have no validation, and oats money is not shown.</li>');
    li.push('<li><b>Assumptions:</b> corn ' + '$' + E.price.corn.toFixed(2) + ' and soybean $' + E.price.soybean.toFixed(2) + ' a bushel (USDA WASDE, Nov 2026) in every season; costs from Iowa State’s 2026 crop budgets, including land rent (' + usd(E.costParts.corn.landRent) + ') and labor (' + usd(E.wagePerHour) + ' an hour); the cover crop cost is an example value; cost-share only if you tick it (Iowa program, 160-acre cap); irrigation counts pumping energy only; insurance is a simplified approximation.</li>');
    li.push('<li><b>Data sources:</b> ' + links + '. Prices and costs as of ' + esc(f.asOf) + '.</li>');
    li.push('<li><b>Limits:</b> prices do not change with the weather (in real droughts prices rise, so drought losses here are overstated); weather is one 50 km grid cell; tile drainage, disease, hail and machinery breakdowns are not modelled; the Iowa budgets are not your farm’s records, so put in your own rent, wage and costs.</li>');
    return '<ul class="fs-detail-list">' + li.join('') + '</ul>';
  }

  // ---- the block under the season strip
  var openMap = {};
  function panelHtml(fieldId, controls, planId) {
    var f = fin(fieldId, controls); if (!f) return '';
    var plan = planId && itemOf(f, planId) ? planId : f.items[0].plan, it = itemOf(f, plan);
    var h = '<div class="fs-fin"><p class="fs-fin-line"><b>' + esc(f.fieldName) + ', ' + esc(planName(plan).toLowerCase()) + '.</b> ' + esc(lineText(f, it)) + badge(f, it) + '</p>' + rangeBar(it.pct);
    var pts = it.crop === 'soybean' ? f.err.soybean : f.err.corn;
    var rangeNote = '<p class="fs-fin-note">Typical model error for one season: about ' + Math.round(pts.points) + ' points of a normal crop' + (!it.moneyHidden && moneyOk() ? ' (about ' + usd(pts.dollars) + ' an acre)' : '') + '. Worst season ' + it.pct.worstYear + ', best ' + it.pct.bestYear + '.' + (!it.moneyHidden && moneyOk() ? ' Net return range: worst ' + usd(it.net.worst) + ', typical ' + usd(it.net.median) + ', best ' + usd(it.net.best) + ' an acre; a loss in ' + it.net.lossSeasons + ' of ' + f.nSeasons + ' seasons.' : '') + '</p>';
    function det(id, title, body) { return '<details class="fs-fin-d" data-fin="' + id + '"' + (openMap[id] ? ' open' : '') + '><summary>' + title + '</summary><div class="fs-fin-body">' + body + '</div></details>'; }
    h += det('range', 'Range Details', rangeNote);
    if (!moneyOk()) h += '<p class="fs-fin-note">Dollar figures are not shown outside Iowa, because the costs are Iowa State budgets.</p>';
    else if (f.items.some(function (x) { return !x.moneyHidden; })) { h += det('money', 'Money Breakdown', breakdownHtml(f)); h += det('ins', 'Crop Insurance', insuranceHtml(f)); }
    h += det('about', 'About These Numbers', aboutHtml(f)) + '</div>';
    return h;
  }

  function readNum(id) { var e = document.getElementById(id); if (!e || e.value === '') return null; var v = Number(e.value); return isFinite(v) && v >= 0 ? v : null; }
  function setFin(key, v) { var c = S.get().controls; c.other = c.other || {}; c.other.fin = c.other.fin || {}; A.setControl('other.fin.' + key, v, 'ui'); }
  function bind(listEl, redo) {
    listEl.addEventListener('toggle', function (e) { var d = e.target; if (d && d.getAttribute && d.getAttribute('data-fin')) openMap[d.getAttribute('data-fin')] = d.open; }, true);
    listEl.addEventListener('change', function (e) {
      var id = e.target && e.target.id, m = { 'fs-fin-rent': 'landRent', 'fs-fin-wage': 'wage', 'fs-fin-cover': 'coverCost', 'fs-fin-pcorn': 'premiumCorn', 'fs-fin-psoy': 'premiumSoybean' };
      if (id === 'fs-fin-cov') { setFin('coverage', Number(e.target.value)); A.runSimulation('fin', 'Crop insurance ' + e.target.value + '%'); return; }
      if (m[id]) { setFin(m[id], readNum(id)); A.runSimulation('fin', 'Your own money numbers'); }
    });
    listEl.addEventListener('click', function (e) {
      if (!(e.target.closest && e.target.closest('[data-fin-reset]'))) return;
      ['landRent', 'wage', 'coverCost', 'premiumCorn', 'premiumSoybean'].forEach(function (k) { setFin(k, null); });
      A.runSimulation('fin', 'Sourced money numbers');
    });
  }

  FS.finUI = { panelHtml: panelHtml, cardLine: cardLine, cardMore: cardMore, bind: bind, planName: planName };
})();
