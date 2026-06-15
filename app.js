/* ============================================================================
   PROPAGATOR — hothouse control surface (WebMIDI)
   The CC map is the contract with the firmware (see daisy repo
   docs/MIDI_PROTOCOL.md). Edit CONFIG to extend.
   ========================================================================== */
'use strict';

const CONFIG = {
  channel: 0,                       // MIDI channel (0-based)
  ccMode: [20, 21, 22, 23, 24, 25], // MODE-layer knobs 1..6
  ccFx:   [26, 27, 28, 29, 30, 31], // FX-layer knobs 1..6
  ccModeSelect: 16,                 // mode select (0/64/127 -> synth/granular/generative)
  ccFxSelect:   17,                 // FX select   (0/64/127 -> off/delay/reverb)
  ccSynth: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53],  // 0-7 voice, 8 wave, 9-12 LFO, 13 voices
  synthLabels: ['Detune', 'Sub', 'Sustain', 'Release', 'F.Env Amt', 'F.Env Time', 'Glide', 'Width'],
  modeOrder: ['synth', 'granular', 'generative'], // toggle 1: up / middle / down
  modeLabels: {
    synth:      ['Cutoff', 'Resonance', 'Attack', 'Decay', 'Mod Depth', 'Gen-mod Mix'],
    granular:   ['Grain Size', 'Density', 'Pitch', 'Pitch Spread', 'Scatter', 'Dry/Wet'],
    generative: ['Rate', 'Pitch Range', 'Tone', 'Decay', 'Randomness', 'LFO Depth'],
  },
  modeNotes: {
    synth:      'osc → moog filter → envelope · USB MIDI',
    granular:   'records input → grains · footswitch freeze',
    generative: 'self-playing krell · random-walk pitch',
  },
  fxLabels: ['Mix', 'Delay Time', 'Feedback', 'Tone', 'Reverb Decay', 'Reverb Damp'],
  fxOrder: ['Off', 'Delay', 'Reverb'],
  toggle2Labels: ['Wave A', 'Wave B', 'Wave C'],
  // Footswitch 2 action per mode (Footswitch 1 is always bypass/engage).
  fsActions: { synth: 'SUSTAIN', granular: 'FREEZE', generative: 'RE-SEED' },
};

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- DOM ---------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const stage     = $('#stage');
const wires     = $('#wires');
const annot     = $('#annot');
const knobsRow  = $('#knobs');
const fxKnobsEl = $('#fxKnobs');
const togglesEl = $('#toggles');
const stompsEl  = $('#stomps');
const midiPod   = $('#midiPod'), midiAct = $('#midiAct'), midiLast = $('#midiLast');

/* ---------- MIDI state ---------- */
let midi = null, midiOut = null, midiIn = null;
let thru = true;   // forward IN-device messages to the pedal (OUT)
// clock OFF by default: the pedal ignores incoming clock, and relaying a 24-PPQN
// stream floods its USB-MIDI input and can cause it to miss notes. (Beat sync in
// the web UI is unaffected — it reads clock locally, before this forward filter.)
const thruFilter = { notes: true, cc: true, other: true, clock: false };
let clockSync = true;                               // derive BPM + beat from incoming MIDI clock
let clockCount = 0, lastClockMs = 0, clockBpm = 0;  // MIDI clock tracking (24 PPQN)
let activeMode = 0;   // 0 synth / 1 granular / 2 generative
let activeFx = 0;     // 0 off / 1 delay / 2 reverb

