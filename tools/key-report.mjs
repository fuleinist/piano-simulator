// Validation: read the key signature straight out of the MIDI bytes, then check
// that the sheet prints the same one. Read-only, prints a block per file.
//
//   node tools/key-report.mjs [file.mid ...]
//
// The reader here shares no code with src/score.js. It walks the track chunks,
// takes the FF 59 meta event as a signed byte pair, and pairs note ons with
// note offs from the running status. The sheet side comes from layoutScore().
//
// Checks per file:
//   - the raw event and the library reader agree on every key-signature event
//   - the sheet holds one signature per event, with the same mark count
//   - each staff draws as many marks as the signature names, in the engraved
//     order (F C G D A E B / B E A D G C F), inside the staff or one space past
//   - a notehead carries a sign exactly when its pitch class is outside the
//     scale that those marks spell
//   - the marks cover the sounding time: the share of the piece that the
//     printed scale holds, and the pitch classes that escape it
import fs from 'node:fs';
import path from 'node:path';
import MidiPkg from '@tonejs/midi';
import { assignFingering, markMelody } from '../src/fingering.js';
import { barTimes, keyAt, keyMarkSteps, keySegments, layoutScore } from '../src/score.js';

const { Midi } = MidiPkg;
const dir = path.resolve('public/midi');

