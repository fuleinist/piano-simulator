// Baseline measurement for the fingering / hand-motion plan.
// Replicates the RiggedHand.load solve loop in pure Node, then scores it.
import fs from 'node:fs';
import path from 'node:path';
import * as MidiNS from '@tonejs/midi';

import { assignFingering } from '../src/fingering.js';
import { keyX, isBlack, keyTopY } from '../src/layout.js';
import { buildRig, solveContact, chooseFingers, reachRange, REST_CURLS, STRIKE_CURLS } from '../src/handrig.js';
import { buildChords } from '../src/chords.js';
import { travelLead } from '../src/motion.js';

const Midi = MidiNS.Midi || (MidiNS.default && MidiNS.default.Midi) || MidiNS.default;
const ROOT = path.resolve(import.meta.dirname, '..');
const load = (side) => buildRig(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests/fixtures', `hand-${side}.json`), 'utf8')));
const rigs = { L: load('left'), R: load('right') };

function solveSong(file) {
  const buf = fs.readFileSync(path.join(ROOT, 'public/midi', file));
  const midi = new Midi(buf);
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

  const out = { file, chords: 0, shifts: [], residuals: [], reachGaps: [],
                abductJumps: [], thumbBlack: 0, preThumb: 0, thumbBlackAlt: 0, fingersUsed: { L: new Set(), R: new Set() },
                scales: [], perPosition: [], heldWhileMoving: 0,
                // Counted AFTER chooseFingers, which is what the app actually renders.
                postThumbBlack: 0, postThumb: 0, postFingers: { L: [0, 0, 0, 0, 0, 0], R: [0, 0, 0, 0, 0, 0] },
                // reachRange tests zero roll. solveContact can pronate, so a reach gap
                // only means "unreachable" when the contact solve also misses.
                unreachable: 0, reachGapButContact: 0,
                // chooseFingers only guards 2..5 notes. A chord with more notes
                // than fingers gets no guard, and two notes share one finger.
                oversize: 0, unreachableOversize: 0, sizes: {} };

  for (const n of notes) {
    if (n.finger !== 1) continue;
    out.preThumb++;
    if (isBlack(n.midi)) out.thumbBlack++;
  }

  for (const hand of ['L', 'R']) {
    const rig = rigs[hand];
    const chords = buildChords(notes, hand);
    out.chords += chords.length;
    let prev = null;
    for (const c of chords) {
      const ordered = Object.values(c.fingers).sort((a, b) => a.midi - b.midi);
      const midis = ordered.map((n) => n.midi);
      const chosen = chooseFingers(rig, midis, hand, ordered.map((n) => n.finger));
      const entries = ordered.map((n, i) => ({
        finger: chosen[i], midi: n.midi,
        curls: REST_CURLS[chosen[i]].map((v, k) => v + STRIKE_CURLS[chosen[i]][k]),
      }));
      for (const e of entries) out.fingersUsed[hand].add(e.finger);
      for (const e of entries) {
        out.postFingers[hand][e.finger]++;
        if (e.finger === 1) { out.postThumb++; if (isBlack(e.midi)) out.postThumbBlack++; }
      }
      const solve = solveContact(rig, entries);
      const base = Math.max(solve.wrist[1], c.keyTop + 1.6);
      const lift = Math.max(0, ...solve.tips.map((tip, i) => keyTopY(entries[i].midi) + 0.02 - tip[1]));
      c.wrist = [solve.wrist[0], base + lift, solve.wrist[2]];
      c.solve = solve;
      c.entries = entries;
      out.residuals.push(solve.maxResidual);
      out.scales.push(entries.length > 1
        ? (Math.max(...midis.map(keyX)) - Math.min(...midis.map(keyX)))
        : 0);
      const r = reachRange(rig, midis, chosen);
      out.sizes[midis.length] = (out.sizes[midis.length] || 0) + 1;
      if (midis.length > 5) out.oversize++;
      if (r.gap > 0) {
        out.reachGaps.push({ hand, time: c.time, gap: r.gap * 23.5 });
        if (solve.maxResidual > 5) {
          out.unreachable++;
          if (midis.length > 5) out.unreachableOversize++;
        } else out.reachGapButContact++;
      } else if (solve.maxResidual > 5) {
        // Reachable at zero roll, yet the contact solve still misses.
        out.unreachable++;
        if (midis.length > 5) out.unreachableOversize++;
      }
      if (prev) {
        const d = Math.hypot(c.wrist[0] - prev.wrist[0], c.wrist[1] - prev.wrist[1], c.wrist[2] - prev.wrist[2]);
        // Does the hand move while a key from the previous chord is still held?
        const held = Object.values(prev.fingers || {}).some((n) => n.time + n.duration > c.time + 0.02);
        if (held && d * 23.5 > 8) out.heldWhileMoving = (out.heldWhileMoving || 0) + 1;
        out.shifts.push({ hand, gap: c.time - prev.time, dist: d * 23.5, keys: d });
        // Abduction snap. `rad` is how far the solved spread moves between two
                // chords: the old renderer wrote it in one frame. `step` is what the
                // renderer shows now, with the fan spread over the travel window and
                // the ease's peak slope (pi/2) at its fastest.
                let jump = 0;
                for (const e of entries) {
                  const was = prev.entries.find((p) => p.finger === e.finger);
                  if (!was) continue;
                  jump = Math.max(jump, Math.abs(solve.spread[e.finger] - prev.solve.spread[e.finger]));
                }
                const frames = Math.max(1, Math.round(travelLead(d, c.time - prev.time) * 60));
                out.abductJumps.push({ hand, rad: jump, step: (jump * Math.PI) / (2 * frames), frames, time: c.time });
      }
      prev = c;
    }
    // Notes per hand position: run-length over near-equal wrist X.
    let run = 0, runs = [];
    prev = null;
    for (const c of chords) {
      const size = Object.keys(c.fingers).length;
      if (prev && Math.abs(c.wrist[0] - prev.wrist[0]) < 0.35 && Math.abs(c.wrist[2] - prev.wrist[2]) < 0.5) {
        run += size;
      } else {
        if (run) runs.push(run);
        run = size;
      }
      prev = c;
    }
    if (run) runs.push(run);
    out.perPosition.push(...runs);
  }
  return out;
}

// Critically damped spring, as in src/hands.js: w = 14. The target moves
// `lead` seconds before the chord. How far along the step is the hand at the
// note onset? Assumes the hand starts each transition at rest on the previous
// target, so chained lag in a fast run makes the real error larger, not
// smaller.
function springArrival(gapSeconds, shiftMm, lead) {
  const w = 14;
  const dt = 1 / 240;
  let x = 0, v = 0;
  for (let t = 0; t < gapSeconds; t += dt) {
    const target = gapSeconds - t <= lead ? shiftMm : 0;
    const a = (target - x) * w * w - v * 2 * w;
    v += a * dt;
    x += v * dt;
  }
  return x;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rows = [];
const globalResiduals = [];
const globalShifts = [];
const globalLate = [];
const globalLateFixed = [];
const globalAbduct = [];
const globalSizes = {};
const globalPost = { L: [0, 0, 0, 0, 0, 0], R: [0, 0, 0, 0, 0, 0] };
for (const file of files) {
  const t0 = Date.now();
  const r = solveSong(file);
  globalResiduals.push(...r.residuals);
  for (const [k, v] of Object.entries(r.sizes)) globalSizes[k] = (globalSizes[k] || 0) + v;
  for (const h of ['L', 'R']) r.postFingers[h].forEach((v, i) => { globalPost[h][i] += v; });
  globalShifts.push(...r.shifts.map((x) => x.dist));
  globalAbduct.push(...r.abductJumps);
  for (const sh2 of r.shifts) if (sh2.dist > 20) {
    globalLate.push(sh2.dist - springArrival(sh2.gap, sh2.dist, travelLead(sh2.keys, sh2.gap)));
    globalLateFixed.push(sh2.dist - springArrival(sh2.gap, sh2.dist, 0.12));
  }
  const res = r.residuals.slice().sort((a, b) => a - b);
  const pct = (p) => res[Math.min(res.length - 1, Math.floor(res.length * p))];
  const shifts = r.shifts;
  const big = shifts.filter((s) => s.dist > 20);
  const lateErr = big.map((s) => s.dist - springArrival(s.gap, s.dist, travelLead(s.keys, s.gap))).sort((a, b) => a - b);
  const jumpRad = r.abductJumps.map((j) => j.rad);
  const dists = shifts.map((s) => s.dist).sort((a, b) => a - b);
  rows.push({
    file, chords: r.chords, ms: Date.now() - t0,
    resP50: +pct(0.5).toFixed(2), resP95: +pct(0.95).toFixed(2), resMax: +res[res.length - 1].toFixed(2),
    resOver5: r.residuals.filter((v) => v > 5).length,
    shifts: shifts.length,
    shiftMedMm: Math.round(dists[dists.length >> 1] || 0),
    shiftP95Mm: Math.round(dists[Math.floor(dists.length * 0.95)] || 0),
    bigShifts: big.length,
    lateP50mm: Math.round(lateErr[lateErr.length >> 1] || 0),
    lateMaxmm: Math.round(lateErr[lateErr.length - 1] || 0),
    reachGapChords: r.reachGaps.length,
    abductSnaps: jumpRad.filter((v) => v > 0.05).length,
    abductSnapMax: +Math.max(0, ...jumpRad).toFixed(2),
    thumbBlack: r.thumbBlack,
    preThumb: r.preThumb,
    postFingersL: r.postFingers.L, postFingersR: r.postFingers.R,
    fingersL: r.fingersUsed.L.size, fingersR: r.fingersUsed.R.size,
    heldMove: r.heldWhileMoving || 0,
    unreachable: r.unreachable,
    unreachableOversize: r.unreachableOversize,
    oversize: r.oversize,
    reachButContact: r.reachGapButContact,
    postThumbBlack: r.postThumbBlack,
    postThumb: r.postThumb,
    pinkyShare: +(100 * (r.postFingers.L[5] + r.postFingers.R[5])
      / Math.max(1, r.postFingers.L.reduce((a, b) => a + b, 0) + r.postFingers.R.reduce((a, b) => a + b, 0))).toFixed(1),
    runNotes: r.perPosition.reduce((a, b) => a + b, 0),
    runCount: r.perPosition.length,
    notesPerPos: +(r.perPosition.reduce((a, b) => a + b, 0) / Math.max(1, r.perPosition.length)).toFixed(2),
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  console.table(rows.map((r) => ({
    file: r.file, chords: r.chords, resP95: r.resP95, resMax: r.resMax,
    over5mm: r.resOver5, unreachable: r.unreachable, shifts: r.shifts,
    shiftMedMm: r.shiftMedMm, lateP50mm: r.lateP50mm, heldMove: r.heldMove,
    snaps: r.abductSnaps, notesPerPos: r.notesPerPos,
  })));
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const pctOf = (k, p) => {
    const v = rows.map((r) => r[k]).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(v.length * p))];
  };
  console.log(`AGGREGATE, ${rows.length} songs, ${sum('chords')} chord events`);
  const all = globalResiduals.slice().sort((a, b) => a - b);
  const at = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
  console.log(`  residual over ${all.length} chords: p50 ${at(0.5).toFixed(2)} mm, p90 ${at(0.9).toFixed(2)} mm, p95 ${at(0.95).toFixed(2)} mm, p99 ${at(0.99).toFixed(2)} mm, max ${at(1).toFixed(2)} mm`);
  console.log(`  per-song worst chord: median ${pctOf('resMax', 0.5).toFixed(2)} mm, worst ${pctOf('resMax', 1).toFixed(2)} mm`);
  console.log(`  chords over 5 mm residual   ${sum('resOver5')} (${(100 * sum('resOver5') / sum('chords')).toFixed(1)}%)`);
  console.log(`    of those, more than 5 notes in one hand: ${sum('unreachableOversize')}`);
  console.log(`    of those, 5 notes or fewer:              ${sum('resOver5') - sum('unreachableOversize')}`);
  console.log(`  chords with more notes than fingers        ${sum('oversize')} (${(100 * sum('oversize') / sum('chords')).toFixed(1)}%)`);
  console.log(`  reach gap at zero roll      ${sum('reachGapChords')} (${(100 * sum('reachGapChords') / sum('chords')).toFixed(1)}%)`);
  console.log(`    pronation rescues the chord: ${sum('reachButContact')}`);
  const sh = globalShifts.slice().sort((a, b) => a - b);
  const sat = (p) => sh[Math.min(sh.length - 1, Math.floor(sh.length * p))];
  console.log(`  hand shifts                 ${sh.length}, median ${sat(0.5).toFixed(0)} mm, p90 ${sat(0.9).toFixed(0)} mm, p95 ${sat(0.95).toFixed(0)} mm, max ${sat(1).toFixed(0)} mm`);
  console.log(`  shifts over 20 mm           ${sum('bigShifts')} (${(100 * sum('bigShifts') / sum('shifts')).toFixed(1)}%)`);
  const la = globalLate.slice().sort((a, b) => a - b);
  const lf = globalLateFixed.slice().sort((a, b) => a - b);
  const lat = (p2) => la[Math.min(la.length - 1, Math.floor(la.length * p2))];
  const latf = (p2) => lf[Math.min(lf.length - 1, Math.floor(lf.length * p2))];
  console.log(`  short at note onset, fixed 0.12 s (${la.length} shifts over 20 mm): p50 ${latf(0.5).toFixed(0)} mm, p90 ${latf(0.9).toFixed(0)} mm, max ${latf(1).toFixed(0)} mm`);
  console.log(`  short at note onset, travel window:                        p50 ${lat(0.5).toFixed(0)} mm, p90 ${lat(0.9).toFixed(0)} mm, max ${lat(1).toFixed(0)} mm`);
  console.log(`  moves while a key is held   ${sum('heldMove')} (${(100 * sum('heldMove') / sum('shifts')).toFixed(1)}%)`);
  const abRad = globalAbduct.map((j) => j.rad).sort((a, b) => a - b);
  const abStep = globalAbduct.map((j) => j.step).sort((a, b) => a - b);
  const abFrames = globalAbduct.map((j) => j.frames).sort((a, b) => a - b);
  const ap = (v, p) => v[Math.min(v.length - 1, Math.floor(v.length * p))];
  const snaps = abRad.filter((v) => v > 0.05).length;
  console.log(`  abduction change per chord  ${snaps} of ${abRad.length} over 0.05 rad (${(100 * snaps / Math.max(1, abRad.length)).toFixed(1)}%), p95 ${ap(abRad, 0.95).toFixed(2)}, max ${ap(abRad, 1).toFixed(2)} rad`);
  console.log(`    written in one frame      p50 ${ap(abRad, 0.5).toFixed(2)}, max ${ap(abRad, 1).toFixed(2)} rad (the old renderer)`);
  console.log(`    spread over the travel    p50 ${ap(abStep, 0.5).toFixed(3)}, p95 ${ap(abStep, 0.95).toFixed(3)}, max ${ap(abStep, 1).toFixed(3)} rad per frame at 60 fps, over ${ap(abFrames, 0.5)} frames (median)`);
  console.log(`  thumb on a black key, before the reach guard: ${sum('thumbBlack')} of ${sum('preThumb')} thumb notes (${(100 * sum('thumbBlack') / Math.max(1, sum('preThumb'))).toFixed(1)}%)`);
  console.log(`  thumb on a black key, after the reach guard:  ${sum('postThumbBlack')} of ${sum('postThumb')} thumb notes (${(100 * sum('postThumbBlack') / Math.max(1, sum('postThumb'))).toFixed(1)}%)`);
  console.log(`  pinky share after the guard  ${pctOf('pinkyShare', 0.5).toFixed(1)}% (median over songs)`);
  console.log(`  notes per hand position     ${(sum('runNotes') / Math.max(1, sum('runCount'))).toFixed(2)} over ${sum('runCount')} runs`);
  console.log(`  notes per chord, one hand:  ${Object.entries(globalSizes).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  for (const h of ['L', 'R']) {
    const tot = globalPost[h].reduce((a, b) => a + b, 0);
    const share = [1, 2, 3, 4, 5].map((f) => `${f}: ${(100 * globalPost[h][f] / tot).toFixed(1)}`).join(', ');
    console.log(`  finger share after the guard, ${h}: ${share}%  (${tot} notes)`);
  }
}
