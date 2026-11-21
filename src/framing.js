// Camera framing for a recording.
//
// A recording frame has a fixed shape, and the keys a piece uses can run past
// the edge of that shape: the narrow 9:16 frame shows about 21 of the 52 key
// widths from the default overhead view. So while a capture runs, the camera
// pulls back along its own view direction until every key the hands press
// projects inside the frame. Once the music fits the view the player chose,
// the camera returns to it.
//
// The fit is the distance at which the farthest corner of the subject's box
// lands on the safe edge of the frame. It is solved in closed form, one
// inequality per frame side, so a corner can never be handled by guesswork.
//
// Pure module: points are plain [x, y, z] arrays, so Node tests can check the
// fit against a real PerspectiveCamera without a browser.

import { keyX, keyWidth, KEY_BACK_Z, KEY_FRONT_Z } from './layout.js';

/** Share of the half-frame that the pressed keys may fill. */
export const SAFE = 0.92;

/**
 * The share of the visible height that a view slides up the screen, so the
 * stage sits below the paper (see src/scene.js). The fit needs the same
 * number: the slide moves the subject down the frame, so a box that sits low
 * needs a longer pull-back than one that sits high.
 */
export const VIEW_LIFT = 0.11;

/** Scene units of key kept clear beside the outermost pressed key. */
export const PAD = 2.4;

/**
 * How far below the committed pull-back a need must sit before the camera
 * comes back in. Three percent is roughly two white keys of slack at the
 * default view, so a repeat of the same chord never moves the view.
 */
export const FIT_DEADBAND = 0.97;

/**
 * How long a narrower need must hold before the camera comes back in. A hold
 * window that slides past a wide passage reports a smaller need every frame,
 * and acting on each report walks the view in over a dozen small steps; one
 * second of agreement folds them into a single move.
 */
export const NARROW_DWELL_S = 1.2;

/** Height of the hand above the keys: the top of the box, in scene units. */
const HAND_Y = 2.6;

/** How far the hand reaches in front of the keys, in scene units. */
const HAND_FRONT = 1.2;

/** The key depth kept clear behind the pressed keys, in scene units. */
const KEY_BACK_PAD = 0.4;

/**
 * The box a recording must keep in frame: every key in `midis`, the hand above
 * it, and `pad` units of clear key on each side. Empty input gives null.
 */
export function musicBox(midis, pad = PAD) {
  if (!midis || !midis.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const midi of midis) {
    const x = keyX(midi);
    const half = keyWidth(midi) / 2;
    lo = Math.min(lo, x - half);
    hi = Math.max(hi, x + half);
  }
  return {
    min: [lo - pad, 0, KEY_BACK_Z - KEY_BACK_PAD],
    max: [hi + pad, HAND_Y, KEY_FRONT_Z + HAND_FRONT],
  };
}

/** The eight corners of a box. */
export function boxCorners(box) {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  return [
    [x0, y0, z0], [x0, y0, z1], [x0, y1, z0], [x0, y1, z1],
    [x1, y0, z0], [x1, y0, z1], [x1, y1, z0], [x1, y1, z1],
  ];
}

/**
 * The screen axes of a view, and its half-frame tangents.
 *
 * `dir` is the unit vector from the target toward the camera. The axes match
 * the scene's own (`_screenAxes` in src/scene.js): a straight-down view has no
 * right vector of its own, so the key axis serves.
 */
function frameOf(view) {
  const dir = normalize(view.dir);
  const f = [-dir[0], -dir[1], -dir[2]];
  let r = cross(f, [0, 1, 0]);
  if (len2(r) < 1e-12) r = [1, 0, 0];
  else r = scale(r, 1 / Math.sqrt(len2(r)));
  const u = normalize(cross(r, f));
  const tanHalf = Math.tan((view.fov ?? 45) * Math.PI / 360);
  return {
    target: view.target,
    f,
    r,
    u,
    tanHalf,
    aspect: view.aspect ?? 1,
    safe: view.safe ?? SAFE,
    lift: view.lift ?? VIEW_LIFT,
  };
}

