// Sheet-music layout. Pure module: no DOM and no three.js, so a Node test can
// measure every position it produces.
//
// The sheet is a grand staff on one pitch grid. The right hand takes the upper
// staff and the left hand takes the lower staff, which follows the hand split.
// A note outside its staff draws ledger lines.
//
// Coordinates: x grows to the right and equals the note time times the scroll
// speed. y grows downward from the top of the paper. One staff line gap is the
// unit for every mark that touches a note.

export const TREBLE = 'treble';
export const BASS = 'bass';

// Steps are diatonic positions: C0 is 0, D0 is 1, and C1 is 7. A staff spans
// eight steps, and a step is half a line gap.
export const MIDDLE_C_STEP = 28;
export const TREBLE_TOP_STEP = 38; // F5, the top line of the upper staff
export const BASS_TOP_STEP = 26; // A3, the top line of the lower staff
export const TREBLE_MID_STEP = 32; // G4, where the treble clef turns
export const BASS_MID_STEP = 24; // F3, where the bass clef turns
const STAFF_STEPS = 8; // the steps between the outer lines of one staff

export const PAD = 14; // paper above and below the staves, in px
export const MAX_GAP = 11; // widest line gap, in px
export const MIN_GAP = 5.5; // narrowest line gap, in px
export const HEAD_RX = 0.55; // notehead radius across, in line gaps
export const HEAD_RY = 0.42; // notehead radius down, in line gaps
export const STEM_LEN = 3.4; // stem length, in line gaps
// Extra line gaps between the two staves of the grand staff. With the two gaps
// the pitch grid already gives, the staves sit six gaps apart, which is the
// spacing a printed piano score uses.
export const STAFF_GAP = 4;
export const CHUNK_SECONDS = 4; // how much music one scroll block holds
export const PLAYHEAD_RATIO = 0.34; // where the notes cross the marker
export const CHORD_WINDOW = 0.04; // notes this close share a stem, in seconds

