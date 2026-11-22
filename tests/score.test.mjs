// Sheet-music layout tests. Run: node --test tests/score.test.mjs
//
// The sheet is a pure layout module plus a thin SVG view, so most defects that
// matter here can be measured without a browser: a note on the wrong line, a
// stem that points the wrong way, a bar line in the wrong place, or a note that
// leaves the paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BASS, BEAM_SLOPE, MAX_GAP, MIN_GAP, MIN_STEM, PAD, TREBLE, barTimes, guessAccidentals,
  keyAccidentalsOf, keyAt, keyMarkSteps, keySegments, layoutScore, ledgerStepsOf,
  noteValueOf, pitchOf, signatureAt, staffOf, ticksToSeconds,
} from '../src/score.js';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('src/styles.css');
const main = read('src/main.js');
const player = read('src/player.js');
const view = read('src/scoreui.js');

const note = (midi, time, duration = 0.5, hand = 'R') => ({ midi, time, duration, hand });

// A piece needs the tempo map and the signature to name a note value, so the
// helpers below build both, at the 120 bpm that a bare file uses.
const TEMPOS = [{ ticks: 0, bpm: 120 }];
const PPQ = 480;
const SIGNATURES = [{ ticks: 0, timeSignature: [4, 4] }];
// Sheet tests pin the key so a spelling cannot depend on the inference path.
const KEYS = [{ ticks: 0, key: 'C', scale: 'major' }];
const barsOf = (duration, timeSignatures = SIGNATURES) => barTimes(
  { ppq: PPQ, tempos: TEMPOS, timeSignatures },
  { duration },
);
const sheetOf = (notes, {
  duration = 4, timeSignatures = SIGNATURES, keySignatures = KEYS,
} = {}) => layoutScore(notes, {
  bars: barsOf(duration, timeSignatures),
  width: 1200,
  tempos: TEMPOS,
  ppq: PPQ,
  timeSignatures,
  keySignatures,
});

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

test('a pitch maps to its line on the staff, and a sharp keeps its letter', () => {
  assert.deepEqual(
    { ...pitchOf(60) },
    { letter: 'C', accidental: '', alter: 0, octave: 4, step: 28, pc: 0 },
    'C4 must sit on the middle C step',
  );
  assert.equal(pitchOf(61).letter, 'C', 'C sharp must keep the letter C');
  assert.equal(pitchOf(61).accidental, '#');
  assert.equal(pitchOf(61).step, pitchOf(60).step, 'C sharp must not move off the C line');
  assert.equal(pitchOf(70).step, 33, 'A sharp 4 must sit on the A line');
  assert.equal(pitchOf(21).step, 5, 'A0 must be three octaves and a third below middle C');
});

test('the hand picks the staff, and the register is the fallback', () => {
  assert.equal(staffOf({ midi: 72, hand: 'L' }), BASS, 'a left-hand note belongs to the lower staff');
  assert.equal(staffOf({ midi: 40, hand: 'R' }), TREBLE, 'a right-hand note belongs to the upper staff');
  assert.equal(staffOf({ midi: 55 }), BASS, 'a note below middle C falls back to the lower staff');
  assert.equal(staffOf({ midi: 64 }), TREBLE, 'a note above middle C falls back to the upper staff');
});

test('ledger lines appear only outside the staff', () => {
  assert.deepEqual(ledgerStepsOf(32, TREBLE), [], 'a note inside the staff needs no ledger line');
  assert.deepEqual(ledgerStepsOf(30, TREBLE), [], 'the bottom line itself needs no ledger line');
  assert.deepEqual(ledgerStepsOf(28, TREBLE), [28], 'middle C needs one ledger line below the upper staff');
  assert.deepEqual(ledgerStepsOf(39, TREBLE), [], 'a note in the space above the staff needs no line');
  assert.deepEqual(ledgerStepsOf(40, TREBLE), [40], 'A5 needs one ledger line above the upper staff');
  assert.deepEqual(ledgerStepsOf(28, BASS), [28], 'middle C needs one ledger line above the lower staff');
  assert.deepEqual(ledgerStepsOf(42, TREBLE), [40, 42], 'C6 needs two ledger lines');
});

test('a note lands on the line its pitch names', () => {
  const layout = layoutScore([note(60, 1), note(72, 2), note(48, 1, 0.5, 'L')], { width: 1200 });
  assert.ok(layout.gap >= MIN_GAP && layout.gap <= MAX_GAP, 'the line gap left its range');
  assert.equal(layout.glyphs.length, 3, 'two onsets: one chord each hand, then one note');

  const [right] = layout.glyphs.filter((g) => g.staff === TREBLE);
  const [left] = layout.glyphs.filter((g) => g.staff === BASS);
  const staves = layout.staves;
  assert.equal(
    right.heads[0].y,
    staves.trebleTopY + (staves.trebleTop - 28) * (layout.gap / 2),
    'C4 must sit on the middle C step',
  );
  assert.equal(
    left.heads[0].y,
    staves.bassTopY + (staves.bassTop - 21) * (layout.gap / 2),
    'C3 must sit on the C3 step',
  );
  assert.ok(left.heads[0].y > right.heads[0].y, 'a lower note must sit lower on the paper');

  // C4 is not on either staff line: it sits between the staves, so the upper
  // staff needs one ledger line and the lower staff needs none.
  assert.equal(right.ledgers.length, 1, 'the upper staff needs one ledger line for middle C');
  assert.equal(left.ledgers.length, 0, 'C3 sits inside the lower staff');
});

