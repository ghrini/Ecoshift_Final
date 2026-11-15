// Usage: node verify/qa2/livemap_test.js dist/simulator.test.html <outdir>
// The farmer's own live map: a tiny local server stands in for /api/farmmap (slow, then a map with fields; also an error case).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const file = path.resolve(process.argv[2]), out = path.resolve(process.argv[3] || 'live_out'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const html = fs.readFileSync(file); let mode = 'ok', calls = 0;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/farmmap?')) {
    calls++;
    return setTimeout(() => {
      if (mode === 'err') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"no"}'); }
      const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/farmmaps.js'), 'utf8').replace(/^[\s\S]*?FS\.data\.farmMaps = /, '').replace(/;\s*$/, ''))['obrien-ia'];
      const b = Buffer.from(m.img.split(',')[1], 'base64'); srv.img = b;
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ map: '/api/farmmap/img/x.jpg', photo: '/api/farmmap/img/x.jpg', source: 'usgs', credit: 'USDA NAIP (test)', detail: 'test', widthKm: 1.6, fields: m.fields }));
    }, 1500);
  }
  if (req.url.startsWith('/api/farmmap/img/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(srv.img); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
(async () => {
  await new Promise(r => srv.listen(0, r)); const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch(); const errors = [];
  for (const m of ['ok', 'err']) {
    mode = m; calls = 0;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message)); await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.addInitScript(() => { try { localStorage.setItem('fieldshift.setup.v1', 'x'); } catch (e) {} });
    await page.goto(url); await page.waitForTimeout(600);
    if (await page.isVisible('#fs-setup')) await page.click('#fs-setup-example');
    await page.waitForTimeout(300);
    // a farmer with their own point
    await page.evaluate(() => { FS.farmSetup.setup = Object.assign({}, FS.farmSetup.setup, { example: false, point: { lat: 43.1, lon: -95.6, label: 'Test Farm Road' } }); FS.farmSetup.example = false; FS.fieldView.refresh(); });
    await page.waitForTimeout(500);
    ok(/Drawing your farm/.test(await page.textContent('.fv-mapnote')), m + ': quiet note while the own map is drawn');
    ok(await page.evaluate(() => document.querySelector('#fs-view').classList.contains('fv-realmap')), m + ': county map shown meanwhile');
    await page.waitForTimeout(2200);
    const cap = await page.textContent('.fv-credit'), note = await page.textContent('.fv-mapnote');
    if (m === 'ok') { ok(/^Your farm from above/.test(cap), 'live map caption: ' + cap.slice(0, 60)); ok(note === '', 'note cleared'); }
    else { ok(/Example farm near/.test(cap) && /could not be drawn/.test(note), 'error: county map kept, one quiet line: ' + note); }
    await (await page.$('#fs-view-panel')).screenshot({ path: path.join(out, 'live-' + m + '.png') });
    await page.evaluate(() => FS.fieldView.refresh()); await page.waitForTimeout(300); ok(calls === 1, m + ': one request only (' + calls + ')');
    await ctx.close();
  }
  ok(errors.length === 0, 'no page errors ' + errors.join('|')); await browser.close(); srv.close(); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
