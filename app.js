/* ============================================================================
   PROPAGATOR (WebMIDI) — the cultivating surface for Spore
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
  ccDaisyReboot: 118,               // CC 118 >=64 -> reboot into the Daisy bootloader (reflash the app, QSPI)
  ccSysReboot:  119,                // CC 119 >=64 -> reboot into the STM ROM DFU (reflash the bootloader itself)
  ccChaos:      [18],               // CC 18 -> Lorenz chaos speed (single-knob "bank")
  ccVar:        93,                 // CC 93 -> VAR / Toggle 2 (thirds: 0 / 1 / 2)
  ccFs1:        91,                 // CC 91 >=64 -> bypass on, <64 -> engaged
  ccFs2:        92,                 // CC 92 >=64 -> mode action (freeze / re-seed)
  ccMasterFilt: 88,                 // CC 88 -> master filter type (0 off / 1 LP / 2 BP / 3 HP)
  ccMaster:     [7, 89, 90],        // master "bank": [volume(CC7) · cutoff(CC89) · res(CC90)]
  ccGen:        [32, 33, 34, 35, 36, 37],   // GENERATIVE pod bank: chord·swell·motion·bright·texture·wander
  ccGran:       [94, 95, 96, 97],           // GRANULAR pod bank: reverse·width·shape·scale

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
const annot     = $('#annot');
const knobsRow  = $('#knobs');
const fxKnobsEl = $('#fxKnobs');
const togglesEl = $('#toggles');
const stompsEl  = $('#stomps');
const midiPod   = $('#midiPod'), midiAct = $('#midiAct'), midiLast = $('#midiLast');

/* ---------- MIDI state ---------- */
let midi = null, midiOut = null, midiIn = null;
let sporeIn = null;   // Spore's own MIDI input (telemetry), independent of the performance input
let thru = true;   // forward IN-device messages to Spore (OUT)
let latestFw = null;     // {version,size,file} from ./firmware/latest.json
let connectedFw = null;  // version string from Spore's SysEx identify reply
let clockMaster = 'off';   // tempo master: 'off' | 'gui' | 'in'
let delaySyncIdx = 0;      // delay tempo-sync division (part of a patch/preset)
// clock forwarding off by default; the UI's beat sync reads clock locally
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
  chaos: [0.15],   // Lorenz speed (0..1 -> CC 18); 0.15 ~= the firmware default 2.0
  master: [1.0, 1.0, 0.0],   // master out: [volume · filter cutoff · resonance]
  gen: [0.40, 0.50, 0.45, 0.50, 0.50, 0.35],   // generative: chord·swell·motion·bright·texture·wander
  gran: [0.30, 0.00, 0.00, 0.00],   // granular: reverse·width·shape·scale (defaults = stock sound)
};
let activeVar = 0;          // VAR / Toggle 2 position (0/1/2), part of a patch
let activeMasterFilt = 0;   // master filter type: 0 off / 1 LP / 2 BP / 3 HP
let applyingRemote = false; // true while mirroring incoming CC -> UI (suppresses re-send)
// pristine defaults, captured before any preset/autosave restore — used by "new"
const KNOB_DEFAULTS = { mode: knobValue.mode.slice(), fx: knobValue.fx.slice(), synth: knobValue.synth.slice(), chaos: knobValue.chaos.slice(), master: knobValue.master.slice(), gen: knobValue.gen.slice(), gran: knobValue.gran.slice() };

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
  const cc = (bank === 'mode' ? CONFIG.ccMode : bank === 'fx' ? CONFIG.ccFx : bank === 'chaos' ? CONFIG.ccChaos : bank === 'master' ? CONFIG.ccMaster : bank === 'gen' ? CONFIG.ccGen : bank === 'gran' ? CONFIG.ccGran : CONFIG.ccSynth)[idx];

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
  envRedraw();   // redraw the synth filter curve (Svf 2-pole <-> Moog 4-pole)
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
  if (!envSvg) { buildEnv(); if (!envSvg) return; }   // build on first draw
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
    e.preventDefault(); e.stopPropagation();
    const mv = (ev) => { onMove(envPoint(ev)); drawEnv(); refreshKnobs(); };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
  const mkH = (cls) => { const c = document.createElementNS(NSVG, 'circle'); c.setAttribute('r', '7'); c.setAttribute('class', 'env-handle ' + cls); return c; };
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
/* ---- filter response curves (master output + synth filter-env "pluck") ---- */
// Idealised state-variable magnitude over a 20Hz-20kHz log axis. type: 0 off/flat,
// 1 LP, 2 BP, 3 HP. poles 2 or 4 (4 = steeper, drawn as the 2-pole response squared).
function drawFilterCurve(canvas, type, fc01, q01, fmin, fmax, opts) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const W = canvas.width, H = canvas.height, pad = 4;
  ctx.clearRect(0, 0, W, H);
  const fLo = 20, fHi = 20000;
  const fc = fmin * Math.pow(fmax / fmin, fc01);     // cutoff (knob 0..1 -> Hz, exp)
  const Q = 0.5 + q01 * 9.0;                          // resonance -> Q (visual)
  const poles = (opts && opts.poles) || 2;
  const ghost = opts && opts.ghost;                   // dim "no-filter" look when off
  const dB = (f) => {
    if (type === 0) return 0;                         // off -> flat
    const w = f / fc;
    const d = Math.sqrt((1 - w * w) * (1 - w * w) + (w / Q) * (w / Q));
    let m = type === 1 ? 1 / d : type === 3 ? (w * w) / d : (w / Q) / d;  // LP / HP / BP
    if (poles >= 4) m *= m;                           // cascade ~ 4-pole
    return 20 * Math.log10(Math.max(m, 1e-4));
  };
  const x = (f) => pad + (Math.log(f / fLo) / Math.log(fHi / fLo)) * (W - 2 * pad);
  const y = (db) => pad + (1 - (Math.max(-36, Math.min(18, db)) + 36) / 54) * (H - 2 * pad);
  // 0 dB grid line
  ctx.strokeStyle = 'rgba(91,208,230,.15)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(W - pad, y(0)); ctx.stroke();
  // the curve (canvas can't read CSS vars, so resolve --mode to a real colour)
  const accent = getComputedStyle(document.body).getPropertyValue('--mode').trim() || '#3fb56b';
  ctx.strokeStyle = ghost ? 'rgba(120,150,170,.45)' : accent;
  ctx.lineWidth = 2; ctx.beginPath();
  for (let px = pad; px <= W - pad; px++) {
    const f = fLo * Math.pow(fHi / fLo, (px - pad) / (W - 2 * pad));
    const yy = y(dB(f));
    if (px === pad) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
  }
  ctx.stroke();
}
function drawMasterFilt() {
  const c = $('#masterFiltViz'); if (!c) return;
  drawFilterCurve(c, activeMasterFilt, knobValue.master[1], knobValue.master[2],
                  40, 18000, { poles: 2, ghost: activeMasterFilt === 0 });
  drawFreqCursor(c);
}
function drawSynthFilt() {
  const c = $('#synthFiltViz'); if (!c) return;
  // synth voice filter: cutoff = mode knob 1, res = mode knob 2, poles from SP_FILTER (21)
  const cut = knobValue.mode[0], res = knobValue.mode[1];
  const poles = knobValue.synth[21] >= 0.5 ? 4 : 2;     // Svf 2-pole | Moog 4-pole
  const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  // faint "pluck peak" curve: the filter-env (SP_FENV_AMT, idx 4) sweeps cutoff up
  const peak = Math.min(1, cut + knobValue.synth[4] * 0.45);
  drawFilterCurve(c, 1, peak, res, 40, 12000, { poles, ghost: true });
  // draw the base curve on top (same canvas; drawFilterCurve clears, so layer manually)
  drawFilterCurveOver(c, 1, cut, res, 40, 12000, poles);
  drawFreqCursor(c);
}
// Hover read-out: a vertical line + estimated frequency at the mouse x (set by the
// mousemove handler). Same 20Hz-20kHz log axis the curves use.
function drawFreqCursor(canvas) {
  const hx = canvas._hoverX; if (hx == null) return;
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const W = canvas.width, H = canvas.height, pad = 4, fLo = 20, fHi = 20000;
  const frac = Math.max(0, Math.min(1, (hx - pad) / (W - 2 * pad)));
  const f = fLo * Math.pow(fHi / fLo, frac);
  ctx.strokeStyle = 'rgba(150,200,220,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hx, pad); ctx.lineTo(hx, H - pad); ctx.stroke();
  const txt = f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + ' kHz' : Math.round(f) + ' Hz';
  ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = '#cfeaf2';
  const tw = ctx.measureText(txt).width;
  ctx.fillText(txt, hx + 5 + tw > W ? hx - 5 - tw : hx + 5, 11);
}
// draw a curve onto a canvas WITHOUT clearing (for layering base over the ghost peak)
function drawFilterCurveOver(canvas, type, fc01, q01, fmin, fmax, poles) {
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  const W = canvas.width, H = canvas.height, pad = 4, fLo = 20, fHi = 20000;
  const fc = fmin * Math.pow(fmax / fmin, fc01), Q = 0.5 + q01 * 9.0;
  const y = (db) => pad + (1 - (Math.max(-36, Math.min(18, db)) + 36) / 54) * (H - 2 * pad);
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--mode').trim() || '#3fb56b';
  ctx.lineWidth = 2; ctx.beginPath();
  for (let px = pad; px <= W - pad; px++) {
    const f = fLo * Math.pow(fHi / fLo, (px - pad) / (W - 2 * pad));
    const w = f / fc, d = Math.sqrt((1 - w * w) * (1 - w * w) + (w / Q) * (w / Q));
    let m = 1 / d; if (poles >= 4) m *= m;
    const yy = y(20 * Math.log10(Math.max(m, 1e-4)));
    if (px === pad) ctx.moveTo(px, yy); else ctx.lineTo(px, yy);
  }
  ctx.stroke();
}
function redrawGraphs() { drawEnv(); drawMasterFilt(); drawSynthFilt(); }
envRedraw = redrawGraphs;   // knob edits (and applyPatch) refresh ADSR + both filter curves
redrawGraphs();
// hover read-out of the estimated frequency on each filter curve
[['#masterFiltViz', drawMasterFilt], ['#synthFiltViz', drawSynthFilt]].forEach(([sel, fn]) => {
  const c = $(sel); if (!c) return;
  c.addEventListener('mousemove', (e) => {
    const r = c.getBoundingClientRect();
    c._hoverX = (e.clientX - r.left) / r.width * c.width;   // CSS px -> canvas px
    fn();
  });
  c.addEventListener('mouseleave', () => { c._hoverX = null; fn(); });
});

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
const MOD_SRC = ['Off', 'LFO1', 'LFO2', 'Rnd', 'Sens', 'Vel', 'Key', 'Chaos', 'Steps'];   // -> synth param * 8
const MOD_DST = ['Cutoff', 'Pitch', 'Scan', 'Drive', 'Sub', 'FM', 'Amp', 'LFO1 Hz', 'LFO2 Hz'];  // -> param * 8
// hover explanations (index aligns with MOD_SRC.slice(1) and MOD_DST)
const PATCH_SRC_TIP = [
  'LFO1 — first low-frequency oscillator (rate/shape above)',
  'LFO2 — second LFO (its own rate/shape/depth)',
  'Rnd — random / sample-and-hold wobble from the hardware RNG',
  'Sens — the analog sensor input (light/pressure)',
  'Vel — note velocity, per voice (MIDI notes or the sequencer)',
  'Key — note pitch / key-track, per voice (centred on middle C)',
  'Chaos — Lorenz attractor: smooth, deterministic-but-never-repeating drift',
  'Steps — logistic-map chaos: stepped (sample & hold) with hidden structure',
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
const chaosKnobsEl = $('#chaosKnobs');
if (chaosKnobsEl) chaosKnobsEl.appendChild(makeKnob('chaos', 0, 'Speed'));   // CC 18 -> Lorenz speed
const masterKnobsEl = $('#masterKnobs');
if (masterKnobsEl) {
  masterKnobsEl.appendChild(makeKnob('master', 0, 'Volume'));   // CC 7
  masterKnobsEl.appendChild(makeKnob('master', 1, 'Cutoff'));   // CC 89
  masterKnobsEl.appendChild(makeKnob('master', 2, 'Res'));      // CC 90
}
const masterFiltSeg = $('#masterFiltSeg');
if (masterFiltSeg) masterFiltSeg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) setMasterFilt(+b.dataset.t);   // CC 88
});
const genKnobsEl = $('#genKnobs');
if (genKnobsEl) ['Chord', 'Swell', 'Motion', 'Bright', 'Texture', 'Wander']
  .forEach((lbl, i) => genKnobsEl.appendChild(makeKnob('gen', i, lbl)));   // CC 32-37