const LETTERS = 'CDEFGAB';
const LETTER_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const SHARP_PCS = new Set([1, 3, 6, 8, 10]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Diatonic position of a MIDI note. A sharp note keeps the letter below it. */
export function pitchOf(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const letter = LETTER_OF_PC[pc];
  const octave = Math.floor(midi / 12) - 1;
  return {
    letter: LETTERS[letter],
    accidental: SHARP_PCS.has(pc) ? '#' : '',
    octave,
    step: octave * 7 + letter,
    pc,
  };
}

/** Which staff a note belongs to. The hand decides; the register is a fallback. */
export function staffOf(note) {
  if (note.hand === 'L') return BASS;
  if (note.hand === 'R') return TREBLE;
  return pitchOf(note.midi).step < MIDDLE_C_STEP ? BASS : TREBLE;
}

/** Steps of the ledger lines that this note needs, outside its own staff. */
export function ledgerStepsOf(step, staff = TREBLE) {
  const steps = [];
  const top = staffTopStep(staff);
  const bottom = top - 8; // a staff spans eight steps between its outer lines
  for (let s = top + 2; s <= step; s += 2) steps.push(s);
  for (let s = bottom - 2; s >= step; s -= 2) steps.push(s);
  return steps;
}

/** Step of the top line of a staff. */
export function staffTopStep(staff) {
  return staff === BASS ? BASS_TOP_STEP : TREBLE_TOP_STEP;
}

/** Seconds from the start of a file for a tick position, across tempo changes. */
export function ticksToSeconds(ticks, tempos, ppq) {
  let seconds = 0;
  let lastTicks = 0;
  let bpm = 120; // the value a MIDI file uses before its first tempo event
  for (const tempo of tempos) {
    if (tempo.ticks >= ticks) break;
    seconds += ((tempo.ticks - lastTicks) / ppq) * (60 / bpm);
    lastTicks = tempo.ticks;
    bpm = tempo.bpm;
  }
  return seconds + ((ticks - lastTicks) / ppq) * (60 / bpm);
}

/**
 * Where the bar lines fall, in seconds. A file with no time signature gets
 * 4/4, which is what the MIDI standard specifies. `duration` bounds the list:
 * a bar that starts after the piece ends is of no use to the sheet.
 */
export function barTimes(header, { duration = Infinity, maxBars = 4000 } = {}) {
  const ppq = header.ppq || 480;
  const tempos = [...(header.tempos || [])].sort((a, b) => a.ticks - b.ticks);
  const sigs = [...(header.timeSignatures || [])].sort((a, b) => a.ticks - b.ticks);
  if (!sigs.length) sigs.push({ ticks: 0, timeSignature: [4, 4] });

  const bars = [];
  for (let i = 0; i < sigs.length && bars.length < maxBars; i++) {
    const [beats, unit] = sigs[i].timeSignature;
    const ticksPerBar = (ppq * 4 * beats) / unit;
    const stop = i + 1 < sigs.length ? sigs[i + 1].ticks : Infinity;
    if (!(ticksPerBar >= 1)) continue;
    for (let tick = sigs[i].ticks; tick < stop && bars.length < maxBars; tick += ticksPerBar) {
      const seconds = ticksToSeconds(tick, tempos, ppq);
      if (seconds > duration) break;
      bars.push(seconds);
    }
  }
  return bars.filter((t, i) => i === 0 || t > bars[i - 1] + 1e-3);
}

/**
 * How fast the paper scrolls, in pixels per second.
 *
 * Six seconds of music should fit across the paper, so the player can read
 * ahead. A dense piece needs more room than that, or two noteheads overlap, so
 * the spacing between onsets raises the speed. A narrow screen caps the speed,
 * because a fast scroll there would show less than a beat.
 */
export function scrollSpeed(notes, { width = 1200, gap = MAX_GAP } = {}) {
  const onsets = [];
  for (const note of notes) {
    if (!onsets.length || note.time - onsets[onsets.length - 1] >= 0.02) onsets.push(note.time);
  }
  const spacings = [];
  for (let i = 1; i < onsets.length; i++) spacings.push(onsets[i] - onsets[i - 1]);
  spacings.sort((a, b) => a - b);
  // The fast passages set the speed, not the average: a piece with a few runs
  // of sixteenth notes must not smear them. The lower quartile stands for them.
  const typical = spacings.length ? spacings[Math.floor(spacings.length / 4)] : 0.4;
  const headWidth = 2 * HEAD_RX * gap;
  const forSpacing = (1.7 * headWidth) / Math.max(typical, 0.04);
  return clamp(Math.max(width / 6, forSpacing), 56, Math.min(240, width / 4));
}

/**
 * Lay a piece out on the two staves.
 *
 * `maxHeight` is the height the window can give the paper. The line gap shrinks
 * to fit a wide register, so no note leaves the paper, and never grows past
 * MAX_GAP.
 */
export function layoutScore(notes, { bars = [], width = 1200, maxHeight = 190 } = {}) {
  const sorted = notes
    .filter((n) => Number.isFinite(n.time) && Number.isFinite(n.midi))
    .slice()
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  let minStep = BASS_TOP_STEP - STAFF_STEPS; // G2, the bottom line of the lower staff
  let maxStep = TREBLE_TOP_STEP; // F5, the top line of the upper staff
  let midiMin = null;
  let midiMax = null;
  for (const note of sorted) {
    const { step } = pitchOf(note.midi);
    if (step < minStep) minStep = step;
    if (step > maxStep) maxStep = step;
    if (midiMin === null || note.midi < midiMin) midiMin = note.midi;
    if (midiMax === null || note.midi > midiMax) midiMax = note.midi;
  }

  const topRef = Math.max(TREBLE_TOP_STEP, maxStep);
  const bottomRef = Math.min(BASS_TOP_STEP - STAFF_STEPS, minStep);
  const halfSteps = topRef - bottomRef;
  // A grand staff leaves air between its two staves. The pitch grid already
  // separates them by two line gaps, so STAFF_GAP adds the rest.
  const gap = clamp((maxHeight - 2 * PAD) / (halfSteps / 2 + STAFF_GAP), MIN_GAP, MAX_GAP);
  const staffShift = STAFF_GAP * gap;
  const height = 2 * PAD + (halfSteps / 2) * gap + staffShift;
  const pxPerSecond = scrollSpeed(sorted, { width, gap });

  const yOfStep = (step, staff) => PAD + (topRef - step) * (gap / 2) + (staff === BASS ? staffShift : 0);
  const trebleTopY = PAD + (topRef - TREBLE_TOP_STEP) * (gap / 2);
  const bassTopY = trebleTopY + 6 * gap + staffShift;
  const glyphs = [];
  let i = 0;
  while (i < sorted.length) {
    // One onset window, then one stem per hand inside it. Each note extends
    // the window when it follows the note before it, so a rolled chord shares
    // one stem. The span is capped, so a fast run stays separate notes.
    let end = i + 1;
    while (
      end < sorted.length
      && sorted[end].time - sorted[end - 1].time <= CHORD_WINDOW
      && sorted[end].time - sorted[i].time <= 2 * CHORD_WINDOW
    ) end++;
    const window = sorted.slice(i, end);
    i = end;
    for (const staff of [TREBLE, BASS]) {
      const chord = window.filter((n) => staffOf(n) === staff);
      if (chord.length) glyphs.push(glyphOf(chord, staff, { gap, yOfStep, pxPerSecond }));
    }
  }
  glyphs.sort((a, b) => a.time - b.time || a.staff.localeCompare(b.staff));

  const duration = sorted.length ? Math.max(...sorted.map((n) => n.time + (n.duration || 0))) : 0;
  const barSeconds = bars.filter((t) => Number.isFinite(t) && t >= 0 && t <= duration);

  return {
    gap,
    height,
    width,
    pxPerSecond,
    playheadRatio: PLAYHEAD_RATIO,
    chunkSeconds: CHUNK_SECONDS,
    noteCount: sorted.length,
    midiMin,
    midiMax,
    steps: { min: minStep, max: maxStep },
    staves: {
      trebleTop: TREBLE_TOP_STEP,
      bassTop: BASS_TOP_STEP,
      topRef,
      bottomRef,
      staffShift,
      trebleTopY,
      bassTopY,
      bassBottomY: bassTopY + 4 * gap,
      trebleBottomY: trebleTopY + 4 * gap,
    },
    glyphs,
    bars: barSeconds,
    duration,
  };
}

function glyphOf(chord, staff, { gap, yOfStep, pxPerSecond }) {
  const first = chord[0];
  const heads = chord.map((note) => {
    const { step, accidental } = pitchOf(note.midi);
    return {
      midi: note.midi,
      step,
      y: yOfStep(step, staff),
      accidental,
      start: note.time,
      end: note.time + (note.duration || 0),
      hand: note.hand,
    };
  });

  const top = Math.min(...heads.map((h) => h.y));
  const bottom = Math.max(...heads.map((h) => h.y));
  // A stem points away from the middle line of its own staff.
  const middleStep = staffTopStep(staff) - 4;
  const meanStep = heads.reduce((sum, h) => sum + h.step, 0) / heads.length;
  const up = meanStep < middleStep;
  const offset = HEAD_RX * gap;
  const stem = up
    ? { x: offset, y1: bottom, y2: top - STEM_LEN * gap }
    : { x: -offset, y1: top, y2: bottom + STEM_LEN * gap };

  const ledgers = [...new Set(heads.flatMap((h) => ledgerStepsOf(h.step, staff)))].map((step) => ({
    y: yOfStep(step, staff),
    x1: -1.5 * gap,
    x2: 1.5 * gap,
  }));

  return {
    time: first.time,
    x: first.time * pxPerSecond,
    staff,
    hand: first.hand || (staff === BASS ? 'L' : 'R'),
    heads,
    stem,
    ledgers,
    start: Math.min(...heads.map((h) => h.start)),
    end: Math.max(...heads.map((h) => h.end)),
  };
}