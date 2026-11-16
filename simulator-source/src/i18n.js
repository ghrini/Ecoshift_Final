/* Languages: the whole simulator page in the farmer's language, translated by the AI helper on the EcoShift server
   (POST /api/translate, Google Gemini). The page is written in English; this module watches it and swaps every piece of
   screen text (the questionnaire, the guide, the panels, chat answers, the analysis) for its translation as it appears.
   Translations are kept in this browser, so each sentence is only translated once. Numbers, dates and the year strip
   are left as they are. What the farmer types in the chat is put into English before the simulator reads it.
   With no AI key on the server (or no server), the page stays in English and says so once. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var KEY = 'ecoshift.lang', CACHE = 'ecoshift.tr.', MAX_CACHE = 5000, BATCH = 150;
  // [value sent to the AI, name shown in that language]
  var LANGS = [['English', 'English'], ['Spanish', 'Español'], ['Portuguese', 'Português'], ['French', 'Français'], ['Hindi', 'हिन्दी'],
    ['Chinese (Simplified)', '中文'], ['Arabic', 'العربية'], ['Swahili', 'Kiswahili'], ['Vietnamese', 'Tiếng Việt'], ['Ukrainian', 'Українська']];
  var LOCALE = { English: 'en', Spanish: 'es', Portuguese: 'pt', French: 'fr', Hindi: 'hi', 'Chinese (Simplified)': 'zh', Arabic: 'ar', Swahili: 'sw', Vietnamese: 'vi', Ukrainian: 'uk' };
  // left in English: numbers and dates that change every frame, the 44-season strip, the language picker itself
  var SKIP = 'script,style,code,pre,textarea,input,[translate="no"],.notranslate,.fv-date,.fv-wx,.fs-sq,.fv-tick,.fv-speed,.fs-lang';
  var SKIP_ATTR = '[translate="no"],.notranslate,.fv-date,.fv-wx,.fs-sq,.fv-tick,.fv-speed,.fs-lang';   // input boxes keep what is typed, but their hints are translated
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  function apiBase() { return /^https?:$/.test(location.protocol) ? location.origin : null; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* blocked storage: works for this visit */ } }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  var lang = read(KEY) || 'English', map = {}, pending = {}, nPending = 0, timer = 0, busy = false, pausedUntil = 0, told = false;
  var done = new WeakMap();    // text node -> the translated text we put in (so our own change is not translated again)
  var doneAttr = new WeakMap(); // element -> { attr: translated value }
  function active() { return lang !== 'English' && !!apiBase(); }
  function loadCache() { try { map = JSON.parse(read(CACHE + lang) || '{}') || {}; } catch (e) { map = {}; } }
  function saveCache() {
    var keys = Object.keys(map);
    if (keys.length > MAX_CACHE) { var keep = {}; keys.slice(-Math.floor(MAX_CACHE * 0.7)).forEach(function (k) { keep[k] = map[k]; }); map = keep; }
    store(CACHE + lang, JSON.stringify(map));
  }
  function wanted(s) { return s.length > 1 && s.length < 1500 && /[A-Za-z]{2,}/.test(s); }
  function skipped(el) { return !el || !el.closest || !!el.closest(SKIP); }

  function want(s) { if (!map[s] && !pending[s]) { pending[s] = 1; nPending++; schedule(); } }
  function doText(node) {
    var v = node.nodeValue; if (!v || done.get(node) === v) return;
    var s = v.trim(); if (!wanted(s) || skipped(node.parentElement)) return;
    var tr = map[s];
    if (tr) { var t = v.replace(s, tr); done.set(node, t); node.nodeValue = t; } else want(s);
  }
  function doAttrs(el) {
    if (!el || !el.closest || el.closest(SKIP_ATTR) || el.closest('script,style')) return;
    var mine = doneAttr.get(el) || {};
    ATTRS.forEach(function (a) {
      var v = el.getAttribute(a); if (!v || mine[a] === v) return;
      var s = v.trim(); if (!wanted(s)) return;
      if (map[s]) { mine[a] = map[s]; doneAttr.set(el, mine); el.setAttribute(a, map[s]); } else want(s);
    });
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    if (skipped(root)) return;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else if (n.hasAttribute && (n.hasAttribute('placeholder') || n.hasAttribute('title') || n.hasAttribute('aria-label'))) doAttrs(n); }
  }

  function schedule() { if (!timer) timer = setTimeout(flush, 250); }
  function flush() {
    timer = 0;
    if (!active() || busy || !nPending) return;
    if (Date.now() < pausedUntil) { timer = setTimeout(flush, pausedUntil - Date.now()); return; }
    var all = Object.keys(pending), strings = all.slice(0, BATCH), forLang = lang;
    busy = true;
    fetch(apiBase() + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: lang, strings: strings }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) {
        busy = false; if (forLang !== lang) return;
        if (!x.ok || !x.j || !x.j.translations) throw new Error((x.j && x.j.error) || 'The translation did not come back.');
        strings.forEach(function (s) { delete pending[s]; nPending--; var t = x.j.translations[s]; if (typeof t === 'string' && t.trim()) map[s] = t; });
        saveCache(); walk(document.body);
        if (nPending) schedule();
      })
      .catch(function (e) {
        busy = false; pausedUntil = Date.now() + 60000;   // try again in a minute; the page stays readable in English meanwhile
        notice(String(e && e.message || e));
        if (nPending) schedule();
      });
  }
  function notice(msg) {
    if (told) return; told = true;
    var el = document.createElement('p'); el.className = 'fs-lang-note'; el.setAttribute('role', 'status'); el.setAttribute('translate', 'no');
    el.textContent = 'Translation is not available right now, so some text is in English. (' + msg + ')';
    document.body.appendChild(el); setTimeout(function () { el.remove(); }, 9000);
  }

  // ---- the language picker (questionnaire welcome step and the top bar)
  function options() {
    var known = LANGS.some(function (l) { return l[0] === lang; });
    return LANGS.map(function (l) { return '<option value="' + l[0] + '"' + (l[0] === lang ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('') +
      (known ? '' : '<option value="' + lang.replace(/"/g, '') + '" selected>' + lang.replace(/[<&"]/g, '') + '</option>') + '<option value="__other">Other…</option>';
  }
  function selectHTML(id) {
    return '<label class="fs-lang" translate="no"><span class="fs-lang-ic" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg></span>' +
      '<span class="fs-sr">Language</span><select id="' + id + '" class="fs-lang-select" aria-label="Language">' + options() + '</select></label>';
  }
  function set(next) {
    if (next === '__other') {
      next = (window.prompt('Type the language you would like (for example Tagalog, Punjabi, Hmong):', '') || '').trim().slice(0, 40);
      if (!next) { syncSelects(); return; }
    }
    if (!next || next === lang) return;
    store(KEY, next === 'English' ? null : next);
    location.reload();   // a fresh page in the new language (and English comes back exactly as written)
  }
  function syncSelects() { Array.prototype.forEach.call(document.querySelectorAll('.fs-lang-select'), function (s) { s.innerHTML = options(); }); }
  document.addEventListener('change', function (e) { if (e.target && e.target.classList && e.target.classList.contains('fs-lang-select')) set(e.target.value); });

  // What the farmer types in the chat, in English for the simulator to read (their own words stay on screen).
  function toEnglish(text) {
    if (!active() || !/\S/.test(text)) return Promise.resolve(text);
    return fetch(apiBase() + '/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'English', strings: [text] }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { var t = j && j.translations && j.translations[text]; return typeof t === 'string' && t.trim() ? t : text; })
      .catch(function () { return text; });
  }

  function start() {
    if (lang !== 'English') { document.documentElement.lang = LOCALE[lang] || ''; loadCache(); }
    // the top-bar picker, next to "Your farm"
    var farm = document.getElementById('fs-farm-btn');
    if (farm && !document.getElementById('fs-lang-top') && apiBase()) { var w = document.createElement('div'); w.className = 'fs-lang-top'; w.innerHTML = selectHTML('fs-lang-top'); farm.parentNode.insertBefore(w.firstChild, farm); }
    if (!active()) return;
    walk(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else Array.prototype.forEach.call(m.addedNodes, walk);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  FS.i18n = { language: function () { return lang; }, active: active, selectHTML: selectHTML, set: set, toEnglish: toEnglish, languages: LANGS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
