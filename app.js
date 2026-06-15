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

/* ---------- MIDI state ---------- */
let midi = null, midiOut = null, midiIn = null;
let activeMode = 0;   // 0 synth / 1 granular / 2 generative
let activeFx = 0;     // 0 off / 1 delay / 2 reverb

const knobValue = { mode: [0.5,0.5,0.5,0.5,0.5,0.5], fx: [0.3,0.4,0.35,0.7,0.6,0.7] };

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
  const cc = (bank === 'mode' ? CONFIG.ccMode : CONFIG.ccFx)[idx];

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
}
function setFx(f) {
  activeFx = f; toggleEls[2].dataset.pos = f; updateToggleVals(2, f);
  document.querySelectorAll('#fxSeg button').forEach(b => b.classList.toggle('on', +b.dataset.fx === f));
  $('#fxPod').dataset.active = f > 0 ? 'on' : 'off';
  drawWires();
}
$('#modeSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(+b.dataset.mode); });
$('#fxSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setFx(+b.dataset.fx); });

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
  // auto-pick first output if none chosen
  if (!midiOut && midi.outputs.size) { const first = midi.outputs.values().next().value; selectOut(first.id); $('#midiOut').value = first.id; }
  updateConn();
}
function updateConn() {
  const n = midi ? midi.outputs.size : 0;
  if (midiOut) setStatus('live', 'connected');
  else if (midi) setStatus('ready', n ? 'pick a device' : 'no devices');
  else setStatus('off', 'offline');
  $('#footMidi').textContent = midi ? `${midi.outputs.size} out · ${midi.inputs.size} in` : 'no MIDI';
}
function selectOut(id) { midiOut = id ? midi.outputs.get(id) : null; updateConn(); }
function selectIn(id) {
  if (midiIn) midiIn.onmidimessage = null;
  midiIn = id ? midi.inputs.get(id) : null;
  if (midiIn) midiIn.onmidimessage = onMidiMessage;
  updateConn();
}
// incoming (for future 2-way sync): reflect CC back onto knobs
function onMidiMessage(e) {
  const [status, d1, d2] = e.data;
  if ((status & 0xf0) === 0xb0) {
    const mi = CONFIG.ccMode.indexOf(d1);
    const fi = CONFIG.ccFx.indexOf(d1);
    if (mi >= 0) { knobValue.mode[mi] = d2 / 127; modeKnobs[mi]._apply(); }
    else if (fi >= 0) { knobValue.fx[fi] = d2 / 127; }
  }
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

function showNotice(title, body) { $('#noticeTitle').textContent = title; $('#noticeBody').innerHTML = body; $('#notice').hidden = false; updateConn(); }
function hideNotice() { $('#notice').hidden = true; }
$('#noticeRetry').addEventListener('click', initMidi);

/* ===========================================================================
   BPM + BEAT ENGINE
   ========================================================================= */
let bpm = 96;
const bpmNum = $('#bpmNum'), beatSeed = $('#beatSeed'), beatDots = [...document.querySelectorAll('#beatDots i')];
beatDots[0].classList.add('down');

function setBpm(v) { bpm = Math.max(40, Math.min(240, Math.round(v))); bpmNum.textContent = bpm; }
(() => {
  const dial = $('#bpmDial'); let sy = 0, sb = 0, drag = false;
  dial.addEventListener('pointerdown', e => { drag = true; sy = e.clientY; sb = bpm; dial.setPointerCapture(e.pointerId); });
  dial.addEventListener('pointermove', e => { if (drag) setBpm(sb + (sy - e.clientY) * 0.5); });
  dial.addEventListener('pointerup', e => { drag = false; try { dial.releasePointerCapture(e.pointerId); } catch (_) {} });
  dial.addEventListener('wheel', e => { e.preventDefault(); setBpm(bpm - Math.sign(e.deltaY)); }, { passive: false });
})();

let beatIndex = 0, nextBeat = performance.now();
function pulseBeat(beatInBar) {
  const down = beatInBar === 0;
  beatSeed.classList.toggle('down', down);
  beatSeed.classList.add('kick');
  setTimeout(() => beatSeed.classList.remove('kick'), 90);
  beatDots.forEach((d, i) => d.classList.toggle('on', i === beatInBar));
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
    if (!s.anchor || !s.pod) continue;
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
  const interval = 60000 / bpm;
  if (now >= nextBeat) {
    pulseBeat(beatIndex % 4); beatIndex++;
    nextBeat += interval;
    if (now - nextBeat > interval) nextBeat = now + interval; // resync if tab was backgrounded
  }
  drawWires();
  requestAnimationFrame(loop);
}

/* ---------- go ---------- */
setMode(0); setFx(0);
window.addEventListener('resize', drawWires);
requestAnimationFrame(() => { drawWires(); requestAnimationFrame(loop); });
startBoil();
initMidi();
