import * as Tone from 'tone';
import * as MidiNS from '@tonejs/midi';
import { assignFingering, markMelody } from './fingering.js';
import { noteName, MIDI_MIN, MIDI_MAX } from './layout.js';

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
    this.active = new Map(); // midi -> releaseTime
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
        raw.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti });
      }
    });
    raw.sort((a, b) => a.time - b.time || a.midi - b.midi);
    const assigned = markMelody(assignFingering(raw));
    this.notes = assigned;
    this.duration = Math.max(midi.duration, ...assigned.map((n) => n.time + n.duration), 1);
    this.title = title;
    this.bars.load(assigned);
    this.hands.load(assigned);
    this.seek(0);
    this._emit();
    return { notes: assigned.length, duration: this.duration, title };
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
          this._releaseAll();
          this._emit();
          if (this.onEnd) this.onEnd();
        }
      }
      this._trigger(prev, this.time);
    }
    // Release keys whose note has ended.
    for (const [midi, rel] of this.active) {
      if (this.time >= rel) { this.piano.release(midi); this.active.delete(midi); }
    }
    this.bars.update(this.time);
    this.hands.update(this.time, dt);
  }

  _trigger(from, to) {
    while (this.pointer < this.notes.length && this.notes[this.pointer].time <= to) {
      const n = this.notes[this.pointer++];
      if (n.time < from - 0.02) continue;
      const name = noteName(n.midi);
      const dur = Math.max(0.08, n.duration / this.speed);
      if (this.ready) this.sampler.triggerAttackRelease(name, dur, Tone.now(), 0.3 + n.velocity * 0.7);
      this.piano.press(n.midi, HAND_COLOR[n.hand], n.velocity);
      this.active.set(n.midi, n.time + n.duration);
    }
  }

  _releaseAll() {
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