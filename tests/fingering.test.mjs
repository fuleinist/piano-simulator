// Hand split tests. Run: node --test tests/fingering.test.mjs
//
// The rule under test comes from how a score divides the hands: the lower staff
// is the left hand and the upper staff is the right hand, whatever the pitch and
// whatever the clef. A MIDI track stands in for a staff, so a track that names
// its hand must keep all of its notes, and only a file with no staff evidence
// may fall back to the register at middle C.
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitHands, assignFingering } from '../src/fingering.js';

const note = (over) => ({ midi: 60, time: 0, duration: 0.5, velocity: 0.6, track: 0, ...over });

const hands = (notes) => notes.map((n) => n.hand);
const at = (out, midi) => out.filter((n) => n.midi === midi).map((n) => n.hand);

test('a named left-hand track keeps a chord above middle C on the left', () => {
  // Moonlight-style accompaniment: the lower staff climbs over middle C.
  const out = splitHands([
    note({ midi: 60, track: 1, trackName: 'Piano left' }),
    note({ midi: 64, track: 1, trackName: 'Piano left' }),
    note({ midi: 67, track: 1, trackName: 'Piano left' }),
  ]);
  assert.deepEqual(hands(out), ['L', 'L', 'L']);
});

test('a named right-hand track keeps a low note on the right', () => {
  const out = splitHands([note({ midi: 45, track: 0, trackName: 'Piano right' })]);
  assert.deepEqual(hands(out), ['R']);
});

test('a left-hand octave stays whole when the right hand sounds with it', () => {
  // The opening bar of the Moonlight: C#2 and C#3 are one left-hand octave,
  // and the right hand enters on G#3 at the same moment. A split at the widest
  // gap would hand C#3 to the right hand and break the octave.
  const out = splitHands([
    note({ midi: 37, track: 1, trackName: 'Piano left' }),
    note({ midi: 49, track: 1, trackName: 'Piano left' }),
    note({ midi: 56, track: 0, trackName: 'Piano right' }),
  ]);
  assert.deepEqual(at(out, 37), ['L']);
  assert.deepEqual(at(out, 49), ['L'], 'the octave keeps both notes');
  assert.deepEqual(at(out, 56), ['R']);
});

test('each staff keeps its own notes when both hands sound together', () => {
  const out = splitHands([
    note({ midi: 43, track: 1, trackName: 'Accompaniment left' }),
    note({ midi: 67, track: 0, trackName: 'Piano right' }),
    note({ midi: 72, track: 0, trackName: 'Piano right' }),
  ]);
  assert.deepEqual(at(out, 43), ['L']);
  assert.deepEqual(at(out, 67), ['R']);
  assert.deepEqual(at(out, 72), ['R']);
});

test('a lone bass note in an unnamed track goes to the left hand', () => {
  // A single-track file carries both hands, so the register decides. A bass
  // note under C3 must not follow the track average up into the right hand.
  const out = splitHands([
    note({ midi: 35, time: 1 }),
    note({ midi: 72, time: 2 }),
  ]);
  assert.deepEqual(at(out, 35), ['L']);
  assert.deepEqual(at(out, 72), ['R']);
});

test('an octave across middle C stays on one hand', () => {
  const out = splitHands([note({ midi: 48 }), note({ midi: 60 })]);
  assert.deepEqual(hands(out), ['L', 'L']);
});

test('middle C alone goes to the right hand', () => {
  const out = splitHands([note({ midi: 60 })]);
  assert.deepEqual(hands(out), ['R']);
});

test('a chord wider than one hand divides where both hands can reach', () => {
  // Six notes over two octaves: no single hand reaches this, and a reachable
  // division exists, so the split must find it.
  const midis = [41, 48, 55, 72, 79, 84];
  const out = splitHands(midis.map((midi) => note({ midi })));
  const left = out.filter((n) => n.hand === 'L').map((n) => n.midi);
  const right = out.filter((n) => n.hand === 'R').map((n) => n.midi);
  assert.ok(left.length && right.length, 'both hands play');
  assert.ok(Math.max(...left) < Math.min(...right), 'the left hand takes the lower notes');
  assert.ok(Math.max(...left) - Math.min(...left) <= 15, 'the left hand spans no more than a tenth');
  assert.ok(Math.max(...right) - Math.min(...right) <= 15, 'the right hand spans no more than a tenth');
});

test('every note leaves the split with a hand', () => {
  const notes = [];
  for (let i = 0; i < 40; i++) {
    notes.push(note({ midi: 40 + i, time: i * 0.05, track: i % 2, trackName: i % 2 ? 'Piano left' : 'Piano right' }));
  }
  for (const n of splitHands(notes)) assert.ok(n.hand === 'L' || n.hand === 'R');
});

