# Ideas & Backlog

Forward-looking backlog for Propagator. Shipped features live in
[`CHANGELOG.md`](../CHANGELOG.md), not here.

Legend: 🔜 next · 🅰️ tier-1 (core) · 🅲 tier-3 (ambitious) · 💡 idea

---

## 🅰️ Universal device editor (device templates)

Today the editor is hard-coded to Spore (the `CONFIG` CC map, the pods, the synth
panel). The goal: make Propagator a **generic MIDI device editor** driven by a
declarative **device template** — Spore becomes "device #1", and adding e.g. an
Arturia MicroFreak is just a new template, no app changes.

### Template shape

One data file per device describes its editable surface; the app is a generic
renderer + MIDI engine that consumes it:

```js
{
  id: 'spore',
  name: 'Spore',
  midi: { channel: 0,
          identify: { request: [0xF0,0x7D,0x01,0xF7], replyPrefix: [0x7D,0x41] } },
  match: ['Spore', 'Daisy'],            // auto-pick by MIDI port name
  features: { flashing: true, clock: true, sequencer: true, patchbay: true },
  sections: [                            // each section -> a pod
    { id: 'osc', title: 'OSC', controls: [
      { type: 'knob',   label: 'Detune', cc: 40 },
      { type: 'select', label: 'Engine', cc: 54, options: ['Analog','Wavetable'] },
      { type: 'select', label: 'Wave',   cc: 48, options: ['Sin','Tri','Saw','Sqr'] },
    ]},
    /* … */
  ],
}
```

A **control descriptor** carries everything the engine needs: `type` (knob /
select / switch / note-source), the **address** (`cc`, later `nrpn` / `sysex`),
value **encoding** (0–1 ↔ 0–127, or option-index → value, curve, default), and
label. `makeKnob` / `makeSwitches` become generic over a descriptor instead of
hard-coded indices.

### What generalizes vs. what's device-gated
- **Generic core:** MIDI connect/IN/OUT, the knob/select/switch widgets,
  soft-takeover, presets (a preset = values for template X), pod layout + View
  menu, autosave.
- **Capability-gated (per `features`):** firmware flashing/DFU + the identify
  update-pulse (Spore-only), the patchbay/mod-matrix, the step sequencer, the
  clock master. A device that doesn't declare a feature simply doesn't render it.
- **Identity/aesthetic:** the hand-inked Spore chassis is Spore-specific; a generic
  device gets a neutral control-grid layout (a template may supply its own artwork).

### MicroFreak as the proof
The MicroFreak has a fixed, documented MIDI map (CCs + NRPNs for osc type/wave/
timbre/shape, cutoff, resonance, envelope…). A `microfreak` template lists those
with `features:{ flashing:false, clock:true }` and yields a working editor with
**zero app changes** — the test that the abstraction is real. It also forces the
encoding layer to support **NRPN** (the MicroFreak uses it for several params).

### Migration path (behaviour-preserving)
1. Define the template + control-descriptor schema and the encoding layer
   (CC now; NRPN / SysEx as needed).
2. Extract Spore's current hard-coded surface into `templates/spore.js` — no
   behaviour change.
3. Make the renderer + MIDI send/receive consume descriptors instead of
   `CONFIG` / `synth[i]` indices.
4. Add a device picker (topbar) + template loader + persisted selection;
   auto-match by port name.
5. Gate the Spore-only features behind `features`.
6. Add a second template (MicroFreak) to validate genericity.

### Open decisions
- **Scope:** full feature parity per device, or start with params + layout (leave
  flashing/sequencer Spore-only at first)?
- **Identity:** Propagator becomes a *generic* editor with Spore as device #1 — confirm.

---

## Other ideas

- 🔜 **2-way sync (SysEx)** — read the device's current patch back so the editor
  mirrors hardware on connect (pairs with the Spore patch dump/load work).
- 💡 **Unsaved-changes indicator** — autosave is silent today; show when the live
  patch differs from the loaded preset, or offer "restore last session?" on load.
- 💡 **Preset metadata** — tags / author / notes per preset; search the library.
- 🅲 **MIDI learn** — click a control, wiggle a hardware knob, bind the CC — useful
  for building templates for undocumented devices.