test('the staves keep a grand-staff gap between them', () => {
  const layout = layoutScore([note(60, 1), note(48, 1, 0.5, 'L')], { width: 1200 });
  const { staves } = layout;
  const away = (staves.bassTopY - staves.trebleBottomY) / layout.gap;
  // Two line gaps come from the pitch grid itself, and STAFF_GAP adds four.
  assert.equal(away, 6, `the staves sit ${away.toFixed(2)} line gaps apart, which is not the grand-staff rule`);
  // The extra air must stay inside the paper.
  assert.ok(staves.bassBottomY <= layout.height, 'the lower staff left the paper');
  assert.ok(staves.trebleTopY >= 0, 'the upper staff left the paper');
});

test('notes at the same moment share one stem', () => {
  const layout = layoutScore([note(60, 1), note(64, 1.01), note(67, 1.02)], { width: 1200 });
  assert.equal(layout.glyphs.length, 1, 'a chord must draw one stem, not three');
  const [chord] = layout.glyphs;
  assert.equal(chord.heads.length, 3, 'the chord keeps all three noteheads');
  assert.equal(chord.stem.y1, Math.max(...chord.heads.map((h) => h.y)), 'the stem starts on a notehead');
  assert.ok(chord.stem.y2 < chord.stem.y1, 'a low chord takes an upward stem');
  for (const head of chord.heads) {
    assert.ok(head.y > 0 && head.y < layout.height, 'a notehead left the paper');
  }
});

test('a high chord takes a downward stem and its own ledger lines', () => {
  const layout = layoutScore([note(96, 1), note(100, 1)], { width: 1200 });
  const [chord] = layout.glyphs;
  assert.ok(chord.stem.y2 > chord.stem.y1, 'a high chord takes a downward stem');
  assert.ok(chord.ledgers.length >= 2, 'notes above the staff need ledger lines');
  assert.equal(chord.heads.length, 2, 'two noteheads');
});

test('a sharp note carries an accidental', () => {
  const layout = sheetOf([note(61, 1), note(63, 1), note(65, 1)]);
  const [chord] = layout.glyphs;
  assert.deepEqual(chord.heads.map((h) => h.accidental), ['#', '#', ''], 'only the black keys take a sharp');
});

test('the scroll position follows the note time', () => {
  const layout = layoutScore([note(60, 0), note(62, 1), note(64, 3)], { width: 1200 });
  assert.ok(layout.pxPerSecond >= 56 && layout.pxPerSecond <= 200, 'the scroll speed left its range');
  assert.equal(layout.glyphs[0].x, 0);
  assert.equal(layout.glyphs[1].x, layout.pxPerSecond, 'one second of music scrolls one width');
  assert.equal(layout.glyphs[2].x, 3 * layout.pxPerSecond);
  assert.ok(layout.playheadRatio > 0 && layout.playheadRatio < 1, 'the marker must sit on the paper');
});

test('a wide register shrinks the line gap instead of leaving the paper', () => {
  const piece = [note(21, 1, 0.5, 'L'), note(108, 2)];
  const layout = layoutScore(piece, { width: 1200, maxHeight: 190 });
  for (const glyph of layout.glyphs) {
    for (const head of glyph.heads) {
      assert.ok(head.y >= 0 && head.y <= layout.height, `MIDI ${head.midi} left the paper`);
    }
  }
  assert.ok(layout.gap >= MIN_GAP, 'the line gap fell below the readable limit');
  // The paper grows only when the readable limit stops the gap from shrinking.
  if (layout.gap > MIN_GAP) {
    assert.ok(layout.height <= 190, 'the paper grew past the height the window offers');
  }
});

test('bar lines come from the file time signature and tempo', () => {
  const flat = { ppq: 480, tempos: [{ ticks: 0, bpm: 120 }], timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }] };
  const bars = barTimes(flat, { duration: 10 });
  assert.deepEqual(bars.slice(0, 3), [0, 2, 4], '4/4 at 120 bpm gives a bar every two seconds');
  assert.deepEqual(bars, [0, 2, 4, 6, 8, 10], 'the list stops at the end of the piece');

  const waltz = { ...flat, timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }] };
  assert.deepEqual(barTimes(waltz, { duration: 6 }).slice(0, 2), [0, 1.5], '3/4 at 120 bpm gives a bar every 1.5 seconds');

  const slower = { ...flat, tempos: [{ ticks: 0, bpm: 120 }, { ticks: 1920, bpm: 60 }] };
  assert.deepEqual(barTimes(slower, { duration: 12 }).slice(0, 3), [0, 2, 6], 'a tempo change must stretch the bars after it');

  const bare = { ppq: 480, tempos: [], timeSignatures: [] };
  assert.deepEqual(barTimes(bare, { duration: 6 }).slice(0, 2), [0, 2], 'a file with no signature reads as 4/4');
});

