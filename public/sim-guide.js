// EcoShift guided tutorial for the simulator (Shaurya's EcoShift simulator in ./deepdive).
// Order on the site: the farm questionnaire, then this guide, then the simulation.
// The guide opens by itself when the farmer finishes the questionnaire, once per visit,
// and also from the "How To Use This Page" button in the simulator's top bar.
// It walks through every part of the simulator, one at a time, in plain language (about 20 steps, 3 minutes):
//  your farm and language, Run, importing your real field outlines (the Import Field button in the Simulation panel), the Weather /
//  Crops / Prices & Costs settings bar, the field picture and Play bar, the three views (Simulation, Farm Map with "Use my own photo",
//  Advanced Near-Real-Time Conditions), the results and season strip, the chat, the Next 30 Days panel, and the
//  Make A Box Bigger button.
//
// Built for farmers who are older or have a disability:
//  - large text and large buttons, high contrast
//  - works with the keyboard alone (Enter or Right arrow = next, Left arrow = back, Escape = stop)
//  - works with screen readers (it is announced as a dialog and each step is read out)
//  - optional "Read aloud" using the browser's own voice
//
// The guide only points at things; it never presses a button or changes the page. Parts that sit behind a tab
// (the Farm Map and the live conditions) are explained while the tab button itself is highlighted, because opening
// those views starts slow server work (aerial photos, satellite checks). The same goes for Next 30 Days: it stays folded and its
// title line is highlighted, because opening it fetches the forecast. The settings panels and the import panel are only opened to be
// shown (a step's open() hook) and are closed again when the step changes. A step marked "optional" is left out
// when its part is not on the page (for example the language picker when the page is opened as a file).
// Text is set in English; the simulator's language module (src/i18n.js) translates whatever text appears on the
// page, so this guide is shown in the farmer's language too.
//
// The site's app.js adds this script to the simulator page, so the simulator's own file stays unchanged.
(function () {
  "use strict";
  if (window.__fieldshiftGuide) return;
  window.__fieldshiftGuide = true;

  var SPEAK_KEY = "fieldshift.guideSpeak";

  // Every word the guide shows, in English. The language picker translates it with the rest of the page.
  var L = {
    introTitle: "A Short Guide Before You Start",
    introText: "This simulator lets you try a change on your farm before you spend a dollar or plant a seed, using 44 years of real NASA weather. This guide shows you each part, one at a time. It takes about three minutes, and you can stop it whenever you like.",
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
    farmT: "Your Farm",
    farm: "This shows the farm you described in the questions. Press Change to look at your answers or change them. After you import your own fields, it names them here.",
    langT: "Your Language",
    lang: "Choose your language here and the whole page is shown in it, this guide too. You can type your questions in your own language as well.",
    runT: "Run The Simulation",
    run: "After you change any setting, press Run Simulation. A small dot on the button means you have changes that have not run yet. The results then update.",
    impT: "Import Your Field",
    imp: "Use your real fields instead of the example ones. Press Import Field, above the map, and a small panel opens. Drop a file with your field outlines in its box, or press the box to choose one. Google Earth files (.kml) work, and so do .geojson and .json files from farm software like John Deere Operations Center or Climate FieldView, geojson.io or QGIS. Any shape works: curved edges, round center pivots, and fields with a pond or yard cut out of the middle. Up to 4 fields and 5 MB.",
    impDoneT: "What You Get From Your File",
    impDone: "No file? Press Iowa sample or California sample to try one. After 10 to 40 seconds, the simulation runs on your exact fields. It uses 44 seasons of NASA weather for your spot, the slope and height inside each field, the USDA soil in each field, and your county's harvests. The chat lists what was found. To go back to the example farm, press Reset Simulation, which shows up in this panel after an import.",
    weatherT: "Weather",
    weather: "Press Weather to open its settings. Pick a Quick Picks button, such as Historical Drought, or pick one past season. Press More Options to make every year warmer or cooler, and wetter or drier. Press Weather again to close it. Only one settings panel is open at a time.",
    cropsT: "Crops",
    crops: "Press Crops to open it. Choose a field and the plan for next season. Press More Options to set how many acres to try it on, the planting date, and the irrigation if your farm can water its crops.",
    otherT: "Prices And Costs",
    other: "Press Prices & Costs to open it. Set the crop price and how the options are ranked. Press More Options for the fertilizer price, how much you have already sold, and cover-crop cost-share. Each panel has a Reset button to put it back.",
    viewT: "Your Fields From Above",
    view: "This picture shows your fields. The colours show what is growing: corn, soybeans, rye, oats or bare ground. Press Fields to see the list, and press a field to pick it. The Add field and minus buttons change how many fields you have, up to four.",
    playT: "Play The Season",
    play: "Press Play to watch the season week by week. Drag the slider to go to any week. The marks on the line show events like a dry spell; press one to jump there. The speed button makes it play faster or slower.",
    tabsT: "Three Views",
    tabs: "These three buttons change what the big box shows: the season simulation, a map of your farm, and the conditions on your fields today. Press Simulation to come back here at any time.",
    mapT: "Farm Map And Your Own Photo",
    map: "Press Farm Map to see your farm drawn from above, made from a US aerial photo or a satellite image. Switch between Illustrated Map and Photo It Was Drawn From. Have a drone or aerial photo of your farm? Press Use my own photo and the map is drawn from it.",
    nowT: "Conditions On Your Fields Today",
    now: "Press Advanced Near-Real-Time Conditions to check your fields today. It shows the weather now and for the next days, how wet the soil is compared to normal, the air, and the soil's fertility. It also looks for NASA fire detections near your fields.",
    warnT: "Warnings And What To Do",
    warn: "In the same view, a map of your fields marks wet spots and puddles, low ground, bare soil, weak growth and burned ground, with numbered warnings and what to do about each. Field health this season shows how each crop is doing in satellite pictures. Press Check again for the newest news. While the view is open, it checks again by itself every 15 minutes.",
    resultsT: "Your Results",
    results: "The first lines give one answer per field: what to plant, and how it does in its worst year. Below that, how your farm does in a typical year: how much of a normal crop you get and what it earns. Press Show details to read more. Folds below hold About This Range, Costs And Profit, Crop Insurance and Where These Numbers Come From.",
    stripT: "Every Season Since 1982",
    strip: "Open See All 44 Years in Results. Each small square is one real season of weather on your farm. Olive means a good season, brown means a bad one, and grey means about normal. Press a square to see that season.",
    chatT: "Ask In Your Own Words",
    chat: "Type a question or a change, for example: What if July is very dry? Then press Send. The answers also compare the options for each field. Open Other Options For a field, then press More on an option to read about it. Under each answer, How This Answer Was Made shows which helpers worked on it.",
    outlookT: "The Next 30 Days",
    outlook: "This line is folded to keep the page short. Press it to open the weather forecast for your farm, warnings like frost or heavy rain, and a first guess at next year's harvest, which opens from Next Harvest. When the AI helper is on, a short note says what it means for you. Days 17 to 30 are only a rough guess.",
    bigT: "Make A Box Bigger",
    big: "This button makes a box fill the screen, which is easier to read. Press it again to make it small. Most boxes have one. When a box has more to read, a Scroll down for more note shows at its bottom; press it to see the rest.",
    endTitle: "You Are Ready",
    endText: "That is every part of the simulator. Try a few what-ifs: every one is free, and each shows you how a change would have done in real seasons on your fields. Take what you find to your adviser or seed dealer, so the plan you choose fits your farm. To see this guide again, press \"How To Use This Page\" at the top of the screen."
  };

  // Each step points at one part of the simulator. Several parts can be named, separated by commas.
  // optional: left out when its part is not on the page when the guide starts.
  var ALL_STEPS = [
    { t: "farmT", x: "farm", target: "#fs-farm-btn" },
    { t: "langT", x: "lang", target: "#fs-lang-top", optional: true },
    { t: "runT", x: "run", target: "#fs-run" },
    { t: "impT", x: "imp", target: "#fs-imp-btn, #fs-import .fs-imp-card", optional: true, open: openImport },
    { t: "impDoneT", x: "impDone", target: "#fs-imp-btn, #fs-import .fs-imp-card", optional: true, open: openImport },
    { t: "weatherT", x: "weather", target: "#fs-ctl-weather .fs-ctl-toggle, #fs-ctl-weather .fs-panel-body", open: function () { return openControls("weather"); } },
    { t: "cropsT", x: "crops", target: "#fs-ctl-crops .fs-ctl-toggle, #fs-ctl-crops .fs-panel-body", open: function () { return openControls("crops"); } },
    { t: "otherT", x: "other", target: "#fs-ctl-other .fs-ctl-toggle, #fs-ctl-other .fs-panel-body", open: function () { return openControls("other"); } },
    { t: "viewT", x: "view", target: "#fs-view .fv-stage" },
    { t: "playT", x: "play", target: "#fs-view .fv-bar" },
    { t: "tabsT", x: "tabs", target: ".fs-fm-tabs" },
    { t: "mapT", x: "map", target: ".fs-fm-tabs button[data-t=\"map\"]", optional: true },
    { t: "nowT", x: "now", target: ".fs-fm-tabs button[data-t=\"now\"]", optional: true },
    { t: "warnT", x: "warn", target: ".fs-fm-tabs button[data-t=\"now\"]", optional: true },
    { t: "resultsT", x: "results", target: "#fs-analysis" },
    { t: "stripT", x: "strip", target: "#fs-analysis .fs-strip-fold", open: openStrip },
    { t: "chatT", x: "chat", target: "#fs-chat", guideTop: true },
    { t: "outlookT", x: "outlook", target: "#fs-outlook > .fs-panel-head" },
    { t: "bigT", x: "big", target: "#fs-analysis .fs-expand" },
    { t: "endTitle", x: "endText", target: null }
  ];
  var STEPS = ALL_STEPS;         // the steps for this showing (set in start)

  // A step may open a panel of the simulator so its part is on screen (its open() hook). The hook returns a function that closes the
  // panel again (or null when the farmer already had it open); that runs when the step changes or the guide ends.
  function fsCall(mod, fn) {
    try { var F = window.FS, o = mod ? F && F[mod] : F, a = Array.prototype.slice.call(arguments, 2); if (o && typeof o[fn] === "function") o[fn].apply(o, a); } catch (e) { /* the part is simply not shown */ }
  }
  function openImport() {
    var b = document.getElementById("fs-imp-btn"), was = !!b && b.getAttribute("aria-expanded") === "true";
    fsCall("fieldImport", "open", true);
    return was ? null : function () { fsCall("fieldImport", "open", false); };
  }
  function openControls(k) {
    var box = document.getElementById("fs-ctl-" + k), was = !!box && !box.classList.contains("is-collapsed");
    fsCall("", "controlsOpen", k, true);
    return was ? null : function () { fsCall("", "controlsOpen", k, false); };
  }
  function openStrip() {
    var d = document.querySelector("#fs-analysis .fs-strip-fold"), was = !!d && d.open;
    if (d) d.open = true;
    return was || !d ? null : function () { d.open = false; };
  }
  var closer = null;
  function closeOpened() { var c = closer; closer = null; if (c) c(); }

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
    u.lang = document.documentElement.lang || "en"; // the page's language, set by the language picker
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
    // a step whose buttons sit at the bottom of the part (the chat's Send): keep the guide at the top so they stay visible
    if (covered && STEPS[index] && STEPS[index].guideTop) { els.panel.classList.add("fsg-top"); return; }
    if (covered) {
      if (r.left - pad > pw + 32) els.panel.classList.add("fsg-left");
      else if (vw - r.right - pad > pw + 32) els.panel.classList.add("fsg-right");
      else if (r.top - pad > ph + 32) els.panel.classList.add("fsg-top");
      else {
        // A short screen: put the guide just under the part, and let the guide scroll inside if it must.
        var under = Math.round(r.bottom + pad + 8), room = vh - under - 8;
        // only when the whole guide box (or most of a tall one) fits there, so Back and Next are never cut off;
        // otherwise it stays at the bottom of the screen, over the lower part of the highlighted area
        if (room >= Math.min(ph, 360)) {
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
    closeOpened();
    if (s && s.open) closer = s.open();

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
    // Read it out a moment later, so a translation already kept in this browser is read instead of the English.
    var shown = index;
    setTimeout(function () { if (open && index === shown) say(els.title.textContent + ". " + els.text.textContent); }, 60);
  }

  function start() {
    if (open || !onSimulator()) return;
    build();
    STEPS = ALL_STEPS.filter(function (s) { return !s.optional || document.querySelector(s.target); });
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
    closeOpened();
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
