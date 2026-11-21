// Recording fit tests. Run: node --test tests/framing.test.mjs
//
// The fit is a closed-form distance, so it is checked against the camera the
// scene really builds: a PerspectiveCamera at the anchor, slid up the screen by
// the view lift. Every corner of the box must land inside the safe frame at
// that distance, and must leave it a hair closer in.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { keyX, keyWidth } from '../src/layout.js';
import {
  FIT_DEADBAND, NARROW_DWELL_S, PAD, SAFE, VIEW_LIFT, boxCorners, fitDistance, fitScale, musicBox, nextFit,
  project, upcomingSpan,
} from '../src/framing.js';

/** The view the scene builds from a preset anchor, as plain data. */
const view = (over = {}) => ({
  target: [0, 0, 0],
  dir: [0, 1, 0],
  distance: 46,
  fov: 45,
  aspect: 16 / 9,
  ...over,
});

/** The camera Scene puts at `distance` along the view, lift and all. */
function camera(view, distance) {
  const dir = new THREE.Vector3(...view.dir).normalize();
  const pos = new THREE.Vector3(...view.target).addScaledVector(dir, distance);
  const f = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, f).normalize();
  const height = 2 * distance * Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
  const lift = up.multiplyScalar(height * VIEW_LIFT);
  const target = new THREE.Vector3(...view.target).add(lift);
  pos.add(lift);
  const cam = new THREE.PerspectiveCamera(view.fov, view.aspect, 0.1, 400);
  cam.position.copy(pos);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

// A straight-down view is the one the app starts on, and Three tilts the
// camera by 0.0001 there to break the lookAt tie. That roll moves a corner by
// up to about 0.0003 of a frame, so the comparisons leave room for it.
const TOL = 1e-3;

/** The worst half-frame coordinate of the box, in the real camera. */
function worst(box, v, distance) {
  const cam = camera(v, distance);
  let far = 0;
  for (const p of boxCorners(box)) {
    const q = new THREE.Vector3(...p).project(cam);
    far = Math.max(far, Math.abs(q.x), Math.abs(q.y));
  }
  return far;
}

test('the box spans the pressed keys and the hand above them', () => {
  const low = keyX(21) - keyWidth(21) / 2;   // A0, the lowest key
  const high = keyX(108) + keyWidth(108) / 2; // C8, the highest
  const all = musicBox([21, 108]);
  assert.equal(all.min[0], low - PAD, 'the left edge keeps a pad of key clear');
  assert.equal(all.max[0], high + PAD, 'the right edge keeps a pad of key clear');
  assert.ok(all.max[1] > 0.5, 'the box reaches above a black key top');
  assert.ok(all.min[2] < 0 && all.max[2] > 0, 'the box covers the key depth');

  // One key is narrower than the span of two, and empty input has no box.
  const one = musicBox([60]);
  assert.ok(one.max[0] - one.min[0] < all.max[0] - all.min[0]);
  assert.deepEqual(musicBox([60, 60]), one, 'a repeated key is one key');
  assert.equal(musicBox([]), null);
  assert.equal(musicBox(null), null);
});

test('a wide frame holds the whole keyboard at the default view', () => {
  const v = view();
  const all = musicBox([21, 108]);
  assert.ok(worst(all, v, v.distance) < SAFE - TOL, 'the top view already holds every key');
  assert.equal(fitScale(all, v), 1, 'a view that holds the keys is left alone');
});

test('a narrow frame pulls back until every pressed key is inside it', () => {
  const v = view({ aspect: 9 / 16 });
  for (const midis of [[21, 108], [36, 84], [21, 24], [60]]) {
    const box = musicBox(midis);
    const scale = fitScale(box, v);
    assert.ok(scale >= 1, 'the fit never zooms in past the chosen view');
    const at = worst(box, v, v.distance * scale);
    assert.ok(at <= SAFE + TOL, `a corner left the frame at ${at.toFixed(3)}`);
    if (scale > 1) {
      // The pull-back is no bigger than it must be: the box lands on the safe
      // edge, and one percent closer the frame no longer holds the music.
      assert.ok(at > SAFE - 0.01, 'the fit stops as soon as the box fits');
      assert.ok(worst(box, v, v.distance * scale * 0.99) > SAFE - TOL);
    }
  }
});

