/* ============================================================================
   PROPAGATOR (WebMIDI) — the cultivating surface for the Spore pedal
   SPDX-License-Identifier: GPL-3.0-or-later
   Copyright (C) 2026 Joakim Langkilde
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
  ccTempo:      14,                 // internal clock BPM (0..1 -> 40..200)
  ccDelaySync:  15,                 // delay tempo-sync division (0 off / ¼ / ⅛ / ⅛. / 16)
  ccSysReboot:  119,                // CC 119 >=64 -> pedal reboots into DFU bootloader

  ccSynth: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87],  // 0-7 voice · 8 wave · 9-12 LFO · 13 voices · 14-19 wavetable · 20-24 tone · 25-26 LFO2 · 27-44 matrix · 45 LFO2 depth · 46 LFO1 sync · 47 LFO2 sync
  synthLabels: ['Detune', 'Sub', 'Sustain', 'Release', 'F.Env Amt', 'F.Env Time', 'Glide', 'Width'],
  modeOrder: ['synth', 'granular', 'generative'], // toggle 1: up / middle / down
  modeLabels: {
    synth:      ['Cutoff', 'Resonance', 'Attack', 'Decay', 'Mod Depth', 'Gen-mod Mix'],
    granular:   ['Grain Size', 'Density', 'Pitch', 'Pitch Spread', 'Scatter', 'Dry/Wet'],
    generative: ['Tempo', 'Range', 'Tone', 'Reverb', 'Density', 'Drift'],
  },
  modeNotes: {
    synth:      'osc → moog filter → envelope · USB MIDI',
    granular:   'records input → grains · footswitch freeze',
    generative: 'ambient pad · self-playing · slow tempo · big reverb',
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
let clockMaster = 'off';   // tempo master for the pedal: 'off' | 'gui' | 'in'
let delaySyncIdx = 0;      // delay tempo-sync division (part of a patch/preset)
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
  // 14 engine(0=analog) · 15 wt scan · 16 FM amt · 17 FM ratio · 18 fold · 19 wt bank
  // 20 drive · 21 filter(0=Svf) · 22 unison(0.33->2) · 23 sub oct · 24 sub wave
  // 25 LFO2 rate · 26 LFO2 shape · 27-44 mod matrix (6 slots: src/dst/amt)
  synth: [0.25, 0.40, 0.70, 0.30, 0.50, 0.30, 0.00, 0.60, 0.66, 0.30, 0.00, 0.00, 0.33, 0.60,
          0.00, 0.30, 0.00, 0.25, 0.00, 0.00,
          0.00, 0.00, 0.33, 0.00, 0.00,
          0.30, 0.00,
          0.00, 0.00, 0.50, 0.00, 0.00, 0.50, 0.00, 0.00, 0.50,
          0.00, 0.00, 0.50, 0.00, 0.00, 0.50, 0.00, 0.00, 0.50,
          1.00,
          0.00, 0.00],
};

/* ===========================================================================
   KNOBS
   ========================================================================= */
function rotFor(v) { return -135 + v * 270; }
let envRedraw = () => {};   // set by the envelope pod; lets knob edits redraw the ADSR graph

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
      apply(); sendCC(cc, knobValue[bank][idx]); showAnnot(e); envRedraw();
    } else if (e.buttons === 0) { showAnnot(e); }
  });
  const end = (e) => { if (!dragging) return; dragging = false; k.classList.remove('grabbing'); try { dial.releasePointerCapture(e.pointerId); } catch (_) {} };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  dial.addEventListener('pointerleave', () => { if (!dragging) annot.hidden = true; });
  // double-click resets to centre
  dial.addEventListener('dblclick', () => { knobValue[bank][idx] = 0.5; apply(); sendCC(cc, 0.5); envRedraw(); });
  // wheel fine-tune
  dial.addEventListener('wheel', (e) => {
    e.preventDefault();
    knobValue[bank][idx] = Math.max(0, Math.min(1, knobValue[bank][idx] - Math.sign(e.deltaY) * 0.02));
    apply(); sendCC(cc, knobValue[bank][idx]); envRedraw();
  }, { passive: false });
}

/* build mode knobs */
const modeKnobs = CONFIG.modeLabels[CONFIG.modeOrder[0]].map((lab, i) => makeKnob('mode', i, lab));
modeKnobs.forEach(k => knobsRow.appendChild(k));
/* build fx knobs */
CONFIG.fxLabels.forEach((lab, i) => fxKnobsEl.appendChild(makeKnob('fx', i, lab)));
/* build synth-panel knobs — VOICE pod keeps the timbre params; the envelope
   params (Sustain/Release + filter env) are broken out into the ENV pod below */
