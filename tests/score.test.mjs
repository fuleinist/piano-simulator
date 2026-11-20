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
  BASS, MAX_GAP, MIN_GAP, PAD, TREBLE, barTimes, layoutScore, ledgerStepsOf, pitchOf,
  staffOf, ticksToSeconds,
} from '../src/score.js';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('src/styles.css');
const main = read('src/main.js');
const player = read('src/player.js');

const note = (midi, time, duration = 0.5, hand = 'R') => ({ midi, time, duration, hand });

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

test('a pitch maps to its line on the staff, and a sharp keeps its letter', () => {
  assert.deepEqual(
    { ...pitchOf(60) },
    { letter: 'C', accidental: '', octave: 4, step: 28, pc: 0 },
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
  const layout = layoutScore([note(61, 1), note(63, 1), note(65, 1)], { width: 1200 });
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
});