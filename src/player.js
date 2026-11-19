import * as Tone from 'tone';
import * as MidiNS from '@tonejs/midi';
import { assignFingering, markMelody } from './fingering.js';
import { noteName, MIDI_MIN, MIDI_MAX } from './layout.js';
import { collectPedals, pedalSpans, PedalState, PEDAL_ORDER } from './pedals.js';

const Midi = MidiNS.Midi || (MidiNS.default && MidiNS.default.Midi) || MidiNS.default;

const SAMPLE_NOTES = [
  'A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3',
  'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6',
  'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8',
];

export const HAND_COLOR = { L: 0x2f9dff, R: 0xffab2e };

export class Player {
  constructor(piano, bars, hands) {
    this.piano = piano;
    this.bars = bars;
    this.hands = hands;
    this.notes = [];
    this.duration = 0;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.loop = false;
    this.pointer = 0;
    this.active = new Map(); // midi -> releaseTime of the key
    // midi -> releaseTime of the tone. The damper pedal keeps a tone alive
    // after its key lifts, so the two maps differ while the pedal is down.
    this.voices = new Map();
    this.pedalSpans = { damper: [], sostenuto: [], soft: [] };
    this.pedalState = new PedalState();
    this.ready = false;
    this.onState = null;
    // Fired once when the piece reaches its end. A new load or a seek does not
    // fire it; pressing play again from the end does not either, because the
    // transport restarts from zero.
    this.onEnd = null;
    this._buildAudio();
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
    this.title = title;
    this.bars.load(assigned, this.pedalSpans);
    this.hands.load(assigned);
    this.seek(0);
    this._emit();
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
    this._emit();
  }
  pause() { this.playing = false; this._releaseAll(); this._emit(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    this.time = THREE_clamp(t, 0, this.duration);
    this.pointer = lowerBound(this.notes, this.time);
    this._releaseAll();
    this.hands.seek(this.time);
    this._emit();
  }

  setSpeed(s) { this.speed = s; }

  update(dt) {
    if (this.playing) {
      const prev = this.time;
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        if (this.loop) { this.seek(0); }
        else {
          this.time = this.duration;
          this.playing = false;
          // A player lifts the pedal at the end. The tones then release on
          // their own tail instead of ringing until the next seek.
          this.pedalState.liftAll();
          this._releaseKeys();
          this._emit();
          if (this.onEnd) this.onEnd();
        }
      }
      // Apply this step's pedal events before the notes start. The soft pedal
      // must reach a tone that starts in the same step, and the sostenuto
      // pedal must see the tones that already sound.
      this.pedalState.advance(this.time, this.voices.keys());
      this._trigger(prev, this.time);
    }
    // Release keys whose note has ended. The key lifts at the note end even
    // when a pedal keeps the tone alive, because a damper pedal does not hold
    // the key down.
    for (const [midi, rel] of this.active) {
      if (this.time >= rel) { this.piano.release(midi); this.active.delete(midi); }
    }
    this._releaseDue();
    this.bars.update(this.time);
    this.hands.update(this.time, dt);
  }

  // Release the tones whose note has ended and that no pedal holds.
  _releaseDue() {
    for (const [midi, rel] of this.voices) {
      if (this.time < rel) continue;
      if (this.pedalState.holds(midi)) continue;
      this._releaseVoice(midi);
    }
  }

  _releaseVoice(midi) {
    if (this.ready) this.sampler.triggerRelease(noteName(midi), Tone.now());
    this.voices.delete(midi);
  }

  _releaseKeys() {
    for (const midi of this.active.keys()) this.piano.release(midi);
    this.active.clear();
  }

  _trigger(from, to) {
    while (this.pointer < this.notes.length && this.notes[this.pointer].time <= to) {
      const n = this.notes[this.pointer++];
      if (n.time < from - 0.02) continue;
      const name = noteName(n.midi);
      const velocity = Math.min(1, (0.3 + n.velocity * 0.7) * this.pedalState.velocityScale());
      // Hold the tone with an attack and release it at its own end, or later
      // when a pedal holds it. A fixed duration would cut a sustained tone.
      if (this.ready) this.sampler.triggerAttack(name, Tone.now(), velocity);
      this.piano.press(n.midi, HAND_COLOR[n.hand], n.velocity);
      this.active.set(n.midi, n.time + n.duration);
      this.voices.set(n.midi, n.time + n.duration);
    }
  }

  _releaseAll() {
    this._releaseKeys();
    for (const midi of [...this.voices.keys()]) this._releaseVoice(midi);
    this.pedalState.reset(this.time);
  }

  _emit() { if (this.onState) this.onState(this); }
}

function THREE_clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function lowerBound(notes, t) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid].time < t) lo = mid + 1; else hi = mid; }
  return lo;
}