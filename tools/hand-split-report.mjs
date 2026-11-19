// Diagnostic: compare the automatic hand split with the staff structure that a
// printable score would use. Read-only, prints a block per file.
//
//   node tools/hand-split-report.mjs [file.mid ...]
//
// Checks:
//   - staff purity: how many of a track's notes change hand
//   - register: notes below C3 played by the right hand
//   - crossing: a left wrist right of the right wrist, or a left note above a
//     right note at the same onset
//   - churn: hand switches inside one track, which a single line does not do
import fs from 'node:fs';
import path from 'node:path';
import MidiPkg from '@tonejs/midi';
const { Midi } = MidiPkg;
import { assignFingering, CHORD_WINDOW } from '../src/fingering.js';
import { noteName } from '../src/layout.js';

const dir = path.resolve('public/midi');
const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.mid'));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

let lowTotal = 0, crossTotal = 0;
for (const f of files) {
  const midi = new Midi(fs.readFileSync(path.join(dir, path.basename(f))));
  const raw = [];
  const trackInfo = [];
  midi.tracks.forEach((t, ti) => {
    if (t.channel === 9) return;
    const ns = t.notes.filter((n) => n.midi >= 21 && n.midi <= 108);
    if (!ns.length) return;
    trackInfo.push({ ti, name: t.name || '(unnamed)', count: ns.length, med: median(ns.map((n) => n.midi)) });
    for (const n of ns) {
      raw.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti, trackName: t.name });
    }
  });
  const assigned = assignFingering(raw);

  const rows = trackInfo.map((t) => {
    const ns = assigned.filter((n) => n.track === t.ti);
    const l = ns.filter((n) => n.hand === 'L').length;
    const switches = ns.reduce((c, n, i) => c + (i && n.hand !== ns[i - 1].hand ? 1 : 0), 0);
    return { ...t, l, r: ns.length - l, mixed: Math.min(l, ns.length - l) / ns.length, switches };
  });

  const lowOnRight = assigned.filter((n) => n.midi < 48 && n.hand === 'R').length;
  const byTime = new Map();
  for (const n of assigned) {
    const k = Math.round(n.time / CHORD_WINDOW);
    if (!byTime.has(k)) byTime.set(k, { L: [], R: [] });
    byTime.get(k)[n.hand].push(n);
  }
  let cross = 0, both = 0;
  for (const g of byTime.values()) {
    if (!g.L.length || !g.R.length) continue;
    both++;
    const lhAbove = Math.max(...g.L.map((n) => n.midi)) > Math.min(...g.R.map((n) => n.midi));
    if (g.L[0].wristX > g.R[0].wristX || lhAbove) cross++;
  }
  lowTotal += lowOnRight;
  crossTotal += cross;

  console.log(`\n=== ${f}  tracks=${trackInfo.length} notes=${assigned.length}`);
  for (const t of rows) {
    console.log(`  tr${t.ti} ${String(t.name).slice(0, 22).padEnd(22)} n=${String(t.count).padStart(4)} med=${noteName(t.med).padEnd(4)} L${String(t.l).padStart(4)} R${String(t.r).padStart(4)} mixed=${(t.mixed * 100).toFixed(1)}% switches=${t.switches}`);
  }
  console.log(`  both hands at one onset: ${both}; crossed: ${cross}; below C3 on the right: ${lowOnRight}`);
}
console.log(`\ncorpus: ${lowTotal} notes below C3 on the right hand, ${crossTotal} crossed onsets`);