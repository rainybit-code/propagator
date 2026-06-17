# Changelog

All notable changes to the Propagator editor are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project
uses [Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH`).

## [Unreleased]
- Live on GitHub Pages: <https://rainybit-code.github.io/propagator/>.
- In-browser **firmware flashing** (WebUSB DFU, `dfu.js`): update the Spore pedal from
  the editor — pick the latest GitHub release `.bin` or a local file, reboot to DFU
  over MIDI (CC 119), then flash via DfuSe to internal flash. Chrome/Edge; on Windows
  the bootloader needs the WinUSB driver once (Zadig).

<!--
Releasing:
  1. Move the Unreleased items under a new `## [vX.Y.Z] - YYYY-MM-DD` heading.
  2. Commit, then tag:  git tag -a vX.Y.Z -m "vX.Y.Z"  &&  git push origin vX.Y.Z
  3. The `web` workflow attaches propagator-vX.Y.Z.zip to the Release.
  (The live site auto-deploys from main on every push — releases are just pinned snapshots.)
-->