test('the tempo map converts ticks the way the MIDI reader does', () => {
  const tempos = [{ ticks: 0, bpm: 90 }, { ticks: 960, bpm: 140 }];
  assert.equal(ticksToSeconds(0, tempos, 480), 0);
  assert.equal(ticksToSeconds(960, tempos, 480), (960 / 480) * (60 / 90), 'the first tempo holds to its change');
  assert.equal(
    ticksToSeconds(1920, tempos, 480),
    (960 / 480) * (60 / 90) + (960 / 480) * (60 / 140),
    'the seconds accumulate across a tempo change',
  );
  assert.equal(ticksToSeconds(480, [{ ticks: 240, bpm: 60 }], 480), 0.25 + 0.5, 'a late first tempo leaves 120 bpm before it');
});

test('the piece keeps its bar lines and its note count', () => {
  const layout = layoutScore([note(60, 0.5), note(62, 1.5)], { width: 1200, bars: [0, 1, 2] });
  assert.deepEqual(layout.bars, [0, 1, 2], 'the layout keeps the bar lines it was given');
  assert.equal(layout.noteCount, 2);
  assert.equal(layout.duration, 2);
});

test('the page carries the sheet and a toggle for it', () => {
  const toggle = html.match(/<input\b[^>]*\bid="scoreToggle"[^>]*>/);
  assert.ok(toggle, 'index.html carries no #scoreToggle');
  assert.ok(/\bchecked\b/.test(toggle[0]), 'the sheet starts visible');
  const show = html.slice(html.indexOf('<h2>Show</h2>'), html.indexOf('</section>', html.indexOf('<h2>Show</h2>')));
  assert.ok(show.includes('id="scoreToggle"'), 'the toggle belongs in the Show section');

  const root = html.match(/<div\b[^>]*\bid="score"[^>]*>/);
  assert.ok(root, 'index.html carries no #score layer');
  assert.ok(/\bhidden\b/.test(root[0]), 'the paper starts hidden until it has a piece');
  assert.equal(attr(root[0], 'aria-hidden'), 'true', 'a layer that changes every frame stays out of the reading order');
  assert.match(html, /<svg\b[^>]*\bid="scoreSvg"/, 'the paper needs its SVG root');
});