const synthKnobsEl = $('#synthKnobs');
const VOICE_KNOBS = [0, 1, 6, 7];   // Detune, Sub, Glide, Width
VOICE_KNOBS.forEach(i => synthKnobsEl.appendChild(makeKnob('synth', i, CONFIG.synthLabels[i])));
synthKnobsEl.appendChild(makeKnob('synth', 20, 'Drive'));   // pre-filter saturation (grit)
/* waveform selector -> synth CC */
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
/* filter type -> SP_FILTER (idx 21): 0 = clean Svf, 1 = fat Moog */
$('#synthFilterSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const f = +b.dataset.f;
  document.querySelectorAll('#synthFilterSeg button').forEach(x => x.classList.toggle('on', +x.dataset.f === f));
  knobValue.synth[21] = f; sendCC(CONFIG.ccSynth[21], f);
});
/* unison -> SP_UNISON (idx 22): 1..4 osc map to (u-1)/3 */
$('#synthUniSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const u = +b.dataset.u;
  document.querySelectorAll('#synthUniSeg button').forEach(x => x.classList.toggle('on', +x.dataset.u === u));
  knobValue.synth[22] = (u - 1) / 3; sendCC(CONFIG.ccSynth[22], (u - 1) / 3);
});
/* sub octave -> SP_SUB_OCT (idx 23): 0 = -1, 1 = -2 */
$('#subOctSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const o = +b.dataset.o;
  document.querySelectorAll('#subOctSeg button').forEach(x => x.classList.toggle('on', +x.dataset.o === o));
  knobValue.synth[23] = o; sendCC(CONFIG.ccSynth[23], o);
});
/* sub waveform -> SP_SUB_WAVE (idx 24): 0 = square, 1 = sine */
$('#subWaveSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const w = +b.dataset.w;
  document.querySelectorAll('#subWaveSeg button').forEach(x => x.classList.toggle('on', +x.dataset.w === w));
  knobValue.synth[24] = w; sendCC(CONFIG.ccSynth[24], w);
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

/* ===========================================================================
   ENVELOPE pod — an interactive ADSR graph that edits the amp envelope spread
   across the knob banks: Attack = mode CC, Decay = mode CC, Sustain/Release =
   synth CC. Dragging the handles drives those params (and the dials stay in
   sync via refreshKnobs). Filter-env amount/time live here as two knobs.
   ========================================================================= */
const ENV = { X0: 10, AW: 62, DW: 62, SUS: 34, RW: 62, TOP: 8, BOT: 84, VBW: 236, VBH: 92 };
ENV.H = ENV.BOT - ENV.TOP;
const NSVG = 'http://www.w3.org/2000/svg';
const envHost = $('#envGraph');
let envSvg = null, envFill = null, envLine = null, envHA = null, envHS = null, envHR = null;

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
// Attack/Decay are the synth-mode MODE knobs 3/4; Sustain/Release are synth params.
function envGet() { return { A: knobValue.mode[2], D: knobValue.mode[3], S: knobValue.synth[2], R: knobValue.synth[3] }; }
function envSet(bank, idx, v) {
  knobValue[bank][idx] = clamp01(v);
  sendCC((bank === 'mode' ? CONFIG.ccMode : CONFIG.ccSynth)[idx], knobValue[bank][idx]);
}

function drawEnv() {
  if (!envSvg) { buildEnv(); if (!envSvg) return; }   // lazy-build if it wasn't ready at load
  const { A, D, S, R } = envGet();
  const peakX = ENV.X0 + A * ENV.AW;
  const susStartX = peakX + D * ENV.DW;
  const ySus = ENV.BOT - S * ENV.H;
  const susEndX = susStartX + ENV.SUS;
  const endX = susEndX + R * ENV.RW;
  const d = `M ${ENV.X0} ${ENV.BOT} L ${peakX.toFixed(1)} ${ENV.TOP} L ${susStartX.toFixed(1)} ${ySus.toFixed(1)} L ${susEndX.toFixed(1)} ${ySus.toFixed(1)} L ${endX.toFixed(1)} ${ENV.BOT}`;
  envLine.setAttribute('d', d);
  envFill.setAttribute('d', d + ` L ${ENV.X0} ${ENV.BOT} Z`);
  envHA.setAttribute('cx', peakX.toFixed(1)); envHA.setAttribute('cy', ENV.TOP);
  envHS.setAttribute('cx', susStartX.toFixed(1)); envHS.setAttribute('cy', ySus.toFixed(1));
  envHR.setAttribute('cx', endX.toFixed(1)); envHR.setAttribute('cy', ENV.BOT);
}
function envPoint(e) {
  const r = envSvg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * ENV.VBW, y: (e.clientY - r.top) / r.height * ENV.VBH };
}
function envDrag(handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = (ev) => { onMove(envPoint(ev)); refreshKnobs(); };   // refreshKnobs redraws the env too
    const up = (ev) => {
      handle.removeEventListener('pointermove', mv);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointermove', mv);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    mv(e);
  });
}
function buildEnv() {
  if (!envHost || envSvg) return;   // build once; idempotent for the lazy path
  envSvg = document.createElementNS(NSVG, 'svg');
  envSvg.setAttribute('viewBox', `0 0 ${ENV.VBW} ${ENV.VBH}`);
  envSvg.setAttribute('class', 'env-svg');
  const base = document.createElementNS(NSVG, 'line');   // baseline
  base.setAttribute('x1', ENV.X0); base.setAttribute('y1', ENV.BOT);
  base.setAttribute('x2', ENV.VBW - 2); base.setAttribute('y2', ENV.BOT);
  base.setAttribute('class', 'env-base');
  envFill = document.createElementNS(NSVG, 'path'); envFill.setAttribute('class', 'env-fill');
  envLine = document.createElementNS(NSVG, 'path'); envLine.setAttribute('class', 'env-line');
  const mkH = (cls) => { const c = document.createElementNS(NSVG, 'circle'); c.setAttribute('r', '5'); c.setAttribute('class', 'env-handle ' + cls); return c; };
  envHA = mkH('hA'); envHS = mkH('hS'); envHR = mkH('hR');
  envSvg.append(base, envFill, envLine, envHA, envHS, envHR);
  envHost.appendChild(envSvg);

  envDrag(envHA, (p) => envSet('mode', 2, (p.x - ENV.X0) / ENV.AW));                      // attack: x
  envDrag(envHS, (p) => {                                                                 // decay+sustain
    const peakX = ENV.X0 + knobValue.mode[2] * ENV.AW;
    envSet('mode', 3, (p.x - peakX) / ENV.DW);                                            //   decay:   x
    envSet('synth', 2, (ENV.BOT - p.y) / ENV.H);                                          //   sustain: y
  });
  envDrag(envHR, (p) => {                                                                 // release: x
    const relStart = ENV.X0 + knobValue.mode[2] * ENV.AW + knobValue.mode[3] * ENV.DW + ENV.SUS;
    envSet('synth', 3, (p.x - relStart) / ENV.RW);
  });
}
buildEnv();
/* filter-env knobs (broken out of the voice pod) */
const envFilterEl = $('#envFilter');
if (envFilterEl) [4, 5].forEach(i => envFilterEl.appendChild(makeKnob('synth', i, CONFIG.synthLabels[i])));
envRedraw = drawEnv;   // knob edits (and applyPatch) now refresh the graph
drawEnv();

/* ===========================================================================
   WAVE / DIGITAL pod — selects the voice engine (analog vs wavetable) and the
   digital params: wavetable scan position, FM amount + ratio, wavefold.
   ========================================================================= */
$('#waveEngineSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const en = +b.dataset.e;   // 0 = analog, 1 = wavetable
  document.querySelectorAll('#waveEngineSeg button').forEach(x => x.classList.toggle('on', +x.dataset.e === en));
  knobValue.synth[14] = en; sendCC(CONFIG.ccSynth[14], en);
  updateEngineUI();
});
// show only the controls that apply to the chosen engine
function showEl(sel, show) { const e = $(sel); if (e) e.style.display = show ? '' : 'none'; }
function updateEngineUI() {
  const wt = knobValue.synth[14] >= 0.5;   // wavetable engine?
  showEl('#wtControls', wt);               // table / scan / FM / fold
  showEl('#oscWaveRow', !wt);              // analog waveform selector
  showEl('#unisonRow', !wt);               // unison is analog-only
  const note = $('#waveNote');
  if (note) note.textContent = wt
    ? 'wavetable scan (sine→bright) · FM (carrier × ratio) · wavefold · sub for body'
    : 'analog: 2–4 detuned oscillators (super-saw via UNISON) + sub';
  // note: no relayout here — the panel resizes in place so nothing else jumps
}
const waveKnobsEl = $('#waveKnobs');
if (waveKnobsEl) {
  waveKnobsEl.appendChild(makeKnob('synth', 15, 'Scan'));   // wavetable position
  waveKnobsEl.appendChild(makeKnob('synth', 16, 'FM'));     // FM depth
  waveKnobsEl.appendChild(makeKnob('synth', 18, 'Fold'));   // wavefold
}
$('#waveRatioSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const r = +b.dataset.r;   // 0..3 -> {0.5, 1, 2, 3}
  document.querySelectorAll('#waveRatioSeg button').forEach(x => x.classList.toggle('on', +x.dataset.r === r));
  knobValue.synth[17] = r / 3; sendCC(CONFIG.ccSynth[17], r / 3);
});
/* wavetable bank (idx 19): 5 banks map to b/4 */
$('#waveBankSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const w = +b.dataset.b;   // 0..4 -> Saw / Square / Organ / Vocal / Digital
  document.querySelectorAll('#waveBankSeg button').forEach(x => x.classList.toggle('on', +x.dataset.b === w));
  knobValue.synth[19] = w / 4; sendCC(CONFIG.ccSynth[19], w / 4);
});

/* ===========================================================================
   MOD MATRIX pod — LFO2 + 3 routing slots (source -> destination -> amount).
   ========================================================================= */
