// Feasibility probe: for every chord the app misses by more than 5 mm, try
// EVERY finger set and keep the best contact residual. If some set lands, the
// miss is a fingering bug. If none lands, the rig itself is too small.
import fs from 'node:fs';
import path from 'node:path';
import * as MidiNS from '@tonejs/midi';
import { assignFingering } from '../src/fingering.js';
import { keyTopY } from '../src/layout.js';
import {
  buildRig, solveContact, chooseFingers, REST_CURLS, STRIKE_CURLS,
} from '../src/handrig.js';

const Midi = MidiNS.Midi || (MidiNS.default && MidiNS.default.Midi) || MidiNS.default;
const ROOT = path.resolve(import.meta.dirname, '..');
const load = (side) => buildRig(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests/fixtures', `hand-${side}.json`), 'utf8')));
const rigs = { L: load('left'), R: load('right') };

function chordsOf(notes, hand) {
  const ns = notes.filter((n) => n.hand === hand).sort((a, b) => a.time - b.time);
  const out = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1].time - ns[i].time <= 0.05) j++;
    const g = ns.slice(i, j + 1);
    const fingers = {};
    for (const n of g) fingers[n.finger] = n;
    out.push({ time: g[0].time, fingers, keyTop: Math.max(...g.map((n) => keyTopY(n.midi))) });
    i = j + 1;
  }
  return out;
}

function sets(n, hand) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === n) { out.push(hand === 'R' ? [...cur] : [...cur].reverse()); return; }
    for (let i = start; i < 5; i++) { cur.push(i + 1); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

const residual = (rig, midis, fingers) => solveContact(rig, midis.map((m, i) => ({
  finger: fingers[i], midi: m,
  curls: REST_CURLS[fingers[i]].map((v, k) => v + STRIKE_CURLS[fingers[i]][k]),
}))).maxResidual;

const files = process.argv.slice(2);
const hardChords = [];

for (const file of files) {
  const midi = new Midi(fs.readFileSync(path.join(ROOT, 'public/midi', file)));
  const raw = [];
  midi.tracks.forEach((track, ti) => {
    if (track.channel === 9) return;
    for (const n of track.notes) {
      if (n.midi < 21 || n.midi > 108) continue;
      raw.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti });
    }
  });
  raw.sort((a, b) => a.time - b.time || a.midi - b.midi);
  const notes = assignFingering(raw);
  for (const hand of ['L', 'R']) {
    const rig = rigs[hand];
    for (const c of chordsOf(notes, hand)) {
      const ordered = Object.values(c.fingers).sort((a, b) => a.midi - b.midi);
      const midis = ordered.map((n) => n.midi);
      const chosen = chooseFingers(rig, midis, hand, ordered.map((n) => n.finger));
      const now = residual(rig, midis, chosen);
      if (now <= 5) continue;
      hardChords.push({ file, hand, rig, midis, now });
    }
  }
}

// Even sample across every piece, not the first N in file order.
const hard = hardChords.length;
const CAP = 400;
const stride = Math.max(1, hard / CAP);
const sample = [];
for (let i = 0; i < hard && sample.length < CAP; i += stride) sample.push(hardChords[Math.floor(i)]);

let fixedByFingering = 0, stillHard = 0;
const improvements = [];
for (const s of sample) {
  let best = s.now;
  for (const f of sets(s.midis.length, s.hand)) best = Math.min(best, residual(s.rig, s.midis, f));
  improvements.push({ file: s.file, hand: s.hand, n: s.midis.length, now: +s.now.toFixed(2), best: +best.toFixed(2) });
  if (best <= 5) fixedByFingering++; else stillHard++;
}
const sampled = sample.length;

console.log(`chords the app misses by > 5 mm: ${hard}`);
console.log(`even sample across all ${files.length} pieces: ${sampled}`);
console.log(`  some finger set lands within 5 mm: ${fixedByFingering} (${(100 * fixedByFingering / sampled).toFixed(1)}%)`);
console.log(`  no finger set lands within 5 mm:   ${stillHard} (${(100 * stillHard / sampled).toFixed(1)}%)`);
const bySize = {};
for (const r of improvements) {
  const k = r.n;
  bySize[k] = bySize[k] || { n: 0, fixed: 0 };
  bySize[k].n++;
  if (r.best <= 5) bySize[k].fixed++;
}
console.log('  by chord size:', Object.entries(bySize).map(([k, v]) => `${k} notes: ${v.fixed}/${v.n} fixable`).join(', '));
const byFile = {};
for (const r of improvements) {
  byFile[r.file] = byFile[r.file] || { n: 0, fixed: 0 };
  byFile[r.file].n++;
  if (r.best <= 5) byFile[r.file].fixed++;
}
console.log('  by piece:', Object.entries(byFile).map(([k, v]) => `${k} ${v.fixed}/${v.n}`).join(', '));
const sorted = improvements.slice().sort((a, b) => (b.now - b.best) - (a.now - a.best));
console.log('  largest gains from a better finger set:');
for (const r of sorted.slice(0, 5)) console.log(`    ${r.file} ${r.hand} ${r.n} notes: ${r.now} mm -> ${r.best} mm`);
const projected = hard * stillHard / sampled;
console.log(`projected misses after an exhaustive contact-aware choice: ${projected.toFixed(0)} of 15189 (${(100 * projected / 15189).toFixed(1)}%)`);
console.log(`so fingering work alone cannot take the miss rate below about ${(100 * projected / 15189).toFixed(1)}%`);