const knobValue = {
  mode:  [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  fx:    [0.3, 0.4, 0.35, 0.7, 0.6, 0.7],
  // 0-7 voice · 8 wave · 9 LFO rate · 10 LFO depth · 11 LFO shape · 12 LFO dest · 13 voices(0.6->4)
  synth: [0.25, 0.40, 0.70, 0.30, 0.50, 0.30, 0.00, 0.60, 0.66, 0.30, 0.00, 0.00, 0.33, 0.60],
};

/* ===========================================================================
   KNOBS
   ========================================================================= */
function rotFor(v) { return -135 + v * 270; }

function makeKnob(bank, idx, label) {
  const k = el('div', 'knob');
  k.dataset.bank = bank; k.dataset.idx = idx;
  const dial = el('div', 'knob-dial');
  const ptr = el('span', 'knob-pointer');
  dial.appendChild(ptr);
  const lab = el('div', 'knob-label'); lab.textContent = label;
  const val = el('div', 'knob-val');
  k.append(dial, lab, val);
  const apply = () => {
    const v = knobValue[bank][idx];
    dial.style.setProperty('--rot', rotFor(v) + 'deg');
    val.textContent = String(Math.round(v * 127)).padStart(3, '0');
  };
  apply();
  attachKnobDrag(k, dial, bank, idx, apply, lab);
  k._apply = apply; k._label = lab;
  return k;
}

function attachKnobDrag(k, dial, bank, idx, apply, lab) {
  let startY = 0, startV = 0, dragging = false;
  const cc = (bank === 'mode' ? CONFIG.ccMode : bank === 'fx' ? CONFIG.ccFx : CONFIG.ccSynth)[idx];

  const showAnnot = (e) => {
    annot.hidden = false;
    annot.innerHTML = `<b>${lab.textContent}</b><br><span class="cc">CC ${cc}</span> · ${Math.round(knobValue[bank][idx]*127)}/127`;
    annot.style.left = e.clientX + 'px';
    annot.style.top = e.clientY + 'px';
  };

  dial.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startV = knobValue[bank][idx];
    k.classList.add('grabbing'); dial.setPointerCapture(e.pointerId); showAnnot(e); e.preventDefault();
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragging) {
      const dv = (startY - e.clientY) / 200;
      knobValue[bank][idx] = Math.max(0, Math.min(1, startV + dv));
      apply(); sendCC(cc, knobValue[bank][idx]); showAnnot(e);
    } else if (e.buttons === 0) { showAnnot(e); }
  });
  const end = (e) => { if (!dragging) return; dragging = false; k.classList.remove('grabbing'); try { dial.releasePointerCapture(e.pointerId); } catch (_) {} };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('pointerleave', () => { if (!dragging) annot.hidden = true; });
  // double-click resets to centre
  dial.addEventListener('dblclick', () => { knobValue[bank][idx] = 0.5; apply(); sendCC(cc, 0.5); });
  // wheel fine-tune
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    knobValue[bank][idx] = Math.max(0, Math.min(1, knobValue[bank][idx] - Math.sign(e.deltaY) * 0.02));
    apply(); sendCC(cc, knobValue[bank][idx]);
  }, { passive: false });
}

/* build mode knobs */
const modeKnobs = CONFIG.modeLabels[CONFIG.modeOrder[0]].map((lab, i) => makeKnob('mode', i, lab));
modeKnobs.forEach(k => knobsRow.appendChild(k));
/* build fx knobs */
CONFIG.fxLabels.forEach((lab, i) => fxKnobsEl.appendChild(makeKnob('fx', i, lab)));
/* waveform selector -> synth CC (the extended-param knobs were retired; the
   SYNTH pod is gone — wave + voices now live in the MOD pod) */
$('#synthWaveSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const w = +b.dataset.w, idx = 8;  // SP_WAVE
  document.querySelectorAll('#synthWaveSeg button').forEach(x => x.classList.toggle('on', +x.dataset.w === w));
  knobValue.synth[idx] = w / 3;
  sendCC(CONFIG.ccSynth[idx], w / 3);
});
/* voices selector -> SP_VOICES (idx 13): 1..6 voices map to (v-1)/5 */
$('#voiceSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const v = +b.dataset.v;  // 1..6
  document.querySelectorAll('#voiceSeg button').forEach(x => x.classList.toggle('on', +x.dataset.v === v));
  knobValue.synth[13] = (v - 1) / 5;
  sendCC(CONFIG.ccSynth[13], (v - 1) / 5);
});

/* MOD / LFO pod: rate + depth knobs, shape + destination selectors */
const modKnobsEl = $('#modKnobs');
modKnobsEl.appendChild(makeKnob('synth', 9, 'LFO Rate'));
modKnobsEl.appendChild(makeKnob('synth', 10, 'Depth'));
$('#lfoShapeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const w = +b.dataset.w;  // SP_LFO_SHAPE -> idx 11
  document.querySelectorAll('#lfoShapeSeg button').forEach(x => x.classList.toggle('on', +x.dataset.w === w));
  knobValue.synth[11] = w / 3; sendCC(CONFIG.ccSynth[11], w / 3);
});
$('#lfoDestSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = +b.dataset.d;  // SP_LFO_DEST -> idx 12
  document.querySelectorAll('#lfoDestSeg button').forEach(x => x.classList.toggle('on', +x.dataset.d === d));
  knobValue.synth[12] = d / 3; sendCC(CONFIG.ccSynth[12], d / 3);
});

/* ===========================================================================
   TOGGLES (3-position)
   ========================================================================= */
const toggleDefs = [
  { name: 'MODE', pos: 0, vals: ['SYNTH', 'GRAN', 'GEN'] },
  { name: 'VAR',  pos: 0, vals: ['I', 'II', 'III'] },
  { name: 'FX',   pos: 0, vals: ['OFF', 'DLY', 'RVB'] },
];
const toggleEls = toggleDefs.map((def, ti) => {
  const t = el('div', 'toggle'); t.dataset.toggle = ti; t.dataset.pos = def.pos;
  const name = el('div', 'toggle-name'); name.textContent = def.name;
  const rowEl = el('div', 'toggle-row');
  const track = el('div', 'toggle-track'); track.appendChild(el('div', 'toggle-bat'));
  const vals = el('div', 'toggle-vals');
  def.vals.forEach((v, vi) => { const s = el('span'); s.textContent = v; if (vi === def.pos) s.classList.add('on'); vals.appendChild(s); });
  rowEl.append(track, vals);
  t.append(name, rowEl);
  t.addEventListener('click', () => {
    const next = (parseInt(t.dataset.pos, 10) + 1) % 3;
    if (ti === 0) setMode(next);
    else if (ti === 2) setFx(next);
    else setToggle(ti, next);
  });
  togglesEl.appendChild(t);
  return t;
});
function updateToggleVals(ti, pos) {
  toggleEls[ti].querySelectorAll('.toggle-vals span').forEach((s, i) => s.classList.toggle('on', i === pos));
}
function setToggle(ti, pos) { toggleEls[ti].dataset.pos = pos; updateToggleVals(ti, pos); }

