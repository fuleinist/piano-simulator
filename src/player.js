import * as Tone from 'tone';
import * as MidiNS from '@tonejs/midi';
import { assignFingering, markMelody } from './fingering.js';
import { noteName, MIDI_MIN, MIDI_MAX } from './layout.js';
import { collectPedals, pedalSpans, PedalState, PEDAL_ORDER } from './pedals.js';
import { barTimes } from './score.js';
import { MusicClock } from './clock.js';
import { NoteSchedule } from './schedule.js';

const Midi = MidiNS.Midi || (MidiNS.default && MidiNS.default.Midi) || MidiNS.default;

const SAMPLE_NOTES = [
  'A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3',
  'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6',
  'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8',
];

export const HAND_COLOR = { L: 0x2f9dff, R: 0xffab2e };

/**
 * How far ahead of the audio clock the player places its notes, in music
 * seconds. A hidden tab throttles the page timers to one tick a second, so the
 * margin must span more than that: with two seconds in hand the music never
 * runs out of notes before the next pump.
 */
export const LOOKAHEAD_S = 2;

export class Player {
  constructor(piano, bars, hands) {
    this.piano = piano;
    this.bars = bars;
    this.hands = hands;
    this.notes = [];
    this.duration = 0;
    this.speed = 1;
    this.playing = false;
    this.loop = false;
    // The audio clock owns the time of the piece. A frame that arrives late, or
    // not at all, cannot slow it: the next reading takes the elapsed time from
    // the clock that the browser runs for the sound.
    this.clock = new MusicClock({ now: () => Tone.getContext().currentTime });
    this.schedule = new NoteSchedule();
    this.sink = {
      attack: (midi, time, velocity) => this._attack(midi, time, velocity),
      release: (midi, time) => this._release(midi, time),
    };
    this.active = new Map(); // midi -> releaseTime of the key, for the view
    this.pedalSpans = { damper: [], sostenuto: [], soft: [] };
    this.pedalState = new PedalState();
    this.ready = false;
    this.onState = null;
    // Fired once when the piece reaches its end. A new load or a seek does not
    // fire it; pressing play again from the end does not either, because the
    // transport restarts from zero.
    this.onEnd = null;
    // Fired once after a piece is ready, so a view can take the notes.
    this.onLoad = null;
    this._seen = 0; // music time of the last frame
    this._key = 0; // notes the frame loop has pressed
    this._buildAudio();
  }

  /** Music seconds. The audio clock owns the value, so the frame rate cannot change it. */
  get time() {
    return this.clock.read();
  }

  _buildAudio() {
    const urls = {};
    for (const n of SAMPLE_NOTES) urls[n.replace('s', '#')] = `${n}.mp3`;
    this.gain = new Tone.Gain(0.9).toDestination();
    this.verb = new Tone.Freeverb({ roomSize: 0.62, dampening: 3200, wet: 0.16 }).connect(this.gain);
    this.sampler = new Tone.Sampler({
      urls, baseUrl: '/samples/piano/', release: 1.4, volume: -4,
      onload: () => { this.ready = true; this._emit(); },
    }).connect(this.verb);
  }

  async loadBuffer(buffer, title = 'Custom MIDI') {
    const midi = new Midi(buffer);
    const raw = [];
    midi.tracks.forEach((track, ti) => {
      if (track.channel === 9) return; // skip percussion
      for (const n of track.notes) {
        if (n.midi < MIDI_MIN || n.midi > MIDI_MAX) continue;
        raw.push({
          midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity,
          track: ti, trackName: track.name,
        });
      }
    });
    raw.sort((a, b) => a.time - b.time || a.midi - b.midi);
    const assigned = markMelody(assignFingering(raw));
    this.notes = assigned;
    this.duration = Math.max(midi.duration, ...assigned.map((n) => n.time + n.duration), 1);
    const events = collectPedals(midi.tracks);
    this.pedalSpans = pedalSpans(events, this.duration);
    this.pedalState = new PedalState(events);
    this.pedalsUsed = PEDAL_ORDER.filter((name) => this.pedalSpans[name].length);
    // Bar lines come from the file's own time signatures and tempo map, so the
    // sheet marks the bars that the score marks.
    this.barlines = barTimes(midi.header, { duration: this.duration });
    // The sheet needs the tempo and the time signatures to name a note value
    // and to place a rest, so the file header travels with the notes.
    this.scoreMeta = {
      ppq: midi.header.ppq || 480,
      tempos: midi.header.tempos || [],
      timeSignatures: midi.header.timeSignatures || [],
    };
    this.title = title;
    this.schedule = new NoteSchedule(assigned, events);
    this.bars.load(assigned, this.pedalSpans);
    this.hands.load(assigned);
    this.seek(0);
    this._emit();
    if (this.onLoad) this.onLoad(this);
    return { notes: assigned.length, duration: this.duration, title, pedals: this.pedalsUsed };
  }

