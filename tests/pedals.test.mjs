// Piano pedal tests. Run: node --test tests/pedals.test.mjs
//
// The three pedals of a grand piano send their own control change: CC64 the
// damper, CC66 the sostenuto, and CC67 the soft pedal. A value of 64 or more
// presses the pedal. These tests hold the parser and the hold logic to that
// standard, and hold the depth lane to the same motion as the note bars.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PEDAL_CC, PEDAL_ORDER, SOFT_SCALE,
  pedalEvents, collectPedals, pedalSpans, PedalState, spanOnLane,
} from '../src/pedals.js';

// @tonejs/midi stores a control value as value / 127.
const raw = (v) => v / 127;
const cc = (time, value) => ({ time, value: raw(value) });
const track = (channel, changes) => ({ channel, controlChanges: changes });

const LANE = { pps: 3.2, endZ: -3.6, runway: 19.2 };

test('each pedal number maps to its own control change', () => {
  assert.equal(PEDAL_CC.damper, 64);
  assert.equal(PEDAL_CC.sostenuto, 66);
  assert.equal(PEDAL_CC.soft, 67);
  assert.deepEqual(PEDAL_ORDER, ['damper', 'sostenuto', 'soft']);
});

test('a value of 64 presses the pedal and 63 lifts it', () => {
  const events = pedalEvents({ 64: [cc(1, 64), cc(2, 63)] }, 0);
  assert.deepEqual(events, [
    { time: 1, name: 'damper', down: true },
    { time: 2, name: 'damper', down: false },
  ]);
});

test('the percussion channel never counts as a pedal', () => {
  const events = pedalEvents({ 64: [cc(1, 127)] }, 9);
  assert.deepEqual(events, []);
});

test('the three pedal types come out in time order', () => {
  const events = pedalEvents({ 64: [cc(2, 127)], 66: [cc(0, 127)], 67: [cc(1, 127)] }, 0);
  assert.deepEqual(events.map((e) => e.name), ['sostenuto', 'soft', 'damper']);
});

test('a press and its lift make one span', () => {
  const spans = pedalSpans(pedalEvents({ 64: [cc(1, 127), cc(3, 0)] }, 0), 10);
  assert.deepEqual(spans.damper, [[1, 3]]);
});

test('a lift with no press adds no span', () => {
  const spans = pedalSpans(pedalEvents({ 64: [cc(3, 0)] }, 0), 10);
  assert.deepEqual(spans.damper, []);
});

test('a pedal still down at the end runs to the end of the piece', () => {
  const spans = pedalSpans(pedalEvents({ 64: [cc(2, 127)] }, 0), 9);
  assert.deepEqual(spans.damper, [[2, 9]]);
});

test('a press and lift on one tick make no span', () => {
  const spans = pedalSpans(pedalEvents({ 64: [cc(2, 127), cc(2, 0)] }, 0), 10);
  assert.deepEqual(spans.damper, []);
});

test('a lift after the end of the piece stops at the end', () => {
  // The MIDI file may hold a pedal event past the last note. Nothing sounds
  // there, so the lane must not draw past the end of the piece.
  const spans = pedalSpans(pedalEvents({ 64: [cc(8, 127), cc(14, 0)] }, 0), 10);
  assert.deepEqual(spans.damper, [[8, 10]]);
});

test('a press after the end of the piece adds no span', () => {
  const spans = pedalSpans(pedalEvents({ 64: [cc(11, 127), cc(13, 0)] }, 0), 10);
  assert.deepEqual(spans.damper, []);
});

test('two tracks that carry the same pedal make one span', () => {
  const left = track(0, { 64: [cc(0, 127), cc(4, 0)] });
  const right = track(0, { 64: [cc(0, 127), cc(4, 0)] });
  const events = collectPedals([left, right]);
  // The second press repeats a press that is already down, so it adds nothing.
  assert.deepEqual(pedalSpans(events, 10).damper, [[0, 4]]);
});

test('the damper keeps a tone after its key lifts', () => {
  const state = new PedalState(pedalEvents({ 64: [cc(0, 127), cc(2, 0)] }, 0));
  state.advance(0.5);
  assert.equal(state.holds(60), true);
  state.advance(2);
  assert.equal(state.holds(60), false, 'the lift ends the hold');
});

test('the sostenuto pedal holds only the tones that sound when it goes down', () => {
  const state = new PedalState(pedalEvents({ 66: [cc(1, 127), cc(3, 0)] }, 0));
  state.advance(1, [60, 64]);
  assert.equal(state.holds(60), true);
  assert.equal(state.holds(64), true);
  // A tone that starts after the press is not caught by the sostenuto pedal.
  assert.equal(state.holds(67), false);
  state.advance(3);
  assert.equal(state.holds(60), false);
});

test('the soft pedal lowers the velocity and its lift holds no tone', () => {
  const state = new PedalState(pedalEvents({ 67: [cc(0, 127), cc(1, 0)] }, 0));
  state.advance(0.5);
  assert.equal(state.velocityScale(), SOFT_SCALE);
  assert.ok(SOFT_SCALE < 1);
  assert.equal(state.holds(60), false, 'the soft pedal never holds a tone');
  state.advance(1);
  assert.equal(state.velocityScale(), 1);
  assert.deepEqual(state.active(), []);
});

test('the state rebuilds at a seek point', () => {
  const state = new PedalState(pedalEvents({ 64: [cc(0, 127), cc(2, 0)] }, 0));
  state.advance(3);
  assert.equal(state.holds(60), false);
  state.reset(1);
  assert.equal(state.holds(60), true, 'the damper is down at 1 s');
  state.reset(2);
  assert.equal(state.holds(60), false, 'the damper lifts at 2 s');
});

test('a lift of every pedal clears the holds', () => {
  const state = new PedalState(pedalEvents({ 64: [cc(0, 127)], 66: [cc(0, 127)] }, 0));
  state.advance(1, [60]);
  assert.deepEqual(state.active(), ['damper', 'sostenuto']);
  state.liftAll();
  assert.deepEqual(state.active(), []);
  assert.equal(state.holds(60), false);
  // No event replays after the lift, so the state stays clear.
  state.advance(5);
  assert.deepEqual(state.active(), []);
  assert.equal(state.holds(60), false);
});

test('a span ahead of the play head sits behind the strike line', () => {
  const seg = spanOnLane([10, 12], 5, LANE);
  assert.ok(seg.near < LANE.endZ, 'the near edge is still behind the keys');
  assert.ok(seg.far < seg.near);
});

test('a span under the play head reaches the strike line', () => {
  const seg = spanOnLane([10, 12], 10, LANE);
  assert.equal(seg.near, LANE.endZ);
  assert.equal(seg.length, 6.4, 'two seconds of pedal at 3.2 units per second');
});

test('a span in the past leaves the lane', () => {
  assert.equal(spanOnLane([10, 12], 13, LANE), null);
});

test('a span beyond the look-ahead is not drawn', () => {
  assert.equal(spanOnLane([20, 22], 0, LANE), null);
});

test('the far edge stops at the start of the runway', () => {
  const seg = spanOnLane([100, 160], 100, LANE);
  assert.equal(seg.far, LANE.endZ - LANE.runway);
});

test('every pedal name has a lane order', () => {
  assert.equal(PEDAL_ORDER.length, 3);
});