/* ===========================================================================
   FOOTSWITCHES + LEDs
   ========================================================================= */
const stompNames = [];
[0, 1].forEach((si) => {
  const unit = el('div', 'stomp-unit');
  const led = el('span', 'fs-led'); led.dataset.led = si;
  const s = el('div', 'stomp'); s.dataset.stomp = si;
  const lbl = el('div', 'stomp-name'); stompNames[si] = lbl;
  s.addEventListener('click', () => {
    s.classList.toggle('pressed');
    led.classList.toggle('on', s.classList.contains('pressed'));
  });
  unit.append(led, s, lbl);
  stompsEl.appendChild(unit);
});
stompNames[0].textContent = 'BYPASS';   // footswitch 1 = engage/bypass (all modes)

/* ===========================================================================
   MODE / FX state
   ========================================================================= */
function setMode(m) {
  activeMode = m; toggleEls[0].dataset.pos = m; updateToggleVals(0, m);
  const name = CONFIG.modeOrder[m];
  document.body.dataset.mode = name;   // drives the per-mode color scheme (CSS)
  const labels = CONFIG.modeLabels[name];
  modeKnobs.forEach((k, i) => { k._label.textContent = labels[i]; });
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', +b.dataset.mode === m));
  $('#modeNote').textContent = CONFIG.modeNotes[name];
  if (stompNames[1]) stompNames[1].textContent = CONFIG.fsActions[name] || 'ACTION';  // FS2 = mode action
  const mp = $('#modePod'); if (mp) mp.classList.remove('closed');   // switch change re-opens its box
  const mo = $('#modPod'); if (mo) mo.hidden = (m !== 0);            // synth MOD panel only in Synth mode
  sendCC(CONFIG.ccModeSelect, m / 2);   // tell the pedal to switch mode
  if (m === 0) requestAnimationFrame(reflowPods);   // synth/mod pods just became visible
}
function setFx(f) {
  activeFx = f; toggleEls[2].dataset.pos = f; updateToggleVals(2, f);
  document.querySelectorAll('#fxSeg button').forEach(b => b.classList.toggle('on', +b.dataset.fx === f));
  const fp = $('#fxPod');
  if (fp) { fp.dataset.active = f > 0 ? 'on' : 'off'; fp.classList.remove('closed'); }  // switch change re-opens its box
  sendCC(CONFIG.ccFxSelect, f / 2);   // tell the pedal to switch FX
  drawWires();
}
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(+b.dataset.mode); });
$('#fxSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setFx(+b.dataset.fx); });

/* ===========================================================================
   PRESETS — factory library (presets.json, shipped in repo) + user store
   (localStorage). A patch = mode + fx select and every knob bank. Loading one
   updates the UI and pushes every param to the pedal.
   ========================================================================= */
let factoryPresets = [];                       // [{name, patch}] from presets.json
const PRESET_KEY = 'propagator.presets';

function loadUserPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch (_) { return {}; } }
function saveUserPresets(obj) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); } catch (_) {} }

function capturePatch() {
  return {
    v: 1, mode: activeMode, fx: activeFx,
    knobs: { mode: knobValue.mode.slice(), fx: knobValue.fx.slice(), synth: knobValue.synth.slice() },
  };
}

// redraw every knob dial/readout from the current knobValue state
function refreshKnobs() {
  document.querySelectorAll('.knob').forEach(k => {
    const v = knobValue[k.dataset.bank][+k.dataset.idx];
    k.querySelector('.knob-dial').style.setProperty('--rot', rotFor(v) + 'deg');
    k.querySelector('.knob-val').textContent = String(Math.round(v * 127)).padStart(3, '0');
  });
}
// re-light the wave / LFO shape / LFO dest / voices selectors from synth state
function refreshSegments() {
  const on = (sel, attr, val) =>
    document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', +b.dataset[attr] === val));
  on('#synthWaveSeg', 'w', Math.round(knobValue.synth[8] * 3));
  on('#lfoShapeSeg',  'w', Math.round(knobValue.synth[11] * 3));
  on('#lfoDestSeg',   'd', Math.round(knobValue.synth[12] * 3));
  on('#voiceSeg',     'v', Math.round(knobValue.synth[13] * 5) + 1);
}
function pushAllCC() {
  CONFIG.ccMode.forEach((cc, i) => sendCC(cc, knobValue.mode[i]));
  CONFIG.ccFx.forEach((cc, i) => sendCC(cc, knobValue.fx[i]));
  CONFIG.ccSynth.forEach((cc, i) => sendCC(cc, knobValue.synth[i]));
}