const MOD_SRC = ['Off', 'LFO1', 'LFO2', 'Rnd', 'Sens', 'Vel', 'Key'];   // -> synth param * 6
const MOD_DST = ['Cutoff', 'Pitch', 'Scan', 'Drive', 'Sub', 'FM', 'Amp', 'LFO1 Hz', 'LFO2 Hz'];  // -> param * 8
// hover explanations (index aligns with MOD_SRC.slice(1) and MOD_DST)
const PATCH_SRC_TIP = [
  'LFO1 — first low-frequency oscillator (rate/shape above)',
  'LFO2 — second LFO (its own rate/shape/depth)',
  'Rnd — random / sample-and-hold wobble from the hardware RNG',
  'Sens — the analog sensor input (light/pressure)',
  'Vel — note velocity, per voice (MIDI notes or the sequencer)',
  'Key — note pitch / key-track, per voice (centred on middle C)',
];
const PATCH_DST_TIP = [
  'Cutoff — filter frequency (sweeps/wah)',
  'Pitch — oscillator pitch (vibrato when subtle)',
  'Scan — wavetable scan position (timbre morph)',
  'Drive — pre-filter saturation amount (grit)',
  'Sub — sub-oscillator level',
  'FM — FM amount (wavetable engine)',
  'Amp — output level (tremolo)',
  'LFO1 Hz — LFO1 rate (modulate one LFO with another)',
  'LFO2 Hz — LFO2 rate',
];
const lfo2KnobsEl = $('#lfo2Knobs');
if (lfo2KnobsEl) {
  lfo2KnobsEl.appendChild(makeKnob('synth', 25, 'LFO2 Rate'));
  lfo2KnobsEl.appendChild(makeKnob('synth', 45, 'Depth'));   // master depth for LFO2
}
$('#lfo2ShapeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const w = +b.dataset.w;   // SP_LFO2_SHAPE -> idx 26
  document.querySelectorAll('#lfo2ShapeSeg button').forEach(x => x.classList.toggle('on', +x.dataset.w === w));
  knobValue.synth[26] = w / 3; sendCC(CONFIG.ccSynth[26], w / 3);
});
/* LFO clock-sync selectors (free Hz vs locked division) */
function wireLfoSync(sel, idx) {
  $(sel).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const s = +b.dataset.s;
    document.querySelectorAll(sel + ' button').forEach(x => x.classList.toggle('on', +x.dataset.s === s));
    knobValue.synth[idx] = s / 5; sendCC(CONFIG.ccSynth[idx], s / 5);
    updateLfoSyncUI();
  });
}
wireLfoSync('#lfo1SyncSeg', 46);
wireLfoSync('#lfo2SyncSeg', 47);
// when an LFO is clock-synced, its free-rate knob does nothing -> dim it
function updateLfoSyncUI() {
  const dim = (idx, synced) => { const k = document.querySelector('.knob[data-bank="synth"][data-idx="' + idx + '"]'); if (k) k.classList.toggle('knob-off', synced); };
  dim(9,  knobValue.synth[46] > 0.05);   // LFO1 rate
  dim(25, knobValue.synth[47] > 0.05);   // LFO2 rate
}
updateLfoSyncUI();
/* ---- PATCHBAY: a silkscreen-on-metal patch field. Source pads (left) and
   destination pads (right) are white silkscreen labels; faint guide lines show
   every possible connection. Drag from a source pad to a destination pad to lay
   a cable (= one of the 6 matrix slots). Many cables can share a source or a
   destination; the pedal sums per destination. ---- */
const NSV = 'http://www.w3.org/2000/svg';
const elNS = (n) => document.createElementNS(NSV, n);
const PATCH_SLOTS = [27, 30, 33, 36, 39, 42];   // synth idx of each slot's SRC (DST=+1, AMT=+2)
const PB_W = 300, PB_H = 176;
const PB_SPIN = 66, PB_DPIN = PB_W - 66;               // source / dest jack centres (cable anchors)
const SRCY = [14, 43, 72, 101, 130, 158];              // 6 source jacks (LFO1/2/Rnd/Sens/Vel/Key)
const DSTY = [14, 32, 50, 68, 86, 104, 122, 140, 158]; // 9 destination jacks
let patchSvg = null, patchSel = -1, patchKnobApply = null;

function slotGet(i) {
  const b = PATCH_SLOTS[i];
  return { src: Math.round(knobValue.synth[b] * 6), dst: Math.round(knobValue.synth[b + 1] * 8), amt: knobValue.synth[b + 2] };
}
function slotSet(i, src, dst, amt) {
  const b = PATCH_SLOTS[i];
  if (src != null) { knobValue.synth[b] = src / 6; sendCC(CONFIG.ccSynth[b], src / 6); }
  if (dst != null) { knobValue.synth[b + 1] = dst / 8; sendCC(CONFIG.ccSynth[b + 1], dst / 8); }
  if (amt != null) { knobValue.synth[b + 2] = amt; sendCC(CONFIG.ccSynth[b + 2], amt); }
}
function freeSlot() { for (let i = 0; i < 6; i++) if (slotGet(i).src === 0) return i; return -1; }
// find an existing cable for this exact source+destination (src is 1-based, dst 0-based)
function findSlot(src, dst) { for (let i = 0; i < 6; i++) { const s = slotGet(i); if (s.src === src && s.dst === dst) return i; } return -1; }
function cablePath(sx, sy, dx, dy) {   // hanging-wire curve (control points sag down)
  const mx = (sx + dx) / 2, sag = 10 + Math.abs(dx - sx) * 0.06;
  return `M ${sx} ${sy} C ${mx} ${sy + sag} ${mx} ${dy + sag} ${dx} ${dy}`;
}
function svgPt(e) { const r = patchSvg.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * PB_W, y: (e.clientY - r.top) / r.height * PB_H }; }

function buildPatch() {
  const host = $('#patchbay'); if (!host) return;
  patchSvg = elNS('svg');
  patchSvg.setAttribute('viewBox', `0 0 ${PB_W} ${PB_H}`);
  patchSvg.setAttribute('class', 'patch-svg');

  const cables = elNS('g'); cables.setAttribute('class', 'patch-cables');
  patchSvg.appendChild(cables); patchSvg._cables = cables;

  // each source/destination is a panel jack (metal nut + hole) with a label beside it
  const jack = (kind, i, cy, label) => {
    const g = elNS('g'); g.setAttribute('class', 'patch-jack ' + kind); g.dataset.kind = kind; g.dataset.i = i;
    const jx = kind === 'src' ? PB_SPIN : PB_DPIN;
    const tip = elNS('title'); tip.textContent = (kind === 'src' ? PATCH_SRC_TIP : PATCH_DST_TIP)[i] || label;
    const nut = elNS('circle'); nut.setAttribute('cx', jx); nut.setAttribute('cy', cy); nut.setAttribute('r', 6.5); nut.setAttribute('class', 'jack-nut');
    const hole = elNS('circle'); hole.setAttribute('cx', jx); hole.setAttribute('cy', cy); hole.setAttribute('r', 2.8); hole.setAttribute('class', 'jack-hole');
    const t = elNS('text'); t.setAttribute('y', cy + 3); t.setAttribute('class', 'patch-silk'); t.textContent = label;
    if (kind === 'src') { t.setAttribute('x', 6); t.setAttribute('text-anchor', 'start'); }
    else { t.setAttribute('x', PB_W - 6); t.setAttribute('text-anchor', 'end'); }
    g.append(tip, nut, hole, t); patchSvg.appendChild(g);
  };
  MOD_SRC.slice(1).forEach((n, i) => jack('src', i, SRCY[i], n));
  MOD_DST.forEach((n, j) => jack('dst', j, DSTY[j], n));
  host.appendChild(patchSvg);

  // drag a wire from either jack (source or destination)
  patchSvg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.patch-jack');
    if (!g) { if (patchSel !== -1) { patchSel = -1; renderPatch(); } return; }   // empty space -> deselect
    const startKind = g.dataset.kind, startI = +g.dataset.i;
    const ax = startKind === 'src' ? PB_SPIN : PB_DPIN;
    const ay = startKind === 'src' ? SRCY[startI] : DSTY[startI];
    const temp = elNS('path'); temp.setAttribute('class', 'cab-temp'); patchSvg._cables.appendChild(temp);
    try { patchSvg.setPointerCapture(e.pointerId); } catch (_) {}
    const mv = (ev) => { const q = svgPt(ev); temp.setAttribute('d', cablePath(ax, ay, q.x, q.y)); };
    const up = (ev) => {
      patchSvg.removeEventListener('pointermove', mv); patchSvg.removeEventListener('pointerup', up);
      try { patchSvg.releasePointerCapture(ev.pointerId); } catch (_) {}
      temp.remove();
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const tg = t && t.closest ? t.closest('.patch-jack') : null;
      if (tg && tg.dataset.kind !== startKind) {                     // connect to the opposite side
        const srcI = startKind === 'src' ? startI : +tg.dataset.i;
        const dstI = startKind === 'src' ? +tg.dataset.i : startI;
        const dup = findSlot(srcI + 1, dstI);   // already wired? don't add a duplicate
        if (dup >= 0) {
          patchSel = dup;                        // just select the existing cable (adjust its amount)
        } else {
          const slot = freeSlot();
          if (slot >= 0) { slotSet(slot, srcI + 1, dstI, 0.75); patchSel = slot; }
        }
      }
      renderPatch();
    };
    patchSvg.addEventListener('pointermove', mv); patchSvg.addEventListener('pointerup', up);
    mv(e);
  });
  renderPatch();
}

