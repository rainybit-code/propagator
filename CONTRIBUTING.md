# Contributing to Propagator

Thanks for your interest in improving Propagator! This is the browser control surface for
the **Spore** synthesizer; the firmware lives in the separate
[`spore`](https://github.com/rainybit-code/spore) repo.

## Getting set up

It's a static site — no build step, no dependencies to install:

```sh
python -m http.server 8000      # from the repo root
# then open http://localhost:8000 in Chrome or Edge
```

Use a **Chromium browser** (Chrome/Edge): Web MIDI and WebUSB need a *secure context*, and
`localhost` counts. Safari has no Web MIDI; Firefox is partial. You can develop most of the
UI without hardware; you only need a Daisy Seed + Hothouse running Spore to test live MIDI
and flashing.

## Project layout

```
index.html    structure + inline SVG filters and the Spore chassis
styles.css    the "living blueprint" theme + animations
app.js        WebMIDI, pods/knobs/patchbay/sequencer/clock, presets, flash wizard
core.js       pure, dependency-free helpers shared by app.js and the tests
dfu.js        self-contained WebUSB + DfuSe firmware flasher
presets.json  factory preset library
test/         Node unit tests for core.js (run with `node --test`)
firmware/     Spore .bin bundled at deploy time (CI) — never committed
```

## Conventions

- **Vanilla JS, no framework, no build.** Keep it that way — the value is that anyone can
  open the file and edit it. ES2020+ is fine (Chromium-only target).
- **Formatting** is enforced by [Prettier](https://prettier.io) via
  [`.prettierrc.json`](.prettierrc.json) (4-space indent, 100-col, single quotes — matching
  the Spore firmware's style). Run `npx prettier --write .` before committing; CI rejects
  unformatted code. Markdown and workflow YAML are left hand-formatted (see `.prettierignore`).
- **Linting**: a lightweight ESLint flat config ([`eslint.config.js`](eslint.config.js),
  core rules only — no plugins) catches bug-class issues. Run `npx eslint .`.
- **Tests**: pure logic lives in [`core.js`](core.js) and is unit-tested with Node's built-in
  runner — no dependencies. Run `node --test`. New pure helpers belong in `core.js` with a test.
- **License header.** Start each source file with the SPDX + copyright line used throughout
  (`SPDX-License-Identifier: GPL-3.0-or-later`).

## The MIDI contract (single source of truth)

The CC / SysEx map is **defined by the firmware** — see
[`spore/docs/MIDI_PROTOCOL.md`](https://github.com/rainybit-code/spore/blob/main/docs/MIDI_PROTOCOL.md).
Propagator mirrors it in the `CONFIG` block at the top of [`app.js`](app.js). If you add or
change a control, change it in `spore` first, then update `CONFIG` here to match — they must
stay in sync.

## Submitting a change

1. Branch off `main`.
2. Make your change. Running `npx prettier --write .` and opening the page in Chrome/Edge to
   sanity-check it is the fast path; CI enforces formatting either way.
3. Add a line under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).
4. Open a PR against `main`. On every PR, CI syntax-checks the scripts, validates
   `presets.json`, checks Prettier formatting, runs ESLint and the unit tests, and requires a
   `CHANGELOG.md` entry (label the PR `skip-changelog` for changes that don't warrant one).

Releases are cut from version tags — see `scripts/release.*`.