  async loadFile(file) {
    return this.loadBuffer(await file.arrayBuffer(), file.name.replace(/\.midi?$/i, ''));
  }

  async loadSong(song) {
    const res = await fetch(`/midi/${song.file}`);
    if (!res.ok) throw new Error(`Cannot load ${song.file}`);
    return this.loadBuffer(await res.arrayBuffer(), `${song.title} — ${song.composer}`);
  }

  play() {
    if (!this.notes.length) return;
    if (this.time >= this.duration - 0.05) this.seek(0);
    Tone.start();
    this.playing = true;
    this.clock.play();
    this._emit();
    this.pump();
  }

  pause() {
    this.clock.pause();
    this.playing = false;
    this._releaseKeys();
    this._stopTones();
    this.schedule.reset(this.time);
    this._emit();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.clock.seek(THREE_clamp(t, 0, this.duration));
    this.schedule.reset(this.time);
    this._stopTones();
    this._releaseKeys();
    this._seen = this.time;
    this._key = lowerBound(this.notes, this.time);
    this.pedalState.reset(this.time);
    this.hands.seek(this.time);
    this._emit();
  }

  setSpeed(s) {
    const time = this.time;
    this.clock.setSpeed(s);
    // The notes already placed on the audio clock keep the old speed, so they
    // would sound at the wrong moment. Drop them and place the rest again.
    if (this.playing) {
      this.schedule.reset(time);
      this._stopTones();
      this.pump();
    }
  }

  update(dt) {
    if (this.playing) {
      if (this.time >= this.duration) {
        if (this.loop) this.seek(0);
        else this._finish();
      } else {
        this._pressKeys(this._seen, this.time);
      }
    }
    const time = this.time;
    this.pedalState.advance(time, this.active.keys());
    // Release the keys whose note has ended. The key lifts at the note end even
    // when a pedal keeps the tone alive, because a damper pedal does not hold
    // the key down.
    for (const [midi, rel] of this.active) {
      if (time >= rel) { this.piano.release(midi); this.active.delete(midi); }
    }
    this._seen = time;
    this.bars.update(time);
    this.hands.update(time, dt);
    this.pump();
  }

  /**
   * Place the notes of the next seconds on the audio clock. The frame loop
   * calls this, and so does a page timer: a hidden tab draws no frames, and the
   * music must not wait for one.
   */
  pump() {
    if (!this.playing || !this.notes.length) return;
    const until = Math.min(this.time + LOOKAHEAD_S * this.speed, this.duration);
    this.schedule.pump(until, this.sink);
  }

  /** The music reached its end. A player lifts the pedal and lets the tail ring. */
  _finish() {
    this.clock.seek(this.duration);
    this.clock.pause();
    this.playing = false;
    this.pedalState.liftAll();
    this.schedule.drain(this.duration, this.sink);
    this.schedule.reset(this.duration);
    this._releaseKeys();
    this._emit();
    if (this.onEnd) this.onEnd();
  }

  _attack(midi, time, velocity) {
    if (!this.ready) return;
    this.sampler.triggerAttack(noteName(midi), this.clock.clockFor(time), velocity);
  }

  _release(midi, time) {
    if (!this.ready) return;
    this.sampler.triggerRelease(noteName(midi), this.clock.clockFor(time));
  }

  /** Stop every tone at once, as a pause or a seek does. */
  _stopTones() {
    if (!this.ready) return;
    this.sampler.releaseAll(Tone.getContext().currentTime);
  }

  /** Press the keys that the frame now reaches. The sound is already scheduled. */
  _pressKeys(from, to) {
    while (this._key < this.notes.length && this.notes[this._key].time <= to) {
      const n = this.notes[this._key++];
      if (n.time < from - 0.02) continue;
      this.piano.press(n.midi, HAND_COLOR[n.hand], n.velocity);
      this.active.set(n.midi, n.time + n.duration);
    }
  }

  _releaseKeys() {
    for (const midi of this.active.keys()) this.piano.release(midi);
    this.active.clear();
  }

  _emit() { if (this.onState) this.onState(this); }
}

function THREE_clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid].time < t) lo = mid + 1; else hi = mid; }
  return lo;
}