function renderPatch() {
  if (!patchSvg) return;
  const g = patchSvg._cables; g.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const s = slotGet(i); if (s.src === 0) continue;
    const d = cablePath(PB_SPIN, SRCY[s.src - 1], PB_DPIN, DSTY[s.dst]);
    const mag = Math.abs(s.amt * 2 - 1);   // bipolar amount magnitude -> brightness
    const cg = elNS('g'); cg.setAttribute('class', 'patch-cable' + (i === patchSel ? ' sel' : ''));
    const hit = elNS('path'); hit.setAttribute('d', d); hit.setAttribute('class', 'cab-hit');   // wide invisible click target
    const under = elNS('path'); under.setAttribute('d', d); under.setAttribute('class', 'cab-under');
    const core = elNS('path'); core.setAttribute('d', d); core.setAttribute('class', 'cab-core');
    core.style.stroke = (s.amt * 2 - 1) >= 0 ? 'var(--mode)' : 'var(--blue)';   // + green / - blue
    core.style.opacity = (0.28 + 0.72 * mag).toFixed(3);
    core.style.strokeWidth = (1.7 + 1.7 * mag).toFixed(2);
    cg.append(hit, under, core);
    cg.addEventListener('pointerdown', (e) => { e.stopPropagation(); patchSel = i; renderPatch(); });
    g.appendChild(cg);
  }
  patchSvg.querySelectorAll('.patch-jack').forEach((p) => {
    const kind = p.dataset.kind, i = +p.dataset.i; let used = false;
    for (let s = 0; s < 6; s++) { const sl = slotGet(s); if (sl.src === 0) continue;
      if (kind === 'src' && sl.src - 1 === i) used = true; if (kind === 'dst' && sl.dst === i) used = true; }
    p.classList.toggle('used', used);
  });
  const ins = $('#patchInspect');
  if (ins) {
    const ok = patchSel >= 0 && slotGet(patchSel).src > 0;
    ins.hidden = !ok;
    if (ok) { const s = slotGet(patchSel); $('#patchLabel').textContent = MOD_SRC[s.src] + ' → ' + MOD_DST[s.dst];
      if (patchKnobApply) patchKnobApply(); }
  }
}
/* bipolar AMOUNT knob for the currently-selected cable (value display = +/-100) */
(function buildPatchKnob() {
  const host = $('#patchAmtKnob'); if (!host) return;
  const k = el('div', 'knob'); const dial = el('div', 'knob-dial'); dial.appendChild(el('span', 'knob-pointer'));
  const lab = el('div', 'knob-label'); lab.textContent = 'AMT';
  const val = el('div', 'knob-val'); val.textContent = '+0';
  k.append(dial, lab, val); host.appendChild(k);
  const cur = () => patchSel >= 0 ? slotGet(patchSel).amt : 0.5;
  const apply = () => { const v = cur(); dial.style.setProperty('--rot', rotFor(v) + 'deg'); const b = Math.round((v * 2 - 1) * 100); val.textContent = (b > 0 ? '+' : '') + b; };
  patchKnobApply = apply;
  let sy = 0, sv = 0, drag = false;
  const set = (v) => { v = Math.max(0, Math.min(1, v)); slotSet(patchSel, null, null, v); apply(); renderPatch(); };
  dial.addEventListener('pointerdown', (e) => { if (patchSel < 0) return; drag = true; sy = e.clientY; sv = cur(); try { dial.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
  dial.addEventListener('pointermove', (e) => { if (drag) set(sv + (sy - e.clientY) / 200); });
  const end = (e) => { if (!drag) return; drag = false; try { dial.releasePointerCapture(e.pointerId); } catch (_) {} };
  dial.addEventListener('pointerup', end); dial.addEventListener('pointercancel', end);
  dial.addEventListener('dblclick', () => { if (patchSel >= 0) set(0.5); });   // centre = 0
  dial.addEventListener('wheel', (e) => { if (patchSel < 0) return; e.preventDefault(); set(cur() - Math.sign(e.deltaY) * 0.02); }, { passive: false });
})();
const patchRmEl = $('#patchRemove');
if (patchRmEl) patchRmEl.addEventListener('click', () => { if (patchSel < 0) return; slotSet(patchSel, 0, 0, 0.5); patchSel = -1; renderPatch(); });
function refreshMatrix() { renderPatch(); }   // called on preset load
buildPatch();
updateEngineUI();   // set the initial analog/wavetable control visibility

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
  if (stompNames[1]) stompNames[1].textContent = CONFIG.fsActions[name] || 'ACTION';  // FS2 = mode action
  sendCC(CONFIG.ccModeSelect, m / 2);   // tell the pedal to switch mode
  if (typeof applyPods === 'function') applyPods();   // synth-only panels follow the mode
}
function setFx(f) {
  activeFx = f; toggleEls[2].dataset.pos = f; updateToggleVals(2, f);
  document.querySelectorAll('#fxSeg button').forEach(b => b.classList.toggle('on', +b.dataset.fx === f));
  const fp = $('#fxPod');
  if (fp) fp.dataset.active = f > 0 ? 'on' : 'off';
  // changing FX re-opens the FX panel (and ticks it in View)
  if (typeof podShown !== 'undefined' && !podShown.fxPod) {
    podShown.fxPod = true; const fm = podMeta('fxPod'); if (fm && fm._cb) fm._cb.checked = true; saveView();
  }
  sendCC(CONFIG.ccFxSelect, f / 2);   // tell the pedal to switch FX
  if (typeof applyPods === 'function') applyPods(); else drawWires();
}
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
    v: 1, mode: activeMode, fx: activeFx, delaySync: delaySyncIdx,
    knobs: { mode: knobValue.mode.slice(), fx: knobValue.fx.slice(), synth: knobValue.synth.slice() },
    seq: serializeSeq(),
  };
}

