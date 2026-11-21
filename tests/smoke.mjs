// Smoke test: parse every bundled MIDI, run hand split + fingering, assert sanity.
// Run: npm test
import fs from 'node:fs';
import path from 'node:path';
import MidiPkg from '@tonejs/midi';
const { Midi } = MidiPkg;
import { assignFingering, markMelody, CHORD_WINDOW } from '../src/fingering.js';
import { keyX, isBlack, noteName, midiFromName, MIDI_MIN, MIDI_MAX, WHITE_COUNT } from '../src/layout.js';
import { PRESETS } from '../src/scene.js';
import { barLengths, PPS, MIN_LEN } from '../src/bars.js';
import { collectPedals, pedalSpans, PEDAL_ORDER } from '../src/pedals.js';
import { MAX_GAP, MIN_GAP, barTimes, layoutScore } from '../src/score.js';

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

// View check. The default view is a true overhead view: the camera sits
// directly above its target, so key widths and hand spans read without
// keystone. An angled camera here would silently break that.
const top = PRESETS.top;
const EPS = 1e-9;
const topVertical = Math.abs(top.pos[0] - top.target[0]) <= EPS && Math.abs(top.pos[2] - top.target[2]) <= EPS;
if (!topVertical) fail(`top preset is not vertical: pos [${top.pos}] target [${top.target}]`);
if (!(top.pos[1] > top.target[1])) fail('top preset does not look down at the keys');
else if (topVertical) console.log(`view: top camera ${top.pos[1]} units above the keys, 90° down — OK`);

