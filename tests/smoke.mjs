// Smoke test: parse every bundled MIDI, run hand split + fingering, assert sanity.
// Run: npm test
import fs from 'node:fs';
import path from 'node:path';
import MidiPkg from '@tonejs/midi';
const { Midi } = MidiPkg;
import { assignFingering, markMelody, CHORD_WINDOW } from '../src/fingering.js';
import { keyX, isBlack, noteName, midiFromName, MIDI_MIN, MIDI_MAX, WHITE_COUNT } from '../src/layout.js';

const dir = path.resolve('public/midi');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mid'));
let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL:', msg); };

// Layout checks.
let whites = 0;
for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
  const x = keyX(m);
  if (!Number.isFinite(x)) fail(`keyX(${m}) not finite`);
  if (!isBlack(m)) whites++;
}
if (whites !== WHITE_COUNT) fail(`white key count ${whites} != ${WHITE_COUNT}`);
if (noteName(60) !== 'C4') fail('noteName(60) != C4');
if (midiFromName('A0') !== 21) fail('midiFromName(A0) != 21');
if (midiFromName('C8') !== 108) fail('midiFromName(C8) != 108');
console.log(`layout: ${whites} white keys, 88 total — OK`);

for (const f of files) {
  const midi = new Midi(fs.readFileSync(path.join(dir, f)));
  const notes = [];
  midi.tracks.forEach((t, ti) => {
    if (t.channel === 9) return; // skip drum channel
    for (const n of t.notes) {
      if (n.midi < MIDI_MIN || n.midi > MIDI_MAX) continue;
      notes.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti });
    }
  });
  if (!notes.length) { fail(`${f}: no playable notes`); continue; }
  const assigned = markMelody(assignFingering(notes));
  let lh = 0, rh = 0, badFinger = 0, badWrist = 0, bigSpan = 0;
  for (const n of assigned) {
    if (n.hand === 'L') lh++; else rh++;
    if (!(n.finger >= 1 && n.finger <= 5)) badFinger++;
    if (!Number.isFinite(n.wristX)) badWrist++;
  }
  // Chord span check per hand.
  const byHand = { L: [], R: [] };
  for (const n of assigned) byHand[n.hand].push(n);
  for (const hand of ['L', 'R']) {
    const ns = byHand[hand].sort((a, b) => a.time - b.time);
    let i = 0;
    while (i < ns.length) {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1].time - ns[i].time <= CHORD_WINDOW) j++;
      const span = ns[j].midi - ns[i].midi;
      if (span > 19) bigSpan++;
      i = j + 1;
    }
  }
  if (badFinger) fail(`${f}: ${badFinger} invalid fingers`);
  if (badWrist) fail(`${f}: ${badWrist} non-finite wristX`);
  if (bigSpan) fail(`${f}: ${bigSpan} chords span > 19 semitones`);
  const melody = assigned.filter((n) => n.melody).length;
  console.log(
    `${f.padEnd(26)} notes=${String(notes.length).padStart(5)} ` +
    `L=${String(lh).padStart(4)} R=${String(rh).padStart(4)} ` +
    `melody=${String(melody).padStart(4)} dur=${midi.duration.toFixed(1)}s` +
    (badFinger || badWrist || bigSpan ? '  [FAIL]' : '  OK')
  );
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE TESTS PASSED');
process.exit(failures ? 1 : 0);