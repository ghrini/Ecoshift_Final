#!/usr/bin/env python3
"""Build the single-file simulator page.
   python3 build.py              -> dist/simulator.html (+ .test.html)
   python3 build.py --only view  -> dist/view-only.*  (engine + field view in a bare harness)
   python3 build.py --only ui    -> dist/ui-only.*    (full page; stub engine/view used if developer B's files are missing)
"""
import sys, pathlib
root = pathlib.Path(__file__).resolve().parent
src, dist = root / 'src', root / 'dist'
dist.mkdir(exist_ok=True)
only = sys.argv[sys.argv.index('--only') + 1] if '--only' in sys.argv else 'all'

def rd(name):
    p = src / name
    return p.read_text(encoding='utf-8') if p.exists() else ''

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">')

STUB_ENGINE = r'''
window.FS = window.FS || {};
FS.engine = FS.engine || { run: function (input) {
  var weeks = [], fields = {}, d = new Date('2026-11-16T00:00:00Z');
  for (var i = 0; i < 52; i++) { var f = {}; input.farm.fields.forEach(function (fl) { f[fl.id] = { crop: 'none', stage: 'bare', green: 0.1, soilWater: 0.5, stress: 0, flags: [] }; });
    weeks.push({ date: new Date(d.getTime() + i * 6048e5).toISOString().slice(0, 10), label: 'W' + (i + 1), weather: { tmaxC: 20, rainMm: 10, heavyRain: false, frost: false, heat: false }, fields: f }); }
  input.farm.fields.forEach(function (fl) { fields[fl.id] = { plan: input.controls.crops.plans[fl.id], planLabel: FS.data.plans[input.controls.crops.plans[fl.id]].label, crop: 'none', acres: fl.acres, trialAcres: fl.acres, yieldPctOfNormal: 100, yieldBuPerAcre: 0, returnPerAcre: 0, returnVsBaselinePerAcre: 0, greenCoverMonths: 0, worstWeek: null, note: 'stub engine' }; });
  return { label: 'Stub run', sample: true, inputs: input.controls, weeks: weeks, summary: { farm: { acres: 280, returnTotal: 0, returnVsBaselineTotal: 0 }, fields: fields, events: [], why: [{ text: 'Stub engine: developer B has not delivered engine.js yet.', source: 'power' }],
    recommendations: [ { rank: 1, fieldId: 'creek', plan: 'rye-soy', title: 'Stub recommendation', deltaPerAcre: 0, greenCoverMonthsAdded: 0, risk: 'low', why: 'stub', source: 'modis' } ] } };
} };
'''
STUB_VIEW = r'''
window.FS = window.FS || {};
FS.fieldView = FS.fieldView || { mount: function (el) { el.innerHTML = '<div style="padding:16px;color:var(--text-muted)">Field view placeholder (developer B)</div>'; } };
'''

VIEW_HARNESS = '<title>Field view harness</title>\n' + FONTS + '''
<style>/*__CSS__*/
body{background:var(--bg);color:var(--text);font-family:var(--font-sans);margin:0;padding-block:16px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.h{max-width:1100px;margin:0 auto;display:grid;gap:12px}#fs-view{height:min(70vh,640px);min-height:360px;border:1px solid var(--border);border-radius:12px;background:var(--panel);overflow:hidden;position:relative}
.h button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);background:var(--panel-2);color:var(--text);cursor:pointer}</style>
<div class="h"><div><button id="h-run">Run 2012 drought</button> <button id="h-sel">Select South 120</button></div><div id="fs-view"></div><pre id="h-out" style="font:12px var(--font-mono);color:var(--text-muted);white-space:pre-wrap"></pre></div>
<!--__SCRIPTS__-->
<script>
FS.computeBaseline(); FS.fieldView.mount(document.getElementById('fs-view'));
var r = FS.actions.runSimulation('test', 'Typical year');
document.getElementById('h-out').textContent = JSON.stringify(r.summary, null, 1).slice(0, 2500);
document.getElementById('h-run').onclick = function(){ FS.actions.setControl('weather.scenario','drought2012'); var r2 = FS.actions.runSimulation('test'); document.getElementById('h-out').textContent = JSON.stringify(r2.summary, null, 1).slice(0, 2500); };
document.getElementById('h-sel').onclick = function(){ FS.actions.selectField('south','test'); };
</script>'''

css = rd('tokens.css')
if only in ('all', 'ui'): css += '\n' + rd('app.css')
if only in ('all', 'view', 'ui'): css += '\n' + rd('view.css')

js = [rd('data.js'), rd('climate.js'), rd('sites.js'), rd('farmmaps.js'), rd('store.js')]   # sites.js (other locations) may not exist yet: rd() returns '' then
eng, view = rd('engine.js'), rd('fieldview.js')
if only == 'ui':
    js += [eng or STUB_ENGINE, view or STUB_VIEW]
else:
    js += [eng, view]
if only in ('all', 'ui'):
    js += [rd('i18n.js'), rd('controls.js'), rd('analysis.js'), rd('chat.js'), rd('questionnaire.js'), rd('outlook.js'), rd('farmmap.js'), rd('conditions.js'), rd('fieldimport.js'), rd('app.js'), rd('scrollhint.js')]
for j in js:
    assert '</script' not in j.lower(), 'a JS file contains </script'
scripts = '\n'.join('<script>\n' + j + '\n</script>' for j in js if j.strip())

body = VIEW_HARNESS if only == 'view' else rd('index.html')
assert '/*__CSS__*/' in body and '<!--__SCRIPTS__-->' in body, 'index.html must contain /*__CSS__*/ and <!--__SCRIPTS__-->'
out = body.replace('/*__CSS__*/', css).replace('<!--__SCRIPTS__-->', scripts)
name = {'all': 'simulator', 'view': 'view-only', 'ui': 'ui-only'}[only]
(dist / (name + '.html')).write_text(out, encoding='utf-8')
skeleton = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>')
(dist / (name + '.test.html')).write_text(skeleton + out + '</body></html>', encoding='utf-8')
if only == 'all':
    # standalone page for GitHub Pages: no test harness. The fragment starts with <title>, <meta>, <link> and <style> (head material), then the page.
    cut = out.index('<header') if '<header' in out else 0
    nav = out.find('<nav id="fs-backrow"'); cut = nav if 0 <= nav < cut else cut
    (dist / 'deep-dive.html').write_text('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' + __import__('urllib.parse').parse.quote((src / 'logo.svg').read_text(encoding='utf-8').strip()) + '">\n'
        + out[:cut] + '</head><body>\n' + out[cut:] + '\n</body></html>', encoding='utf-8')
    print('built dist/deep-dive.html')
print('built dist/%s.html (%d bytes)' % (name, len(out)))