function applyPatch(p) {
  if (!p || !p.knobs) return;
  if (Array.isArray(p.knobs.mode)) p.knobs.mode.forEach((v, i) => { if (i < knobValue.mode.length) knobValue.mode[i] = v; });
  if (Array.isArray(p.knobs.fx))   p.knobs.fx.forEach((v, i) => { if (i < knobValue.fx.length) knobValue.fx[i] = v; });
  // tolerate older/shorter synth arrays: keep defaults for any missing tail params
  if (Array.isArray(p.knobs.synth)) p.knobs.synth.forEach((v, i) => { if (i < knobValue.synth.length) knobValue.synth[i] = v; });
  setMode(typeof p.mode === 'number' ? p.mode : activeMode);   // sends mode select + updates UI
  setFx(typeof p.fx === 'number' ? p.fx : activeFx);           // sends fx select
  refreshKnobs(); refreshSegments();
  pushAllCC();   // push every param to the pedal
}

function rebuildPresetList() {
  const sel = $('#presetSel'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— preset —</option>';
  if (factoryPresets.length) {
    const g = el('optgroup'); g.label = 'Factory';
    factoryPresets.forEach(p => { const o = el('option'); o.value = 'f:' + p.name; o.textContent = p.name; g.appendChild(o); });
    sel.appendChild(g);
  }
  const names = Object.keys(loadUserPresets()).sort();
  if (names.length) {
    const g = el('optgroup'); g.label = 'Yours';
    names.forEach(n => { const o = el('option'); o.value = 'u:' + n; o.textContent = n; g.appendChild(o); });
    sel.appendChild(g);
  }
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

function loadPresetByKey(key) {
  if (!key) return;
  if (key[0] === 'f') { const p = factoryPresets.find(x => x.name === key.slice(2)); if (p) applyPatch(p.patch); }
  else { const u = loadUserPresets(); if (u[key.slice(2)]) applyPatch(u[key.slice(2)]); }
}

$('#presetSel').addEventListener('change', e => loadPresetByKey(e.target.value));

// Save: the button morphs into a name field + green ✓. Click outside (or Esc)
// reverts to the button without saving; ✓ or Enter commits.
const presetSaveBtn = $('#presetSave'), presetSaver = $('#presetSaver'), presetName = $('#presetName');
function closeSaver() {
  presetSaver.hidden = true; presetSaveBtn.hidden = false;
  document.removeEventListener('pointerdown', saverOutside, true);
}
function saverOutside(e) { if (!presetSaver.contains(e.target)) closeSaver(); }
function openSaver() {
  presetSaveBtn.hidden = true; presetSaver.hidden = false;
  // if one of the user's presets is selected, pre-fill its name so ✓ updates it
  const sel = $('#presetSel').value;
  presetName.value = sel.startsWith('u:') ? sel.slice(2) : '';
  presetName.focus(); presetName.select();
  setTimeout(() => document.addEventListener('pointerdown', saverOutside, true), 0);
}
function commitSave() {
  const name = presetName.value.trim();
  if (!name) { closeSaver(); return; }
  const u = loadUserPresets(); u[name] = capturePatch(); saveUserPresets(u);
  rebuildPresetList(); $('#presetSel').value = 'u:' + name;
  closeSaver();
}
presetSaveBtn.addEventListener('click', openSaver);
$('#presetConfirm').addEventListener('click', commitSave);
presetName.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitSave(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSaver(); }
});
$('#presetDel').addEventListener('click', () => {
  const sel = $('#presetSel'), key = sel.value;
  if (key[0] !== 'u') { alert('Pick one of your saved presets to delete (factory presets are read-only).'); return; }
  const name = key.slice(2);
  if (!confirm('Delete preset "' + name + '"?')) return;
  const u = loadUserPresets(); delete u[name]; saveUserPresets(u);
  rebuildPresetList(); sel.value = '';
});

async function loadFactoryPresets() {
  try {
    const res = await fetch('presets.json', { cache: 'no-cache' });
    if (res.ok) factoryPresets = await res.json();
  } catch (_) { /* offline / file:// — user presets still work */ }
  rebuildPresetList();
}

/* ===========================================================================
   WEB MIDI
   ========================================================================= */
function sendCC(cc, v01) {
  if (!midiOut) return;
  const v = Math.max(0, Math.min(127, Math.round(v01 * 127)));
  try { midiOut.send([0xB0 | (CONFIG.channel & 0x0f), cc, v]); } catch (_) {}
}

function setStatus(state, label) {
  const s = $('#connStatus'); s.dataset.state = state; $('#connLabel').textContent = label;
}