test('the paper is styled, and a drag on it still moves the camera', () => {
  const rule = css.match(/#score\s*\{[^}]*\}/);
  assert.ok(rule, 'no #score rule in styles.css');
  assert.match(rule[0], /pointer-events:\s*none/, 'the paper would swallow the orbit drag');
  assert.match(rule[0], /background:\s*var\(--paper\)/, 'the paper must be white');
  // The paper must not hide the falling bars, so it stays see-through. The ink
  // keeps full opacity, or the notes would fade with it.
  assert.match(rule[0], /--paper:\s*rgba\(252,\s*252,\s*250,\s*0\.4\)/, 'the paper is not 60% transparent');
  assert.match(rule[0], /right:\s*238px/, 'the paper must stop short of the side panel');
  for (const rule of ['.sc-line', '.sc-head', '.sc-head.on', '.sc-stem', '.sc-playhead']) {
    assert.ok(css.includes(`${rule} {`), `no ${rule} rule in styles.css`);
  }
  assert.match(css, /\.sc-head\.on\s*\{[^}]*fill:\s*var\(--note\)/, 'a sounding note must change colour');

  // A phone has no side panel, so the paper may take the full width there.
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*#score\s*\{[^}]*left:\s*12px/, 'the paper keeps a side panel margin on a phone');
});

test('the app feeds the paper and follows playtime', () => {
  assert.match(main, /new ScoreView\(/, 'main.js never creates the sheet view');
  assert.match(main, /player\.onLoad\s*=/, 'main.js never passes a piece to the sheet');
  assert.match(main, /score\.update\(player\.time\)/, 'the frame loop never scrolls the paper');
  assert.match(main, /scoreToggle'\)\.addEventListener\('change'/, 'the toggle is not wired');
  assert.match(main, /score\.setRecording\(r\.recording\)/, 'a recording would keep the paper on screen');
  assert.match(main, /--score-top/, 'the paper is not kept clear of the header');
  assert.match(main, /getBoundingClientRect\(\)\.bottom/, 'the header height is not measured');

  // The player owns the notes and the tempo map, so it publishes both.
  assert.match(player, /this\.onLoad = null/, 'the player has no load hook');
  assert.match(player, /this\.barlines = barTimes\(midi\.header[^)]*\)/, 'the player does not read the bar lines');
  assert.match(player, /if \(this\.onLoad\) this\.onLoad\(this\)/, 'the load hook never fires');
  assert.match(player, /this\.scoreMeta = \{/, 'the player never publishes the tempo map');
  assert.match(main, /meta: p\.scoreMeta/, 'the view never receives the tempo map');
});

// --- Written values, beams, dots, rests, and the signature ----------------

test('a duration names the note value a printed score would use', () => {
  // At 120 bpm a quarter note lasts half a second, so sixteenths are easy to
  // count: 0.125 s is one sixteenth.
  assert.equal(noteValueOf(4).name, 'quarter');
  assert.equal(noteValueOf(2).name, 'eighth');
  assert.equal(noteValueOf(1).name, 'sixteenth');
  assert.equal(noteValueOf(8).name, 'half');
  assert.equal(noteValueOf(16).name, 'whole');
  assert.equal(noteValueOf(6).name, 'quarter', 'six sixteenths is a dotted quarter');
  assert.equal(noteValueOf(6).dotted, true, 'six sixteenths needs a dot');
  assert.equal(noteValueOf(1.5).dotted, true, 'a dotted sixteenth keeps its dot');
  assert.equal(noteValueOf(4).open, false, 'a quarter note is solid');
  assert.equal(noteValueOf(8).open, true, 'a half note is hollow');
  assert.equal(noteValueOf(16).stem, false, 'a whole note has no stem');
  assert.equal(noteValueOf(3).flags, 1, 'a dotted eighth needs one flag');
  assert.equal(noteValueOf(1).flags, 2, 'a sixteenth needs two flags');
});

test('the paper draws the value of each note, not one shape for all', () => {
  const sheet = sheetOf([
    note(72, 0, 2), // whole note
    note(72, 2, 1), // half note
    note(72, 3, 0.5), // quarter note
    note(72, 3.5, 0.25), // eighth note
  ], { duration: 8 });
  const byTime = new Map(sheet.glyphs.map((g) => [g.time, g]));
  assert.equal(byTime.get(0).value.name, 'whole');
  assert.equal(byTime.get(0).stem, null, 'a whole note must not carry a stem');
  assert.equal(byTime.get(2).value.open, true, 'a half note must print a hollow head');
  assert.equal(byTime.get(2).stem !== null, true, 'a half note carries a stem');
  assert.equal(byTime.get(3).value.open, false, 'a quarter note must print a solid head');
  assert.equal(byTime.get(3.5).flags >= 1 || byTime.get(3.5).beam !== null, true, 'an eighth note must show its value');
});

test('beams join the short notes of one beat and nothing else', () => {
  // Four eighths at 120 bpm: two fall on each side of the half-second beat.
  const sheet = sheetOf([
    note(72, 0, 0.25), note(74, 0.25, 0.25), note(76, 0.5, 0.25), note(77, 0.75, 0.25),
  ]);
  assert.equal(sheet.beams.length, 2, 'four eighths over two beats make two beams');
  const [first] = sheet.beams;
  assert.equal(first.count, 1, 'eighths take one beam line');
  assert.ok(first.x2 > first.x1, 'a beam must run left to right');
  assert.ok(first.y1 !== null && first.y2 !== null, 'a beam needs a height at both ends');

  // Every beamed note loses its flag, or the beam and the flag say it twice.
  for (const glyph of sheet.glyphs) {
    if (glyph.beam) assert.equal(glyph.flags, 0, 'a beamed note must not also draw a flag');
  }
});

test('a lone eighth keeps its flag, and a sixteenth takes two', () => {
  const sheet = sheetOf([note(72, 0, 0.25)], { duration: 4 });
  const [glyph] = sheet.glyphs;
  assert.equal(sheet.beams.length, 0, 'one short note cannot be beamed');
  assert.equal(glyph.flags, 1, 'a lone eighth needs its flag');
  assert.equal(glyph.stem !== null, true, 'a flag needs a stem to hang from');

  const run = sheetOf([
    note(72, 0, 0.125), note(74, 0.125, 0.125), note(76, 0.25, 0.125), note(77, 0.375, 0.125),
  ]);
  assert.equal(run.beams.length, 1, 'four sixteenths inside one beat make one beam');
  assert.equal(run.beams[0].count, 2, 'sixteenths take two beam lines');
});

test('a compound metre beams three eighths, not one', () => {
  const signature = [{ ticks: 0, timeSignature: [6, 8] }];
  const waltz = [];
  for (let i = 0; i < 6; i++) waltz.push(note(72 + (i % 3), i * 0.25, 0.25));
  const sheet = sheetOf(waltz, { duration: 3, timeSignatures: signature });
  assert.equal(sheet.beams.length, 2, '6/8 groups its eighths in threes');
  assert.equal(sheet.beams[0].time, 0);
  assert.equal(sheet.beams[1].time, 0.75, 'the second group starts a dotted quarter later');
});

test('a beamed group takes one stem direction from its average pitch', () => {
  // The first pair sits high on the staff and the second pair sits low.
  const sheet = sheetOf([
    note(81, 0, 0.25), note(83, 0.25, 0.25), note(60, 0.5, 0.25), note(62, 0.75, 0.25),
  ]);
  const [high, low] = sheet.beams;
  assert.equal(high.up, false, 'a high group must hang its stems down');
  assert.equal(low.up, true, 'a low group must point its stems up');
  for (const glyph of sheet.glyphs) {
    if (!glyph.beam) continue;
    assert.equal(glyph.stem.up, sheet.beams[glyph.beam.id].up, 'every stem in a beam must agree with its beam');
  }
});

test('a beam runs stem to stem and every stem ends on it', () => {
  const sheet = sheetOf([
    note(72, 0, 0.25), note(79, 0.25, 0.25), note(84, 0.5, 0.25), note(76, 0.75, 0.25),
  ]);
  const { gap } = sheet;
  assert.ok(sheet.beams.length >= 1, 'the run needs a beam');
  for (const [id, beam] of sheet.beams.entries()) {
    const members = sheet.glyphs.filter((g) => g.beam && g.beam.id === id);
    assert.ok(members.length >= 2, 'a beam joins at least two notes');
    const first = members[0];
    const last = members[members.length - 1];
    // A beam that stopped at the note centre would end one head short of the
    // stem it belongs to.
    assert.equal(beam.x1, first.x + first.stem.x, 'the beam must start on the first stem');
    assert.equal(beam.x2, last.x + last.stem.x, 'the beam must end on the last stem');
    const slope = (beam.y2 - beam.y1) / (beam.x2 - beam.x1);
    for (const glyph of members) {
      const at = beam.y1 + slope * ((glyph.x + glyph.stem.x) - beam.x1);
      assert.ok(Math.abs(glyph.stem.y2 - at) < 1e-6, 'a stem must end on the beam line');
      const length = Math.abs(glyph.stem.y2 - glyph.stem.y1) / gap;
      assert.ok(length >= MIN_STEM - 1e-6, `a stem of ${length.toFixed(2)} gaps is too short`);
      const headEnd = glyph.stem.up ? glyph.bottom : glyph.top;
      assert.equal(glyph.stem.y1, headEnd, 'a stem must start on the head that belongs to it');
      const away = glyph.stem.up ? glyph.stem.y2 < glyph.stem.y1 : glyph.stem.y2 > glyph.stem.y1;
      assert.ok(away, 'a stem must point away from its head');
    }
    assert.ok(Math.abs(beam.slope) <= BEAM_SLOPE + 1e-6, 'a beam must not tilt past the limit');
  }
});

test('a whole rest hangs from the fourth line and a half rest sits on the middle', () => {
  const sheet = sheetOf([
    note(72, 0, 0.5), note(72, 1.5, 0.5), note(72, 4.5, 0.5),
  ], { duration: 5 });
  const treble = sheet.rests.filter((r) => r.staff === TREBLE);
  const middle = sheet.staves.trebleTopY + 2 * sheet.gap;
  const half = treble.find((r) => r.symbol === 'half');
  const whole = treble.find((r) => r.symbol === 'whole');
  assert.ok(Math.abs(half.y - middle) < 1e-6, 'a half rest reads from the middle line');
  assert.ok(Math.abs(whole.y - (middle + sheet.gap)) < 1e-6, 'a whole rest reads from the fourth line');
});

test('a silent beat takes a rest, and a held note takes none', () => {
  // The right hand plays at 0 s and 1 s, so the beat between them needs a rest.
  const sheet = sheetOf([
    note(72, 0, 0.5), note(72, 1, 0.5),
  ], { duration: 1.5 });
  const treble = sheet.rests.filter((r) => r.staff === TREBLE);
  assert.equal(treble.length, 1, 'the silent beat takes one rest');
  assert.equal(treble[0].symbol, 'quarter', 'a silent beat reads as a quarter rest');
  assert.equal(treble[0].time, 0.5, 'the rest sits on the beat it fills');

  // A half note held across two beats leaves no room for a rest.
  const held = sheetOf([note(72, 0, 1)], { duration: 1 });
  const heldRests = held.rests.filter((r) => r.staff === TREBLE);
  assert.equal(heldRests.length, 0, 'a note that still sounds needs no rest');
});

test('two silent beats merge into a half rest, and a silent bar into a whole rest', () => {
  // Notes at 0 s, 1.5 s and 4.5 s leave beats 2 and 3 of bar one silent, and
  // the whole of bar two silent.
  const sheet = sheetOf([
    note(72, 0, 0.5), note(72, 1.5, 0.5), note(72, 4.5, 0.5),
  ], { duration: 5 });
  const treble = sheet.rests.filter((r) => r.staff === TREBLE);
  const symbols = treble.map((r) => r.symbol);
  assert.equal(symbols[0], 'half', 'the two silent beats of bar one merge');
  assert.equal(treble[0].time, 0.5, 'the half rest starts on the second beat, after the first note');
  const whole = treble.find((r) => r.symbol === 'whole');
  assert.ok(whole, 'a bar with no notes takes one whole rest');
  assert.equal(whole.time, 2, 'the whole rest starts the silent bar');
});

test('a staff the piece never uses draws no rests', () => {
  const sheet = sheetOf([note(72, 0, 0.5), note(74, 1, 0.5)], { duration: 2 });
  assert.equal(sheet.rests.filter((r) => r.staff === BASS).length, 0, 'an empty staff stays empty');
});

test('a dotted note carries one dot, in the space beside the head', () => {
  // 0.75 s at 120 bpm is three sixteenths, which is a dotted eighth.
  const sheet = sheetOf([note(72, 0, 0.75)]);
  const [glyph] = sheet.glyphs;
  assert.equal(glyph.value.dotted, true, 'three sixteenths is dotted');
  assert.equal(glyph.dots.length, 1, 'one head takes one dot');
  assert.ok(glyph.dots[0].x > 0, 'the dot sits right of the head');
  const head = glyph.heads[0];
  const onLine = Math.abs(head.step % 2) === 0;
  const wanted = onLine ? head.y - sheet.gap / 2 : head.y;
  assert.equal(glyph.dots[0].y, wanted, 'a dot on a lined head moves into the space above');
});

test('the time signature comes from the file, and the gutter reads it', () => {
  const sheet = sheetOf([note(72, 0, 0.5)], { timeSignatures: [{ ticks: 0, timeSignature: [3, 4] }] });
  assert.equal(sheet.signatures.length, 1);
  assert.equal(sheet.signatures[0].beats, 3);
  assert.equal(sheet.signatures[0].unit, 4);
  assert.equal(signatureAt(sheet.signatures, 10).beats, 3, 'the signature holds to the end of the piece');

  // A file with no signature reads as 4/4, and a change of signature lands at
  // the time the header gives it.
  const plain = layoutScore([note(72, 0)], { width: 1200 });
  assert.equal(plain.signatures[0].beats, 4, 'a bare file reads as 4/4');
  assert.equal(plain.signatures[0].unit, 4);
  const changed = sheetOf([note(72, 0, 0.5)], {
    timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }, { ticks: 480, timeSignature: [3, 4] }],
  });
  assert.equal(changed.signatures.length, 2, 'a mid-piece change makes a second segment');
  assert.equal(changed.signatures[1].beats, 3);
  assert.equal(signatureAt(changed.signatures, 0.4).beats, 4);
  assert.equal(signatureAt(changed.signatures, 0.6).beats, 3, 'a signature change lands at half a second');

  // The view writes the signature into the gutter, and the CSS styles it.
  assert.match(view, /_showSignature\(/, 'the view never shows the time signature');
  assert.match(view, /signatureAt\(/, 'the view does not follow a signature change');
  assert.ok(css.includes('.sc-sig {'), 'no .sc-sig rule in styles.css');
});

test('a key signature names its marks, and every mark sits on the staff', () => {
  assert.equal(keyAccidentalsOf({ key: 'Ab', scale: 'major' }), -4, 'four flats');
  assert.equal(keyAccidentalsOf({ key: 'B', scale: 'minor' }), 5, 'B minor carries the marks of D major');
  assert.equal(keyAccidentalsOf({ key: 'Cb', scale: 'major' }), -7);
  assert.equal(keyAccidentalsOf({ key: 'C#', scale: 'major' }), 7);
  assert.equal(keyAccidentalsOf({ key: 'C', scale: 'major' }), 0);
  assert.equal(keyAccidentalsOf({ key: 'H' }), 0, 'an unknown key name prints no mark');
  assert.equal(keyAccidentalsOf(null), 0);

  // The marks run F C G D A E B on the upper staff, and each sign keeps its
  // own letter.
  const sharps = keyMarkSteps(5, TREBLE);
  assert.equal(sharps.length, 5, 'five sharps take five marks');
  assert.deepEqual(sharps.map((m) => m.sign), ['#', '#', '#', '#', '#']);
  assert.deepEqual(sharps.map((m) => 'CDEFGAB'[m.step % 7]), ['F', 'C', 'G', 'D', 'A']);
  assert.equal(sharps[0].step, 38, 'the first treble sharp sits on the top line, F5');

  // The marks run B E A D G C F on the lower staff.
  const flats = keyMarkSteps(-4, BASS);
  assert.equal(flats.length, 4);
  assert.deepEqual(flats.map((m) => m.sign), ['b', 'b', 'b', 'b']);
  assert.deepEqual(flats.map((m) => 'CDEFGAB'[m.step % 7]), ['B', 'E', 'A', 'D']);

  assert.equal(keyMarkSteps(0, TREBLE).length, 0, 'C major prints no mark');
  assert.equal(keyMarkSteps(4, TREBLE).length, 4);
});

test('a note takes its spelling from the key', () => {
  // Four flats: B flat, E flat, A flat and D flat carry no sign of their own.
  assert.equal(pitchOf(70, -4).letter, 'B', 'B flat keeps the B space');
  assert.equal(pitchOf(70, -4).accidental, '');
  assert.equal(pitchOf(63, -4).accidental, '');
  assert.equal(pitchOf(61, -4).letter, 'D', 'D flat keeps the D line');
  assert.equal(pitchOf(62, -4).accidental, 'n', 'D natural cancels the mark of the key');
  // A note outside the key takes the plainest sign, in the direction of the key.
  assert.equal(pitchOf(66, -4).accidental, 'b', 'a flat key spells G flat, not F sharp');
  assert.equal(pitchOf(66, -4).letter, 'G');
  // The same pitch reads as a sharp in C major, and as a key note in five sharps.
  assert.equal(pitchOf(70, 0).letter, 'A');
  assert.equal(pitchOf(70, 0).accidental, '#');
  assert.equal(pitchOf(70, 5).accidental, '');
  // A flat lowers the letter, so C flat 4 prints on the middle C line.
  const cFlat = pitchOf(59, -7);
  assert.equal(cFlat.letter, 'C');
  assert.equal(cFlat.accidental, '');
  assert.equal(cFlat.octave, 4);
  assert.equal(cFlat.step, 28);
});

test('the paper prints the file key and drops the signs that key covers', () => {
  const notes = [note(70, 0), note(70, 1), note(62, 2), note(66, 3)];
  const keyed = sheetOf(notes, { keySignatures: [{ ticks: 0, key: 'Ab', scale: 'major' }] });
  assert.equal(keyed.keys.length, 1);
  assert.equal(keyed.keys[0].accidentals, -4);
  assert.equal(keyed.keys[0].guessed, false, 'the file named its key');
  const signs = keyed.glyphs.flatMap((g) => g.heads.map((h) => h.accidental));
  assert.deepEqual(
    signs,
    ['', '', 'n', 'b'],
    'the key covers B flat, D natural cancels its flat, and G flat sits outside the key',
  );

  // The same notes in C major print a sharp on every black key.
  const plain = sheetOf(notes);
  assert.equal(plain.glyphs.flatMap((g) => g.heads.map((h) => h.accidental)).filter(Boolean).length, 3);
});

test('a key change lands at the time the file gives it', () => {
  const keys = keySegments([
    { ticks: 0, key: 'Ab', scale: 'major' },
    { ticks: 480, key: 'E', scale: 'major' },
    { ticks: 960, key: 'Ab', scale: 'major' },
  ], TEMPOS, PPQ);
  assert.equal(keys.length, 3, 'three signatures over the piece');
  assert.equal(keyAt(keys, 0).accidentals, -4);
  assert.equal(keyAt(keys, 0.6).accidentals, 4, 'the middle section takes four sharps');
  assert.equal(keyAt(keys, 2.5).accidentals, -4, 'the last segment holds to the end');
  // A repeated signature adds no segment, and a file with no event adds none.
  assert.equal(keySegments([{ ticks: 0, key: 'C' }, { ticks: 480, key: 'C' }], TEMPOS, PPQ).length, 1);
  assert.deepEqual(keySegments([], TEMPOS, PPQ), []);
  assert.equal(keySegments(null, TEMPOS, PPQ).length, 0);
});

test('a file with no key event takes the signature that needs the fewest marks', () => {
  const scale = [0, 2, 4, 5, 7, 9, 11].map((pc, i) => note(60 + pc, i * 0.5));
  assert.equal(guessAccidentals(scale), 0, 'a C major scale keeps an empty signature');
  const gMajor = [7, 9, 11, 0, 2, 4, 6].map((pc, i) => note(60 + pc, i * 0.5));
  assert.equal(guessAccidentals(gMajor), 1, 'a G major scale takes one sharp');
  const dMinor = [2, 4, 5, 7, 9, 10, 0].map((pc, i) => note(60 + pc, i * 0.5));
  assert.equal(guessAccidentals(dMinor), -1, 'D natural minor shares the signature of F major');
  assert.equal(guessAccidentals([]), 0, 'no notes take no mark');

  const sheet = layoutScore(scale, { width: 1200, tempos: TEMPOS, ppq: PPQ });
  assert.equal(sheet.keys[0].guessed, true, 'the sheet marks a signature that it had to infer');
});

test('the view draws the key signature and follows a key change', () => {
  assert.match(view, /_showKey\(/, 'the view never shows the key signature');
  assert.match(view, /keyMarkSteps\(/, 'the view never places the marks');
  assert.match(view, /keyAt\(/, 'the view does not follow a key change');
  assert.match(view, /signGlyph\(/, 'the view never prints the music glyph of a sign');
  assert.ok(css.includes('.sc-key {'), 'no .sc-key rule in styles.css');
  assert.match(player, /keySignatures: midi\.header\.keySignatures/, 'the player never publishes the key signature');
  assert.match(main, /meta: p\.scoreMeta/, 'the view never receives the key signature');
});

test('the marks pack tight, and a note stops at the left margin', () => {
  // A printed signature sets its marks about two fifths of a line gap apart,
  // not the full gap that the first version used.
  assert.match(view, /const KEY_GAP = 0\.42/, 'the mark pitch left the printed range');
  assert.match(view, /this\.keyGap = gap \* KEY_GAP/, 'the key signature is spaced too wide');
  assert.match(view, /KEY_SQUEEZE/, 'a mark needs a squeeze to fit that pitch');
  // The note layer carries a clip that starts on the system line in the gutter,
  // inside a group with no transform of its own.
  assert.match(view, /clipPath/, 'the paper has no clip at the left margin');
  assert.match(view, /'clip-path': 'url\(#sc-clip\)'/, 'the note layer is not clipped at the left margin');
  assert.match(view, /this\._layoutGutter\(\)/, 'the gutter is measured after the clip is built');
  assert.match(view, /this\.marginX = Math\.round\(this\.gutterWidth - BRACKET\)/, 'the margin must sit on the system line');
  assert.match(view, /x: this\.marginX/, 'the clip must start on the system line, not the marker');
  assert.match(view, /this\.clip\.appendChild\(this\.world\)/, 'the note layer must sit inside the clip group');
});

test('every mark the paper draws stays on the paper', () => {
  const sheet = sheetOf([
    note(21, 0, 1), note(108, 0, 1), note(60, 1, 1, 'L'), note(72, 2, 0.5),
  ], { duration: 8 });
  const limited = layoutScore([
    note(21, 0, 1), note(108, 0, 1), note(60, 1, 1, 'L'), note(72, 2, 0.5),
  ], {
    bars: barsOf(8),
    width: 1200,
    maxHeight: 190,
    tempos: TEMPOS,
    ppq: PPQ,
    timeSignatures: SIGNATURES,
  });
  for (const sheetToCheck of [sheet, limited]) {
    for (const glyph of sheetToCheck.glyphs) {
      for (const head of glyph.heads) {
        assert.ok(head.y >= 0 && head.y <= sheetToCheck.height, `MIDI ${head.midi} left the paper`);
      }
      if (glyph.stem) {
        const low = Math.min(glyph.stem.y1, glyph.stem.y2);
        const high = Math.max(glyph.stem.y1, glyph.stem.y2);
        assert.ok(low >= -1 && high <= sheetToCheck.height + 1, 'a stem left the paper');
      }
    }
    for (const rest of sheetToCheck.rests) {
      assert.ok(rest.y >= 0 && rest.y <= sheetToCheck.height, 'a rest left the paper');
    }
    for (const beam of sheetToCheck.beams) {
      assert.ok(beam.y1 >= 0 && beam.y1 <= sheetToCheck.height, 'a beam left the paper');
      assert.ok(beam.y2 >= 0 && beam.y2 <= sheetToCheck.height, 'a beam left the paper');
    }
  }

  // The widest signature still finds room for every mark on both staves.
  for (const key of ['C#', 'Cb']) {
    const wide = sheetOf([note(60, 0, 1), note(72, 1, 1)], {
      keySignatures: [{ ticks: 0, key, scale: 'major' }],
    });
    assert.equal(Math.abs(wide.keys[0].accidentals), 7, `${key} must print seven marks`);
    for (const staff of [TREBLE, BASS]) {
      for (const mark of keyMarkSteps(wide.keys[0].accidentals, staff)) {
        const y = (staff === BASS ? wide.staves.bassTopY : wide.staves.trebleTopY)
          + ((staff === BASS ? wide.staves.bassTop : wide.staves.trebleTop) - mark.step) * (wide.gap / 2);
        assert.ok(y >= 0 && y <= wide.height, `a ${key} mark left the paper`);
      }
    }
  }
});

test('the view draws every symbol the layout describes', () => {
  for (const name of ['.sc-head.open', '.sc-flag', '.sc-beam', '.sc-dot', '.sc-rest', '.sc-rest-fill', '.sc-sig', '.sc-key']) {
    assert.ok(css.includes(`${name} {`), `no ${name} rule in styles.css`);
  }
  assert.match(view, /flagPath\(/, 'the view never draws a flag');
  assert.match(view, /restNode\(/, 'the view never draws a rest');
  assert.match(view, /class: 'sc-beam'/, 'the view never draws a beam');
  assert.match(view, /glyph\.value\.open \? 'sc-head open'/, 'the view never prints a hollow head');
  assert.match(view, /this\.marks/, 'the view never draws the beams and rests');
});