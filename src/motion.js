// Hand motion timing, in song time. Pure module: no Three.js, no window, so
// Node tests and `tools/measure-fingering.mjs` share the timing the renderer
// uses.
//
// The renderer used to write the solved abduction straight onto the bones. A
// chord change therefore moved the fingers sideways in one frame: 21.7% of
// transitions changed a finger's spread by more than 0.05 rad, the worst by
// 1.1 rad, or 63 degrees, in a single frame. A hand does not do that. It leaves
// the old pose, fans open or closed over the keys, and arrives before the
// strike.
//
// The window ends exactly at the chord's own time, so the fingers are in place
// when the note sounds, and it is measured in the music's clock rather than in
// frames or in wall-clock seconds. Two consequences follow: the pose does not
// depend on the frame rate, and a seek samples the same path a playthrough
// would have travelled.

import { FINGERS, REST_CURLS } from './handrig.js';

/** Seconds a shift of one white key takes. */
export const TRAVEL_BASE_S = 0.09;

/**
 * Extra seconds per white key past the first. A seven-key shift takes 0.29 s,
 * which is about the speed a pianist's hand actually moves.
 */
export const TRAVEL_PER_KEY_S = 0.033;

/**
 * Longest window. A distant chord should not draw the hand in for seconds.
 */
export const MAX_LEAD_S = 0.35;

/**
 * Share of the gap between two chords the hand may spend travelling. The rest
 * belongs to the previous chord: a finger that is still holding its key must
 * not be dragged sideways off it the moment the next chord exists.
 */
export const GAP_SHARE = 0.75;

/**
 * How long the hand takes to reach a chord, in seconds.
 *
 * The shortest shift, one key, already asks for `TRAVEL_BASE_S`, so there is no
 * separate floor: a gap too short to hold the ask shortens the window rather
 * than letting the travel start while the previous chord is still sounding.
 *
 * @param {number} distanceKeys how far the wrist travels, in white keys
 * @param {number} gapSeconds time since the previous chord
 */
export function travelLead(distanceKeys, gapSeconds) {
  const want = TRAVEL_BASE_S + TRAVEL_PER_KEY_S * Math.max(0, distanceKeys - 1);
  const room = Math.min(MAX_LEAD_S, Number.isFinite(gapSeconds) ? gapSeconds * GAP_SHARE : Infinity);
  return Math.min(want, room);
}

/**
 * Travel ease: 0 at rest, 1 at the chord, with no speed at either end. A hand
 * accelerates off the old pose and decelerates into the strike, so the fan is
 * fastest in the middle of the travel.
 */
export function easeInOut(u) {
  const t = Math.min(1, Math.max(0, u));
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/**
 * Blend two poses. `s` is the raw travel fraction: 0 returns `from` exactly,
 * 1 returns `to` exactly, so contact at the strike is unchanged.
 *
 * A pose is `{ abduction, curls }`, both keyed by finger number. A missing
 * abduction counts as the bind pose (0 rad) and a missing curl set as the rest
 * curls, so a caller can pass only the part of the pose that moves.
 *
 * The renderer blends abduction and palm roll only: each finger's strike is
 * animated off its own note onset, so its curl belongs to the press and not to
 * the travel. `blendPose` still carries the curl set because the timed path of
 * a crossing moves fingers without moving the wrist, and that path has no note
 * onset to hang a press on.
 *
 * @param {{abduction?: object, curls?: object}} from
 * @param {{abduction?: object, curls?: object}} to
 * @param {number} s
 */
export function blendPose(from, to, s) {
  const t = Math.min(1, Math.max(0, s));
  const pose = { abduction: {}, curls: {} };
  for (const finger of FINGERS) {
    const a = from?.abduction?.[finger] ?? 0;
    const b = to?.abduction?.[finger] ?? 0;
    // The endpoints are exact, not merely close: the strike pose the solve
    // placed a fingertip with must be the pose the renderer writes.
    pose.abduction[finger] = t >= 1 ? b : t <= 0 ? a : a + (b - a) * t;

    const ca = from?.curls?.[finger] ?? REST_CURLS[finger];
    const cb = to?.curls?.[finger] ?? REST_CURLS[finger];
    pose.curls[finger] = cb.map((value, i) => {
      const start = ca[i] ?? value;
      return t >= 1 ? value : t <= 0 ? start : start + (value - start) * t;
    });
  }
  return pose;
}