test('an angled view and a low box are fitted as well', () => {
  for (const over of [
    { dir: [0, 0.75, 0.66], target: [0, 1, -1] },
    { dir: [0.2, 0.8, 0.55], target: [4, 0.5, 1] },
    { dir: [-0.6, 0.6, 0.5], target: [0, 1, 0], aspect: 16 / 9 },
  ]) {
    const v = view({ aspect: 9 / 16, distance: 18, ...over });
    for (const midis of [[21, 108], [21, 33], [96, 108]]) {
      const box = musicBox(midis);
      const at = worst(box, v, v.distance * fitScale(box, v));
      assert.ok(at <= SAFE + TOL, `an angled view left a corner out at ${at.toFixed(3)}`);
    }
  }
});

test('the fit only ever pulls back', () => {
  const v = view({ aspect: 9 / 16, distance: 100 });
  const box = musicBox([60]);
  assert.ok(fitDistance(box, v) < v.distance, 'a distant view already holds the key');
  assert.equal(fitScale(box, v), 1);

  // A view with no distance and a box that is not there hold the view still.
  assert.equal(fitScale(box, view({ distance: 0 })), 1);
  assert.equal(fitScale(null, v), 1);
  assert.equal(fitDistance(null, v), 0);

  // A wider set of keys is never closer than a narrower one.
  const narrow = fitDistance(musicBox([60]), v);
  const wide = fitDistance(musicBox([48, 72]), v);
  assert.ok(wide >= narrow, 'a wider chord needs at least as much room');
});

test('a projected corner agrees with the real camera', () => {
  // A straight-down view is the one the app starts on. Three tilts the camera
  // by 0.0001 there to break the lookAt tie, so the roll is nearly the key
  // axis and the numbers agree to about a ten-thousandth of a frame.
  const top = view();
  const cam = camera(top, top.distance);
  for (const p of boxCorners(musicBox([21, 108]))) {
    const real = new THREE.Vector3(...p).project(cam);
    const mine = project(p, top, top.distance);
    assert.ok(Math.abs(real.x - mine[0]) < 5e-4 && Math.abs(real.y - mine[1]) < 5e-4);
  }

  // An angled view agrees to machine precision.
  const angled = view({ dir: [0.2, 0.8, 0.55], target: [4, 0.5, 1], distance: 24 });
  const cam2 = camera(angled, angled.distance);
  for (const p of boxCorners(musicBox([36, 84]))) {
    const real = new THREE.Vector3(...p).project(cam2);
    const mine = project(p, angled, angled.distance);
    assert.ok(Math.abs(real.x - mine[0]) < 1e-9 && Math.abs(real.y - mine[1]) < 1e-9);
  }

  // A point behind the camera has no place in the frame.
  assert.equal(project([0, 40, 0], top, 10), null);
});