/**
 * Where a world point lands in the frame, as (x, y) in half-frame units: the
 * frame runs from -1 to 1, so 1 is the left or bottom edge. Null when the
 * point sits behind the camera.
 */
export function project(point, view, distance) {
  const frame = frameOf(view);
  const p = sub(point, frame.target);
  const depth = distance + dot(p, frame.f);
  if (!(depth > 1e-6)) return null;
  const drop = 2 * distance * frame.tanHalf * frame.lift;
  return [
    dot(p, frame.r) / (depth * frame.tanHalf * frame.aspect),
    (dot(p, frame.u) - drop) / (depth * frame.tanHalf),
  ];
}

/**
 * The distance at which every corner of `box` sits inside the safe part of the
 * frame, measured from the view's target. Zero when there is no box.
 *
 * Each corner yields a lower bound: a point at `p` from the target needs
 * |p·right| <= safe * tan * aspect * depth and the same on the vertical axis,
 * with the lift's screen drop folded in. The largest bound holds them all.
 */
export function fitDistance(box, view) {
  if (!box) return 0;
  const { f, r, u, tanHalf, aspect, safe, lift } = frameOf(view);
  const across = safe * tanHalf * aspect;
  const up = safe * tanHalf;
  const down = tanHalf * (2 * lift - safe);
  let distance = 0;
  for (const corner of boxCorners(box)) {
    const p = sub(corner, view.target);
    const pf = dot(p, f);
    const pu = dot(p, u);
    distance = Math.max(
      distance,
      Math.abs(dot(p, r)) / across - pf,
      (pu - up * pf) / (tanHalf * (safe + 2 * lift)),
      (pu + up * pf) / down,
      -pf,
    );
  }
  return distance;
}

/**
 * How far the camera must pull back from `view.distance`, as a multiplier.
 *
 * The result is never below 1: the view the player chose is the floor, so the
 * camera never zooms in past it. A box that already fits there returns 1, and
 * that is what brings the camera back after a wide chord.
 */
export function fitScale(box, view) {
  const distance = view.distance;
  if (!(distance > 0)) return 1;
  return Math.max(1, fitDistance(box, view) / distance);
}

/**
 * The committed pull-back after this frame's two needs.
 *
 * `out` is what the near window must fit: a note that needs more room widens
 * the view at once. `hold` is what the hold window must fit: while that needs
 * the wider view, the camera stays where it is. A narrow view is taken only
 * when the hold window has needed less than the current view for `dwell`
 * seconds, so a sliding window cannot walk the view in step by step.
 *
 * `state` is `{ fit, narrowFor }` and the result keeps that shape, because the
 * dwell lives on the frame clock and a pure function cannot hold it.
 */
export function nextFit(state, out, hold, dt, { deadband = FIT_DEADBAND, dwell = NARROW_DWELL_S } = {}) {
  const fit = Math.max(1, state.fit);
  if (out > fit) return { fit: Math.max(1, out), narrowFor: 0 };
  if (hold >= fit * deadband) return { fit, narrowFor: 0 };
  const narrowFor = state.narrowFor + dt;
  if (narrowFor < dwell) return { fit, narrowFor };
  return { fit: Math.max(1, hold), narrowFor: 0 };
}

/**
 * The lowest and highest note that the piece starts between `from` and `to`.
 * A recording looks a little ahead so a wide chord pulls the view back before
 * it lands. Null when nothing starts in the window.
 */
export function upcomingSpan(notes, from, to) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time <= from) lo = mid + 1;
    else hi = mid;
  }
  let low = Infinity;
  let high = -Infinity;
  for (let i = lo; i < notes.length && notes[i].time <= to; i++) {
    low = Math.min(low, notes[i].midi);
    high = Math.max(high, notes[i].midi);
  }
  return low <= high ? [low, high] : null;
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len2(a) { return dot(a, a); }
function normalize(a) { return scale(a, 1 / Math.sqrt(len2(a))); }