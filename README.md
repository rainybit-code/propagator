# 🌱 Propagator — Hothouse control surface

A browser-based **WebMIDI** editor for the DIY **Hothouse** pedal (Electrosmith
Daisy Seed firmware lives in the separate `daisy` repo). Configure the pedal's
parameters live over USB MIDI — no install, no drivers.

The look: a hand-inked **"boiling line"** cartoon of the pedal on cyanotype
blueprint paper. Everything breathes, vibrates, and grows. The pedal is the hero
in the centre; secondary parameters branch out into fenced blueprint callouts; the
MIDI connection lives subtly in the top frame; a tempo dial drives a live beat.

## Run it

It's a static site — no build step.

```sh
# from this folder
python -m http.server 8000
# then open http://localhost:8000 in Chrome or Edge
```

Use a **Chromium browser** (Chrome/Edge). Web MIDI needs a **secure context**, and
`localhost` counts — so serving over `http.server` is enough (SysEx included).
Safari has no Web MIDI; recent Firefox is partial.

> Opening `index.html` directly via `file://` may block MIDI permissions — serve
> over localhost instead.

## What it does

- Lists MIDI inputs/outputs, connects to the pedal, shows live status.
- 6 **knobs** (drag, wheel, double-click to centre) send Control Change.
- **Toggle 1** picks the mode (Synth / Granular / Generative) and **relabels** the
  knobs; **Toggle 3** picks the FX (Off / Delay / Reverb) and lights the FX pod.
- **FX pod** branches off Toggle 3 with its own 6 controls.
- **Tempo** dial + a pulsing beat (visual only for now).

## MIDI map (the contract)

Matches `daisy/docs/MIDI_PROTOCOL.md`:

| Control            | CC      |
|--------------------|---------|
| Mode knobs 1–6     | 20–25   |
| FX knobs 1–6       | 26–31   |

Values are 0–127 (0..1 normalized). Edit `CONFIG` at the top of `app.js` to extend
(labels, CC numbers, channel).

## Files

```
index.html   structure + inline SVG filters (boil) and pedal chassis
styles.css   the living blueprint theme + animations
app.js       WebMIDI, knob/toggle/footswitch interaction, beat engine, wires
```

## Roadmap

Tracks the firmware's `MIDI_PROTOCOL.md` phases: SysEx 2-way sync, preset
librarian (browser + pedal QSPI), and sample upload. Deploy to **GitHub Pages**
once it stabilizes (https = secure context, usable from any machine).
