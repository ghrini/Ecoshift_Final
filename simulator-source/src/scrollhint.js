/* "Scroll down for more" / "Scroll up for more": a small note at the bottom or top of any panel that has more to read out of view
   (Sim analysis, Chat, or any other panel body once it overflows). Pressing a note scrolls that way by most of a screenful. */
(function () {
  'use strict';
  var FS = window.FS = window.FS || {};
  var boxes = [];

  function attach(box) {
    if (box.__hint) return;
    var host = box.parentElement; if (!host) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    function mk(dir) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fs-scrollhint fs-scrollhint-' + dir; b.hidden = true; b.tabIndex = -1;
      b.innerHTML = '<span aria-hidden="true">' + (dir === 'up' ? '↑' : '↓') + '</span> Scroll ' + dir + ' for more';
      b.addEventListener('click', function () { box.scrollBy({ top: (dir === 'up' ? -1 : 1) * box.clientHeight * 0.8, behavior: 'smooth' }); });
      host.appendChild(b); return b;
    }
    var h = box.__hint = { up: mk('up'), down: mk('down') };
    function update() {
      var over = /(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 4;
      var top = box.offsetTop, bottom = top + box.offsetHeight;
      h.up.style.top = (top - 2) + 'px';           // just outside the text box (above it / below it), so the note never covers words
      h.down.style.top = (bottom + 2) + 'px';
      h.up.hidden = !(over && box.scrollTop > 4);
      h.down.hidden = !(over && box.scrollTop + box.clientHeight < box.scrollHeight - 4);
    }
    box.addEventListener('scroll', update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(box);
    new MutationObserver(function () { requestAnimationFrame(update); }).observe(box, { childList: true, subtree: true, characterData: true });
    boxes.push(update); update();
  }
  function scan() { Array.prototype.forEach.call(document.querySelectorAll('.fs-panel-body'), attach); boxes.forEach(function (u) { u(); }); }

  // ---------------------------------------------------------------- the whole page, when the farmer is idle
  // After a few seconds with no scrolling, typing, pointer or touch, a small note fades in at the bottom of the screen
  // ("Scroll down for more") and/or the top ("Scroll up for more") when the page has more in that direction.
  // Any activity hides them again. Not shown while the farm questions or the guide are open, or when the page fits the screen.
  var IDLE_MS = 4000, idleTimer = 0, page = null;
  function pageStyle() {
    var s = document.createElement('style');
    s.textContent =
      // one small pill in the bottom-right corner, so it never sits over a heading in the middle of the screen
      '.fs-pagehint{position:fixed;right:max(16px,env(safe-area-inset-right,0px));bottom:max(16px,env(safe-area-inset-bottom,0px));z-index:900;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;' +
      'border-radius:999px;border:1px solid var(--accent-edge,#b07648);background:var(--panel-2,#262626);color:var(--text,#f4f4f2);' +
      'font:600 15px var(--font-sans,system-ui);white-space:nowrap;box-shadow:var(--shadow-pop,0 4px 16px rgba(0,0,0,.5));cursor:pointer;opacity:0;pointer-events:none;transition:opacity .35s ease}' +
      '.fs-pagehint.is-on{opacity:1;pointer-events:auto}' +
      '.fs-pagehint.is-left{right:auto;left:max(16px,env(safe-area-inset-left,0px))}' +
      '.fs-pagehint:focus-visible{outline:2px solid var(--focus-edge,#9E6438);outline-offset:3px}' +
      '.fs-pagehint i{font-style:normal;color:var(--accent-strong,#D3AF7C)}' +
      '@media (prefers-reduced-motion:no-preference){.fs-pagehint.is-on i{animation:fs-pagehint-bob 1.4s ease-in-out infinite}}' +
      '.fs-pagehint-up.is-on i{animation-direction:reverse}' +
      '@keyframes fs-pagehint-bob{0%,100%{transform:translateY(-2px)}50%{transform:translateY(3px)}}' +
      '@media (max-width:600px){.fs-pagehint{font-size:14px;padding:7px 12px}}';
    document.head.appendChild(s);
  }
  function pageHints() {
    pageStyle();
    function mk(dir) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fs-pagehint fs-pagehint-' + dir; b.tabIndex = -1;
      b.setAttribute('aria-hidden', 'true');   // a visual nudge only: keyboard and screen-reader users already move through the page in order
      b.innerHTML = '<i aria-hidden="true">' + (dir === 'up' ? '↑' : '↓') + '</i> ' + (dir === 'up' ? 'More above' : 'More below');
      b.addEventListener('click', function () { window.scrollBy({ top: (dir === 'up' ? -1 : 1) * window.innerHeight * 0.8, behavior: 'smooth' }); hide(); });
      document.body.appendChild(b); return b;
    }
    page = { up: mk('up'), down: mk('down') };
  }
  function blocked() {
    var q = document.getElementById('fs-setup');
    return (q && !q.hidden) || document.body.classList.contains('fsg-open') || !!document.querySelector('.fs-panel.fs-expanded');
  }
  function hide() { if (!page) return; page.up.classList.remove('is-on'); page.down.classList.remove('is-on'); }
  // Something the farmer can press (a button, link, field or the chat box) under the spot where the note would sit?
  var PRESSABLE = 'button, a[href], input, textarea, select, summary, label, [role="button"], [contenteditable="true"], .fs-panel-head';
  function coversControl(b) {
    var r = b.getBoundingClientRect(), pts = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
    return pts.some(function (p) {
      return (document.elementsFromPoint ? document.elementsFromPoint(p[0], p[1]) : []).some(function (el) {
        return !el.classList.contains('fs-pagehint') && !el.closest('.fs-pagehint') && !!el.closest(PRESSABLE);
      });
    });
  }
  function showIdle() {
    if (!page || document.hidden) return;
    if (blocked()) { clearTimeout(idleTimer); idleTimer = setTimeout(showIdle, IDLE_MS); return; }   // try again once the questions or the guide close
    var y = window.scrollY || document.documentElement.scrollTop, max = document.documentElement.scrollHeight - window.innerHeight;
    if (max < 40) return;
    // one at a time: "More below" until near the bottom, then "More above"
    var more = y < max - 120, b = more ? page.down : (y > 120 ? page.up : null);
    hide(); if (!b) return;
    // bottom-right first, then bottom-left; if both would cover something to press (the chat's Send, a header), stay hidden
    b.classList.remove('is-left');
    if (coversControl(b)) { b.classList.add('is-left'); if (coversControl(b)) { b.classList.remove('is-left'); return; } }
    b.classList.add('is-on');
  }
  // moving the pointer only restarts the clock (so a shown note can still be reached and pressed); scrolling, typing or tapping hides it
  function active(e) {
    var onHint = e && e.target && e.target.closest && e.target.closest('.fs-pagehint');
    if (!(e && e.type === 'pointermove') && !onHint) hide();
    clearTimeout(idleTimer); idleTimer = setTimeout(showIdle, IDLE_MS);
  }

  function start() {
    scan(); window.addEventListener('resize', scan); setTimeout(scan, 1500);
    pageHints();
    // capture phase: still heard when another part of the page stops the event (the guide stops Escape)
    ['scroll', 'wheel', 'pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, active, { passive: true, capture: true }); });
    active();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
  FS.scrollHints = { refresh: scan };
})();
