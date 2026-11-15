// Usage: node verify/qa2/realmap_test.js dist/simulator.test.html <outdir>
// Real farm map checks: county map painted with the four fields, season shots, selection by click, tooltip, other counties, phone, fallback, frame time.
const { chromium, devices } = require('playwright'); const path = require('path'); const fs = require('fs');
const file = path.resolve(process.argv[2]), out = path.resolve(process.argv[3] || 'realmap_out'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch(); const errors = [];
  async function open(ctxOpts) {
    const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
    await page.goto('file://' + file); await page.waitForTimeout(600);
    if (await page.isVisible('#fs-setup')) await page.click('#fs-setup-example');
    await page.waitForTimeout(500); return { ctx, page };
  }
  const { ctx, page } = await open({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  ok(await page.evaluate(() => !!(FS.data.farmMaps && FS.data.farmMaps['story-ia'])), 'farmMaps data present');
  ok(await page.evaluate(() => document.querySelector('#fs-view').classList.contains('fv-realmap')), 'example farm shows the real map');
  await page.evaluate(() => FS.fieldView.pause());
  const panel = await page.$('#fs-view-panel');
  for (const w of [0, 10, 20, 26, 30, 34, 40, 46, 50]) {
    await page.evaluate(w => FS.fieldView.setWeek(w), w); await page.waitForTimeout(250);
    await panel.screenshot({ path: path.join(out, 'season-w' + String(w).padStart(2, '0') + '.png') });
  }
  // sample colours of one field at the label point per week
  const sample = await page.evaluate(async () => {
    const res = []; const c = document.querySelector('.fv-canvas'), x = c.getContext('2d'), st = document.querySelector('.fv-stage');
    for (const w of [0, 15, 20, 25, 30, 35, 40, 45, 50]) {
      FS.fieldView.setWeek(w); await new Promise(r => setTimeout(r, 120));
      const lb = document.querySelector('.fv-label'); const r = lb.getBoundingClientRect(), cr = c.getBoundingClientRect();
      const px = x.getImageData(Math.round((r.left + r.width / 2 - cr.left + 30) * (c.width / cr.width)), Math.round((r.top - cr.top - 20) * (c.height / cr.height)), 1, 1).data; res.push([w, Array.from(px).slice(0, 3)]);
    }
    return res;
  });
  console.log('north field colour by week', JSON.stringify(sample));
  const distinct = new Set(sample.map(s => s[1].map(v => Math.round(v / 20)).join(','))).size; ok(distinct >= 4, 'field colour changes through the season (' + distinct + ' distinct)');
  // click a field
  await page.evaluate(() => FS.fieldView.setWeek(25)); await page.waitForTimeout(200);
  const where = await page.evaluate(() => { const st = document.querySelector('.fv-canvas').getBoundingClientRect(); const out = {}; document.querySelectorAll('.fv-label').forEach((l, i) => { const r = l.getBoundingClientRect(); out[l.textContent] = [r.left + r.width / 2, r.top + r.height / 2 + 24]; }); return out; });
  const names = Object.keys(where); ok(names.length === 4, 'four labels: ' + names.join(', '));
  for (const nm of names) {
    const [x, y] = where[nm]; await page.mouse.move(x, y); await page.waitForTimeout(150); const tip = await page.evaluate(() => { const t = document.querySelector('.fv-tip'); return t.hidden ? null : t.textContent; });
    await page.mouse.click(x, y); await page.waitForTimeout(150);
    const sel = await page.evaluate(() => FS.store.get().selectedField);
    console.log(nm, '->', sel, '| tip:', tip && tip.slice(0, 150));
    ok(!!tip && /Map outline about|Found automatically/.test(tip), 'tooltip on ' + nm);
  }
  await page.mouse.move(where[names[0]][0], where[names[0]][1]); await page.waitForTimeout(200);
  await panel.screenshot({ path: path.join(out, 'hover-tooltip.png') });
  ok(/drawn from USDA aerial photos|Sentinel-2/.test(await page.textContent('.fv-credit')), 'caption: ' + (await page.textContent('.fv-credit')).slice(0, 90));
  // frame time while playing
  const ft = await page.evaluate(() => new Promise(res => { FS.fieldView.setWeek(0); FS.fieldView.play(); const t = []; let last = performance.now(), n = 0; (function f(now) { t.push(now - last); last = now; if (++n < 150) requestAnimationFrame(f); else { FS.fieldView.pause(); t.shift(); t.sort((a, b) => a - b); res({ avg: t.reduce((a, b) => a + b) / t.length, p95: t[Math.floor(t.length * 0.95)] }); } })(performance.now()); }));
  console.log('frame time ms', JSON.stringify(ft)); ok(ft.p95 < 40, 'frame time p95 ' + ft.p95.toFixed(1));
  // other counties
  for (const id of ['obrien-ia', 'saunders-ne', 'tippecanoe-in']) {
    await page.evaluate(async id => { const site = JSON.parse(JSON.stringify(window.__s = null)) ; }, id).catch(() => {});
    const r = await page.evaluate(id => { const r = FS.engine.setFarm({ site: id, fields: FS.data.farm.fields }); FS.farmSetup.site = { id, name: (FS.data.farmMaps[id] || {}).name, short: id }; FS.fieldView.refresh(); return r && r.ok; }, id);
    await page.waitForTimeout(500);
    await page.evaluate(() => { const r = FS.engine.run(FS.store.get().controls ? { farm: FS.data.farm, controls: FS.store.get().controls } : null); });
    await page.evaluate(() => FS.fieldView.setWeek(30)); await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelector('#fs-view').classList.contains('fv-realmap')), id + ' shows its county map (setFarm ok=' + r + ')');
    await panel.screenshot({ path: path.join(out, 'county-' + id + '.png') });
  }
  // fallback
  await page.evaluate(() => { delete FS.data.farmMaps; FS.fieldView.refresh(); }); await page.waitForTimeout(400);
  ok(await page.evaluate(() => !document.querySelector('#fs-view').classList.contains('fv-realmap')), 'fallback: old layout when farmMaps is removed');
  await panel.screenshot({ path: path.join(out, 'fallback.png') });
  await ctx.close();
  // phone
  const p = await open({ ...devices['iPhone 13'], colorScheme: 'dark' });
  await p.page.evaluate(() => FS.fieldView.pause()); await p.page.evaluate(() => FS.fieldView.setWeek(25)); await p.page.waitForTimeout(400);
  const ov = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(ov <= 0, 'phone overflowX ' + ov);
  await (await p.page.$('#fs-view-panel')).screenshot({ path: path.join(out, 'phone-w25.png') });
  await p.ctx.close();
  const errs = errors.filter(e => !/ERR_FAILED/.test(e)); ok(errs.length === 0, 'no page errors' + (errs.length ? ": " + errs.slice(0, 3).join(' | ') : ''));
  await browser.close(); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
