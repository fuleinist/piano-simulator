// The note schedule. Run: node --test tests/schedule.test.mjs
//
// The schedule walks the piece in music time and fires each attack and release
// with the time it belongs to, so the player can place them on the audio clock
// instead of waiting for a frame. These tests pump a small piece with a sink
// that records the events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteSchedule } from '../src/schedule.js';

const note = (midi, time, duration, velocity = 1) => ({ midi, time, duration, velocity });
const pedal = (time, name, down) => ({ time, name, down });

/** A sink that records every event, as [kind, midi, music time, velocity]. */
function recorder() {
  const out = [];
  return {
    out,
    attack: (midi, time, velocity) => out.push(['on', midi, time, velocity]),
    release: (midi, time) => out.push(['off', midi, time]),
  };
}

test('a note starts and ends at its own music time', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 0, 1)]);
  schedule.pump(2, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1], ['off', 60, 1]]);
  assert.equal(schedule.sounding, 0);
});

test('a pump places only the events inside its window', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 0, 1)]);
  schedule.pump(0.5, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1]], 'a pump stops at its horizon');
  assert.equal(schedule.sounding, 1);

  schedule.pump(2, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1], ['off', 60, 1]], 'the next pump fires the rest');
});

test('a damper pedal holds a tone until it lifts', () => {
  const sink = recorder();
  const events = [pedal(0.2, 'damper', true), pedal(1.5, 'damper', false)];
  const schedule = new NoteSchedule([note(60, 0, 1)], events);
  schedule.pump(3, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1], ['off', 60, 1.5]]);
});

test('the soft pedal scales the velocity of the tone it reaches', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 1, 1)], [pedal(0.5, 'soft', true)]);
  schedule.pump(3, sink);
  assert.equal(sink.out[0][0], 'on');
  assert.equal(sink.out[0][3], 0.6, 'the soft pedal cuts the level of a tone that starts under it');
});

test('a repeated strike stops the tone before it', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 0, 1), note(60, 0.5, 1.5)]);
  schedule.pump(3, sink);
  assert.deepEqual(sink.out, [
    ['on', 60, 0, 1], ['off', 60, 0.5],
    ['on', 60, 0.5, 1], ['off', 60, 2],
  ]);
});

test('sostenuto holds only the tones that sound when it goes down', () => {
  const sink = recorder();
  const events = [pedal(0.3, 'sostenuto', true), pedal(2, 'sostenuto', false)];
  const schedule = new NoteSchedule([note(60, 0, 0.5), note(64, 0.6, 0.4)], events);
  schedule.pump(3, sink);
  assert.deepEqual(sink.out, [
    ['on', 60, 0, 1], ['on', 64, 0.6, 1],
    ['off', 64, 1], // not down when the pedal went down, so it ends with its note
    ['off', 60, 2], // held by the pedal, and released when it lifts
  ]);
});

test('a reset drops the tones and starts again', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 0, 1), note(62, 1, 1)]);
  schedule.pump(3, sink);
  assert.equal(sink.out.length, 4);
  assert.equal(schedule.sounding, 0);

  schedule.reset(0.5);
  assert.equal(schedule.sounding, 0, 'a reset leaves no tone behind');
  sink.out.length = 0;
  schedule.pump(3, sink);
  assert.deepEqual(sink.out, [['on', 62, 1, 1], ['off', 62, 2]],
    'the notes before the reset point are not played again');
});

test('a pedal that never lifts leaves its last tone to the drain', () => {
  const sink = recorder();
  const schedule = new NoteSchedule([note(60, 0, 1)], [pedal(0.2, 'damper', true)]);
  schedule.pump(3, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1]], 'a held tone is not cut at its own end');
  assert.equal(schedule.sounding, 1);

  schedule.drain(3, sink);
  assert.deepEqual(sink.out, [['on', 60, 0, 1], ['off', 60, 3]]);
  assert.equal(schedule.sounding, 0);
});

test('the events come out in time order', () => {
  const sink = recorder();
  const notes = [note(48, 0, 2), note(60, 0, 1), note(64, 0.5, 0.5), note(67, 1, 2)];
  const events = [pedal(0.25, 'damper', true), pedal(1.2, 'damper', false), pedal(1.3, 'soft', true)];
  const schedule = new NoteSchedule(notes, events);
  schedule.pump(4, sink);
  schedule.drain(4, sink);

  let last = -Infinity;
  for (const [, , time] of sink.out) {
    assert.ok(time >= last, `event at ${time} comes after ${last}`);
    last = time;
  }
  assert.equal(sink.out.filter(([kind]) => kind === 'on').length, notes.length,
    'every note starts once');
  assert.equal(schedule.sounding, 0);
});