const granKnobsEl = $('#granKnobs');
if (granKnobsEl) ['Reverse', 'Width', 'Shape', 'Scale']
  .forEach((lbl, i) => granKnobsEl.appendChild(makeKnob('gran', i, lbl)));   // CC 94-97
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
   destination; Spore sums per destination. ---- */
const NSV = 'http://www.w3.org/2000/svg';
const elNS = (n) => document.createElementNS(NSV, n);
const PATCH_SLOTS = [27, 30, 33, 36, 39, 42];   // synth idx of each slot's SRC (DST=+1, AMT=+2)
const PB_W = 300, PB_H = 176;
const PB_SPIN = 66, PB_DPIN = PB_W - 66;               // source / dest jack centres (cable anchors)
const SRCY = [14, 35, 55, 76, 96, 117, 137, 158];      // 8 source jacks (LFO1/2/Rnd/Sens/Vel/Key/Chaos/Steps)
const DSTY = [14, 32, 50, 68, 86, 104, 122, 140, 158]; // 9 destination jacks
let patchSvg = null, patchSel = -1, patchKnobApply = null;

function slotGet(i) {
  const b = PATCH_SLOTS[i];
  return { src: Math.round(knobValue.synth[b] * 8), dst: Math.round(knobValue.synth[b + 1] * 8), amt: knobValue.synth[b + 2] };
}
function slotSet(i, src, dst, amt) {
  const b = PATCH_SLOTS[i];
  if (src != null) { knobValue.synth[b] = src / 8; sendCC(CONFIG.ccSynth[b], src / 8); }
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
    else setVar(next);   // ti === 1 (VAR / Toggle 2)
  });
  togglesEl.appendChild(t);
  return t;
});
function updateToggleVals(ti, pos) {
  toggleEls[ti].querySelectorAll('.toggle-vals span').forEach((s, i) => s.classList.toggle('on', i === pos));
}
function setToggle(ti, pos) { toggleEls[ti].dataset.pos = pos; updateToggleVals(ti, pos); }
function setVar(pos) {   // VAR / Toggle 2 -> CC 93 (per-mode variant)
  activeVar = pos;
  toggleEls[1].dataset.pos = pos; updateToggleVals(1, pos);
  sendCC(CONFIG.ccVar, pos / 2);
}
function setMasterFilt(type) {   // master filter type 0 off / 1 LP / 2 BP / 3 HP -> CC 88
  activeMasterFilt = type;
  document.querySelectorAll('#masterFiltSeg button').forEach(b => b.classList.toggle('on', +b.dataset.t === type));
  sendCC(CONFIG.ccMasterFilt, type / 3);
  if (typeof drawMasterFilt === 'function') drawMasterFilt();
}