for (const f of files) {
  const midi = new Midi(fs.readFileSync(path.join(dir, f)));
  const notes = [];
  midi.tracks.forEach((t, ti) => {
    if (t.channel === 9) return; // skip drum channel
    for (const n of t.notes) {
      if (n.midi < MIDI_MIN || n.midi > MIDI_MAX) continue;
      notes.push({
        midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity,
        track: ti, trackName: t.name,
      });
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

  // Track check. A track that never leaves the bass register is one hand's part,
  // so it cannot reach the right hand: that is the "low key on the high row" a
  // player notices. A named hand outranks the register, so those tracks are left
  // to their title.
  const byTrack = new Map();
  for (const n of assigned) {
    if (!byTrack.has(n.track)) byTrack.set(n.track, []);
    byTrack.get(n.track).push(n);
  }
  let bassOnRight = 0;
  for (const ns of byTrack.values()) {
    if (ns.some((n) => n.midi >= 60 || n.hand === undefined)) continue;
    if (/left|right|\blh\b|\brh\b|bass|treble/i.test(ns[0].trackName || '')) continue;
    bassOnRight += ns.filter((n) => n.hand === 'R').length;
  }
  if (bassOnRight) fail(`${f}: ${bassOnRight} bass notes played by the right hand`);

  // Bar check. A bar holds the music of its own note, and it stops at the next
  // note on the same key. Two notes on one key draw bars in one column, so a
  // bar that outran its note paints over the bar behind it.
  const barLens = barLengths(assigned);
  let badBars = 0;
  let clipped = 0;
  let longestBar = 0;
  const byPitch = new Map();
  for (let i = 0; i < assigned.length; i++) {
    const n = assigned[i];
    const len = barLens[i];
    if (!(len > 0)) badBars++;
    // Never longer than the note holds, unless the note sits under the floor.
    if (len > Math.max(n.duration * PPS, MIN_LEN) + 1e-9) badBars++;
    if (len < n.duration * PPS - 1e-9) clipped++;
    longestBar = Math.max(longestBar, len);
    if (!byPitch.has(n.midi)) byPitch.set(n.midi, []);
    byPitch.get(n.midi).push({ time: n.time, len });
  }
  let overBar = 0;
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.time - b.time);
    for (let i = 0; i + 1 < list.length; i++) {
      // The far edge of this bar must stay behind the next bar's near edge.
      if (list[i].len > (list[i + 1].time - list[i].time) * PPS + 1e-9) overBar++;
    }
  }
  if (badBars) fail(`${f}: ${badBars} bars longer than their note`);
  if (overBar) fail(`${f}: ${overBar} bars overlap the next note on their key`);

  // Pedal check. A piece may carry no pedal events at all, and that is not a
  // fault: the lane simply stays empty. A span that the lane draws must start
  // before it ends and must lie inside the piece.
  const endTime = Math.max(midi.duration, ...notes.map((n) => n.time + n.duration));
  const spans = pedalSpans(collectPedals(midi.tracks), endTime);
  let badPedal = 0;
  const used = [];
  for (const name of PEDAL_ORDER) {
    for (const [start, end] of spans[name]) {
      if (!(end > start)) badPedal++;
      if (start < -0.01 || end > endTime + 0.01) badPedal++;
    }
    if (spans[name].length) used.push(`${name}=${spans[name].length}`);
  }
  if (badPedal) fail(`${f}: ${badPedal} bad pedal spans`);

  // Sheet-music check. Every note must land on the paper, every bar line must
  // sit inside the piece and after the one before it, and the bar lines must
  // agree with the tempo map that the MIDI reader already applied to the notes.
  const bars = barTimes(midi.header, { duration: endTime });
  const layout = layoutScore(assigned, {
    bars,
    width: 1200,
    maxHeight: 190,
    tempos: midi.header.tempos,
    ppq: midi.header.ppq,
    timeSignatures: midi.header.timeSignatures,
  });
  let badSheet = 0;
  if (!bars.length || bars[0] !== 0) badSheet++;
  for (let i = 1; i < bars.length; i++) if (!(bars[i] > bars[i - 1])) badSheet++;
  if (!(layout.gap >= MIN_GAP && layout.gap <= MAX_GAP)) badSheet++;
  let heads = 0;
  let beams = 0;
  let rests = 0;
  let dotted = 0;
  for (const glyph of layout.glyphs) {
    if (!Number.isFinite(glyph.x) || !glyph.heads.length) badSheet++;
    // Every note must carry a written value, or the paper shows no shape.
    if (!glyph.value || !glyph.value.name) badSheet++;
    if (glyph.value.dotted) dotted++;
    if (glyph.value.stem && !glyph.stem) badSheet++;
    for (const head of glyph.heads) {
      heads++;
      if (!(head.y >= 0 && head.y <= layout.height)) badSheet++;
    }
    if (glyph.stem && !(Number.isFinite(glyph.stem.y1) && Number.isFinite(glyph.stem.y2))) badSheet++;
    // A flag hangs from a stem, so a flagged note without one cannot draw.
    if (glyph.flags > 0 && !glyph.stem) badSheet++;
    for (const dot of glyph.dots) {
      if (!Number.isFinite(dot.x) || !(dot.y >= 0 && dot.y <= layout.height)) badSheet++;
    }
  }
  for (const beam of layout.beams) {
    beams++;
    if (!(beam.x2 > beam.x1)) badSheet++;
    for (const y of [beam.y1, beam.y2]) {
      if (!(y >= 0 && y <= layout.height)) badSheet++;
    }
  }
  for (const rest of layout.rests) {
    rests++;
    if (!(rest.y >= 0 && rest.y <= layout.height)) badSheet++;
    // A rest belongs inside the piece, on a beat, and never after the end.
    if (!(rest.time >= 0 && rest.time <= endTime + 1e-6)) badSheet++;
    if (!['whole', 'half', 'quarter', 'eighth', 'sixteenth'].includes(rest.symbol)) badSheet++;
  }
  if (heads !== assigned.length) badSheet++;
  const sigs = midi.header.timeSignatures;
  if (sigs.length === 1 && bars.length > 5) {
    const [beats, unit] = sigs[0].timeSignature;
    const ticksPerBar = (midi.header.ppq * 4 * beats) / unit;
    const expected = midi.header.ticksToSeconds(sigs[0].ticks + 5 * ticksPerBar);
    if (Math.abs(bars[5] - expected) > 1e-6) badSheet++;
  }
  if (badSheet) fail(`${f}: ${badSheet} sheet-layout faults`);

  const melody = assigned.filter((n) => n.melody).length;
  console.log(
    `${f.padEnd(26)} notes=${String(notes.length).padStart(5)} ` +
    `L=${String(lh).padStart(4)} R=${String(rh).padStart(4)} ` +
    `melody=${String(melody).padStart(4)} dur=${midi.duration.toFixed(1)}s ` +
    `pedals=${used.join(' ') || 'none'} ` +
    `bars=${clipped}clipped/${longestBar.toFixed(1)}u ` +
    `sheet=${layout.glyphs.length}g/${bars.length}b gap=${layout.gap.toFixed(2)} ` +
    `beam=${beams} rest=${rests} dot=${dotted} ` +
    `bassOnRight=${bassOnRight}` +
    (badFinger || badWrist || bigSpan || bassOnRight || badBars || overBar || badPedal || badSheet ? '  [FAIL]' : '  OK')
  );
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE TESTS PASSED');
process.exit(failures ? 1 : 0);