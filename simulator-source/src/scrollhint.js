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
      h.up.style.top = (top + 6) + 'px';
      h.down.style.top = (bottom - 6) + 'px';
      h.up.hidden = !(over && box.scrollTop > 4);
      h.down.hidden = !(over && box.scrollTop + box.clientHeight < box.scrollHeight - 4);
    }
    box.addEventListener('scroll', update, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(update).observe(box);
    new MutationObserver(function () { requestAnimationFrame(update); }).observe(box, { childList: true, subtree: true, characterData: true });
    boxes.push(update); update();
  }
  function scan() { Array.prototype.forEach.call(document.querySelectorAll('.fs-panel-body'), attach); boxes.forEach(function (u) { u(); }); }

  function start() { scan(); window.addEventListener('resize', scan); setTimeout(scan, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else setTimeout(start, 0);
  FS.scrollHints = { refresh: scan };
})();