/* ===========================================================================
   FOOTSWITCHES + LEDs
   ========================================================================= */
const stompNames = [];
const stompEls = [], ledEls = [];
[0, 1].forEach((si) => {
  const unit = el('div', 'stomp-unit');
  const led = el('span', 'fs-led'); led.dataset.led = si;
  const s = el('div', 'stomp'); s.dataset.stomp = si;
  const lbl = el('div', 'stomp-name'); stompNames[si] = lbl;
  stompEls[si] = s; ledEls[si] = led;
  s.addEventListener('click', () => {
    if (si === 0) {                                   // FS1 = engage/bypass (latching)
      const on = !s.classList.contains('pressed');
      s.classList.toggle('pressed', on); led.classList.toggle('on', on);
      sendCC(CONFIG.ccFs1, on ? 1 : 0);               // >=64 -> bypassed
    } else {                                          // FS2 = momentary mode action
      sendCC(CONFIG.ccFs2, 1);                        // 127 -> trigger Action()
      s.classList.add('pressed'); led.classList.add('on');
      setTimeout(() => { s.classList.remove('pressed'); led.classList.remove('on'); }, 140);
    }
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
  sendCC(CONFIG.ccModeSelect, m / 2);   // tell Spore to switch mode
  if (typeof applyPods === 'function') applyPods();   // synth-only panels follow the mode
}
function setFx(f) {
  activeFx = f; toggleEls[2].dataset.pos = f; updateToggleVals(2, f);
  document.querySelectorAll('#fxSeg button').forEach(b => b.classList.toggle('on', +b.dataset.fx === f));
  const fp = $('#fxPod');
  if (fp) fp.dataset.active = f > 0 ? 'on' : 'off';
  // changing FX re-opens the FX panel (and ticks it in View) -- and ONLY then do we
  // re-layout. Re-laying-out on every FX change would re-stack the column and yank
  // other pods around (e.g. MIDI Thru jumping up when the FX pod is pinned).
  let reopened = false;
  if (typeof podShown !== 'undefined' && !podShown.fxPod) {
    podShown.fxPod = true; const fm = podMeta('fxPod'); if (fm && fm._cb) fm._cb.checked = true; saveView();
    reopened = true;
  }
  sendCC(CONFIG.ccFxSelect, f / 2);   // tell Spore to switch FX
  if (reopened && typeof applyPods === 'function') applyPods();
}
$('#fxSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setFx(+b.dataset.fx); });

/* ===========================================================================
   PRESETS — factory library (presets.json, shipped in repo) + user store
   (localStorage). A patch = mode + fx select and every knob bank. Loading one
   updates the UI and pushes every param to Spore.
   ========================================================================= */
let factoryPresets = [];                       // [{name, patch}] from presets.json
const PRESET_KEY = 'propagator.presets';
const AUTOSAVE_KEY = 'propagator.autosave';    // the live working patch, restored on reload

function loadUserPresets() { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch (_) { return {}; } }
function saveUserPresets(obj) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); } catch (_) {} }

function capturePatch() {
  return {
    v: 3, mode: activeMode, fx: activeFx, delaySync: delaySyncIdx,
    var: activeVar, masterFilt: activeMasterFilt,
    knobs: { mode: knobValue.mode.slice(), fx: knobValue.fx.slice(), synth: knobValue.synth.slice(), chaos: knobValue.chaos.slice(), master: knobValue.master.slice(), gen: knobValue.gen.slice(), gran: knobValue.gran.slice() },
    seq: serializeSeq(),
  };
}

// redraw every knob dial/readout from the current knobValue state
function refreshKnobs() {
  // bank-bound knobs only (the patch-amount knob is a bankless .knob, refreshed on its own)
  document.querySelectorAll('.knob[data-bank]').forEach(k => {
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
  CONFIG.ccChaos.forEach((cc, i) => sendCC(cc, knobValue.chaos[i]));
  CONFIG.ccMaster.forEach((cc, i) => sendCC(cc, knobValue.master[i]));
  CONFIG.ccGen.forEach((cc, i) => sendCC(cc, knobValue.gen[i]));
  CONFIG.ccGran.forEach((cc, i) => sendCC(cc, knobValue.gran[i]));
  sendCC(CONFIG.ccMasterFilt, activeMasterFilt / 3);
  sendCC(CONFIG.ccVar, activeVar / 2);
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
  if (Array.isArray(p.knobs.chaos)) p.knobs.chaos.forEach((v, i) => { if (i < knobValue.chaos.length) knobValue.chaos[i] = v; });
  if (Array.isArray(p.knobs.master)) p.knobs.master.forEach((v, i) => { if (i < knobValue.master.length) knobValue.master[i] = v; });
  if (Array.isArray(p.knobs.gen)) p.knobs.gen.forEach((v, i) => { if (i < knobValue.gen.length) knobValue.gen[i] = v; });
  if (Array.isArray(p.knobs.gran)) p.knobs.gran.forEach((v, i) => { if (i < knobValue.gran.length) knobValue.gran[i] = v; });
  // migrate the mod-matrix SOURCE encoding as sources were added (chained, oldest first):
  //   v1->v2: /6 -> /7 (added Chaos)   ·   v2->v3: /7 -> /8 (added Steps)
  const pv = p.v || 1;
  if (pv < 2) PATCH_SLOTS.forEach(b => { knobValue.synth[b] = Math.round(knobValue.synth[b] * 6) / 7; });
  if (pv < 3) PATCH_SLOTS.forEach(b => { knobValue.synth[b] = Math.round(knobValue.synth[b] * 7) / 8; });
  setMode(typeof p.mode === 'number' ? p.mode : activeMode);   // sends mode select + updates UI
  setFx(typeof p.fx === 'number' ? p.fx : activeFx);           // sends fx select
  if (typeof p.var === 'number') setVar(p.var);                // VAR / Toggle 2
  if (typeof p.masterFilt === 'number') setMasterFilt(p.masterFilt);
  refreshKnobs(); refreshSegments();
  if (typeof p.delaySync === 'number') setDelaySync(p.delaySync);   // restore delay sync
  if (p.seq) { loadSeqState(p.seq); refreshSeqUI(); }   // restore the sequence too
  pushAllCC();   // push every param to Spore
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

/* ---- autosave: persist the live patch so a reload doesn't reset everything ---- */
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(capturePatch())); } catch (_) {}
  }, 300);
}
function restoreAutosave() {
  try { const a = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || 'null'); if (a) applyPatch(a); } catch (_) {}
}