test('the view holds still until a need earns a move', () => {
  const step = (state, out, hold, dt = 1 / 60) => nextFit(state, out, hold, dt);
  const settle = (state, out, hold, seconds) => {
    let s = state;
    for (let t = 0; t < seconds; t += 1 / 60) s = step(s, out, hold);
    return s;
  };

  // A need that already sits at the commitment never moves the view, however
  // many chords arrive: this is what stops the camera from dithering.
  assert.equal(settle({ fit: 2, narrowFor: 0 }, 2, 2, 3).fit, 2);
  assert.equal(settle({ fit: 2, narrowFor: 0 }, 1.9, 2.1, 3).fit, 2);
  let s = { fit: 2, narrowFor: 0 };
  for (let i = 0; i < 40; i++) s = step(s, 1.94 + (i % 2) * 0.02, 1.98 + (i % 3) * 0.02);
  assert.equal(s.fit, 2, 'the view moved on a repeated chord');

  // A wider need widens the view at once, and a widen cancels a narrowing.
  assert.equal(step({ fit: 1, narrowFor: 0 }, 2.4, 2.4).fit, 2.4);
  assert.equal(step({ fit: 1.5, narrowFor: 0 }, 2, 2.5).fit, 2);
  assert.deepEqual(step({ fit: 2, narrowFor: 1 }, 2.6, 1), { fit: 2.6, narrowFor: 0 });

  // A narrower need narrows only past the deadband, and only after the dwell.
  const narrow = nextFit({ fit: 2, narrowFor: 0 }, 1, 1.5, 1 / 60);
  assert.equal(narrow.fit, 2, 'a single narrower frame must not move the view');
  assert.ok(narrow.narrowFor > 0, 'the dwell must start counting');
  assert.equal(settle({ fit: 2, narrowFor: 0 }, 1, 1.5, 2).fit, 1.5, 'a held narrow need must come in');
  assert.equal(settle({ fit: 2, narrowFor: 0 }, 1, 1.99, 2).fit, 2, 'a need inside the deadband must not come in');

  // The commitment is never below the chosen view, and never below 1.
  assert.equal(settle({ fit: 1, narrowFor: 0 }, 1, 1, 1).fit, 1);
  assert.equal(settle({ fit: 0.5, narrowFor: 0 }, 0.5, 0.5, 2).fit, 1);
  assert.equal(settle({ fit: 1, narrowFor: 0 }, 0.2, 0.3, 2).fit, 1);
});

test('a sliding hold window walks the view in once, not step by step', () => {
  // What the hold window reports while a wide passage leaves it: a smaller
  // need every ~0.15 s, each one past the deadband on its own. The dwell must
  // fold the whole slide into one move.
  let s = { fit: 2.5, narrowFor: 0 };
  const seen = [];
  const values = [2.4, 2.3, 2.2, 2.1, 2.0, 1.9, 1.8];
  for (const v of values) {
    for (let i = 0; i < 9; i++) s = nextFit(s, 1, v, 1 / 60);  // ~0.15 s per value
    seen.push(s.fit);
  }
  for (let i = 0; i < 60; i++) s = nextFit(s, 1, 1.8, 1 / 60); // and then it holds
  const moves = seen.filter((v, i) => i && v !== seen[i - 1]).length
    + (s.fit !== seen[seen.length - 1] ? 1 : 0);
  assert.ok(moves <= 1, `the view walked in over ${moves} steps`);
  assert.equal(s.fit, 1.8, 'the view must reach the last need');
});

test('two windows give a steady frame over a whole passage', () => {
  // A passage that alternates a wide chord and a narrow one, with the wide
  // chord repeated every four seconds. The near window sees a chord three
  // seconds out, and the hold window sees ten seconds of music, so the wide
  // chord keeps the frame wide through the gap that follows it.
  const held = 1.8;
  const near = 1;
  let s = { fit: 1, narrowFor: 0 };
  const frames = [];
  for (let t = 0; t < 30; t += 1 / 60) {
    const out = (t % 4 > 1) ? held : near;  // the wide chord is coming
    const hold = held;                      // and it stays inside ten seconds
    s = nextFit(s, out, hold, 1 / 60);
    frames.push(s.fit);
  }
  const moves = frames.filter((v, i) => i && v !== frames[i - 1]).length;
  assert.ok(moves <= 2, `the view moved ${moves} times over the passage`);
  assert.equal(Math.max(...frames), held, 'the wide chord was not framed');
});

test('the lead window names the notes that are about to arrive', () => {
  const notes = [
    { time: 0, midi: 60 }, { time: 0.5, midi: 72 }, { time: 2, midi: 45 },
    { time: 2.2, midi: 84 }, { time: 9, midi: 21 },
  ];
  assert.deepEqual(upcomingSpan(notes, 0, 2.1), [45, 72], 'the window takes time, not index');
  assert.deepEqual(upcomingSpan(notes, 0, 0.5), [72, 72], 'a closed window holds its own note');
  assert.equal(upcomingSpan(notes, 0, 0.4), null, 'nothing starts before the end');
  assert.deepEqual(upcomingSpan(notes, 8, 9), [21, 21], 'the last note is found');
  assert.equal(upcomingSpan(notes, 9, 20), null, 'the window ends with the piece');
  assert.equal(upcomingSpan([], 0, 4), null);
});