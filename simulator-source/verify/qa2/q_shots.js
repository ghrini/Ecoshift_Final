// Usage: node verify/qa2/q_shots.js <dist/simulator.test.html> <out-dir>
// Screenshots of questionnaire steps at 1440x900 and iPhone 13; prints page errors and horizontal overflow.
const { chromium, devices } = require('playwright');
const path = require('path');
const [file, out] = process.argv.slice(2);
const STEPS = ['welcome', 'location', 'fields', 'you', 'land', 'limits', 'contracts', 'priorities', 'review'];
(async () => {
  const browser = await chromium.launch(); const errs = [];
  for (const [name, opts] of [['desk', { viewport: { width: 1440, height: 900 } }], ['phone', { ...devices['iPhone 13'] }]]) {
    const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' }); const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(name + ': ' + e.message));
    await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
    await page.goto('file://' + path.resolve(file)); await page.waitForTimeout(600);
    for (let i = 0; i < 15; i++) {
      const id = await page.evaluate(() => document.querySelector('#fs-q-title').textContent);
      const idx = await page.evaluate(() => FS.questionnaire.steps);
      const cur = await page.evaluate(() => document.getElementById('fs-q-bar').getAttribute('aria-valuenow'));
      const n = i;
      if (STEPS.includes(idx[n])) {
        if (idx[n] === 'review') { await page.evaluate(() => { document.querySelector('input[name=practices]'); }); }
        await page.screenshot({ path: path.join(out, `q-${name}-${String(n).padStart(2, '0')}-${idx[n]}.png`) });
        const ox = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (ox > 0) errs.push(name + ' overflowX ' + ox + ' at ' + idx[n]);
      }
      if (i < 14) { await page.click('#fs-q-next'); await page.waitForTimeout(80); }
    }
    await ctx.close();
  }
  console.log(errs.length ? errs.join('\n') : 'no page errors, no overflow'); await browser.close();
})();