/* ---- start over: reset every bank + the sequence to defaults ---- */
function newPatch() {
  if (!confirm('Start a new patch? This resets the current settings to defaults.')) return;
  KNOB_DEFAULTS.mode.forEach((v, i) => knobValue.mode[i] = v);
  KNOB_DEFAULTS.fx.forEach((v, i) => knobValue.fx[i] = v);
  KNOB_DEFAULTS.synth.forEach((v, i) => knobValue.synth[i] = v);
  KNOB_DEFAULTS.chaos.forEach((v, i) => knobValue.chaos[i] = v);
  KNOB_DEFAULTS.master.forEach((v, i) => knobValue.master[i] = v);
  KNOB_DEFAULTS.gen.forEach((v, i) => knobValue.gen[i] = v);
  KNOB_DEFAULTS.gran.forEach((v, i) => knobValue.gran[i] = v);
  loadSeqState(SEQ_DEFAULT); refreshSeqUI();
  setDelaySync(0);
  setVar(0); setMasterFilt(0);
  setMode(0); setFx(0);
  refreshKnobs(); refreshSegments();
  pushAllCC();
  $('#presetSel').value = '';
  scheduleAutosave();
}

/* ---- export / import the user preset library as a JSON file ---- */
function exportPresets() {
  const u = loadUserPresets();
  if (!Object.keys(u).length) { alert('No saved presets to export yet.'); return; }
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(u, null, 2)], { type: 'application/json' }));
  a.download = 'propagator-presets.json';
  a.click(); URL.revokeObjectURL(a.href);
}
function importPresets(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const obj = JSON.parse(r.result);
      if (!obj || typeof obj !== 'object') throw new Error('not a preset file');
      const u = loadUserPresets();
      let n = 0;
      for (const [name, patch] of Object.entries(obj)) if (patch && patch.knobs) { u[name] = patch; n++; }
      if (!n) throw new Error('no valid presets found');
      saveUserPresets(u); rebuildPresetList();
      alert('Imported ' + n + ' preset' + (n === 1 ? '' : 's') + '.');
    } catch (e) { alert('Could not import: ' + e.message); }
  };
  r.readAsText(file);
}

