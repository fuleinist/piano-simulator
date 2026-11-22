// The note schedule. Pure module: no Tone.js and no browser globals, so a Node
// test can pump it with a sink that records the events.
//
// The player cannot hand a note to the sampler at the moment a frame reaches
// it, because a hidden tab draws no frames and the piece would fall silent.
// Instead this module walks the piece in music time and fires every attack and
// release with the music time it belongs to. The caller turns that time into an
// audio clock time and lets the browser play it, so the rhythm holds whatever
// the frame loop does.

import { PedalState } from './pedals.js';

// A pitch struck twice at one instant is one strike, and the window keeps a
// repeated attack from cutting the tone before it.
const SAME = 1e-6;

export class NoteSchedule {
  /** @param {Array} notes notes in time order, @param {Array} events pedal events */
  constructor(notes = [], events = []) {
    this.notes = notes;
    this.events = events;
    this.reset(0);
  }

  /** Put the schedule at a music time, as a load or a seek does. */
  reset(time = 0) {
    this.cursor = time;
    this.pointer = lowerBound(this.notes, time);
    this.voices = new Map(); // midi -> the music time this tone ends
    this.pedals = new PedalState(this.events);
    this.pedals.reset(time, []);
  }

  /** The number of tones the schedule still holds. */
  get sounding() {
    return this.voices.size;
  }

  /**
   * Fire the events between the cursor and `until`, in time order. The sink
   * takes a pitch and the music time of the event, and the caller places that
   * time on the audio clock.
   */
  pump(until, sink) {
    if (!(until > this.cursor)) return;
    for (;;) {
      const at = this._next(until);
      if (at === null) break;
      this._step(at, sink);
      this.cursor = at;
    }
    this.cursor = until;
  }

  /**
   * Release every tone the schedule still holds. A piece whose last pedal press
   * never lifts leaves its final chord ringing, so the caller drains the
   * schedule when the piece ends.
   */
  drain(time, sink) {
    for (const midi of this.voices.keys()) sink.release(midi, Math.max(time, this.cursor));
    this.voices.clear();
  }

  /**
   * The music time of the next event at or before `until`: a note, a pedal
   * change, or the end of a tone that no pedal holds. A held tone ends at the
   * pedal change that lifts it, which is an event of its own.
   */
  _next(until) {
    let at = Infinity;
    const pedal = this.pedals.events[this.pedals.next];
    if (pedal && pedal.time <= until) at = Math.min(at, pedal.time);
    const note = this.notes[this.pointer];
    if (note && note.time <= until) at = Math.min(at, note.time);
    for (const [midi, end] of this.voices) {
      if (end > until || this.pedals.holds(midi)) continue;
      at = Math.min(at, end);
    }
    if (!Number.isFinite(at)) return null;
    return at > this.cursor ? at : this.cursor;
  }

  _step(at, sink) {
    // The pedals move before the notes that share the instant: the soft pedal
    // must reach a tone that starts with it, and the sostenuto must see the
    // tones that still sound.
    this.pedals.advance(at, this.voices.keys());
    for (const [midi, end] of [...this.voices]) {
      if (end > at || this.pedals.holds(midi)) continue;
      sink.release(midi, at);
      this.voices.delete(midi);
    }
    while (this.pointer < this.notes.length && this.notes[this.pointer].time <= at + SAME) {
      const note = this.notes[this.pointer++];
      const velocity = Math.min(1, (0.3 + note.velocity * 0.7) * this.pedals.velocityScale());
      // A repeated strike on one key stops the tone before it at the same time.
      if (this.voices.has(note.midi)) sink.release(note.midi, at);
      sink.attack(note.midi, at, velocity);
      this.voices.set(note.midi, note.time + note.duration);
    }
  }
}

function lowerBound(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}