test('a track name that names no hand leaves the register in charge', () => {
  const out = splitHands([
    note({ midi: 40, track: 0, trackName: 'Elec. Piano (Classic)' }),
    note({ midi: 80, track: 0, trackName: 'Elec. Piano (Classic)' }),
  ]);
  assert.deepEqual(at(out, 40), ['L']);
  assert.deepEqual(at(out, 80), ['R']);
});

// --- A file that names no hand, but keeps one part per track ------------
// A file can leave every track unnamed and still say where the hands are: if a
// track never sounds two notes beyond one hand's reach at the same instant, it
// is one hand's part, and its register names that hand. Comptine d'un autre été
// and the Yiruma files are written this way, and before the register stood in
// their low notes crossed to the right hand whenever a melody note sounded with
// them.

test('a bass track keeps its notes when a melody track sounds over it', () => {
  // Two notes at one instant from two tracks are two voices, not one chord. The
  // chord average landed on the melody note and gave the bass note away.
  const out = splitHands([
    note({ midi: 59, track: 0, trackName: 'piano1' }),
    note({ midi: 67, track: 2, trackName: 'piano3' }),
  ]);
  assert.deepEqual(at(out, 59), ['L']);
  assert.deepEqual(at(out, 67), ['R']);
});

test('an accompaniment that climbs over middle C stays on the left', () => {
  // Kiss the Rain: the left hand arpeggio reaches above middle C and sounds at
  // the same instant as the melody. Judged note by note it reads as the right
  // hand with the tune; judged as the track it plays in, it is the left hand.
  const notes = [];
  ['48', '55', '62', '70'].forEach((midi, i) => {
    notes.push(note({ midi: Number(midi), time: i * 0.25, track: 1, trackName: 'Track 2' }));
  });
  ['76', '81', '84', '88'].forEach((midi, i) => {
    notes.push(note({ midi: Number(midi), time: i * 0.25, track: 0, trackName: 'Piano' }));
  });
  const out = splitHands(notes);
  assert.deepEqual(at(out, 70), ['L']);
  assert.deepEqual(out.filter((n) => n.track === 1).map((n) => n.hand),
    ['L', 'L', 'L', 'L'], 'the whole accompaniment stays on one hand');
});

test('a track that sounds both hands at once names no hand', () => {
  // A whole piano part on one track, beside a second track that is clearly one
  // hand. The part sounds a bass note under the melody at the same instant,
  // which no hand can do. Its median is high, so if the reach check did not
  // refuse it the two-hands-in-one-track file would all go to the right hand.
  const out = splitHands([
    note({ midi: 48, time: 0 }), note({ midi: 84, time: 0 }),
    note({ midi: 88, time: 1 }), note({ midi: 90, time: 1 }),
    note({ midi: 40, time: 3, track: 1, trackName: 'Bass' }),
  ]);
  assert.deepEqual(at(out, 48), ['L']);
  assert.deepEqual(at(out, 84), ['R']);
});

test('a file with one track leaves the register in charge', () => {
  // Nothing divides here, so no track can name a staff: a lone bass note and a
  // melody note on the one track still go to the hands their pitch names.
  const out = splitHands([note({ midi: 35, time: 1 }), note({ midi: 72, time: 2 })]);
  assert.deepEqual(at(out, 35), ['L']);
  assert.deepEqual(at(out, 72), ['R']);
});

test('a named hand outranks the register of its track', () => {
  // Direct evidence wins: this track sits below middle C and is still right hand.
  const out = splitHands([
    note({ midi: 45, track: 0, trackName: 'Piano right' }),
    note({ midi: 47, track: 0, trackName: 'Piano right' }),
  ]);
  assert.deepEqual(hands(out), ['R', 'R']);
});

test('a doubled bass line does not move the track that carries it', () => {
  // Comptine writes one ostinato across two tracks. Merging the doubled notes
  // before the split stripped one track of every low note it had, moved its
  // register above middle C, and handed the accompaniment to the right hand.
  const notes = [];
  for (let i = 0; i < 8; i++) {
    notes.push(note({ midi: 50, time: i * 0.5, track: 0, trackName: 'piano1' }));
    notes.push(note({ midi: 50, time: i * 0.5, track: 1, trackName: 'piano2' }));
    notes.push(note({ midi: 62, time: i * 0.5, track: 1, trackName: 'piano2' }));
    notes.push(note({ midi: 74 + (i % 2) * 2, time: i * 0.5, track: 2, trackName: 'piano3' }));
  }
  const out = assignFingering(notes);
  const right = out.filter((n) => n.hand === 'R');
  assert.ok(right.length, 'the melody still plays');
  assert.ok(right.every((n) => n.track === 2), 'only the melody track reaches the right hand');
});