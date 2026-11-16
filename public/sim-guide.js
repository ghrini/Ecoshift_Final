// EcoShift guided tutorial for the simulator (Shaurya's EcoShift simulator in ./deepdive).
// Order on the site: the farm questionnaire, then this guide, then the simulation.
// The guide opens by itself when the farmer finishes the questionnaire, once per visit,
// and walks through every part of the simulator, one at a time, in plain language.
//
// Built for farmers who are older or have a disability:
//  - large text and large buttons, high contrast
//  - works with the keyboard alone (Enter or Right arrow = next, Left arrow = back, Escape = stop)
//  - works with screen readers (it is announced as a dialog and each step is read out)
//  - optional "Read aloud" using the browser's own voice
//
// The site's app.js adds this script to the simulator page, so the simulator's own file stays unchanged.
(function () {
  "use strict";
  if (window.__fieldshiftGuide) return;
  window.__fieldshiftGuide = true;

  var SPEAK_KEY = "fieldshift.guideSpeak";

  // Every word the guide shows. The simulator is in English, so the guide is too.
  var L = {
    introTitle: "A Short Guide Before You Start",
    introText: "This guide shows you each part of the simulator, one at a time. It takes about two minutes. You can stop it whenever you like.",
    start: "Start The Guide",
    skip: "Skip The Guide",
    next: "Next",
    back: "Back",
    done: "Finish",
    stop: "Stop The Guide",
    readAloud: "Read Aloud",
    readAloudOn: "Reading aloud is on",
    stepOf: "Step {n} of {total}",
    launch: "How To Use This Page",
    keys: "Keyboard: Enter for next, Left arrow for back, Escape to stop.",
    s1t: "Your Farm",
    s1: "This shows the farm you described in the questions. Press Change to look at your answers or change them.",
    s2t: "Run The Simulation",
    s2: "After you change any setting, press Run Simulation. The results below then update.",
    s3t: "Weather And Season",
    s3: "Press here to open it. You can replay a past season, or make every year warmer or cooler, and wetter or drier.",
    s4t: "Crops",
    s4: "Press here to open it. Choose the plan for next season on each field, how many acres to try it on, and the planting date.",
    s5t: "Prices And Other Conditions",
    s5: "Press here to open it. Set crop and fertilizer prices, how much you have already sold, cover-crop cost-share, and how the options are ranked.",
    s6t: "Your Fields From Above",
    s6: "This picture shows your fields. The colours show what is growing: corn, soybeans, rye, oats or bare ground. Press Fields to see the list of your fields.",
    s7t: "Simulation Or Farm Map",
    s7: "These two buttons switch the picture between the simulation and a drawn map of your farm from above.",
    s8t: "Play The Season",
    s8: "Press Play to watch the season week by week. Drag the slider to go to any week. The speed button makes it play faster or slower.",
    s9t: "Your Results",
    s9: "This tells you how your farm does in a normal year: how much of a normal crop you get, and what it earns.",
    s10t: "Every Season Since 1982",
    s10: "Each small square is one real season of weather on your farm. Olive means a good season, brown means a bad one, and grey means about normal. Press a square to see that season.",
    s11t: "Ask In Your Own Words",
    s11: "Type a what-if, for example: What if July is very dry? Then press Send. The answers also compare the options for each field. Press More to read about an option.",
    s12t: "The Next 30 Days",
    s12: "This shows the weather forecast for your farm, warnings like frost or heavy rain, and a first guess at next year's harvest. Days 17 to 30 are only a rough guess.",
    s13t: "Make A Box Bigger",
    s13: "This button makes a box fill the screen, which is easier to read. Press it again to make it small. Most boxes have one.",
    endTitle: "You Are Ready",
    endText: "That is every part of the simulator. It helps you compare options. Check with someone local before you decide. To see this guide again, press \"How To Use This Page\" at the top of the screen."
  };

  // Each step points at one part of the simulator. Several parts can be named, separated by commas.
  var STEPS = [
    { t: "s1t", x: "s1", target: "#fs-farm-btn" },
    { t: "s2t", x: "s2", target: "#fs-run" },
    { t: "s3t", x: "s3", target: "#fs-ctl-weather" },
    { t: "s4t", x: "s4", target: "#fs-ctl-crops" },
    { t: "s5t", x: "s5", target: "#fs-ctl-other" },
    { t: "s6t", x: "s6", target: "#fs-view .fv-stage" },
    { t: "s7t", x: "s7", target: ".fs-fm-tabs" },
    { t: "s8t", x: "s8", target: "#fs-view .fv-bar" },
    { t: "s9t", x: "s9", target: "#fs-analysis" },
    { t: "s10t", x: "s10", target: "#fs-analysis .fs-strip" },
    { t: "s11t", x: "s11", target: "#fs-chat" },
    { t: "s12t", x: "s12", target: "#fs-outlook > .fs-panel-head" },
    { t: "s13t", x: "s13", target: "#fs-analysis .fs-expand" },
    { t: "endTitle", x: "endText", target: null }
  ];

  var index = -1;                // -1 = intro, 0.. = steps
  var open = false;
  var shownThisVisit = false;    // opened by itself already on this visit
  var questionsWereOpen = false; // the farm questionnaire has been on screen on this visit
  var timer = 0;
  var els = {};
  var canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the guide still works */ } }
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (els.panel) return;
    els.shade = el("div", "fsg-shade");            // full dim behind the intro and the last step
    els.ring = el("div", "fsg-ring");              // highlight around the part being explained
    els.ring.setAttribute("aria-hidden", "true");
    els.shade.setAttribute("aria-hidden", "true");

    els.panel = el("div", "fsg-panel");
    els.panel.setAttribute("role", "dialog");
    els.panel.setAttribute("aria-labelledby", "fsgTitle");
    els.panel.setAttribute("aria-describedby", "fsgText");

    els.count = el("p", "fsg-count");
    els.title = el("h2", "fsg-title");
    els.title.id = "fsgTitle";
    els.title.tabIndex = -1;
    els.text = el("p", "fsg-text");
    els.text.id = "fsgText";
    els.keys = el("p", "fsg-keys");

    els.close = el("button", "fsg-close", "×");
    els.close.type = "button";
    els.close.addEventListener("click", function () { finish(); });

    var row = el("div", "fsg-row");
    els.back = el("button", "fsg-btn");
    els.back.type = "button";
    // On the intro this button reads "Skip the guide"; on later steps it goes back one step.
    els.back.addEventListener("click", function () { index === -1 ? finish() : go(index - 1); });
    els.next = el("button", "fsg-btn fsg-primary");
    els.next.type = "button";
    els.next.addEventListener("click", function () { index >= STEPS.length - 1 ? finish() : go(index + 1); });
    els.speak = el("button", "fsg-btn fsg-speak");
    els.speak.type = "button";
    els.speak.addEventListener("click", toggleSpeak);
    row.appendChild(els.back);
    row.appendChild(els.next);
    if (canSpeak) row.appendChild(els.speak);

    els.panel.appendChild(els.close);
    els.panel.appendChild(els.count);
    els.panel.appendChild(els.title);
    els.panel.appendChild(els.text);
    els.panel.appendChild(row);
    els.panel.appendChild(els.keys);
    els.panel.addEventListener("keydown", onKey);

    // The button that opens the guide again. It is put in the simulator's top bar by check().
    els.launch = el("button", "fsg-launch", L.launch);
    els.launch.type = "button";
    els.launch.hidden = true;
    els.launch.addEventListener("click", function () { start(); });

    document.body.appendChild(els.shade);
    document.body.appendChild(els.ring);
    document.body.appendChild(els.panel);
    els.shade.hidden = els.ring.hidden = els.panel.hidden = true;
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); return; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); index >= STEPS.length - 1 ? finish() : go(index + 1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); if (index < STEPS.length - 1) go(index + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); if (index > -1) go(index - 1); }
    // Keep the Tab key inside the guide while it is open, so keyboard users are not lost behind it.
    if (e.key === "Tab") {
      var f = Array.prototype.filter.call(els.panel.querySelectorAll("button"), function (b) { return !b.hidden && !b.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === els.title)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function speaking() { return canSpeak && store.get(SPEAK_KEY) === "1"; }

  function say(text) {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
    if (!speaking()) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = "en";
    u.rate = 0.9; // a little slower than normal speech
    window.speechSynthesis.speak(u);
  }

  function toggleSpeak() {
    store.set(SPEAK_KEY, speaking() ? "0" : "1");
    paintSpeak();
    if (speaking()) say(els.title.textContent + ". " + els.text.textContent);
    else if (canSpeak) window.speechSynthesis.cancel();
  }

  function paintSpeak() {
    els.speak.textContent = speaking() ? L.readAloudOn : L.readAloud;
    els.speak.setAttribute("aria-pressed", String(speaking()));
  }

  // The box (in screen coordinates) around the part this step explains.
  function targetBox() {
    var s = STEPS[index];
    if (!s || !s.target) return null;
    var list = document.querySelectorAll(s.target), box = null;
    for (var i = 0; i < list.length; i++) {
      var b = list[i].getBoundingClientRect();
      if (!list[i].getClientRects().length || (b.width === 0 && b.height === 0)) continue;
      box = box ? { top: Math.min(box.top, b.top), left: Math.min(box.left, b.left), right: Math.max(box.right, b.right), bottom: Math.max(box.bottom, b.bottom) }
                : { top: b.top, left: b.left, right: b.right, bottom: b.bottom };
      if (s.target.indexOf(",") < 0) break; // a single part: the first one on screen
    }
    return box;
  }

  // Keep the highlight on the part being explained, even when the page scrolls or redraws,
  // and move the guide box aside when it would sit on top of that part.
  function place() {
    if (!open) return;
    var r = targetBox(), pad = 8;
    els.panel.classList.remove("fsg-left", "fsg-right", "fsg-top", "fsg-under");
    els.panel.style.top = els.panel.style.maxHeight = "";
    if (!r) { els.ring.hidden = true; els.shade.hidden = false; return; }
    els.shade.hidden = true;
    els.ring.hidden = false;
    els.ring.style.top = (r.top + window.scrollY - pad) + "px";
    els.ring.style.left = (r.left + window.scrollX - pad) + "px";
    els.ring.style.width = (r.right - r.left + pad * 2) + "px";
    els.ring.style.height = (r.bottom - r.top + pad * 2) + "px";

    var vw = window.innerWidth, vh = window.innerHeight, pw = els.panel.offsetWidth, ph = els.panel.offsetHeight;
    var boxLeft = (vw - pw) / 2, boxTop = vh - ph - 16;
    var covered = r.bottom + pad > boxTop && r.right + pad > boxLeft && r.left - pad < boxLeft + pw;
    if (covered) {
      if (r.left - pad > pw + 32) els.panel.classList.add("fsg-left");
      else if (vw - r.right - pad > pw + 32) els.panel.classList.add("fsg-right");
      else if (r.top - pad > ph + 32) els.panel.classList.add("fsg-top");
      else {
        // A short screen: put the guide just under the part, and let the guide scroll inside if it must.
        var under = Math.round(r.bottom + pad + 8), room = vh - under - 8;
        if (room >= 150) {
          els.panel.classList.add("fsg-under");
          els.panel.style.top = under + "px";
          els.panel.style.maxHeight = room + "px";
        }
      }
    }
  }

  function go(i) {
    index = Math.max(-1, Math.min(STEPS.length - 1, i));
    var intro = index === -1, last = index === STEPS.length - 1;
    var s = STEPS[index];

    els.panel.classList.toggle("fsg-center", intro || last);
    els.count.textContent = intro ? "" : L.stepOf.replace("{n}", index + 1).replace("{total}", STEPS.length);
    els.count.hidden = intro;
    els.title.textContent = intro ? L.introTitle : L[s.t];
    els.text.textContent = intro ? L.introText : L[s.x];
    els.back.textContent = intro ? L.skip : L.back;
    els.next.textContent = intro ? L.start : last ? L.done : L.next;
    els.close.setAttribute("aria-label", L.stop);
    els.close.title = L.stop;
    els.keys.textContent = L.keys;
    paintSpeak();

    var box = targetBox();
    if (box) {
      // Jump straight to the part, near the top of the screen. Gliding is harder to follow and can lag on slow phones.
      window.scrollTo(0, Math.max(0, box.top + window.scrollY - 24));
    }
    place();
    els.title.focus({ preventScroll: true });
    say(els.title.textContent + ". " + els.text.textContent);
  }

  function start() {
    if (open || !onSimulator()) return;
    build();
    open = true;
    document.body.classList.add("fsg-open");
    els.panel.hidden = false;
    go(-1);
    timer = setInterval(place, 250);
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
  }

  function finish() {
    if (!open) return;
    open = false;
    clearInterval(timer);
    window.removeEventListener("scroll", place);
    window.removeEventListener("resize", place);
    if (canSpeak) window.speechSynthesis.cancel();
    document.body.classList.remove("fsg-open");
    els.shade.hidden = els.ring.hidden = els.panel.hidden = true;
    window.scrollTo(0, 0);
    if (!els.launch.hidden && els.launch.isConnected) els.launch.focus({ preventScroll: true });
  }

  // The simulator is on screen when its farm questionnaire is closed.
  function questionsOpen() { var q = document.getElementById("fs-setup"); return !!(q && !q.hidden); }
  function onSimulator() { return !!document.getElementById("fs-app") && !questionsOpen(); }

  function check() {
    build();
    if (questionsOpen()) {
      questionsWereOpen = true;
      if (open) finish();
      els.launch.hidden = true;
      return;
    }
    if (!onSimulator()) return;
    // Put the button in the simulator's top bar, next to "Your farm".
    var farm = document.getElementById("fs-farm-btn"), header = document.getElementById("fs-header");
    var home = farm ? farm.parentNode : header;
    if (home && els.launch.parentNode !== home) {
      if (farm) home.insertBefore(els.launch, farm); else home.appendChild(els.launch);
    }
    els.launch.hidden = false;
    // Questionnaire first, then this guide, then the simulation: open it when the questions close.
    if (questionsWereOpen && !shownThisVisit) {
      shownThisVisit = true;
      setTimeout(start, 300); // let the simulator finish drawing first
    }
  }

  function init() {
    build();
    var q = document.getElementById("fs-setup");
    if (q) new MutationObserver(check).observe(q, { attributes: true, attributeFilter: ["hidden"] });
    check();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