// redraw every knob dial/readout from the current knobValue state
function refreshKnobs() {
  document.querySelectorAll('.knob').forEach(k => {
    const v = knobValue[k.dataset.bank][+k.dataset.idx];
    k.querySelector('.knob-dial').style.setProperty('--rot', rotFor(v) + 'deg');
    k.querySelector('.knob-val').textContent = String(Math.round(v * 127)).padStart(3, '0');
  });
  envRedraw();   // keep the ADSR graph in step with the dials
}
// re-light the wave / LFO shape / LFO dest / voices selectors from synth state
function refreshSegments() {
  const on = (sel, attr, val) =>
    document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', +b.dataset[attr] === val));
  on('#synthWaveSeg', 'w', Math.round(knobValue.synth[8] * 3));
  on('#lfoShapeSeg',  'w', Math.round(knobValue.synth[11] * 3));
  on('#voiceSeg',     'v', Math.round(knobValue.synth[13] * 5) + 1);
  on('#waveEngineSeg', 'e', Math.round(knobValue.synth[14]));
  on('#waveRatioSeg',  'r', Math.round(knobValue.synth[17] * 3));
  on('#waveBankSeg',   'b', Math.round(knobValue.synth[19] * 4));
  on('#synthFilterSeg', 'f', Math.round(knobValue.synth[21]));
  on('#synthUniSeg',    'u', Math.round(knobValue.synth[22] * 3) + 1);
  on('#subOctSeg',      'o', Math.round(knobValue.synth[23]));
  on('#subWaveSeg',     'w', Math.round(knobValue.synth[24]));
  on('#lfo2ShapeSeg',   'w', Math.round(knobValue.synth[26] * 3));
  on('#lfo1SyncSeg',    's', Math.round(knobValue.synth[46] * 5));
  on('#lfo2SyncSeg',    's', Math.round(knobValue.synth[47] * 5));
  refreshMatrix();
  updateEngineUI();
  updateLfoSyncUI();
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
  if (typeof p.delaySync === 'number') setDelaySync(p.delaySync);   // restore delay sync
  if (p.seq) { loadSeqState(p.seq); refreshSeqUI(); }   // restore the sequence too
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
  // virtual "Computer keyboard" input, listed right after "no device"
  const inSel = $('#midiIn');
  const ko = el('option'); ko.value = 'kbd'; ko.textContent = '⌨ Computer keyboard';
  if (kbdOn) ko.selected = true;
  inSel.insertBefore(ko, inSel.children[1] || null);
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
  if (!midiIn && !kbdOn) {
    if (savedIn === 'kbd') { selectIn('kbd'); $('#midiIn').value = 'kbd'; }
    else {
      const inId = resolveSaved(midi.inputs, savedIn, savedInName);
      if (inId) { selectIn(inId); $('#midiIn').value = inId; }
    }
  }
  updateConn();
}
function updateConn() {
  const n = midi ? midi.outputs.size : 0;
  if (midiOut) setStatus('live', 'connected');
  else if (midi) setStatus('ready', n ? 'pick a device' : 'no devices');
  else setStatus('off', 'offline');
  $('#footMidi').textContent = midi ? `${midi.outputs.size} out · ${midi.inputs.size} in` : 'no MIDI';
  const dfu = $('#dfuBtn'); if (dfu) dfu.disabled = !midiOut;   // only when a pedal is connected
  // THRU only makes sense with a distinct IN + OUT — disable the toggle otherwise
  const thruEl = $('#midiThru'); const thruField = thruEl && thruEl.closest('.switch-field');
  const thruOk = !!(midiIn && midiOut && !sameInOut());
  if (thruEl) thruEl.disabled = !thruOk;
  if (thruField) thruField.classList.toggle('disabled', !thruOk);
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
  setKbd(id === 'kbd');                                  // computer-keyboard "device"
  midiIn = (id && id !== 'kbd') ? midi.inputs.get(id) : null;
  if (midiIn) midiIn.onmidimessage = onMidiMessage;
  try {
    localStorage.setItem('propagator.in', id || '');
    localStorage.setItem('propagator.inName', midiIn ? (midiIn.name || '') : (id === 'kbd' ? 'kbd' : ''));
  } catch (_) {}
  updateConn();
}

/* ---- computer keyboard as a note source (a w s e d f t g y h u j ...) ---- */
const KBD_MAP = { a:0, w:1, s:2, e:3, d:4, f:5, t:6, g:7, y:8, h:9, u:10, j:11,
                  k:12, o:13, l:14, p:15, ';':16 };
let kbdOn = false, kbdOctave = 0;
const kbdHeld = new Map();   // physical key -> note currently sounding
function kbdSend(note, vel, on) {
  if (!midiOut) return;
  try { midiOut.send([(on ? 0x90 : 0x80) | (CONFIG.channel & 0x0f), note, vel]); } catch (_) {}
}
function kbdDown(e) {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;  // don't hijack typing
  const k = e.key.toLowerCase();
  if (k === 'z') { kbdOctave = Math.max(-3, kbdOctave - 1); return; }
  if (k === 'x') { kbdOctave = Math.min(3, kbdOctave + 1); return; }
  if (!(k in KBD_MAP) || kbdHeld.has(k)) return;
  const note = 60 + KBD_MAP[k] + kbdOctave * 12;
  kbdHeld.set(k, note); kbdSend(note, 100, true);
  if (midiAct) { midiAct.classList.add('kick'); setTimeout(() => midiAct.classList.remove('kick'), 130); }
  e.preventDefault();
}
function kbdUp(e) {
  const k = e.key.toLowerCase();
  if (!kbdHeld.has(k)) return;
  kbdSend(kbdHeld.get(k), 0, false); kbdHeld.delete(k);
}
function kbdPanic() { kbdHeld.forEach(note => kbdSend(note, 0, false)); kbdHeld.clear(); }
function setKbd(on) {
  if (on === kbdOn) return;
  kbdOn = on;
  if (on) {
    window.addEventListener('keydown', kbdDown); window.addEventListener('keyup', kbdUp);
    window.addEventListener('blur', kbdPanic);
  } else {
    window.removeEventListener('keydown', kbdDown); window.removeEventListener('keyup', kbdUp);
    window.removeEventListener('blur', kbdPanic);
    kbdPanic();   // release any stuck notes
  }
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
    // drive the sequencer from the external clock (24 PPQN)
    if (seq.on) {
      const tps = seqTicksPerStep();
      if ((seqClockTick % tps) === 0) seqFire(seqStepMs(clockBpm || bpm));
      seqClockTick++;
    }
  }
  lastClockMs = now;
}

