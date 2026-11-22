// The music clock. Run: node --test tests/clock.test.mjs
//
// The piece must keep its own time. These tests hand the clock a time source
// that a test moves by hand, and check that a frame that arrives late, or not
// at all, cannot slow the music down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicClock } from '../src/clock.js';

/** A time source in seconds that a test moves. */
function source() {
  const s = { at: 0, now: () => s.at };
  return s;
}

test('a late frame does not slow the piece', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();

  // One frame at the 20 frames a second cap that the frame loop applies.
  s.at = 0.05;
  assert.equal(clock.read(), 0.05);

  // A hidden tab for six seconds. A loop that added up frame steps would read
  // 0.1 here, which is the freeze this clock removes.
  s.at = 6.05;
  assert.equal(clock.read(), 6.05);
});

test('pause holds the time and play continues from it', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();
  s.at = 4;
  clock.pause();
  assert.equal(clock.read(), 4);
  assert.equal(clock.running, false);

  // Time that passes while the clock is stopped does not count.
  s.at = 40;
  assert.equal(clock.read(), 4);
  clock.play();
  assert.equal(clock.read(), 4);
  s.at = 41.5;
  assert.equal(clock.read(), 5.5);
});

test('a speed change keeps the time the piece reached', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();
  s.at = 4;
  clock.setSpeed(2);
  assert.equal(clock.read(), 4);
  s.at = 6;
  assert.equal(clock.read(), 8);
  clock.setSpeed(0.5);
  s.at = 8;
  assert.equal(clock.read(), 9);
});

test('a seek clamps to the piece and runs from there', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();
  s.at = 3;
  clock.seek(-5);
  assert.equal(clock.read(), 0);
  s.at = 4;
  assert.equal(clock.read(), 1);

  clock.seek(30);
  assert.equal(clock.read(), 30);
  s.at = 5;
  assert.equal(clock.read(), 31);
});

test('a speed of zero or less cannot stop the clock', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();
  clock.setSpeed(0);
  s.at = 2;
  assert.equal(clock.read(), 2);
});

test('clockFor places a music time on the time source', () => {
  const s = source();
  const clock = new MusicClock({ now: s.now });
  clock.play();
  s.at = 1;
  assert.equal(clock.read(), 1);

  // At twice the speed, music time 3 plays one second from now.
  clock.setSpeed(2);
  assert.equal(clock.clockFor(3), 2);

  // The mapping inverts the reading it came from.
  s.at = 2.5;
  assert.equal(clock.clockFor(clock.read()), 2.5);
});