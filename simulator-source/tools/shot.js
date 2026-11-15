// Usage: node tools/shot.js <dist/x.test.html> <out-prefix> [--interact]
// Screenshots (desktop dark 1440x900, phone dark 400x860, desktop light 1440x900), horizontal overflow, page errors.
// --interact: runs a smoke script (change controls, select a field, run, send a chat command, play the timeline) before the shots.
// Web requests are blocked except the local file, so web fonts fall back locally; that is expected.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [file, prefix] = process.argv.slice(2); const interact = process.argv.includes('--interact');
  const browser = await chromium.launch(); const errors = [];
  for (const [name, w, h, scheme] of [['desk-dark', 1440, 900, 'dark'], ['phone-dark', 400, 860, 'dark'], ['desk-light', 1440, 900, 'light']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
    await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : r.abort());
    await page.goto('file://' + path.resolve(file)); await page.waitForTimeout(500);
    if (interact) {
      const tryDo = async (label, fn) => { try { await fn(); } catch (e) { errors.push(name + ' interact ' + label + ': ' + e.message.split('\n')[0]); } };
      await tryDo('dismiss setup panel', async () => { if (await page.isVisible('#fs-setup')) await page.click('#fs-setup-example'); });
      await tryDo('open boxes', () => page.evaluate(() => ['weather', 'crops', 'other'].forEach(k => FS.controlsOpen(k, true))));
      await tryDo('scenario', () => page.selectOption('#fs-weather-scenario', 'drought2012'));
      await tryDo('temp', () => page.$eval('#fs-weather-temp', el => { el.value = 2; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }));
      await tryDo('run', () => page.click('#fs-run'));
      await page.waitForTimeout(300);
      await tryDo('chat', async () => { await page.fill('#fs-chat-input', 'simulate the 2019 wet spring with rye before soybean on Creek 40'); await page.press('#fs-chat-input', 'Enter'); });
      await page.waitForTimeout(1500);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: prefix + '-' + name + '.png', fullPage: true });
    console.log(name, 'overflowX:', overflow, '->', prefix + '-' + name + '.png');
    await ctx.close();
  }
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  await browser.close();
})();