function fillSelect(sel, map, current) {
  const prev = current && current.id;
  sel.innerHTML = '<option value="">— no device —</option>';
  for (const port of map.values()) {
    const o = el('option'); o.value = port.id; o.textContent = port.name || port.id;
    if (port.id === prev) o.selected = true;
    sel.appendChild(o);
  }
}

function refreshDevices() {
  if (!midi) return;
  fillSelect($('#midiOut'), midi.outputs, midiOut);
  fillSelect($('#midiIn'), midi.inputs, midiIn);
  // restore remembered devices by id, then by name (fall back to first output)
  let savedOut = '', savedOutName = '', savedIn = '', savedInName = '';
  try {
    savedOut = localStorage.getItem('propagator.out') || ''; savedOutName = localStorage.getItem('propagator.outName') || '';
    savedIn = localStorage.getItem('propagator.in') || ''; savedInName = localStorage.getItem('propagator.inName') || '';
  } catch (_) {}
  if (!midiOut) {
    const outId = resolveSaved(midi.outputs, savedOut, savedOutName);
    if (outId) { selectOut(outId); $('#midiOut').value = outId; }
    else if (midi.outputs.size) { const first = midi.outputs.values().next().value; selectOut(first.id); $('#midiOut').value = first.id; }
  }
  if (!midiIn) {
    const inId = resolveSaved(midi.inputs, savedIn, savedInName);
    if (inId) { selectIn(inId); $('#midiIn').value = inId; }
  }
  updateConn();
}
function updateConn() {
  const n = midi ? midi.outputs.size : 0;
  if (midiOut) setStatus('live', 'connected');
  else if (midi) setStatus('ready', n ? 'pick a device' : 'no devices');
  else setStatus('off', 'offline');
  $('#footMidi').textContent = midi ? `${midi.outputs.size} out · ${midi.inputs.size} in` : 'no MIDI';
  updateMidiPod();
}
function selectOut(id) {
  midiOut = id ? midi.outputs.get(id) : null;
  try {
    localStorage.setItem('propagator.out', id || '');
    localStorage.setItem('propagator.outName', midiOut ? (midiOut.name || '') : '');
  } catch (_) {}
  updateConn();
  if (midiOut) {  // sync the pedal to the UI's current state on connect
    sendCC(CONFIG.ccModeSelect, activeMode / 2);
    sendCC(CONFIG.ccFxSelect, activeFx / 2);
    CONFIG.ccSynth.forEach((cc, i) => sendCC(cc, knobValue.synth[i]));
  }
}
function selectIn(id) {
  if (midiIn) midiIn.onmidimessage = null;
  midiIn = id ? midi.inputs.get(id) : null;
  if (midiIn) midiIn.onmidimessage = onMidiMessage;
  try {
    localStorage.setItem('propagator.in', id || '');
    localStorage.setItem('propagator.inName', midiIn ? (midiIn.name || '') : '');
  } catch (_) {}
  updateConn();
}
// resolve a saved device: prefer the exact id, else fall back to a name match
// (WebMIDI port ids are not stable across sessions, especially on Windows)
function resolveSaved(map, savedId, savedName) {
  if (savedId && map.has(savedId)) return savedId;
  if (savedName) { for (const p of map.values()) if ((p.name || '') === savedName) return p.id; }
  return '';
}
// incoming (for future 2-way sync): reflect CC back onto knobs
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteName(n) { return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
function describeMidi(d) {
  const hi = d[0] & 0xf0;
  if (hi === 0x90 && d[2] > 0) return { cat: 'notes', text: `Note On  ${noteName(d[1])}  v${d[2]}` };
  if (hi === 0x80 || (hi === 0x90 && d[2] === 0)) return { cat: 'notes', text: `Note Off ${noteName(d[1])}` };
  if (hi === 0xB0) return { cat: 'cc', text: `CC ${d[1]} → ${d[2]}` };
  if (hi === 0xE0) return { cat: 'other', text: `Pitch Bend ${((d[2] << 7) | d[1]) - 8192}` };
  if (hi === 0xC0) return { cat: 'other', text: `Program ${d[1]}` };
  if (hi === 0xD0) return { cat: 'other', text: `Ch Pressure ${d[1]}` };
  if (hi === 0xA0) return { cat: 'other', text: `Poly AT ${noteName(d[1])} ${d[2]}` };
  return { cat: 'other', text: `0x${d[0].toString(16)}` };
}
function sameInOut() { return midiIn && midiOut && midiIn.id === midiOut.id; }
function fwd(data, cat) {
  if (thru && thruFilter[cat] && midiOut && !sameInOut()) {
    try { midiOut.send(data); } catch (_) {}
  }
}

// MIDI clock (0xF8, 24 per quarter): derive BPM + drive the beat when sync is on.
function handleClockTick(now) {
  if (clockSync) {
    if (lastClockMs) {
      const dt = now - lastClockMs;
      if (dt > 0.5 && dt < 200) {
        const inst = 60000 / (dt * 24);
        clockBpm = clockBpm ? clockBpm * 0.8 + inst * 0.2 : inst;
        setBpm(clockBpm);
      }
    }
    if (!playing) { playing = true; updateTransportUI(); }  // external clock = running
    if ((clockCount % 24) === 0) pulseBeat((clockCount / 24) % 4);
    clockCount = (clockCount + 1) % 96;
  }
  lastClockMs = now;
}

function onMidiMessage(e) {
  const d = e.data, status = d[0];
  // realtime: clock + transport
  if (status === 0xF8) { handleClockTick(performance.now()); fwd(d, 'clock'); return; }
  if (status === 0xFA || status === 0xFB || status === 0xFC) {
    if (status === 0xFA) { clockCount = 0; if (clockSync) setPlaying(true); }      // start
    else if (status === 0xFC && clockSync) setPlaying(false);                       // stop
    fwd(d, 'clock'); return;
  }
  if (status < 0x80 || status >= 0xF0) return;   // ignore other system msgs (sysex/sensing)

  // channel-voice: activity LED, last-received readout, filtered thru
  const info = describeMidi(d);
  if (midiAct) { midiAct.classList.add('kick'); setTimeout(() => midiAct.classList.remove('kick'), 130); }
  if (midiLast) midiLast.textContent = info.text;
  fwd(d, info.cat);

  // reflect CC onto the on-screen knobs
  if ((status & 0xf0) === 0xb0) {
    const mi = CONFIG.ccMode.indexOf(d[1]);
    const fi = CONFIG.ccFx.indexOf(d[1]);
    if (mi >= 0) { knobValue.mode[mi] = d[2] / 127; modeKnobs[mi]._apply(); }
    else if (fi >= 0) { knobValue.fx[fi] = d[2] / 127; }
  }
}

function updateMidiPod() {
  if (!midiPod) return;
  const show = thru && midiIn && midiOut;
  midiPod.hidden = !show;
  if (show) requestAnimationFrame(reflowPods);   // clamp it on-screen when it appears
}

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    let body;
    if (location.protocol === 'file:') {
      body = 'You opened this as a <code>file://</code> page — browsers hide Web MIDI there. ' +
             'Serve it over <strong>localhost</strong> instead:<br>' +
             '<code>python -m http.server 8000</code><br>' +
             'then open <code>http://localhost:8000</code> in <strong>Chrome</strong>/<strong>Edge</strong>.';
    } else if (!window.isSecureContext) {
      body = `This page isn't a secure context (<code>${location.protocol}//${location.host}</code>). ` +
             'Web MIDI needs <strong>localhost</strong> or <strong>https</strong>. ' +
             'Use <code>http://localhost:PORT</code> (not the machine IP) in Chrome/Edge.';
    } else {
      body = 'This browser has no Web MIDI API. Use <strong>Chrome</strong> or <strong>Edge</strong> ' +
             '(Safari and older Firefox lack it).';
    }
    console.warn('[propagator] requestMIDIAccess missing · protocol=%s host=%s secureContext=%s',
                 location.protocol, location.host, window.isSecureContext);
    showNotice('WebMIDI not available', body);
    return;
  }
  try { midi = await navigator.requestMIDIAccess({ sysex: true }); }
  catch (_) {
    try { midi = await navigator.requestMIDIAccess(); }
    catch (e2) { showNotice('MIDI permission needed', 'Allow MIDI access (and serve over <code>localhost</code> or https for SysEx), then retry.'); return; }
  }
  hideNotice();
  midi.onstatechange = refreshDevices;
  refreshDevices();
}
$('#midiOut').addEventListener('change', e => selectOut(e.target.value));
$('#midiIn').addEventListener('change', e => selectIn(e.target.value));
$('#midiThru').addEventListener('change', e => { thru = e.target.checked; updateMidiPod(); });
$('#fNotes').addEventListener('change', e => { thruFilter.notes = e.target.checked; });
$('#fCC').addEventListener('change', e => { thruFilter.cc = e.target.checked; });
$('#fOther').addEventListener('change', e => { thruFilter.other = e.target.checked; });
$('#fClock').addEventListener('change', e => { thruFilter.clock = e.target.checked; });
$('#fSync').addEventListener('change', e => { clockSync = e.target.checked; if (!clockSync) { lastClockMs = 0; clockBpm = 0; } });