function onMidiMessage(e) {
  const d = e.data, status = d[0];
  // realtime: clock + transport
  if (status === 0xF8) { handleClockTick(performance.now()); fwd(d, 'clock'); return; }
  if (status === 0xFA || status === 0xFB || status === 0xFC) {
    if (status === 0xFA) { clockCount = 0; seqClockTick = 0; seqIdx = 0; seqDir = 1; if (clockSync) setPlaying(true); }   // start
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
  if (typeof applyPods === 'function') applyPods();   // MIDI-thru pod context may have changed
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
  if (clockMaster === 'gui' && midiOut) sendCC(CONFIG.ccTempo, Math.max(0, Math.min(1, (bpm - 40) / 160)));
}

function updateTransportUI() {
  const b1 = $('#bpmMiniPlay'); if (b1) b1.textContent = playing ? '⏹' : '▶';
  const b2 = $('#bpmPlay'); if (b2) b2.textContent = playing ? '⏹ stop' : '▶ start';
}
function setPlaying(p) {
  playing = p;
  updateTransportUI();
  if (clockMaster === 'gui' && midiOut) { try { midiOut.send([playing ? 0xFA : 0xFC]); } catch (_) {} }
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

/* ---- clock master: GUI emits 24-PPQN MIDI clock to the pedal, or we forward the
   input device's clock. The pedal locks to whichever and tempo-syncs its delay. ---- */
let clockTimer = null, clockTickAt = 0;
function startClockEmit() {
  stopClockEmit();
  clockTickAt = performance.now();
  clockTimer = setInterval(() => {
    if (clockMaster !== 'gui' || !midiOut) return;
    const now = performance.now(), tickMs = 60000 / (bpm * 24);
    let guard = 0;
    while (now - clockTickAt >= tickMs && guard++ < 96) { try { midiOut.send([0xF8]); } catch (_) {} clockTickAt += tickMs; }
  }, 6);
}
function stopClockEmit() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
function setClockMaster(c) {
  clockMaster = c;
  document.querySelectorAll('#clockMasterSeg button').forEach(b => b.classList.toggle('on', b.dataset.c === c));
  thruFilter.clock = (c === 'in');   // forward the input device's clock to the pedal
  if (c === 'gui') {
    startClockEmit();
    if (midiOut) { sendCC(CONFIG.ccTempo, Math.max(0, Math.min(1, (bpm - 40) / 160))); if (playing) { try { midiOut.send([0xFA]); } catch (_) {} } }
  } else {
    stopClockEmit();
    if (c === 'off' && midiOut) { try { midiOut.send([0xFC]); } catch (_) {} }
  }
  try { localStorage.setItem('propagator.clock', c); } catch (_) {}
}
$('#clockMasterSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setClockMaster(b.dataset.c); });
function setDelaySync(s) {
  delaySyncIdx = s;
  document.querySelectorAll('#delaySyncSeg button').forEach(x => x.classList.toggle('on', +x.dataset.s === s));
  sendCC(CONFIG.ccDelaySync, s / 4);
}
$('#delaySyncSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setDelaySync(+b.dataset.s); });
try { setClockMaster(localStorage.getItem('propagator.clock') || 'off'); } catch (_) { setClockMaster('off'); }

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
   STEP SEQUENCER — a small piano-roll that plays MIDI out to the pedal.
   Notes live on a pitch×step grid (scale-locked); the loop is 1–4 bars long
   and "order" sets the column playback direction (forward / back / ping-pong /
   random). It rides the same tempo + MIDI clock as the beat engine.
   ========================================================================= */
const ROWS = 8;                               // pitch rows shown (scale degrees 0..7)
const SCALES = [
  { name: 'Maj',  steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Min',  steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dor',  steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Pent', steps: [0, 3, 5, 7, 10] },
  { name: 'Chr',  steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];
const SEQ_GATES = [0.25, 0.5, 0.75, 0.98];    // note length as a fraction of the step
const SEQ_KEY = 'propagator.seq';

const seq = { on: false, scale: 0, root: 0, oct: 4, order: 0, gate: 1,
              stepsPerBar: 16, bars: 1, viewedBar: 0, cells: new Set() };
['0:0', '2:2', '4:4', '6:2', '8:4', '10:7', '12:4', '14:2'].forEach(k => seq.cells.add(k));   // default riff
let seqIdx = 0, seqDir = 1, seqClockTick = 0, seqNext = performance.now(), curStep = -1;

function seqTotal() { return seq.stepsPerBar * seq.bars; }          // total steps in the loop
function seqStepMs(bpmV) { return 4 * (60000 / bpmV) / seq.stepsPerBar; }   // a bar = 4 beats
function seqTicksPerStep() { return Math.max(1, Math.round(96 / seq.stepsPerBar)); }   // 96 PPQN per bar
function degToMidi(deg) {
  const sc = SCALES[seq.scale].steps, L = sc.length;
  const oct = Math.floor(deg / L), idx = ((deg % L) + L) % L;
  return 12 * (seq.oct + 1) + seq.root + sc[idx] + 12 * oct;
}
const cellKey = (step, deg) => step + ':' + deg;
function hasNote(step, deg) { return seq.cells.has(cellKey(step, deg)); }
function setNote(step, deg, on) { const k = cellKey(step, deg); if (on) seq.cells.add(k); else seq.cells.delete(k); }
function notesAt(step) { const out = []; for (let d = 0; d < ROWS; d++) if (hasNote(step, d)) out.push(d); return out; }

/* ---- piano-roll grid ---- */
const seqGridEl = $('#seqGrid');
const seqBarTabsEl = $('#seqBarTabs');
function stepOfCell(c) { return seq.viewedBar * seq.stepsPerBar + (+c.dataset.col); }
function buildGrid() {
  seqGridEl.style.setProperty('--cols', seq.stepsPerBar);
  seqGridEl.innerHTML = '';
  for (let row = 0; row < ROWS; row++) {
    const deg = ROWS - 1 - row;               // top row = highest pitch
    const lab = el('span', 'seq-rlabel'); lab.dataset.deg = deg; seqGridEl.appendChild(lab);
    for (let col = 0; col < seq.stepsPerBar; col++) {
      const c = el('span', 'seq-cell'); c.dataset.col = col; c.dataset.deg = deg;
      if (col % 4 === 0) c.classList.add('beat');   // faint bar-quarter guides
      seqGridEl.appendChild(c);
    }
  }
  paintGrid();
}
function paintGrid() {
  seqGridEl.querySelectorAll('.seq-rlabel').forEach(l => { l.textContent = noteName(degToMidi(+l.dataset.deg)); });
  seqGridEl.querySelectorAll('.seq-cell').forEach(c => {
    const step = stepOfCell(c), deg = +c.dataset.deg;
    c.classList.toggle('on', hasNote(step, deg));
    c.classList.toggle('cur', seq.on && step === curStep);
  });
}
function paintCursor() {
  seqGridEl.querySelectorAll('.seq-cell').forEach(c => { c.classList.toggle('cur', seq.on && stepOfCell(c) === curStep); });
  if (seqBarTabsEl) seqBarTabsEl.querySelectorAll('button').forEach(b =>
    b.classList.toggle('playing', seq.on && curStep >= 0 && +b.dataset.bar === Math.floor(curStep / seq.stepsPerBar)));
}

/* click / drag to paint notes */
let seqPainting = false, seqPaintVal = true;
seqGridEl.addEventListener('pointerdown', (e) => {
  const c = e.target.closest('.seq-cell'); if (!c) return;
  e.stopPropagation();                        // don't start a pod drag
  const step = stepOfCell(c), deg = +c.dataset.deg;
  seqPaintVal = !hasNote(step, deg);
  setNote(step, deg, seqPaintVal); c.classList.toggle('on', seqPaintVal);
  seqPainting = true;
});
seqGridEl.addEventListener('pointerover', (e) => {
  if (!seqPainting) return;
  const c = e.target.closest('.seq-cell'); if (!c) return;
  const step = stepOfCell(c), deg = +c.dataset.deg;
  setNote(step, deg, seqPaintVal); c.classList.toggle('on', seqPaintVal);
});
window.addEventListener('pointerup', () => { if (seqPainting) { seqPainting = false; saveSeq(); } });

/* ---- bar tabs (which bar you're editing; only shown for multi-bar loops) ---- */
function buildBarTabs() {
  seqBarTabsEl.innerHTML = '';
  if (seq.bars <= 1) { seqBarTabsEl.hidden = true; return; }
  seqBarTabsEl.hidden = false;
  for (let b = 0; b < seq.bars; b++) {
    const btn = el('button'); btn.dataset.bar = b; btn.textContent = b + 1;
    btn.classList.toggle('on', b === seq.viewedBar);
    btn.addEventListener('click', (e) => { e.stopPropagation(); seq.viewedBar = b; buildBarTabs(); paintGrid(); });
    seqBarTabsEl.appendChild(btn);
  }
}

/* ---- selectors ---- */
function wireSeqSeg(sel, attr, cb) {
  const root = $(sel); if (!root) return;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = +b.dataset[attr];
    root.querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset[attr] === v));
    cb(v); saveSeq();
  });
}
wireSeqSeg('#seqScaleSeg', 's', v => { seq.scale = v; paintGrid(); });
wireSeqSeg('#seqOrderSeg', 'o', v => { seq.order = v; });
wireSeqSeg('#seqGateSeg',  'g', v => { seq.gate = v; });
wireSeqSeg('#seqStepsSeg', 'p', v => { seq.stepsPerBar = v; if (seq.viewedBar >= seq.bars) seq.viewedBar = 0; buildGrid(); });
wireSeqSeg('#seqBarsSeg',  'b', v => { seq.bars = v; if (seq.viewedBar >= seq.bars) seq.viewedBar = seq.bars - 1; buildBarTabs(); paintGrid(); });
$('#seqRoot').addEventListener('change', e => { seq.root = +e.target.value; paintGrid(); saveSeq(); });
$('#seqOct').addEventListener('change',  e => { seq.oct  = +e.target.value; paintGrid(); saveSeq(); });
$('#seqClear').addEventListener('click', () => { seq.cells.clear(); paintGrid(); saveSeq(); });
$('#seqSeed').addEventListener('click', () => {
  seq.cells.clear();
  const total = seqTotal();
  for (let s = 0; s < total; s++) if (Math.random() < 0.4) setNote(s, Math.floor(Math.random() * ROWS), true);
  paintGrid(); saveSeq();
});

/* ---- run / stop ---- */
const seqRunBtn = $('#seqRun');
function setSeqOn(on) {
  seq.on = on;
  if (seqRunBtn) { seqRunBtn.classList.toggle('on', on); seqRunBtn.textContent = on ? '⏹ stop' : '▶ run'; }
  if (on) {
    seqIdx = 0; seqDir = 1; seqClockTick = 0; curStep = -1; seqNext = performance.now();
    if (!playing) setPlaying(true);     // give the internal clock something to run on
  } else {
    curStep = -1; paintCursor();
  }
}
seqRunBtn.addEventListener('click', () => setSeqOn(!seq.on));

/* ---- stepping ---- */
function seqNextIdx(i) {
  const N = seqTotal();
  switch (seq.order) {
    case 1: return (i - 1 + N) % N;                                                                   // backward
    case 2: { let n = i + seqDir; if (n >= N) { n = N - 2; seqDir = -1; } else if (n < 0) { n = 1; seqDir = 1; } return Math.max(0, Math.min(N - 1, n)); }  // ping-pong
    case 3: return Math.floor(Math.random() * N);                                                     // random
    default: return (i + 1) % N;                                                                      // forward
  }
}
function seqFire(stepMs) {
  if (seqIdx >= seqTotal()) seqIdx = 0;
  curStep = seqIdx;
  const degs = notesAt(seqIdx);
  if (degs.length && midiAct) { midiAct.classList.add('kick'); setTimeout(() => midiAct.classList.remove('kick'), 90); }
  const offMs = Math.max(20, stepMs * SEQ_GATES[seq.gate]);
  degs.forEach(d => { const note = degToMidi(d); kbdSend(note, 100, true); setTimeout(() => kbdSend(note, 0, false), offMs); });
  paintCursor();
  seqIdx = seqNextIdx(seqIdx);
}

/* ---- persistence (its own key, and folded into presets) ---- */
function serializeSeq() {
  return { scale: seq.scale, root: seq.root, oct: seq.oct, order: seq.order, gate: seq.gate,
           stepsPerBar: seq.stepsPerBar, bars: seq.bars, cells: [...seq.cells] };
}
function saveSeq() { try { localStorage.setItem(SEQ_KEY, JSON.stringify(serializeSeq())); } catch (_) {} }
function loadSeqState(o) {
  if (!o) return;
  ['scale', 'root', 'oct', 'order', 'gate', 'stepsPerBar', 'bars'].forEach(k => { if (typeof o[k] === 'number') seq[k] = o[k]; });
  if (seq.bars < 1) seq.bars = 1;
  if (seq.viewedBar >= seq.bars) seq.viewedBar = 0;
  if (Array.isArray(o.cells)) seq.cells = new Set(o.cells.filter(x => typeof x === 'string'));
}
function refreshSeqUI() {
  const lit = (sel, attr, val) => document.querySelectorAll(sel + ' button').forEach(b => b.classList.toggle('on', +b.dataset[attr] === val));
  lit('#seqScaleSeg', 's', seq.scale);
  lit('#seqOrderSeg', 'o', seq.order);
  lit('#seqGateSeg',  'g', seq.gate);
  lit('#seqStepsSeg', 'p', seq.stepsPerBar);
  lit('#seqBarsSeg',  'b', seq.bars);
  const rs = $('#seqRoot'); if (rs) rs.value = seq.root;
  const os = $('#seqOct');  if (os) os.value = seq.oct;
  buildBarTabs(); buildGrid();
}
try { loadSeqState(JSON.parse(localStorage.getItem(SEQ_KEY) || 'null')); } catch (_) {}
refreshSeqUI();

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
// a point on the pedal's edge facing `toward`, at height y — keeps the wire in
// the gutter so it never crosses the pedal face / footswitch LEDs
function pedalEdge(toward, y) {
  const pw = $('.pedal-wrap'); if (!pw) return { x: toward.x, y };
  const r = pw.getBoundingClientRect(); const s = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2 - s.left;
  const x = toward.x > cx ? r.right - s.left : r.left - s.left;
  return { x, y };
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
  const fxPod = $('#fxPod');
  const tog = center(toggleEls[2]);
  if (!fxPod || fxPod.classList.contains('closed') || !tog) return;
  const b = edgePoint(fxPod, tog);
  const a = pedalEdge(b, tog.y - 22);   // pedal edge, lifted above the footswitch LED
  wirePath(a, b, activeFx > 0).forEach(n => wires.appendChild(n));
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
  // step the sequencer on the internal clock (external clock drives it elsewhere)
  if (seq.on && playing && !clockActive) {
    const stepMs = seqStepMs(bpm);
    if (now >= seqNext) {
      seqFire(stepMs);
      seqNext += stepMs;
      if (now - seqNext > stepMs) seqNext = now + stepMs;   // resync after backgrounding
    }
  }
  drawWires();
  requestAnimationFrame(loop);
}

/* ===========================================================================
   DRAGGABLE PODS — grab an empty part of a breakout box to move it.
   (Starting a drag on a control inside is ignored so knobs/buttons still work.
   Uses left/top so the float animation's transform still composes; wires follow.)
   ========================================================================= */
const PODS = [
  { id: 'synthPod',  label: 'Voice',      group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'envPod',    label: 'Envelope',   group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'wavePod',   label: 'Oscillator', group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'matrixPod', label: 'Modulation', group: 'VOICE',  col: 'R', synthOnly: true },
  { id: 'seqPod',    label: 'Sequencer',  group: 'PLAY',   col: 'R' },
  { id: 'fxPod',     label: 'FX',         group: 'PLAY',   col: 'R' },
  { id: 'bpmPod',    label: 'Tempo',      group: 'SYSTEM', col: 'L', tempo: true },
  { id: 'midiPod',   label: 'MIDI Thru',  group: 'SYSTEM', col: 'R' },
];
const VIEW_KEY = 'propagator.view';
const VIEW_DEFAULT = { synthPod: true, envPod: false, wavePod: false, matrixPod: false, seqPod: false, fxPod: true, bpmPod: false, midiPod: true };
let podShown = Object.assign({}, VIEW_DEFAULT);
try { Object.assign(podShown, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch (_) {}
function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(podShown)); } catch (_) {} }
function podMeta(id) { return PODS.find(p => p.id === id); }
function podContextOK(p) {
  if (p.synthOnly && activeMode !== 0) return false;
  if (p.needThru && !(thru && midiIn && midiOut)) return false;
  return true;
}
// show/hide every pod from podShown + context, then re-stack
function applyPods() {
  PODS.forEach(p => {
    const pe = $('#' + p.id); if (!pe) return;
    const want = podShown[p.id] && podContextOK(p);
    if (p.tempo) { setBpmPodClosed(!want); }
    else { pe.hidden = false; pe.style.display = want ? '' : 'none'; }
  });
  layoutPods();
  envRedraw();   // re-draw the ADSR graph whenever the env pod is (re)shown
}
function applyPod(pe) {
  const bx = +(pe.dataset.bx || 0), by = +(pe.dataset.by || 0);
  const dx = +(pe.dataset.dx || 0), dy = +(pe.dataset.dy || 0);
  pe.style.left = (bx + dx) + 'px'; pe.style.top = (by + dy) + 'px';
}
function clampPod(pe) {
  const r = pe.getBoundingClientRect(), m = 8;
  let dx = +(pe.dataset.dx || 0), dy = +(pe.dataset.dy || 0);
  if (r.left < m) dx += m - r.left; else if (r.right > innerWidth - m) dx += (innerWidth - m) - r.right;
  if (r.top < m) dy += m - r.top; else if (r.bottom > innerHeight - m) dy += (innerHeight - m) - r.bottom;
  pe.dataset.dx = dx; pe.dataset.dy = dy; applyPod(pe);
}
function podLaidOut(pe) { return pe && getComputedStyle(pe).display !== 'none' && !pe.classList.contains('closed'); }
// Absolute layout: stack visible pods top-down per column. Called on view/mode/
// resize/reset only -- NOT on a pod's own content change, so nothing jumps.
function layoutPods() {
  const m = 14, gap = 14, sw = stage.clientWidth;
  ['L', 'R'].forEach(side => {
    let y = 14;
    PODS.filter(p => p.col === side).forEach(p => {
      const pe = $('#' + p.id); if (!pe || !podLaidOut(pe)) return;
      pe.dataset.bx = side === 'L' ? m : (sw - pe.offsetWidth - m);
      pe.dataset.by = y;
      applyPod(pe); clampPod(pe);
      y += pe.offsetHeight + gap;
    });
  });
  drawWires();
}
const reflowPods = layoutPods;   // keep the name used by other callers

function makeDraggable(pod) {
  if (!pod) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  pod.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.knob, button, input, label, .pill, .switch-field, .bpm-dial, select, .seg, .seq-grid, .env-graph, .patchbay, .beat-seed')) return;
    dragging = true; pod.classList.add('dragging');
    sx = e.clientX; sy = e.clientY; ox = +(pod.dataset.dx || 0); oy = +(pod.dataset.dy || 0);
    pod.setPointerCapture(e.pointerId); e.preventDefault();
  });
  pod.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pod.dataset.dx = ox + (e.clientX - sx); pod.dataset.dy = oy + (e.clientY - sy);
    applyPod(pod); drawWires();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false; clampPod(pod); pod.classList.remove('dragging'); drawWires();
    try { pod.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  pod.addEventListener('pointerup', end);
  pod.addEventListener('pointercancel', end);
}
PODS.forEach(p => makeDraggable($('#' + p.id)));

