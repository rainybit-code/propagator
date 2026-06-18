# Changelog

All notable changes to the Propagator editor are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses [Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH`).

## [Unreleased]
- **Steps** mod-matrix source — an 8th patchbay source (logistic-map / stepped chaos)
  alongside the smooth Lorenz "Chaos". Source encoding widened to `/8`; saved patches are
  migrated (schema v2→v3). Needs firmware with the Steps source.

## [v0.2.1] - 2026-06-18
- **Chaos panel** in the MOD pod — a **Speed** knob (CC 18) that retunes the device's
  Lorenz chaos live, and a **live attractor canvas** that draws the real chaos streamed
  from the pedal (SysEx `0x03`/`0x43`). Polled ~20 Hz and **only while the canvas is
  visible**, so it's idle otherwise. Needs firmware with the chaos CC + SysEx.
- **Chaos** mod-matrix source — a 7th patchbay source (Lorenz attractor) you can wire to
  any destination. Source encoding widened to `/7`; old saved patches are migrated
  (schema v1→v2) so existing routings keep their meaning. Needs firmware with the Chaos
  matrix source.
- **Remove the Spore→pod connector lines** — the dashed wire overlay between the
  device and the breakout pods is gone (cleaner stage; pods stand on their own).
- **Live CPU load** as a mixer-style meter in the footer — polls Spore's audio-callback
  load once a second over SysEx (`F0 7D 02 F7` → `0x42 <avg%> <max%>`). Fill = avg
  (green→amber→red by level), a peak-hold marker tracks the max and turns red when
  capping (≥ 90 %). Hidden until a device answers; needs firmware with the CPU-meter SysEx.
- **Autosave** the live patch (knobs + mode/fx + sequence) to localStorage — reloading
  the page no longer resets everything.
- **New patch** button — reset every bank + the sequence back to defaults.
- **Export / import** your saved presets as a `.json` file.

## [v0.1.0] - 2026-06-17
- Live on GitHub Pages: <https://rainybit-code.github.io/propagator/>.
- Firmware flashing: the latest Spore build is now **bundled into the site at deploy
  time** (Pages Actions workflow fetches it server-side, dodging the release-asset
  CORS wall), so the wizard can one-click "use latest" via a same-origin fetch. Local
  .bin still supported.
- Spore's firmware version is read over a **SysEx identify** query; the DFU button
  **pulses dim green** when the bundled build is newer than what's on the device.
- In-browser **firmware flashing** (WebUSB DFU, `dfu.js`): update Spore from
  the editor — pick the latest GitHub release `.bin` or a local file, reboot to DFU
  over MIDI (CC 119), then flash via DfuSe to internal flash. Chrome/Edge; on Windows
  the bootloader needs the WinUSB driver once (Zadig).

<!--
Releasing:  scripts/release.sh vX.Y.Z      (or  scripts\release.ps1 vX.Y.Z  on Windows)
  Add your notes under [Unreleased] above, then run that one command: it moves them
  under a dated [vX.Y.Z] heading, commits, tags, and pushes. CI attaches
  propagator-vX.Y.Z.zip and publishes a Release whose body IS this CHANGELOG section.
  (The live site auto-deploys from main on every push — releases are just pinned snapshots.)
-->
