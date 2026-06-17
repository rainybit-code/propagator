# Changelog

All notable changes to the Propagator editor are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses [Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH`).

## [Unreleased]
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