function showNotice(title, body) { $('#noticeTitle').textContent = title; $('#noticeBody').innerHTML = body; $('#notice').hidden = false; updateConn(); }
function hideNotice() { $('#notice').hidden = true; }
$('#noticeRetry').addEventListener('click', initMidi);

/* ===========================================================================
   BPM + BEAT ENGINE
   ========================================================================= */
let bpm = 96;
let playing = true;
const bpmNum = $('#bpmNum'), beatSeed = $('#beatSeed'), beatDots = [...document.querySelectorAll('#beatDots i')];
const bpmMini = $('#bpmMini'), bpmMiniLed = $('#bpmMiniLed'), bpmMiniVal = $('#bpmMiniVal');
beatDots[0].classList.add('down');

function setBpm(v) {
  bpm = Math.max(40, Math.min(240, Math.round(v)));
  bpmNum.textContent = bpm;
  if (bpmMiniVal) bpmMiniVal.textContent = bpm;
}

function updateTransportUI() {
  const b1 = $('#bpmMiniPlay'); if (b1) b1.textContent = playing ? '⏹' : '▶';
  const b2 = $('#bpmPlay'); if (b2) b2.textContent = playing ? '⏹ stop' : '▶ start';
}
function setPlaying(p) {
  playing = p;
  updateTransportUI();
  if (playing) {  // START: restart from the beginning of the bar (downbeat)
    beatIndex = 0;
    nextBeat = performance.now();
  } else {        // STOP: clear the beat visuals
    beatDots.forEach(d => d.classList.remove('on'));
    if (bpmMiniLed) bpmMiniLed.classList.remove('kick', 'down');
  }
}

