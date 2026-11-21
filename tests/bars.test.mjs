// Note-bar length tests. Run: node --test tests/bars.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Bars, PPS, MIN_LEN, barLengths } from '../src/bars.js';

const note = (midi, time, duration) => ({
  midi, time, duration, velocity: 0.7, hand: 'R',
});

// Drawn z-span of every bar instance in the scene, at one moment of the clock.
function spansAt(notes, t) {
  const bars = new Bars(new THREE.Scene());
  bars.load(notes);
  bars.update(t);
  const m = new THREE.Matrix4();
  const spans = [];
  for (let i = 0; i < bars.mesh.count; i++) {
    bars.mesh.getMatrixAt(i, m);
    const centre = new THREE.Vector3().setFromMatrixPosition(m);
    const scale = new THREE.Vector3().setFromMatrixScale(m);
    spans.push({ far: centre.z - scale.z / 2, near: centre.z + scale.z / 2, len: scale.z });
  }
  return spans;
}

test('a bar is as long as its note', () => {
  assert.ok(Math.abs(barLengths([note(60, 1, 0.5)])[0] - 0.5 * PPS) < 1e-9);
  assert.ok(Math.abs(barLengths([note(60, 1, 2.0)])[0] - 2.0 * PPS) < 1e-9);
});

test('a bar stops at the next note on the same key', () => {
  // The regression this guards: a note that overlaps the next note on its own
  // key drew its full length, so the two bars interpenetrated in one column.
  const [first, second] = barLengths([note(60, 1, 0.7), note(60, 1.3, 0.2)]);
  assert.ok(Math.abs(first - 0.3 * PPS) < 1e-9, `first bar ${first} runs past the second note`);
  assert.ok(Math.abs(second - 0.2 * PPS) < 1e-9);
});

test('a bogus long note cannot paint over the rest of its column', () => {
  // A 20 s note-off in a file is a note-on that never closed. Its bar must not
  // span 20 s of music when the key is struck again half a second later.
  const [first] = barLengths([note(48, 205.19, 20.37), note(48, 205.71, 0.5)]);
  assert.ok(Math.abs(first - 0.52 * PPS) < 1e-9, `bar ${first} still covers 20 s`);
});

test('a note on another key does not shorten the bar', () => {
  const lens = barLengths([note(60, 1, 0.7), note(62, 1.05, 0.2)]);
  assert.ok(Math.abs(lens[0] - 0.7 * PPS) < 1e-9);
});

test('an onset shared by two notes is one strike, not a cut', () => {
  // One pitch carried by two tracks lands at one instant. Neither note may cut
  // the other to nothing.
  const lens = barLengths([note(60, 1, 0.5), note(60, 1, 0.5)]);
  assert.ok(Math.abs(lens[0] - 0.5 * PPS) < 1e-9);
  assert.ok(Math.abs(lens[1] - 0.5 * PPS) < 1e-9);
});

test('a note shorter than the floor draws a sliver', () => {
  // A note of 1 ms cannot draw 3 mm at this scale, so it gets the floor. The
  // floor is a floor only while the key stays free.
  const [tiny] = barLengths([note(60, 1, 0.001)]);
  assert.equal(tiny, MIN_LEN);
  const [cut] = barLengths([note(60, 1, 0.001), note(60, 1.01, 0.2)]);
  assert.ok(Math.abs(cut - 0.01 * PPS) < 1e-9, `sliver ${cut} overran the next onset`);
});

test('two bars on one key do not overlap in the scene', () => {
  const spans = spansAt([note(60, 1, 0.7), note(60, 1.3, 0.2)], 0.9);
  assert.equal(spans.length, 2);
  spans.sort((a, b) => b.near - a.near); // nearest the keys first
  assert.ok(spans[1].near <= spans[0].far + 1e-6,
    `bars overlap by ${(spans[1].near - spans[0].far).toFixed(3)} units`);
  assert.ok(Math.abs(spans[0].len - 0.3 * PPS) < 1e-6, `near bar drew ${spans[0].len}`);
});

test('a long note still draws its own length when the key stays free', () => {
  const spans = spansAt([note(60, 5, 3)], 4.9);
  assert.equal(spans.length, 1);
  assert.ok(Math.abs(spans[0].len - 3 * PPS) < 1e-6);
});