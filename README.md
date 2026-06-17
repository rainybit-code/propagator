# 🌱 Propagator

[![web validate](https://github.com/rainybit-code/propagator/actions/workflows/web.yml/badge.svg)](https://github.com/rainybit-code/propagator/actions/workflows/web.yml)

A browser-based **WebMIDI** editor for the DIY **Spore** device (the Electrosmith
Daisy Seed firmware lives in the separate
[**`spore`**](https://github.com/rainybit-code/spore) repo). Configure Spore's
parameters live over USB MIDI — no install, no drivers.

**▶ Live: <https://rainybit-code.github.io/propagator/>** — open in Chrome or Edge
with Spore connected over USB. (It's the editor UI; it needs the device to
do anything.)

The look: a hand-inked **"boiling line"** cartoon of Spore on cyanotype
blueprint paper. Everything breathes, vibrates, and grows. The device is the hero
in the centre; secondary parameters branch out into fenced blueprint callouts; the
MIDI connection lives subtly in the top frame; a tempo dial drives a live beat.

## Run it

Easiest: just open the **[live site](https://rainybit-code.github.io/propagator/)** in
Chrome/Edge (HTTPS = secure context, so Web MIDI + SysEx work).

To run locally for development — it's a static site, no build step:

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

- Lists MIDI inputs/outputs, connects to Spore, shows live status.
- The 6 hardware **knobs** (drag, wheel, double-click to centre) + 3 toggles + 2
  footswitches, mirrored from the hardware. Toggle 1 picks the mode and **relabels**
  the knobs; Toggle 3 picks the FX.
- A full **Synth voice editor** in draggable "pods" (shown/hidden from the View menu):
  oscillator engine (analog / wavetable), tone & voicing, an interactive **ADSR**
  graph, **LFO 1 / LFO 2** (free-Hz or clock-synced), a drag-to-wire **patchbay**
  (6-slot mod matrix), a piano-roll **step sequencer**, and a **tempo/clock** section
  (GUI- or MIDI-master, tempo-synced delay).
- Preset save/load (browser localStorage).
- **Firmware flashing in the browser** (WebUSB DFU) — the ⤓ dfu button opens a wizard
  that fetches the latest `spore` release `.bin` (or takes a local file), reboots
  Spore to DFU over MIDI, and flashes it. Chrome/Edge; Windows needs WinUSB once (Zadig).

## MIDI map (the contract)

The CC / SysEx map is defined by the firmware and is the single source of truth:
see [**`spore/docs/MIDI_PROTOCOL.md`**](https://github.com/rainybit-code/spore/blob/main/docs/MIDI_PROTOCOL.md).
The mirror of it lives in the `CONFIG` block at
the top of `app.js` (labels, CC numbers, channel) — edit there to extend the surface.
Values are 0–127 (0..1 normalized).

## Files

```
index.html    structure + inline SVG filters (boil) and Spore chassis
styles.css    the living blueprint theme + animations
app.js        WebMIDI, pods/knobs/patchbay/sequencer/clock, presets, flash wizard
dfu.js        self-contained WebUSB + DfuSe firmware flasher
presets.json  factory preset library
```

## Roadmap

Tracks the firmware's `MIDI_PROTOCOL.md` phases: SysEx 2-way sync, preset
librarian (browser + device QSPI), and sample upload. Already **live on GitHub
Pages** at <https://rainybit-code.github.io/propagator/> (https = secure context,
usable from any machine).

## License

**GPL-3.0-or-later.** Copyright (C) 2026 Joakim Langkilde. See [`LICENSE`](LICENSE).
Pairs with the **Spore** firmware ([`spore`](https://github.com/rainybit-code/spore) repo),
which is GPL-3.0 for the same reason.

## AI disclosure

In the interest of transparency: this project was built with substantial help from AI.
Code, documentation, and design were generated and iterated with **Claude** (Claude Code)
under human direction and review.