// show the tempo pod or collapse it to the top-bar mini
function setBpmPodClosed(closed) {
  const pod = $('#bpmPod');
  if (pod) pod.classList.toggle('closed', closed);
  if (bpmMini) bpmMini.hidden = !closed;
  drawWires();
}
(() => {
  const dial = $('#bpmDial'); let sy = 0, sb = 0, drag = false;
  dial.addEventListener('pointerdown', e => { drag = true; sy = e.clientY; sb = bpm; dial.setPointerCapture(e.pointerId); });
  dial.addEventListener('pointermove', e => { if (drag) setBpm(sb + (sy - e.clientY) * 0.5); });
  dial.addEventListener('pointerup', e => { drag = false; try { dial.releasePointerCapture(e.pointerId); } catch (_) {} });
  dial.addEventListener('wheel', e => { e.preventDefault(); setBpm(bpm - Math.sign(e.deltaY)); }, { passive: false });
})();

// transport + mini-box wiring
$('#bpmPlay').addEventListener('click', () => setPlaying(!playing));
$('#bpmMiniPlay').addEventListener('click', () => setPlaying(!playing));
$('#bpmMiniOpen').addEventListener('click', () => setBpmPodClosed(false));

let beatIndex = 0, nextBeat = performance.now();
function pulseBeat(beatInBar) {
  const down = beatInBar === 0;
  beatSeed.classList.toggle('down', down);
  beatSeed.classList.add('kick');
  setTimeout(() => beatSeed.classList.remove('kick'), 90);
  beatDots.forEach((d, i) => d.classList.toggle('on', i === beatInBar));
  // top-bar mini LED
  if (bpmMiniLed) {
    bpmMiniLed.classList.toggle('down', down);
    bpmMiniLed.classList.add('kick');
    setTimeout(() => bpmMiniLed.classList.remove('kick'), 90);
  }
}

/* ===========================================================================
   CONNECTOR WIRES (pod ↔ pedal control)
   ========================================================================= */
function center(elm) {
  if (!elm) return null;
  const r = elm.getBoundingClientRect(); const s = stage.getBoundingClientRect();
  return { x: r.left + r.width / 2 - s.left, y: r.top + r.height / 2 - s.top };
}
function edgePoint(podEl, toward) {
  const r = podEl.getBoundingClientRect(); const s = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2 - s.left;
  const x = toward.x > cx ? r.right - s.left : r.left - s.left;
  return { x, y: r.top + r.height / 2 - s.top };
}
function wirePath(a, b, active) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + (active ? -5 : 7);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
  if (active) p.setAttribute('class', 'active');
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', b.x); dot.setAttribute('cy', b.y); dot.setAttribute('r', 2.5);
  return [p, dot];
}
function drawWires() {
  if (!wires) return;
  wires.innerHTML = '';
  // Tempo pod is intentionally NOT wired (kept separate). Only the two toggle
  // breakouts get a connector, and they sit behind the pedal (z-order).
  const segs = [
    { anchor: center(toggleEls[0]), pod: $('#modePod'), active: false },
    { anchor: center(toggleEls[2]), pod: $('#fxPod'),   active: activeFx > 0 },
  ];
  for (const s of segs) {
    if (!s.anchor || !s.pod || s.pod.classList.contains('closed')) continue;
    const b = edgePoint(s.pod, s.anchor);
    wirePath(s.anchor, b, s.active).forEach(n => wires.appendChild(n));
  }
}

/* ===========================================================================
   BOIL (animated hand-drawn wobble)
   ========================================================================= */
function startBoil() {
  if (reduceMotion) return;
  const turbs = document.querySelectorAll('#boil feTurbulence, #boil-soft feTurbulence');
  let seed = 1;
  setInterval(() => { seed = (seed % 6) + 1; turbs.forEach(t => t.setAttribute('seed', seed)); }, 115);
}

/* ===========================================================================
   MAIN LOOP (beat + wires)
   ========================================================================= */
