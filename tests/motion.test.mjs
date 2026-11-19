// Hand motion tests. Run: node --test tests/motion.test.mjs
//
// The renderer used to write the solved finger spread onto the bones in one
// frame, so a chord change looked like a teleport. These tests pin the timing
// that replaced it: a window in song time, an ease with no speed at either end,
// and an arrival that lands exactly on the chord.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRAVEL_BASE_S, TRAVEL_PER_KEY_S, MAX_LEAD_S, GAP_SHARE,
  travelLead, easeInOut, blendPose,
} from '../src/motion.js';
import { REST_CURLS } from '../src/handrig.js';

const FINGERS = [1, 2, 3, 4, 5];

test('the travel ease starts and ends at rest', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-12, 'the middle of the travel is half way');

  // Symmetric, so the hand decelerates into the strike as hard as it
  // accelerates away from the old pose.
  for (const u of [0.1, 0.25, 0.4]) {
    assert.ok(Math.abs(easeInOut(u) + easeInOut(1 - u) - 1) < 1e-12, `symmetric at ${u}`);
  }

  // Monotonic, and clamped outside the window.
  let last = -1;
  for (let i = 0; i <= 100; i++) {
    const v = easeInOut(i / 100);
    assert.ok(v >= last, `monotonic at ${i / 100}`);
    last = v;
  }
  assert.equal(easeInOut(-3), 0);
  assert.equal(easeInOut(4), 1);

  // No speed at either end: the first and last percent move far less than the
  // middle of the travel does.
  const start = easeInOut(0.01) - easeInOut(0);
  const middle = easeInOut(0.51) - easeInOut(0.5);
  assert.ok(start < middle / 10, `the ease starts gently (${start} vs ${middle})`);
});

test('a travel window scales with distance and never outruns the music', () => {
  assert.equal(travelLead(1, 10), TRAVEL_BASE_S);

  const seven = travelLead(7, 10);
  assert.ok(Math.abs(seven - (TRAVEL_BASE_S + 6 * TRAVEL_PER_KEY_S)) < 1e-12,
    'seven keys uses the per-key term');
  assert.ok(seven > travelLead(2, 10), 'a longer shift takes longer');
  assert.ok(seven > 0.2 && seven < 0.35, `seven keys takes a real moment (${seven}s)`);

  // Never more than the share of the gap, never more than the cap.
  for (const gap of [0.08, 0.2, 0.5, 2, 10]) {
    for (const dist of [0.2, 1, 4, 12]) {
      const lead = travelLead(dist, gap);
      assert.ok(lead <= gap * GAP_SHARE + 1e-12, `${lead}s fits in a ${gap}s gap`);
      assert.ok(lead <= MAX_LEAD_S + 1e-12, `${lead}s stays under the cap`);
    }
  }

  // A gap too short for the minimum window still sets the whole window, so the
  // hand never starts moving before the previous chord has sounded.
  const tight = travelLead(6, 0.04);
  assert.ok(tight <= 0.04, `a ${tight}s window fits the ${0.04}s gap`);
  assert.ok(tight > 0, 'a tight gap still allows movement');

  // A short shift across a long rest is not held for the whole rest.
  assert.equal(travelLead(1, 5), TRAVEL_BASE_S, 'the window does not grow with the rest');
  assert.equal(travelLead(40, 5), MAX_LEAD_S, 'a long leap stops at the cap');
});

test('blendPose returns each endpoint exactly', () => {
  const from = { abduction: { 1: -0.2, 2: 0.1, 3: 0, 4: 0.05, 5: 0.3 }, curls: REST_CURLS };
  const to = { abduction: { 1: 0.4, 2: -0.1, 3: 0.25, 4: -0.2, 5: 0 }, curls: REST_CURLS };

  const atStart = blendPose(from, to, 0);
  const atEnd = blendPose(from, to, 1);
  for (const f of FINGERS) {
    assert.equal(atStart.abduction[f], from.abduction[f], `finger ${f} starts on the old pose`);
    assert.equal(atEnd.abduction[f], to.abduction[f], `finger ${f} lands on the new pose`);
    assert.deepEqual(atStart.curls[f], from.curls[f]);
    assert.deepEqual(atEnd.curls[f], to.curls[f]);
  }

  // The strike is a hard requirement, so an overshoot clamps to the target.
  assert.deepEqual(blendPose(from, to, 1.4).abduction, atEnd.abduction);
  assert.deepEqual(blendPose(from, to, -0.5).abduction, atStart.abduction);
});

test('blendPose moves abduction and curls together', () => {
  const from = { abduction: { 3: -0.4 }, curls: { 3: [0.1, 0.1, 0.1] } };
  const to = { abduction: { 3: 0.6 }, curls: { 3: [0.5, 0.9, 0.5] } };

  const half = blendPose(from, to, 0.5);
  assert.ok(Math.abs(half.abduction[3] - 0.1) < 1e-12, 'the spread meets in the middle');
  half.curls[3].forEach((v, i) => {
    assert.ok(Math.abs(v - (0.1 + (to.curls[3][i] - 0.1) / 2)) < 1e-12, `curl ${i} meets in the middle`);
  });

  // A part of the pose a caller leaves out counts as the bind pose, so the
  // thumb on an unchanged chord does not jump to a stale value.
  const sparse = blendPose({}, { abduction: { 2: 0.3 } }, 0.5);
  assert.equal(sparse.abduction[1], 0, 'a missing spread counts as the bind pose');
  assert.ok(Math.abs(sparse.abduction[2] - 0.15) < 1e-12);
  assert.deepEqual(sparse.curls[4], REST_CURLS[4], 'a missing curl set counts as rest');

  // Nothing left in the pose may be NaN, whatever the caller leaves out.
  for (const f of FINGERS) {
    assert.ok(Number.isFinite(sparse.abduction[f]), `abduction ${f} is finite`);
    for (const v of sparse.curls[f]) assert.ok(Number.isFinite(v), `curl ${f} is finite`);
  }
});

test('the worst measured fan spreads over frames instead of one', () => {
  // The largest spread change the solver asks for across the test corpus is
  // 1.1 rad (63 degrees). It came with a multi-key shift, so the window is
  // a long one: 6 keys, one second of music.
  const delta = 1.1;
  const lead = travelLead(6, 1.0);
  const fps = 60;
  const frames = Math.max(1, Math.round(lead * fps));

  const samples = [];
  for (let i = 0; i <= frames; i++) samples.push(delta * easeInOut(i / frames));

  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[frames] - delta) < 1e-12, 'the last sample is the target');

  let biggest = 0;
  for (let i = 1; i < samples.length; i++) biggest = Math.max(biggest, samples[i] - samples[i - 1]);

  // The old code took this step in a single frame. Now no frame covers more
  // than a fraction of it, and the fan needs at least five frames to arrive.
  assert.ok(frames >= 5, `the fan covers ${frames} frames`);
  assert.ok(biggest < delta * 0.15, `the largest frame moves ${(100 * biggest / delta).toFixed(1)}% of the fan`);
  assert.ok(samples[1] < delta * 0.05, 'the first frame barely moves, as a hand starts from rest');

  // No sample leaves the range the solver asked for.
  for (const v of samples) assert.ok(v >= 0 && v <= delta + 1e-12);
});