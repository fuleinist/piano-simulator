// Chord grouping tests. Run: node --test tests/chords.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHORD_WINDOW } from '../src/fingering.js';
import { buildChords } from '../src/chords.js';
import { keyTopY } from '../src/layout.js';

const note = (over) => ({
  midi: 60, time: 0, duration: 0.5, hand: 'R', finger: 3, wristX: 0, ...over,
});

test('the shared chord window is 0.05 s', () => {
  assert.equal(CHORD_WINDOW, 0.05);
});

test('notes 0.047 s apart group into one chord', () => {
  const notes = [
    note({ midi: 60, time: 0, finger: 1 }),
    note({ midi: 64, time: 0.047, finger: 3 }),
  ];
  const chords = buildChords(notes, 'R');
  assert.equal(chords.length, 1, 'a 47 ms gap stays inside the window');
  assert.equal(chords[0].time, 0);
  assert.equal(Object.keys(chords[0].fingers).length, 2);
  assert.equal(chords[0].fingers[1].midi, 60);
  assert.equal(chords[0].fingers[3].midi, 64);
});

test('notes exactly 0.05 s apart still group into one chord', () => {
  const notes = [
    note({ midi: 60, time: 0, finger: 1 }),
    note({ midi: 64, time: 0.05, finger: 3 }),
  ];
  assert.equal(buildChords(notes, 'R').length, 1, 'the window edge is inclusive');
});

test('notes 0.051 s apart split into two chords', () => {
  const notes = [
    note({ midi: 60, time: 0, finger: 1 }),
    note({ midi: 64, time: 0.051, finger: 3 }),
  ];
  const chords = buildChords(notes, 'R');
  assert.equal(chords.length, 2, 'a 51 ms gap exceeds the window');
  assert.equal(chords[0].time, 0);
  assert.equal(chords[1].time, 0.051);
});

test('different hands never share a chord', () => {
  const notes = [
    note({ midi: 48, time: 0, hand: 'L', finger: 5, wristX: -4 }),
    note({ midi: 60, time: 0, hand: 'R', finger: 1 }),
    note({ midi: 64, time: 0.01, hand: 'R', finger: 3 }),
  ];
  const left = buildChords(notes, 'L');
  const right = buildChords(notes, 'R');
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.deepEqual(Object.keys(left[0].fingers), ['5']);
  assert.deepEqual(Object.keys(right[0].fingers).sort(), ['1', '3']);
});

test('a chord keeps every field the renderer reads', () => {
  const notes = [
    note({ midi: 60, time: 0, duration: 0.5, finger: 1, wristX: 2, spread: 1.2 }),
    note({ midi: 61, time: 0.02, duration: 0.4, finger: 3, wristX: 4 }),
  ];
  const [c] = buildChords(notes, 'R');
  assert.equal(c.time, 0);
  assert.equal(c.end, 0.5, 'end is the latest note release');
  assert.equal(c.wristX, 3, 'wristX averages the group');
  assert.equal(c.spread, 1.2, 'spread comes from the first note');
  assert.ok(Math.abs(c.strikeZ - 1.0) < 1e-9, 'strikeZ averages white 1.9 and black 0.1');
  assert.equal(c.keyTop, Math.max(keyTopY(60), keyTopY(61)));
});