// × on every pod -> hide it (and untick it in the View menu)
PODS.forEach(p => {
  const pe = $('#' + p.id); if (!pe) return;
  const btn = el('button', 'pod-close'); btn.textContent = '×'; btn.title = 'hide (re-open from View)';
  btn.addEventListener('click', (e) => { e.stopPropagation(); podShown[p.id] = false; if (p._cb) p._cb.checked = false; saveView(); applyPods(); });
  pe.appendChild(btn);
});

function resetPods() {
  PODS.forEach(p => { const pe = $('#' + p.id); if (pe) { delete pe.dataset.dx; delete pe.dataset.dy; } });
  podShown = Object.assign({}, VIEW_DEFAULT); saveView();
  PODS.forEach(p => { if (p._cb) p._cb.checked = !!podShown[p.id]; });
  applyPods();
}
$('#resetLayout').addEventListener('click', resetPods);

/* View menu — grouped show/hide toggles in the topbar */
function buildViewMenu() {
  const menu = $('#viewMenu'); if (!menu) return;
  let lastGroup = '';
  PODS.forEach(p => {
    if (p.group !== lastGroup) { const h = el('div', 'view-group'); h.textContent = p.group; menu.appendChild(h); lastGroup = p.group; }
    const lab = el('label', 'view-item');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!podShown[p.id];
    cb.addEventListener('change', () => { podShown[p.id] = cb.checked; saveView(); applyPods(); });
    const sp = el('span'); sp.textContent = p.label;
    lab.append(cb, sp); menu.appendChild(lab); p._cb = cb;
  });
}
const viewBtn = $('#viewBtn');
if (viewBtn) viewBtn.addEventListener('click', (e) => { e.stopPropagation(); const m = $('#viewMenu'); if (m) m.hidden = !m.hidden; });
document.addEventListener('click', (e) => { const m = $('#viewMenu'); if (m && !m.hidden && !e.target.closest('.view-wrap')) m.hidden = true; });
buildViewMenu();

/* turn 2-4-option selectors into panel-style N-way switches (CSS does the look) */
function makeSwitches() {
  document.querySelectorAll('.seg, .lfo-dest, .seq-seg, .synth-wave').forEach(sel => {
    const n = sel.querySelectorAll(':scope > button').length;
    if (n >= 2) sel.classList.add('sw', 'sw-' + n);   // all multi-option selectors -> switch styling
  });
}
makeSwitches();

/* DFU: ask the pedal to reboot into the STM bootloader for flashing. The pedal
   then drops off USB-MIDI (expected) until it's reflashed / power-cycled. */
$('#dfuBtn').addEventListener('click', () => {
  if (!midiOut) return;
  if (!confirm('Reboot the pedal into DFU mode for flashing?\nIt will disconnect from MIDI until you flash it or power-cycle.')) return;
  sendCC(CONFIG.ccSysReboot, 1);   // -> 127, firmware reboots to STM DFU
  if (midiLast) midiLast.textContent = 'sent: reboot to DFU';
});

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