$('#presetNew').addEventListener('click', newPatch);
$('#presetExport').addEventListener('click', exportPresets);
$('#presetImport').addEventListener('click', () => $('#presetFile').click());
$('#presetFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importPresets(f); e.target.value = ''; });

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
  scheduleAutosave();   // any param change persists the live patch (even when offline)
  if (applyingRemote) return;   // mirroring an incoming CC -> update UI only, don't echo back
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

// Spore talks back (telemetry SysEx) on its own input port, named "Spore". Find it so we
// can receive the chaos/CPU/identify replies no matter which device is selected to play.
function resolveSporeIn() {
  sporeIn = [...midi.inputs.values()].find(i => /spore/i.test(i.name || '')) || null;
}
// Attach the receive handler to exactly the ports we use -- the selected performance input
// AND Spore's telemetry input -- and clear it from any others (dedupes when they're the same).
function bindInputs() {
  if (!midi) return;
  midi.inputs.forEach(inp => { inp.onmidimessage = (inp === midiIn || inp === sporeIn) ? onMidiMessage : null; });
}

function refreshDevices() {
  if (!midi) return;
  resolveSporeIn();
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
  bindInputs();   // listen on Spore's telemetry input (+ the selected performance input)
  updateConn();
}
function updateConn() {
  const n = midi ? midi.outputs.size : 0;
  if (midiOut) setStatus('live', 'connected');
  else if (midi) setStatus('ready', n ? 'pick a device' : 'no devices');
  else setStatus('off', 'offline');
  $('#footMidi').textContent = midi ? `${midi.outputs.size} out · ${midi.inputs.size} in` : 'no MIDI';
  const dfu = $('#dfuBtn'); if (dfu) dfu.disabled = false;   // flash wizard uses WebUSB, not MIDI
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
  if (midiOut) {  // sync Spore to the UI's current state on connect
    sendCC(CONFIG.ccModeSelect, activeMode / 2);
    sendCC(CONFIG.ccFxSelect, activeFx / 2);
    CONFIG.ccSynth.forEach((cc, i) => sendCC(cc, knobValue.synth[i]));
    connectedFw = null; checkFwUpdate();
    setTimeout(sendIdentify, 150);   // request the running firmware version
    startCpuPoll();                  // begin polling audio-callback load
    startChaosPoll();                // begin polling the chaos attractor (when visible)
  } else { connectedFw = null; checkFwUpdate(); stopCpuPoll(); stopChaosPoll(); }
}
function selectIn(id) {
  setKbd(id === 'kbd');                                  // computer-keyboard "device"
  midiIn = (id && id !== 'kbd') ? midi.inputs.get(id) : null;
  bindInputs();   // (re)bind the handler to the performance input + Spore's telemetry input
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
  // Telemetry from Spore (SysEx, manufacturer 0x7D) is handled from whichever bound port
  // delivered it -- so the chaos graph / CPU meter work regardless of the performance input.
  if (status === 0xF0 && d[1] === 0x7D) {
    if (d.length >= 4 && d[2] === 0x41) {            // identify reply: F0 7D 41 <version ASCII> F7
      let s = '';
      for (let i = 3; i < d.length && d[i] !== 0xF7; i++) s += String.fromCharCode(d[i]);
      connectedFw = s.trim().replace(/^v/, '');
      if (midiLast) midiLast.textContent = 'Spore firmware v' + connectedFw;
      checkFwUpdate();
    } else if (d.length >= 5 && d[2] === 0x42) {     // CPU load: F0 7D 42 <avg%> <max%> F7
      showCpuLoad(d[3], d[4]);
    } else if (d.length >= 5 && d[2] === 0x43) {     // chaos state: F0 7D 43 <x> <z> F7
      pushChaosSample(d[3], d[4]);
    }
    return;
  }
  // Everything below (clock, notes, CC) only from the SELECTED performance input.
  if (e.target !== midiIn) return;
  // realtime: clock + transport
  if (status === 0xF8) { handleClockTick(performance.now()); fwd(d, 'clock'); return; }
  if (status === 0xFA || status === 0xFB || status === 0xFC) {
    if (status === 0xFA) { clockCount = 0; seqClockTick = 0; seqIdx = 0; seqDir = 1; if (clockSync) setPlaying(true); }   // start
    else if (status === 0xFC && clockSync) setPlaying(false);                       // stop
    fwd(d, 'clock'); return;
  }
  if (status === 0xF0) return;   // other SysEx (telemetry handled above)
  if (status < 0x80 || status >= 0xF0) return;   // ignore other system msgs (sensing/etc)

  // channel-voice: activity LED, last-received readout, filtered thru
  const info = describeMidi(d);
  if (midiAct) { midiAct.classList.add('kick'); setTimeout(() => midiAct.classList.remove('kick'), 130); }
  if (midiLast) midiLast.textContent = info.text;
  fwd(d, info.cat);

  // reflect incoming CC onto the UI (device -> web mirror). applyingRemote stops the
  // setters from echoing back out, so the physical surface drives the editor with no loop.
  if ((status & 0xf0) === 0xb0) {
    const cc = d[1], val = d[2];
    const mi = CONFIG.ccMode.indexOf(cc), fi = CONFIG.ccFx.indexOf(cc);
    const third = (v) => (v < 43 ? 0 : v < 86 ? 1 : 2);
    applyingRemote = true;
    try {
      if (mi >= 0) { knobValue.mode[mi] = val / 127; modeKnobs[mi]._apply(); }
      else if (fi >= 0) { knobValue.fx[fi] = val / 127; }
      else if (cc === CONFIG.ccModeSelect) setMode(third(val));
      else if (cc === CONFIG.ccFxSelect)   setFx(third(val));
      else if (cc === CONFIG.ccVar)        setVar(third(val));
      else if (cc === CONFIG.ccFs1 && stompEls[0]) {
        const on = val >= 64;
        stompEls[0].classList.toggle('pressed', on); ledEls[0].classList.toggle('on', on);
      }
    } finally { applyingRemote = false; }
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

/* ---- clock master: GUI emits 24-PPQN MIDI clock to Spore, or we forward the
   input device's clock. Spore locks to whichever and tempo-syncs its delay. ---- */
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
  thruFilter.clock = (c === 'in');   // forward the input device's clock to Spore
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
   STEP SEQUENCER — a small piano-roll that plays MIDI out to Spore.
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
function saveSeq() { try { localStorage.setItem(SEQ_KEY, JSON.stringify(serializeSeq())); } catch (_) {} scheduleAutosave(); }
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
const SEQ_DEFAULT = serializeSeq();   // pristine sequence (default riff) for "new"
try { loadSeqState(JSON.parse(localStorage.getItem(SEQ_KEY) || 'null')); } catch (_) {}
refreshSeqUI();

/* ===========================================================================
   CONNECTOR WIRES — removed. Spore→pod connector lines are no longer drawn.
   drawWires() is kept as a no-op so its call sites (loop, pod drag/apply,
   resize) stay valid without further edits.
   ========================================================================= */
function drawWires() {}

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
   MAIN LOOP (beat)
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
   Uses left/top so the float animation's transform still composes.)
   ========================================================================= */
const PODS = [
  { id: 'synthPod',  label: 'Voice',      group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'envPod',    label: 'Envelope',   group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'wavePod',   label: 'Oscillator', group: 'VOICE',  col: 'L', synthOnly: true },
  { id: 'matrixPod', label: 'Modulation', group: 'VOICE',  col: 'R', synthOnly: true },
  { id: 'seqPod',    label: 'Sequencer',  group: 'PLAY',   col: 'R', synthOnly: true },
  { id: 'genPod',    label: 'Generative', group: 'VOICE',  col: 'L', generativeOnly: true },
  { id: 'granPod',   label: 'Granular',   group: 'VOICE',  col: 'L', granularOnly: true },
  { id: 'fxPod',     label: 'FX',         group: 'PLAY',   col: 'R' },
  { id: 'masterPod', label: 'Master',     group: 'PLAY',   col: 'R' },
  { id: 'bpmPod',    label: 'Tempo',      group: 'SYSTEM', col: 'L', tempo: true },
  { id: 'midiPod',   label: 'MIDI Thru',  group: 'SYSTEM', col: 'R' },
];
const VIEW_KEY = 'propagator.view';
const VIEW_DEFAULT = { synthPod: true, envPod: true, wavePod: true, matrixPod: true, seqPod: false, genPod: true, granPod: true, fxPod: true, masterPod: true, bpmPod: true, midiPod: true };
let podShown = Object.assign({}, VIEW_DEFAULT);
try { Object.assign(podShown, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch (_) {}
function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(podShown)); } catch (_) {} }
function podMeta(id) { return PODS.find(p => p.id === id); }
function podContextOK(p) {
  if (p.synthOnly && activeMode !== 0) return false;
  if (p.generativeOnly && activeMode !== 2) return false;
  if (p.granularOnly && activeMode !== 1) return false;
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
// A pod's position is the absolute x/y in dataset (stage coords). Untouched pods get
// it from layoutPods (auto-stack); a dragged pod is `pinned` and keeps its own x/y.
function applyPod(pe) {
  pe.style.left = (+pe.dataset.x || 0) + 'px';
  pe.style.top  = (+pe.dataset.y || 0) + 'px';
}
function clampPod(pe) {
  // Keep the pod on-stage using the untransformed layout box (offsetWidth/Height) --
  // not getBoundingClientRect, which would fold in the rotate()/float transform.
  const m = 8, sw = stage.clientWidth, sh = stage.clientHeight;
  const w = pe.offsetWidth, h = pe.offsetHeight;
  let x = +pe.dataset.x || 0, y = +pe.dataset.y || 0;
  x = Math.min(Math.max(x, m), Math.max(m, sw - w - m));
  y = Math.min(Math.max(y, m), Math.max(m, sh - h - m));
  pe.dataset.x = x; pe.dataset.y = y; applyPod(pe);
}
function podLaidOut(pe) { return pe && getComputedStyle(pe).display !== 'none' && !pe.classList.contains('closed'); }
// Auto-stack the un-pinned pods top-down per column. Pinned (dragged) pods keep
// their own position -- they're only clamped back on-screen, never re-stacked.
function layoutPods() {
  const m = 14, gap = 14, sw = stage.clientWidth;
  ['L', 'R'].forEach(side => {
    let y = 14;
    PODS.filter(p => p.col === side).forEach(p => {
      const pe = $('#' + p.id); if (!pe || !podLaidOut(pe)) return;
      if (pe.dataset.pinned === '1') { clampPod(pe); return; }   // dragged: leave it put
      pe.dataset.x = side === 'L' ? m : (sw - pe.offsetWidth - m);
      pe.dataset.y = y;
      applyPod(pe);
      y += pe.offsetHeight + gap;
    });
  });
}
const reflowPods = layoutPods;   // keep the name used by other callers

function makeDraggable(pod) {
  if (!pod) return;
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  pod.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.knob, button, input, label, .pill, .switch-field, .bpm-dial, select, .seg, .seq-grid, .env-graph, .patchbay, .beat-seed')) return;
    dragging = true; pod.classList.add('dragging');
    sx = e.clientX; sy = e.clientY; ox = +(pod.dataset.x || 0); oy = +(pod.dataset.y || 0);
    pod.setPointerCapture(e.pointerId); e.preventDefault();
  });
  pod.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pod.dataset.pinned = '1';   // dragged pods stay where the user puts them
    pod.dataset.x = ox + (e.clientX - sx); pod.dataset.y = oy + (e.clientY - sy);
    applyPod(pod);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false; clampPod(pod); pod.classList.remove('dragging');
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
  PODS.forEach(p => { const pe = $('#' + p.id); if (pe) { delete pe.dataset.pinned; delete pe.dataset.x; delete pe.dataset.y; } });
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

/* ===========================================================================
   FIRMWARE UPDATE (WebUSB DFU)
   A 3-step wizard: choose a .bin (bundled latest or local file), reboot Spore into
   the bootloader, connect over WebUSB, and flash via dfu.js (DfuSe). Spore drops off
   USB-MIDI while in DFU.

   Two targets (Spore runs from SRAM via the Daisy bootloader):
     • 'app'  (default) — reboot via CC 118 into the Daisy bootloader, flash the app to
                          QSPI @ 0x90040000. The everyday "update firmware" path.
     • 'boot' (advanced) — reboot via CC 119 (or BOOT+RESET) into the STM ROM DFU, flash
                          the bootloader to internal flash @ 0x08000000. First-time / repair.
   The actual write address is auto-derived from the connected DFU device's memory map
   (which bootloader answered), so a mismatched pick is caught rather than mis-flashed.
   =========================================================================== */
const FW_ADDR = { app: 0x90040000, boot: 0x08000000 };  // QSPI app slot · internal flash base
const FLASH = {
  mode: 'app',                     // 'app' (Daisy bootloader/QSPI) | 'boot' (STM ROM/internal)
  addr: FW_ADDR.app,               // write address; finalized from the device on connect
  buf: null,                       // ArrayBuffer of the firmware to write
  bufName: '',
  dev: null,                       // connected DfuseDevice
  mismatch: false,                 // connected bootloader doesn't match the selected target
};
const fwEl = (id) => document.getElementById(id);
function fwStatus(msg, kind) {
  const s = fwEl('fwStatus'); if (!s) return;
  s.textContent = msg; s.dataset.kind = kind || '';
}
function fwSetFlashEnabled() {
  const b = fwEl('fwFlash'); if (b) b.disabled = !(FLASH.buf && FLASH.dev && !FLASH.mismatch);
  const l = fwEl('fwLeave'); if (l) l.disabled = !FLASH.dev;   // can reboot whenever connected
}
function fwProgress(p) {
  const wrap = fwEl('fwProgWrap'), bar = fwEl('fwBar');
  if (wrap) wrap.hidden = false;
  if (bar) bar.style.width = Math.round((p.ratio || 0) * 100) + '%';
  fwStatus(p.phase === 'erase' ? 'Erasing…' : p.phase === 'write'
    ? 'Writing ' + Math.round((p.ratio || 0) * 100) + '%' : 'Finishing…');
}

// --- firmware version awareness ---
function semverGt(a, b) {   // is version a strictly newer than b?
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
// pulse the DFU button dim green when the bundled build is newer than Spore's
function checkFwUpdate() {
  const btn = $('#dfuBtn'); if (!btn) return;
  const avail = !!(latestFw && latestFw.version && connectedFw && semverGt(latestFw.version, connectedFw));
  btn.classList.toggle('update', avail);
  btn.title = avail ? ('firmware update available: v' + connectedFw + ' → v' + latestFw.version + ' — click to flash')
                    : 'update firmware (flash over USB / DFU)';
}
// the firmware bundled under /firmware/ at deploy time
async function loadLatestFw() {
  try {
    const r = await fetch('./firmware/latest.json', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.version) latestFw = { version: String(j.version).replace(/^v/, ''),
                                       size: j.size, file: j.file || 'spore-latest.bin',
                                       bootFile: j.bootFile || null, bootSize: j.bootSize || null };
    }
  } catch (e) { /* not deployed / local dev — fine */ }
  checkFwUpdate();
}
// request Spore's running firmware version (SysEx identify)
function sendIdentify() {
  if (!midiOut) return;
  try { midiOut.send([0xF0, 0x7D, 0x01, 0xF7]); } catch (e) { /* sysex not permitted */ }
}

// --- CPU load awareness (SysEx query 0x02 -> reply 0x42 <avg%> <max%>) ---
let cpuPollTimer = null;
// request Spore's audio-callback load
function sendCpuQuery() {
  if (!midiOut) return;
  try { midiOut.send([0xF0, 0x7D, 0x02, 0xF7]); } catch (e) { /* sysex not permitted */ }
}
// drive the footer meter: fill = avg load, marker = peak, red when peak caps the budget
function showCpuLoad(avg, max) {
  const meter = $('#cpuMeter'), fill = $('#cpuFill'), peak = $('#cpuPeak'), val = $('#cpuVal');
  if (!meter) return;
  const a = Math.max(0, Math.min(100, avg)), m = Math.max(0, Math.min(100, max));
  if (fill) fill.style.width = a + '%';
  if (peak) peak.style.left = m + '%';
  if (val) val.textContent = a + '%';
  meter.classList.add('on');
  meter.classList.toggle('cap', max >= 90);   // >=90% peak = at risk of dropouts
}
// poll once a second while a device is connected (cheap; one tiny SysEx round-trip)
function startCpuPoll() {
  stopCpuPoll();
  if (!midiOut) return;
  sendCpuQuery();
  cpuPollTimer = setInterval(sendCpuQuery, 1000);
}
function stopCpuPoll() {
  if (cpuPollTimer) { clearInterval(cpuPollTimer); cpuPollTimer = null; }
  const meter = $('#cpuMeter'); if (meter) meter.classList.remove('on', 'cap');
}

// --- Chaos visualization (SysEx query 0x03 -> reply 0x43 <x> <z>) ---
// Plots the device's live Lorenz attractor (X vs Z) as a fading trail. Only
// polled while the canvas is actually on-screen, so it costs nothing when hidden.
let chaosPollTimer = null;
const CHAOS_TRAIL = [];           // {x,z} in -1..1, newest last
const CHAOS_TRAIL_MAX = 240;
function chaosVisible() {
  const c = $('#chaosViz');
  return !!(c && c.offsetParent !== null);   // offsetParent null => display:none / hidden pod
}
function sendChaosQuery() {
  if (!midiOut || !chaosVisible()) return;   // don't poll when the viz isn't shown
  try { midiOut.send([0xF0, 0x7D, 0x03, 0xF7]); } catch (e) { /* sysex not permitted */ }
}
function pushChaosSample(x7, z7) {            // bytes 0..127 -> -1..1
  CHAOS_TRAIL.push({ x: x7 / 127 * 2 - 1, z: z7 / 127 * 2 - 1 });
  if (CHAOS_TRAIL.length > CHAOS_TRAIL_MAX) CHAOS_TRAIL.shift();
  drawChaos();
}
function drawChaos() {
  const c = $('#chaosViz'); if (!c) return;
  const ctx = c.getContext('2d'); if (!ctx) return;
  const W = c.width, H = c.height, pad = 6;
  ctx.clearRect(0, 0, W, H);
  const px = (x) => pad + (x * 0.5 + 0.5) * (W - 2 * pad);
  const py = (z) => pad + (1 - (z * 0.5 + 0.5)) * (H - 2 * pad);
  const n = CHAOS_TRAIL.length;
  for (let i = 1; i < n; i++) {
    const a = CHAOS_TRAIL[i - 1], b = CHAOS_TRAIL[i];
    const age = i / n;                        // older = fainter
    ctx.strokeStyle = `rgba(63, 181, 107, ${(age * 0.9).toFixed(3)})`;   // theme green
    ctx.lineWidth = 1 + age;
    ctx.beginPath(); ctx.moveTo(px(a.x), py(a.z)); ctx.lineTo(px(b.x), py(b.z)); ctx.stroke();
  }
  if (n) {                                    // bright head dot
    const h = CHAOS_TRAIL[n - 1];
    ctx.fillStyle = '#9af7c0';
    ctx.beginPath(); ctx.arc(px(h.x), py(h.z), 2.2, 0, Math.PI * 2); ctx.fill();
  }
}
function startChaosPoll() {
  stopChaosPoll();
  if (!midiOut) return;
  chaosPollTimer = setInterval(sendChaosQuery, 50);   // ~20 Hz, gated on visibility
}
function stopChaosPoll() {
  if (chaosPollTimer) { clearInterval(chaosPollTimer); chaosPollTimer = null; }
  CHAOS_TRAIL.length = 0; drawChaos();
}

function fwShowLatest() {
  const info = fwEl('fwLatestInfo'), btn = fwEl('fwUseLatest');
  const isApp = FLASH.mode === 'app';
  const haveApp = !!(latestFw && latestFw.version);
  const haveBoot = !!(latestFw && latestFw.bootFile);
  if (isApp && haveApp) {
    info.innerHTML = 'latest app: <b>v' + latestFw.version + '</b>'
      + (latestFw.size ? ' · ' + (latestFw.size / 1024).toFixed(1) + ' KB' : '')
      + (connectedFw ? ' · on Spore: v' + connectedFw : '');
    btn.hidden = false;
  } else if (!isApp && haveBoot) {
    info.innerHTML = 'bundled bootloader'
      + (latestFw.bootSize ? ' · ' + (latestFw.bootSize / 1024).toFixed(1) + ' KB' : '');
    btn.hidden = false;
  } else {
    info.innerHTML = 'no bundled build — get it from '
      + '<a href="https://github.com/rainybit-code/spore/releases/latest" target="_blank" rel="noopener">releases</a>, then pick a .bin';
    btn.hidden = true;
  }
}

// Render the wizard for the current target (app vs bootloader). 'app' is the default,
// everyday path; 'boot' is the advanced first-time/repair path.
function fwRender() {
  const isApp = FLASH.mode === 'app';
  const set = (id, html) => { const e = fwEl(id); if (e) e.innerHTML = html; };
  set('fwTitle', isApp ? 'Update firmware' : 'Install / repair bootloader');
  set('fwSub', isApp ? 'Flash the <b>Spore</b> app over USB — no extra tools.'
                     : 'Advanced: reinstall the Daisy <b>bootloader</b> (first-time setup or recovery).');
  set('fwModeToggle', isApp ? 'Install / repair bootloader (advanced)' : '← Back to app update');
  set('fwReboot', isApp ? '⤓ Reboot to bootloader (via MIDI)' : '⤓ Reboot to STM DFU (via MIDI)');
  set('fwRebootHint', isApp
    ? '…or just reset the Daisy — a freshly-bootloadered board waits in DFU on its own.'
    : '…or hold <b>BOOT</b> + tap <b>RESET</b> on the Daisy Seed.');
  fwShowLatest();
}

function fwOpen() {
  const m = fwEl('flash'); if (!m) return;
  m.hidden = false;
  FLASH.mode = 'app';   // always open on the everyday app-update path
  // reset transient UI
  fwEl('fwProgWrap').hidden = true; fwEl('fwBar').style.width = '0%';
  fwStatus(WebDFU.supported() ? '—' : 'WebUSB unavailable — use Chrome/Edge over https/localhost', 'err');
  fwEl('fwConnect').disabled = !WebDFU.supported();
  fwEl('fwReboot').disabled = !midiOut;
  fwRender();
  sendIdentify();   // refresh Spore's reported version while the wizard is open
}
async function fwClose() {
  fwEl('flash').hidden = true;
  if (FLASH.dev) { try { await FLASH.dev.close(); } catch (e) {} FLASH.dev = null; }
  fwSetFlashEnabled();
}

// open the wizard from the topbar DFU button
$('#dfuBtn').addEventListener('click', fwOpen);

// advanced: switch between app-update (default) and bootloader-install
fwEl('fwModeToggle').addEventListener('click', () => {
  FLASH.mode = FLASH.mode === 'app' ? 'boot' : 'app';
  FLASH.buf = null; FLASH.bufName = ''; FLASH.mismatch = false;   // re-pick the right .bin
  const fi = fwEl('fwFileInfo'); if (fi) fi.textContent = '';
  fwRender();
  fwSetFlashEnabled();
});

// --- step 1: use the bundled latest build (app or bootloader, per mode) ---
fwEl('fwUseLatest').addEventListener('click', async () => {
  if (!latestFw) return;
  const isApp = FLASH.mode === 'app';
  const file = isApp ? (latestFw.file || 'spore-latest.bin') : latestFw.bootFile;
  if (!file) return;
  const info = fwEl('fwLatestInfo');
  try {
    const r = await fetch('./firmware/' + file, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    FLASH.buf = await r.arrayBuffer(); FLASH.bufName = file;
    info.innerHTML = '✓ loaded ' + (isApp ? '<b>app v' + latestFw.version + '</b>' : '<b>bootloader</b>')
      + ' · ' + (FLASH.buf.byteLength / 1024).toFixed(1) + ' KB';
    fwSetFlashEnabled();
  } catch (e) {
    info.textContent = 'could not load bundled firmware (' + e.message + ') — use a local .bin';
  }
});
// --- step 1: or choose a local .bin ---
fwEl('fwPick').addEventListener('click', () => fwEl('fwFile').click());
fwEl('fwFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  FLASH.buf = await f.arrayBuffer(); FLASH.bufName = f.name;
  fwEl('fwFileInfo').textContent = '✓ ' + f.name + ' · ' + (FLASH.buf.byteLength / 1024).toFixed(1) + ' KB';
  fwSetFlashEnabled();
});

// --- step 2: reboot to DFU over MIDI ---
fwEl('fwReboot').addEventListener('click', () => {
  if (!midiOut) { fwStatus('connect Spore as MIDI OUT first (or use BOOT+RESET)', 'err'); return; }
  const isApp = FLASH.mode === 'app';
  // app -> Daisy bootloader (infinite DFU, no timing race); boot -> STM ROM DFU
  sendCC(isApp ? CONFIG.ccDaisyReboot : CONFIG.ccSysReboot, 1);
  if (midiLast) midiLast.textContent = 'sent: reboot to ' + (isApp ? 'bootloader' : 'STM DFU');
  fwStatus('reboot sent — Connect when the DFU device appears', 'ok');
});

// --- step 3: connect over WebUSB ---
fwEl('fwConnect').addEventListener('click', async () => {
  try {
    fwStatus('select “STM32 BOOTLOADER” in the picker…');
    const dev = await WebDFU.requestDevice();
    await dev.connect();
    FLASH.dev = dev;
    // Derive the write address from what the connected bootloader actually exposes:
    // a QSPI segment => Daisy bootloader (app slot), internal => STM ROM (bootloader).
    const segs = (dev.memory && dev.memory.segments) || [];
    const has = (a) => segs.some((s) => a >= s.start && a < s.end);
    let target = null;
    if (has(FW_ADDR.app)) { target = 'app'; FLASH.addr = FW_ADDR.app; }
    else if (has(FW_ADDR.boot)) { target = 'boot'; FLASH.addr = FW_ADDR.boot; }
    else { FLASH.addr = FW_ADDR[FLASH.mode]; }   // unknown map — trust the selected mode
    FLASH.mismatch = !!(target && target !== FLASH.mode);
    const name = dev.memory && dev.memory.name;
    const at = '0x' + (FLASH.addr >>> 0).toString(16).toUpperCase();
    if (target && target !== FLASH.mode) {
      // The wrong bootloader answered for the chosen operation — don't flash to the wrong place.
      fwStatus('connected to the ' + (target === 'app' ? 'Daisy bootloader (app slot)' : 'STM ROM (internal)')
        + ', but you picked “' + (FLASH.mode === 'app' ? 'app update' : 'bootloader install')
        + '”. Switch the target to match, then flash.', 'err');
    } else {
      fwStatus('connected' + (name ? ' · ' + name : '') + ' · → ' + at + ' · ready to flash', 'ok');
    }
    fwSetFlashEnabled();
  } catch (e) {
    fwStatus('connect failed: ' + e.message + (/no device|chosen/i.test(e.message) ? '' : ' (Windows: WinUSB via Zadig?)'), 'err');
  }
});

// --- step 3: flash ---
fwEl('fwFlash').addEventListener('click', async () => {
  if (!FLASH.buf || !FLASH.dev) return;
  const btn = fwEl('fwFlash'), cn = fwEl('fwConnect');
  btn.disabled = cn.disabled = true;
  try {
    await FLASH.dev.download(FLASH.buf, FLASH.addr, fwProgress);
    fwEl('fwBar').style.width = '100%';
    fwStatus('✓ done — Spore is rebooting into the new firmware', 'ok');
    try { await FLASH.dev.close(); } catch (e) {} FLASH.dev = null;
  } catch (e) {
    fwStatus('flash failed: ' + e.message + ' — re-enter DFU and retry', 'err');
  } finally {
    cn.disabled = !WebDFU.supported();
    fwSetFlashEnabled();
  }
});

// --- step 3: leave DFU without flashing (boot the existing app) ---
fwEl('fwLeave').addEventListener('click', async () => {
  if (!FLASH.dev) return;
  const btn = fwEl('fwLeave'), cn = fwEl('fwConnect'), fl = fwEl('fwFlash');
  btn.disabled = cn.disabled = fl.disabled = true;
  try {
    await FLASH.dev.leave(FLASH.addr);
    fwStatus('✓ rebooting Spore into app mode', 'ok');
    try { await FLASH.dev.close(); } catch (e) {} FLASH.dev = null;
  } catch (e) {
    fwStatus('reboot failed: ' + e.message, 'err');
  } finally {
    cn.disabled = !WebDFU.supported();
    fwSetFlashEnabled();
  }
});

fwEl('fwClose').addEventListener('click', fwClose);

/* ---------- go ---------- */
setMode(0); setFx(0);
restoreAutosave();       // bring back the last working patch (reload doesn't reset)
setPlaying(false);       // default: tempo stopped
setBpmPodClosed(true);   // default: tempo box closed -> shown as the top-bar mini
updateMidiPod();
window.addEventListener('resize', reflowPods);
requestAnimationFrame(() => { reflowPods(); requestAnimationFrame(loop); });
startBoil();
loadFactoryPresets();    // factory library + any saved user presets -> dropdown
loadLatestFw();          // read the bundled firmware version (drives the DFU update pulse)
initMidi();
