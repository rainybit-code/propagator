/* ============================================================================
   core.js — pure, dependency-free helpers shared by the UI and the tests.
   SPDX-License-Identifier: GPL-3.0-or-later
   Copyright (C) 2026 Joakim Langkilde

   No DOM, no MIDI, no app state — just deterministic functions. Loaded as a
   classic <script> before app.js (so these become the globals the app uses),
   and require()-able by the Node test suite (test/core.test.js).
   ============================================================================ */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// clamp a value into [0, 1]
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// knob rotation in degrees for a 0..1 value (-135deg .. +135deg)
function rotFor(v) {
    return -135 + v * 270;
}

// is version string a strictly newer than b? (semver major.minor.patch, leading 'v' optional)
function semverGt(a, b) {
    const pa = String(a)
        .replace(/^v/, '')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    const pb = String(b)
        .replace(/^v/, '')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
}

// SVG path for a hanging-wire patch cable between two points
function cablePath(sx, sy, dx, dy) {
    const mx = (sx + dx) / 2,
        sag = 10 + Math.abs(dx - sx) * 0.06;
    return `M ${sx} ${sy} C ${mx} ${sy + sag} ${mx} ${dy + sag} ${dx} ${dy}`;
}

// MIDI note number -> name with octave (middle C = C4 at note 60)
function noteName(n) {
    return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// decode a raw MIDI message into { cat, text } for the activity log
function describeMidi(d) {
    const hi = d[0] & 0xf0;
    if (hi === 0x90 && d[2] > 0)
        return { cat: 'notes', text: `Note On  ${noteName(d[1])}  v${d[2]}` };
    if (hi === 0x80 || (hi === 0x90 && d[2] === 0))
        return { cat: 'notes', text: `Note Off ${noteName(d[1])}` };
    if (hi === 0xb0) return { cat: 'cc', text: `CC ${d[1]} → ${d[2]}` };
    if (hi === 0xe0) return { cat: 'other', text: `Pitch Bend ${((d[2] << 7) | d[1]) - 8192}` };
    if (hi === 0xc0) return { cat: 'other', text: `Program ${d[1]}` };
    if (hi === 0xd0) return { cat: 'other', text: `Ch Pressure ${d[1]}` };
    if (hi === 0xa0) return { cat: 'other', text: `Poly AT ${noteName(d[1])} ${d[2]}` };
    return { cat: 'other', text: `0x${d[0].toString(16)}` };
}

// Node test harness can require() this; the browser loads it as a classic script.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NOTE_NAMES, clamp01, rotFor, semverGt, cablePath, noteName, describeMidi };
}
