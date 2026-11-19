// Piano pedals. Pure module: no three.js and no Tone.js imports, so the
// parsing and the hold logic are testable in Node.
//
// A grand piano has three pedals, and each one sends its own MIDI control
// change:
//   CC64  damper (sustain)  lifts the dampers, so a tone rings after its key
//   CC66  sostenuto         holds only the tones that sound when it goes down
//   CC67  soft (una corda)  moves the hammers onto fewer strings, so the tone
//                           is quieter and darker
// A value of 64 or more presses the pedal. A smaller value lifts it.

export const PEDAL_CC = { damper: 64, sostenuto: 66, soft: 67 };
export const PEDAL_ORDER = ['damper', 'sostenuto', 'soft'];
export const PEDAL_COLOR = { damper: 0x35d0a5, sostenuto: 0xa77dff, soft: 0xffc95c };

// A value of 64 or more presses the pedal. @tonejs/midi stores a control value
// as value / 127, so a raw 64 arrives as 0.504 and a raw 63 as 0.496.
const DOWN_AT = 0.5;
// The shortest press worth a span. A press and a lift on the same tick carry
// no hold, and a mark shorter than the lane can draw would only flicker.
const MIN_SPAN = 0.02;
// A real una corda cuts the level by about 4 dB and darkens the tone. A
// sampler cannot move its hammers, so the scene keeps the level change only.
export const SOFT_SCALE = 0.6;
const PERCUSSION = 9;

/**
 * Flatten the control changes of one MIDI track into pedal events, in time
 * order. The percussion channel sends CC64 for its own purpose, so it never
 * counts as a pedal.
 */
export function pedalEvents(controlChanges, channel) {
  const out = [];
  if (channel === PERCUSSION) return out;
  for (const name of PEDAL_ORDER) {
    const list = controlChanges?.[PEDAL_CC[name]] || [];
    for (const cc of list) out.push({ time: cc.time, name, down: cc.value >= DOWN_AT });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Collect the pedal events of every track into one list. Two tracks that both
 * carry the pedal send the same presses, so the caller must tolerate repeats.
 */
export function collectPedals(tracks) {
  const out = [];
  for (const track of tracks) out.push(...pedalEvents(track.controlChanges, track.channel));
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Turn the events into spans of [start, end] seconds for each pedal. A pedal
 * that is still down at the end of the piece runs to `endTime`, so the last
 * chord keeps its ring. A lift that lands after the piece ends is clamped to
 * the same point, because nothing sounds past it.
 */
export function pedalSpans(events, endTime = 0) {
  const limit = endTime > 0 ? endTime : Infinity;
  const spans = { damper: [], sostenuto: [], soft: [] };
  const openAt = {};

  const close = (name, time) => {
    const start = openAt[name];
    if (start === undefined) return;
    delete openAt[name];
    const end = Math.min(time, limit);
    if (start < limit && end - start >= MIN_SPAN) spans[name].push([start, end]);
  };

  for (const e of events) {
    if (e.time > limit) break;
    if (e.down) {
      if (openAt[e.name] === undefined) openAt[e.name] = e.time;
    } else {
      close(e.name, e.time);
    }
  }
  for (const name of PEDAL_ORDER) close(name, limit);
  return spans;
}

/**
 * The pedal state during playback. `advance` applies every event up to a
 * music time, so the caller may step it in frames.
 */
export class PedalState {
  constructor(events = []) {
    this.events = events;
    this.next = 0;
    this.down = { damper: false, sostenuto: false, soft: false };
    this.held = new Set();
  }

  /** Rebuild the state at a music time, after a seek or a pause. */
  reset(time = 0, sounding = []) {
    this.next = 0;
    this.down = { damper: false, sostenuto: false, soft: false };
    this.held.clear();
    this.advance(time, sounding);
  }

  /**
   * Apply the events up to `time`. `sounding` lists the pitches that sound
   * now, because the sostenuto pedal captures them as it goes down.
   */
  advance(time, sounding = []) {
    while (this.next < this.events.length && this.events[this.next].time <= time) {
      const e = this.events[this.next++];
      if (e.down) {
        if (this.down[e.name]) continue;
        this.down[e.name] = true;
        if (e.name === 'sostenuto') for (const midi of sounding) this.held.add(midi);
      } else {
        if (!this.down[e.name]) continue;
        this.down[e.name] = false;
        if (e.name === 'sostenuto') this.held.clear();
      }
    }
  }

  /** True when a pedal keeps this pitch ringing after its key lifts. */
  holds(midi) {
    return this.down.damper || this.held.has(midi);
  }

  /** The velocity multiplier of the soft pedal. */
  velocityScale() {
    return this.down.soft ? SOFT_SCALE : 1;
  }

  /** The names of the pedals that are down, in reading order. */
  active() {
    return PEDAL_ORDER.filter((name) => this.down[name]);
  }

  /**
   * Lift every pedal, as a player does at the end of a piece. The caller then
   * releases the tones it held, and the sampler adds its own tail.
   */
  liftAll() {
    for (const name of PEDAL_ORDER) this.down[name] = false;
    this.held.clear();
    this.next = this.events.length;
  }
}

/**
 * Where a pedal span sits on the depth lane at music time `t`, in scene units.
 * The near edge rides toward the keys at the speed of the note bars, and the
 * far edge trails behind it. Returns null when the span is off the lane.
 */
export function spanOnLane(span, t, { pps, endZ, runway }) {
  const [start, end] = span;
  if (start > t + runway / pps) return null;
  const near = Math.min(endZ - (start - t) * pps, endZ);
  const far = Math.max(endZ - (end - t) * pps, endZ - runway);
  const length = near - far;
  if (length <= 0.02) return null;
  return { near, far, length };
}