// The circle of fifths, as the key name of each mark count.
const KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const SHARP_LETTERS = 'FCGDAEB';
const FLAT_LETTERS = 'BEADGCF';
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTERS = 'CDEFGAB';
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** The scale that a signature spells, derived here and not from src/score.js. */
function scaleOf(sf) {
  const pcs = new Set(['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((letter) => NATURAL[letter]));
  const order = sf > 0 ? SHARP_LETTERS : FLAT_LETTERS;
  for (let i = 0; i < Math.abs(sf); i++) {
    const pc = NATURAL[order[i]];
    pcs.delete(pc);
    pcs.add(((pc + Math.sign(sf)) % 12 + 12) % 12);
  }
  return pcs;
}

/** The letter that each pitch class takes inside the scale that a signature spells. */
function scaleLetters(sf) {
  const map = new Map();
  const order = sf > 0 ? SHARP_LETTERS : FLAT_LETTERS;
  for (const letter of LETTERS) {
    const at = order.indexOf(letter);
    const alter = at >= 0 && at < Math.abs(sf) ? Math.sign(sf) : 0;
    map.set((((NATURAL[letter] + alter) % 12) + 12) % 12, letter);
  }
  return map;
}

/** The signature that covers the most of a piece, with no charge for its marks. */
function bestSignature(weight, total) {
  let best = { sf: 0, cover: 0 };
  for (let sf = -7; sf <= 7; sf++) {
    const scale = scaleOf(sf);
    let inside = 0;
    for (const [pc, held] of weight.entries()) if (scale.has(pc)) inside += held;
    const cover = total ? inside / total : 1;
    if (cover > best.cover) best = { sf, cover };
  }
  return best;
}

/** A variable-length quantity, as the MIDI file writes one. */
function vlq(buf, i) {
  let value = 0;
  let byte;
  do {
    byte = buf[i++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return [value, i];
}

/** Walk one MTrk chunk: the key-signature events and the sounding notes. */
function scanTrack(buf, start, end, keys, notes) {
  let i = start;
  let tick = 0;
  let status = 0;
  const open = new Map();
  while (i < end) {
    let delta;
    [delta, i] = vlq(buf, i);
    tick += delta;
    const byte = buf[i];
    if (byte === undefined) break;
    if (byte & 0x80) {
      status = byte;
      i++;
    } else if (!status) {
      throw new Error(`running status with no status at ${i}`);
    }
    if (status === 0xff) {
      const type = buf[i++];
      let len;
      [len, i] = vlq(buf, i);
      // FF 59 02 sf mi: the key signature. The count is a signed byte.
      if (type === 0x59 && len >= 2) {
        const raw = buf[i];
        keys.push({ tick, sf: raw > 127 ? raw - 256 : raw, mi: buf[i + 1] });
      }
      i += len;
      status = 0; // a meta event cancels the running status
    } else if (status === 0xf0 || status === 0xf7) {
      let len;
      [len, i] = vlq(buf, i);
      i += len;
      status = 0;
    } else {
      const kind = status & 0xf0;
      const size = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      const note = buf[i];
      const value = size === 2 ? buf[i + 1] : 0;
      i += size;
      const slot = (status & 0x0f) * 128 + note;
      if (kind === 0x90 && value > 0) open.set(slot, { midi: note, tick });
      else if (kind === 0x80 || (kind === 0x90 && value === 0)) {
        const on = open.get(slot);
        if (on) {
          notes.push({ midi: note, tick: on.tick, dur: tick - on.tick });
          open.delete(slot);
        }
      }
    }
  }
}

/** The raw read of a file: its key events in tick order, and its notes. */
function readRaw(file) {
  const buf = fs.readFileSync(file);
  const keys = [];
  const notes = [];
  // Past MThd, its length, and its six bytes of header data.
  let i = 8 + buf.readUInt32BE(4);
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32BE(i + 4);
    const start = i + 8;
    if (id === 'MTrk') scanTrack(buf, start, Math.min(start + size, buf.length), keys, notes);
    i = start + size;
  }
  keys.sort((a, b) => a.tick - b.tick || a.sf - b.sf);
  return { keys, notes };
}

/** The mode of a key event, as the tonic pitch class that a player would name. */
function tonicOf(sf, mi) {
  const name = KEYS[sf + 7];
  let pc = NATURAL[name[0]];
  if (name.length > 1) pc += name[1] === '#' ? 1 : -1;
  pc = ((pc % 12) + 12) % 12;
  return mi === 1 ? (pc + 9) % 12 : pc;
}

const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => (path.isAbsolute(f) ? f : path.resolve(f)))
  : fs.readdirSync(dir).filter((f) => f.endsWith('.mid')).sort().map((f) => path.join(dir, f));

let failures = 0;
let validated = 0;
const fail = (file, msg) => {
  failures++;
  console.error(`  FAIL ${path.basename(file)}: ${msg}`);
};

for (const file of files) {
  const midi = new Midi(fs.readFileSync(file));
  const raw = readRaw(file);
  const name = path.basename(file);
  if (!raw.keys.length) {
    console.log(`${name.padEnd(26)} no key-signature event, the sheet infers one — skipped`);
    continue;
  }
  validated++;

  // 1. The library reader and the raw bytes must agree, event for event. The
  // file may carry the same event in two tracks, so compare the two lists as
  // sorted sets of tick and count.
  const library = (midi.header.keySignatures || []).map((k) => ({
    tick: k.ticks,
    sf: KEYS.indexOf(k.key) - 7,
  }));
  const sortEvents = (list) => list.map((k) => `${k.tick}:${k.sf}`).sort();
  const rawSet = sortEvents(raw.keys);
  const libSet = sortEvents(library);
  if (rawSet.join(' ') !== libSet.join(' ')) {
    fail(file, `the readers disagree: raw [${rawSet.join(' ')}] library [${libSet.join(' ')}]`);
  }

  // 2. The sheet must carry one segment per signature, with that mark count.
  const notes = [];
  midi.tracks.forEach((track, ti) => {
    if (track.channel === 9) return;
    for (const n of track.notes) {
      if (n.midi < 21 || n.midi > 108) continue;
      notes.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti, trackName: track.name });
    }
  });
  const endTime = Math.max(midi.duration, ...notes.map((n) => n.time + n.duration));
  const assigned = markMelody(assignFingering(notes));
  const layout = layoutScore(assigned, {
    bars: barTimes(midi.header, { duration: endTime }),
    width: 1200,
    maxHeight: 190,
    tempos: midi.header.tempos,
    ppq: midi.header.ppq,
    timeSignatures: midi.header.timeSignatures,
    keySignatures: midi.header.keySignatures,
  });
  const drawn = layout.keys.map((k) => k.accidentals);
  const expected = keySegments(midi.header.keySignatures, midi.header.tempos, midi.header.ppq)
    .map((k) => k.accidentals);
  if (drawn.join(',') !== expected.join(',')) {
    fail(file, `the sheet shows [${drawn.join(',')}] where the file holds [${expected.join(',')}]`);
  }

  // 3. The marks: count, order, and where each one sits.
  let badMarks = 0;
  const order = [];
  for (const sf of drawn) {
    const letters = (sf > 0 ? SHARP_LETTERS : FLAT_LETTERS).slice(0, Math.abs(sf)).split('');
    order.push(`${sf}:${letters.join('')}`);
    for (const staff of ['treble', 'bass']) {
      const marks = keyMarkSteps(sf, staff);
      if (marks.length !== Math.abs(sf)) badMarks++;
      const top = staff === 'bass' ? 26 : 38; // the top line of that staff
      const bottom = top - 8;
      marks.forEach((mark, index) => {
        if (LETTERS[mark.step % 7] !== letters[index]) badMarks++;
        // Every mark sits inside its staff or one space past it.
        if (mark.step < bottom - 1 || mark.step > top + 1) badMarks++;
      });
    }
  }
  if (badMarks) fail(file, `${badMarks} marks out of order or off the staff`);

  // 4. The spelling: a sign exactly when the pitch class sits outside the marks.
  let badSpell = 0;
  let signs = 0;
  for (const glyph of layout.glyphs) {
    const sf = keyAt(layout.keys, glyph.time).accidentals;
    const scale = scaleOf(sf);
    const letters = scaleLetters(sf);
    for (const head of glyph.heads) {
      const pc = ((head.midi % 12) + 12) % 12;
      if (head.accidental) signs++;
      // A note that the marks cover carries no sign, and it takes the letter
      // that the marks give that pitch class.
      if (Boolean(head.accidental) === scale.has(pc)) badSpell++;
      if (scale.has(pc) && letters.get(pc) !== LETTERS[head.step % 7]) badSpell++;
    }
  }
  if (badSpell) fail(file, `${badSpell} noteheads carry the wrong sign or letter`);

  // 5. The marks must cover the piece. Weigh each pitch class by the ticks it
  // sounds, which reads the same at any tempo, and name what escapes.
  let inside = 0;
  let total = 0;
  const outside = new Map();
  const weight = new Array(12).fill(0);
  for (const note of raw.notes) {
    const held = Math.max(note.dur, 1);
    const pc = ((note.midi % 12) + 12) % 12;
    weight[pc] += held;
    total += held;
  }
  for (const [pc, held] of weight.entries()) {
    const scale = scaleOf(drawn[0]);
    if (scale.has(pc)) inside += held;
    else outside.set(pc, held);
  }
  const coverage = total ? inside / total : 1;
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]);
  const tonic = tonicOf(raw.keys[0].sf, raw.keys[0].mi);
  const tonicRank = ranked.findIndex(([pc]) => pc === tonic) + 1;
  const escapees = [...outside.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([pc, held]) => `${NOTE_NAMES[pc]} ${(100 * held / total).toFixed(1)}%`)
    .join(' ');
  // A signature that leaves notes out is not a fault of the sheet: the sheet
  // prints the signature of the file, and the left-out notes take accidentals.
  // Report the best a signature could do, so a nominal signature stands out.
  const best = bestSignature(weight, total);
  const gap = best.cover - coverage;

  const nameOfKey = `${KEYS[raw.keys[0].sf + 7]} ${raw.keys[0].mi === 1 ? 'minor' : 'major'}`;
  console.log(
    `${name.padEnd(26)} ${nameOfKey.padEnd(10)} marks=${String(order.map((o) => o.split(':')[1] || '-').join('|')).padEnd(9)} ` +
    `${drawn.map((d) => (d === 0 ? '0' : d > 0 ? `+${d}` : d)).join(',').padEnd(12)} ` +
    `events=${raw.keys.length} ` +
    `cover=${(100 * coverage).toFixed(1)}%${gap > 0.02 ? ` best=${best.sf > 0 ? '+' : ''}${best.sf}@${(100 * best.cover).toFixed(1)}%` : ''} ` +
    `tonic=${NOTE_NAMES[tonic]}@${tonicRank} ` +
    `signs=${signs} off=${escapees || 'none'} ` +
    (badMarks || badSpell ? '  [FAIL]' : '  OK')
  );
}

console.log(
  failures
    ? `\n${failures} FAILURES over ${validated} pieces with a key signature`
    : `\n${validated} pieces carry a key-signature event, and every one prints it correctly`,
);
process.exit(failures ? 1 : 0);