function loop(now) {
  // When external MIDI clock is live + sync on, the beat is clock-driven
  // (handleClockTick) and the internal timer steps aside.
  const clockActive = clockSync && lastClockMs && (now - lastClockMs < 400);
  if (playing && !clockActive) {
    const interval = 60000 / bpm;
    if (now >= nextBeat) {
      pulseBeat(beatIndex % 4); beatIndex++;
      nextBeat += interval;
      if (now - nextBeat > interval) nextBeat = now + interval; // resync if tab was backgrounded
    }
  } else if (!playing) {
    nextBeat = now; // stopped: stay ready to resume cleanly
  }
  drawWires();
  requestAnimationFrame(loop);
}

/* ===========================================================================
   DRAGGABLE PODS — grab an empty part of a breakout box to move it.
   (Starting a drag on a control inside is ignored so knobs/buttons still work.
   Uses left/top so the float animation's transform still composes; wires follow.)
   ========================================================================= */
const POD_IDS = ['#modePod', '#fxPod', '#bpmPod', '#midiPod', '#modPod'];
const SNAP_STEP = 28;   // pods tidy onto this px grid when released

// apply a drag offset (dx,dy relative to the grid slot), then nudge the whole
// box back inside the viewport (there's no scroll to recover an off-screen pod)
function placePod(pod, dx, dy) {
  pod.style.left = dx + 'px'; pod.style.top = dy + 'px';
  const r = pod.getBoundingClientRect(), m = 8;
  if (r.left < m) dx += m - r.left;
  else if (r.right > innerWidth - m) dx += (innerWidth - m) - r.right;
  if (r.top < m) dy += m - r.top;
  else if (r.bottom > innerHeight - m) dy += (innerHeight - m) - r.bottom;
  pod.style.left = dx + 'px'; pod.style.top = dy + 'px';
  pod.dataset.dx = dx; pod.dataset.dy = dy;
}
// snap the pod's on-screen position to the grid, then clamp into view
function snapPod(pod) {
  const r = pod.getBoundingClientRect();
  let dx = parseFloat(pod.dataset.dx || '0'), dy = parseFloat(pod.dataset.dy || '0');
  dx += Math.round(r.left / SNAP_STEP) * SNAP_STEP - r.left;
  dy += Math.round(r.top / SNAP_STEP) * SNAP_STEP - r.top;
  placePod(pod, dx, dy);
}
// keep every visible pod on-screen (after load / resize / mode change)
function reflowPods() {
  POD_IDS.forEach(id => {
    const p = $(id);
    if (p && p.offsetParent !== null) placePod(p, parseFloat(p.dataset.dx || '0'), parseFloat(p.dataset.dy || '0'));
  });
  drawWires();
}

function makeDraggable(pod) {
  if (!pod) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  pod.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.knob, button, input, label, .pill, .switch-field, .bpm-dial, select, .seg, .beat-seed')) return;
    dragging = true; pod.classList.add('dragging');
    sx = e.clientX; sy = e.clientY;
    ox = parseFloat(pod.dataset.dx || '0'); oy = parseFloat(pod.dataset.dy || '0');
    pod.setPointerCapture(e.pointerId); e.preventDefault();
  });
  pod.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    placePod(pod, ox + (e.clientX - sx), oy + (e.clientY - sy));   // clamps as you drag
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    snapPod(pod);                       // settle onto the snap grid (CSS eases it)
    pod.classList.remove('dragging');
    drawWires();
    try { pod.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  pod.addEventListener('pointerup', end);
  pod.addEventListener('pointercancel', end);
}
POD_IDS.forEach(id => makeDraggable($(id)));

/* close (×) / reset breakout boxes. A closed mode/fx box re-opens when its
   corresponding toggle switch is changed (see setMode / setFx). */
['#modePod', '#fxPod', '#bpmPod'].forEach(id => {
  const p = $(id); if (!p) return;
  const btn = el('button', 'pod-close'); btn.textContent = '×'; btn.title = 'close';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (id === '#bpmPod') setBpmPodClosed(true);   // collapse tempo to the top-bar mini
    else { p.classList.add('closed'); drawWires(); }
  });
  p.appendChild(btn);
});
function resetPods() {
  POD_IDS.forEach(id => {
    const p = $(id); if (!p) return;
    p.classList.remove('closed');
    p.style.left = ''; p.style.top = ''; delete p.dataset.dx; delete p.dataset.dy;
  });
  setBpmPodClosed(true);   // default layout: tempo collapsed to the mini
  requestAnimationFrame(reflowPods);   // re-clamp the default grid into view
}
$('#resetLayout').addEventListener('click', resetPods);

/* ---------- go ---------- */
setMode(0); setFx(0);
setPlaying(false);       // default: tempo stopped
setBpmPodClosed(true);   // default: tempo box closed -> shown as the top-bar mini
updateMidiPod();
window.addEventListener('resize', reflowPods);
requestAnimationFrame(() => { reflowPods(); requestAnimationFrame(loop); });
startBoil();
loadFactoryPresets();    // factory library + any saved user presets -> dropdown
initMidi();
