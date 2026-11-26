// EcoShift site shell: tab navigation only (Home, Simulation, About us).
// The Simulation tab shows Shaurya's EcoShift simulator (./deepdive), which has the farm
// questionnaire built in. Order: questionnaire, then the guide (sim-guide.js), then the simulation.
// The frame is loaded once and only hidden when another tab is open, so the farmer's place is kept.
(function () {
  'use strict';

  const tabButtons = Array.from(document.querySelectorAll('.tab'));
  const panels = {
    home: document.getElementById('tab-home'),
    details: document.getElementById('tab-details'),
    simulation: document.getElementById('tab-simulation'),
    about: document.getElementById('tab-about'),
  };
  const frame = document.getElementById('sim-frame');
  const header = document.querySelector('.site-header');

  // The simulation fills the screen below the header, so it needs the header's real height.
  function measureHeader() {
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  }
  measureHeader();
  if (window.ResizeObserver) new ResizeObserver(measureHeader).observe(header);
  else window.addEventListener('resize', measureHeader);
  // The Project Details chip bar can wrap to more rows; jump targets need its real height too.
  const tocBar = document.querySelector('.toc-bar');
  function measureToc() {
    if (tocBar && tocBar.offsetHeight) document.documentElement.style.setProperty('--toc-h', tocBar.offsetHeight + 'px');
  }
  measureToc();
  if (tocBar && window.ResizeObserver) new ResizeObserver(measureToc).observe(tocBar);
  else window.addEventListener('resize', measureToc);

  // Additions to the simulator page, made from here (the frame is on the same site) so the simulator's
  // own file is left untouched:
  //  - sim-backdrop.css: the dimmed field photo behind the farm questionnaire
  //  - sim-guide.css + sim-guide.js: the guided tutorial shown after the questionnaire
  //  - each visit starts with the questionnaire: a returning farmer sees their saved answers to check
  const loading = document.getElementById('sim-loading');
  frame.addEventListener('load', () => {
    if (loading && frame.getAttribute('src')) loading.hidden = true;
    try {
      const doc = frame.contentDocument;
      if (!doc || doc.getElementById('fieldshift-backdrop')) return;
      const questions = doc.getElementById('fs-setup');
      const farmButton = doc.getElementById('fs-farm-btn');
      const fromCounty = /[?&]county=/.test(frame.getAttribute('src') || '');   // opened from one of the 14 example farms: go straight to the farm
      if (!fromCounty && questions && questions.hidden && farmButton) farmButton.click(); // opens the questionnaire at the review of saved answers
      const at = (file) => new URL(file, location.href).href;
      const addStyle = (id, file) => {
        const link = doc.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.href = at(file);
        doc.head.appendChild(link);
      };
      addStyle('fieldshift-backdrop', 'sim-backdrop.css');
      addStyle('fieldshift-guide-style', 'sim-guide.css');
      const script = doc.createElement('script');
      script.id = 'fieldshift-guide';
      script.src = at('sim-guide.js');
      doc.body.appendChild(script);
      // When the server has no Gemini key, the 30-day panel would print "The AI helper is off."
      // Hide only that line (and the "could not" variants): the forecast, warnings and harvest estimate stay.
      const hideAiOff = () => {
        doc.querySelectorAll('#fs-outlook .fs-ol-faint').forEach((p) => {
          if (/^The AI helper (is off|could not)/.test(p.textContent.trim())) p.hidden = true;
        });
      };
      const outlook = doc.getElementById('fs-outlook');
      if (outlook) new MutationObserver(hideAiOff).observe(outlook, { childList: true, subtree: true });
      hideAiOff();
    } catch (e) { /* the simulation still works without the photo and the guide */ }
  });

  function showTab(name, focus) {
    if (!panels[name]) return;
    tabButtons.forEach((btn) => {
      const active = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
      if (active && focus) btn.focus();
    });
    Object.keys(panels).forEach((key) => { panels[key].hidden = key !== name; });
    document.body.classList.toggle('on-sim', name === 'simulation');

    // Load the simulation the first time its tab is opened.
    if (name === 'simulation' && !frame.getAttribute('src')) frame.setAttribute('src', frame.dataset.src);
    window.scrollTo(0, 0);
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  }

  tabButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      showTab(tabButtons[(i + dir + tabButtons.length) % tabButtons.length].dataset.tab, true);
    });
  });

  // The 14 example farms: open that county's farm in the simulator (the frame reloads with ?county=<id>).
  document.querySelectorAll('.farm-link[data-county]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const src = frame.dataset.src + '?county=' + encodeURIComponent(a.dataset.county);
      showTab('simulation');
      if (frame.getAttribute('src') !== src) { if (loading) loading.hidden = false; frame.setAttribute('src', src); }
    });
  });

  // Project details: the "on this page" chips scroll to their section (the address bar keeps #details).
  document.querySelectorAll('[data-jump]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const target = document.getElementById(a.dataset.jump);
      if (!target) return;
      e.preventDefault();
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      settle(target);
    });
  });

  // Pictures above a section can finish loading while the page scrolls and push it down: check again once the scroll ends.
  function settle(target) {
    let n = 0;
    const again = () => {
      const want = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      if (Math.abs(target.getBoundingClientRect().top - want) > 24 && n++ < 3) { target.scrollIntoView({ block: 'start' }); setTimeout(again, 400); }
    };
    setTimeout(again, 900);
  }

  // Links from Home to one section of Project details: open the tab, then scroll to the section.
  document.querySelectorAll('[data-go-section]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      showTab('details');
      const target = document.getElementById(a.dataset.goSection);
      if (target) requestAnimationFrame(() => { target.scrollIntoView({ block: 'start' }); settle(target); });
    });
  });

  document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => showTab(el.dataset.go));
  });

  const initial = location.hash.replace('#', '');
  if (panels[initial]) showTab(initial);
})();

// Home page showcase: the photo / map slider and the season film strip.
(function () {
  'use strict';
  const box = document.getElementById('compare');
  const range = document.getElementById('compare-range');
  if (box && range) {
    const set = () => box.style.setProperty('--pos', range.value + '%');
    range.addEventListener('input', set);
    set();
  }

  // Film strip: when motion is allowed, one frame after another is lit while the strip is on screen.
  const strip = document.querySelector('#strip .strip');
  if (!strip || !('IntersectionObserver' in window)) return;
  const frames = Array.from(strip.children);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let timer = null, at = 0, paused = false;
  const light = () => {
    frames.forEach((f, i) => f.classList.toggle('is-on', i === at));
    at = (at + 1) % frames.length;
  };
  const stop = () => { clearInterval(timer); timer = null; strip.classList.remove('is-animating'); frames.forEach((f) => f.classList.remove('is-on')); };
  const start = () => {
    if (timer || paused || reduce.matches) return;
    strip.classList.add('is-animating'); light();
    timer = setInterval(light, 1600);
  };
  let visible = false;
  new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; visible ? start() : stop(); }, { threshold: 0.3 }).observe(strip);
  const hold = (on) => { paused = on; if (on) stop(); else if (visible) start(); };
  const scroller = document.getElementById('strip');
  ['mouseenter', 'focusin', 'touchstart'].forEach((ev) => scroller.addEventListener(ev, () => hold(true), { passive: true }));
  ['mouseleave', 'focusout'].forEach((ev) => scroller.addEventListener(ev, () => hold(false)));
  reduce.addEventListener && reduce.addEventListener('change', () => { reduce.matches ? stop() : (visible && start()); });
})();
