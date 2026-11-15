/* Tiny shared store + actions. Every module reads FS.store.get() and listens with FS.store.on(event, fn).
   Modules change state ONLY through FS.actions so every change emits an event.
   Events:
     'controls:change'  {path, value, source}     a control changed (source: 'ui' | 'chat')
     'field:select'     {id, source}               a field was selected (map click, crops box, chat)
     'sim:start'        {source, label}
     'sim:done'         result                     a run finished; result format in CONTRACT.md
     'chat:message'     {role, text, html?, actions?}  a chat message was added (role: 'assistant' | 'user')
*/
window.FS = window.FS || {};
(function () {
  'use strict';
  var listeners = {};
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var state = {
    farm: FS.data.farm,
    controls: clone(FS.data.initialControls),
    selectedField: FS.data.farm.fields[1].id,
    runs: [],          // every result, oldest first
    current: null,     // latest result
    baseline: null,    // current plans under the same conditions as the latest run (typical year at startup)
    dirty: true,       // controls changed since the last run
    chat: []           // {role, text, html?}
  };

  FS.store = {
    get: function () { return state; },
    on: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit: function (evt, payload) { (listeners[evt] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error(evt, e); } }); },
    snapshot: function () { return clone(state.controls); }
  };

  function setPath(obj, path, value) {
    var keys = path.split('.'), o = obj;
    for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }
  function getPath(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }

  FS.actions = {
    // path examples: 'weather.scenario', 'weather.tempShift', 'crops.plans.creek', 'crops.trialAcres.creek', 'other.priceChange'
    setControl: function (path, value, source) {
      if (getPath(state.controls, path) === value) return;
      setPath(state.controls, path, value);
      state.dirty = true;
      FS.store.emit('controls:change', { path: path, value: value, source: source || 'ui' });
    },
    getControl: function (path) { return getPath(state.controls, path); },
    selectField: function (id, source) {
      if (state.selectedField === id) return;
      state.selectedField = id;
      FS.store.emit('field:select', { id: id, source: source || 'ui' });
    },
    // Runs the engine on the current controls. Returns the result.
    runSimulation: function (source, label) {
      FS.store.emit('sim:start', { source: source || 'ui', label: label || null });
      // "vs your current plan" means: the same weather, prices and costs, but every field on its current plan.
      // So each run first computes that same-conditions baseline, then the run itself.
      var controls = FS.store.snapshot(), base = clone(controls);
      base.crops.plans = clone(FS.data.initialControls.crops.plans);
      base.crops.trialAcres = clone(FS.data.initialControls.crops.trialAcres);
      state.baseline = FS.engine.run({ farm: state.farm, controls: base, baseline: null });
      var result = FS.engine.run({ farm: state.farm, controls: controls, baseline: state.baseline });
      result.runId = state.runs.length + 1;
      result.label = label || result.label || ('Run ' + result.runId);
      result.source = source || 'ui';
      state.runs.push(result);
      state.current = result;
      state.dirty = false;
      FS.store.emit('sim:done', result);
      return result;
    },
    addChat: function (msg) {
      state.chat.push(msg);
      FS.store.emit('chat:message', msg);
    }
  };

  // Baseline: the farmer's current plans in a typical year. Computed once the engine is loaded (see app.js).
  FS.computeBaseline = function () {
    var c = clone(FS.data.initialControls);
    state.baseline = FS.engine.run({ farm: state.farm, controls: c, baseline: null });
    return state.baseline;
  };
})();
