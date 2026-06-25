// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Joakim Langkilde
//
// Tests for the pure helpers in core.js. Run with `node --test` (no dependencies).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clamp01, rotFor, semverGt, cablePath, noteName, describeMidi } = require('../core.js');

test('clamp01 bounds to [0,1]', () => {
    assert.equal(clamp01(-0.5), 0);
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(0.42), 0.42);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(2), 1);
});

test('rotFor maps 0..1 to -135..+135 degrees', () => {
    assert.equal(rotFor(0), -135);
    assert.equal(rotFor(0.5), 0);
    assert.equal(rotFor(1), 135);
});

test('semverGt compares major.minor.patch, leading v optional', () => {
    assert.equal(semverGt('0.4.0', '0.3.4'), true);
    assert.equal(semverGt('v1.0.0', '0.9.9'), true);
    assert.equal(semverGt('0.3.4', '0.4.0'), false);
    assert.equal(semverGt('1.2.3', '1.2.3'), false); // equal is not strictly greater
    assert.equal(semverGt('0.4.10', '0.4.9'), true); // numeric, not lexical
    assert.equal(semverGt('0.4', '0.4.0'), false); // missing parts treated as 0
});

test('noteName numbers octaves with middle C = C4', () => {
    assert.equal(noteName(60), 'C4');
    assert.equal(noteName(69), 'A4'); // A440
    assert.equal(noteName(0), 'C-1');
    assert.equal(noteName(61), 'C#4');
});

test('describeMidi decodes status bytes', () => {
    assert.deepEqual(describeMidi([0x90, 60, 100]), { cat: 'notes', text: 'Note On  C4  v100' });
    assert.equal(describeMidi([0x90, 60, 0]).cat, 'notes'); // note-on vel 0 == note off
    assert.equal(describeMidi([0x80, 60, 0]).text, 'Note Off C4');
    assert.deepEqual(describeMidi([0xb0, 7, 64]), { cat: 'cc', text: 'CC 7 → 64' });
    assert.equal(describeMidi([0xc0, 5]).cat, 'other'); // program change
});

test('cablePath returns a cubic SVG path through the two points', () => {
    const p = cablePath(0, 0, 100, 50);
    assert.match(p, /^M 0 0 C /);
    assert.ok(p.endsWith('100 50'));
});
