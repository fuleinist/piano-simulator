// Sheet-music layout. Pure module: no DOM and no three.js, so a Node test can
// measure every position it produces.
//
// The sheet is a grand staff on one pitch grid. The right hand takes the upper
// staff and the left hand takes the lower staff, which follows the hand split.
// A note outside its staff draws ledger lines. The key signature sets the marks
// in the gutter, and it spells every notehead.
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
export const OPEN_RX = 0.62; // a hollow head is wider, so the hole stays open
export const DOT_GAP = 0.7; // space before an augmentation dot, in line gaps
export const STEM_LEN = 3.4; // stem length, in line gaps
export const MIN_STEM = 2.5; // shortest stem a beam may leave, in line gaps
export const BEAM_THICK = 0.45; // beam line thickness, in line gaps
export const BEAM_SPACE = 0.25; // gap between two beam lines, in line gaps
export const BEAM_SLOPE = 0.3; // steepest beam rise, in line gaps per gap of run
// Extra line gaps between the two staves of the grand staff. With the two gaps
// the pitch grid already gives, the staves sit six gaps apart, which is the
// spacing a printed piano score uses.
export const STAFF_GAP = 4;
export const CHUNK_SECONDS = 4; // how much music one scroll block holds
export const PLAYHEAD_RATIO = 0.34; // where the notes cross the marker
export const CHORD_WINDOW = 0.04; // notes this close share a stem, in seconds

// Written note values live on this scale, in sixteenths. A dot adds half the
// value, so the dotted values sit halfway between two plain ones.
const SIXTEENTHS = [16, 12, 8, 6, 4, 3, 2, 1.5, 1];
const VALUE_BASE = new Map([[16, 16], [12, 8], [8, 8], [6, 4], [4, 4], [3, 2], [2, 2], [1.5, 1], [1, 1]]);
const VALUE_NAME = new Map([
  [16, 'whole'], [12, 'half'], [8, 'half'], [6, 'quarter'], [4, 'quarter'],
  [3, 'eighth'], [2, 'eighth'], [1.5, 'sixteenth'], [1, 'sixteenth'],
]);
const FLAGS_OF = new Map([[16, 0], [8, 0], [4, 0], [2, 1], [1, 2]]);
const REST_OF_BEAT = new Map([[4, 'quarter'], [8, 'eighth'], [2, 'half'], [16, 'sixteenth']]);

const LETTERS = 'CDEFGAB';
// The pitch class of each letter with no accidental: C D E F G A B.
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
// The order in which the marks of a key signature appear, as letter indexes.
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
// The key name of each mark count, from seven flats to seven sharps. A MIDI
// key-signature event names the key this way, and the position of the name
// gives the mark count back.
const KEY_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
// The step that each mark of a key signature sits on, in the order the marks
// appear. A treble signature runs from F5 down the staff, a bass one from F3.
const SHARP_STEPS = {
  [TREBLE]: [38, 35, 39, 36, 33, 37, 34],
  [BASS]: [24, 21, 25, 22, 19, 23, 20],
};
const FLAT_STEPS = {
  [TREBLE]: [34, 37, 33, 36, 32, 35, 30],
  [BASS]: [20, 23, 19, 22, 18, 21, 17],
};
// Each printed mark must buy this much more of the piece inside the key, or a
// signature with no marks is the better answer.
const MARK_COST = 0.005;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The alteration that each letter carries in a key with `accidentals` marks.
 * A sharp signature raises the letters F C G D A E B in that order, and a flat
 * signature lowers B E A D G C F. One element per letter index.
 */
function keyAlters(accidentals) {
  const count = clamp(Math.round(accidentals || 0), -7, 7);
  const alters = new Array(7).fill(0);
  const order = count > 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.abs(count); i++) alters[order[i]] = Math.sign(count);
  return alters;
}

/** The mark count of a MIDI key-signature event. A positive count is sharps. */
export function keyAccidentalsOf(event) {
  if (typeof event === 'number') return clamp(Math.round(event), -7, 7);
  const index = event && typeof event.key === 'string' ? KEY_NAMES.indexOf(event.key) : -1;
  return index < 0 ? 0 : index - 7;
}

/** The pitch classes that a key signature covers. */
export function keyScalePcs(accidentals) {
  const alters = keyAlters(accidentals);
  return new Set(LETTER_PC.map((pc, letter) => (((pc + alters[letter]) % 12) + 12) % 12));
}

/**
 * Diatonic position of a MIDI note, spelled for a key.
 *
 * A note that the key signature covers carries no accidental. A note that
 * cancels a mark of the key carries a natural sign. A note outside the key
 * takes the letter that needs the plainest mark, and the key's own direction
 * decides between two spellings that cost the same.
 */
export function pitchOf(midi, accidentals = 0) {
  const pc = ((midi % 12) + 12) % 12;
  const alters = keyAlters(accidentals);
  const wanted = (accidentals || 0) < 0 ? -1 : 1;
  let best = null;
  for (let letter = 0; letter < 7; letter++) {
    let alter = (((pc - LETTER_PC[letter]) % 12) + 12) % 12;
    if (alter > 6) alter -= 12;
    if (Math.abs(alter) > 2) continue;
    const mark = alters[letter];
    const accidental = alter === mark
      ? ''
      : alter === 0
        ? 'n'
        : (alter > 0 ? '#' : 'b').repeat(Math.abs(alter));
    // No mark reads best, then a natural sign, then one mark, then two.
    const cost = accidental === '' ? 0 : accidental === 'n' ? 1 : Math.abs(alter) + 1;
    // Two letters can cost the same mark, and only the key can choose.
    const rank = cost * 2 + (Math.sign(alter) === wanted ? 0 : 1);
    if (!best || rank < best.rank) best = { letter, alter, accidental, rank };
  }
  // The octave follows the letter, not the sounding pitch: C flat 4 is a B3,
  // and it sits on the middle C line.
  const octave = Math.floor((midi - best.alter) / 12) - 1;
  return {
    letter: LETTERS[best.letter],
    accidental: best.accidental,
    alter: best.alter,
    octave,
    step: octave * 7 + best.letter,
    pc,
  };
}

/**
 * The marks of a key signature on one staff, in the order they appear. Each
 * mark names the step it sits on and the sign it prints.
 */
export function keyMarkSteps(accidentals, staff = TREBLE) {
  const count = clamp(Math.round(accidentals || 0), -7, 7);
  const steps = (count > 0 ? SHARP_STEPS : FLAT_STEPS)[staff] || SHARP_STEPS[TREBLE];
  const sign = count > 0 ? '#' : 'b';
  return steps.slice(0, Math.abs(count)).map((step) => ({ step, sign }));
}

/**
 * The key signature that needs the fewest marks for the notes of a piece.
 *
 * A MIDI file need not carry a key-signature event. The sheet then prints the
 * marks that cover most of the sounding time, and pays for each mark, so a
 * piece in C major keeps an empty signature instead of a needless one.
 */
export function guessAccidentals(notes = []) {
  const weight = new Array(12).fill(0);
  let total = 0;
  for (const note of notes) {
    if (!Number.isFinite(note.midi)) continue;
    const held = Math.max(Number(note.duration) || 0, 0.02);
    weight[((note.midi % 12) + 12) % 12] += held;
    total += held;
  }
  if (!(total > 0)) return 0;
  // Fewest marks first, so the smallest signature wins a tie.
  const order = [0];
  for (let count = 1; count <= 7; count++) order.push(count, -count);
  let best = 0;
  let bestCost = Infinity;
  for (const accidentals of order) {
    const scale = keyScalePcs(accidentals);
    let inside = 0;
    for (let pc = 0; pc < 12; pc++) if (scale.has(pc)) inside += weight[pc];
    const cost = (total - inside) / total + Math.abs(accidentals) * MARK_COST;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = accidentals;
    }
  }
  return best;
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

/** Ticks from the start of a file for a time in seconds, across tempo changes. */
export function secondsToTicks(seconds, tempos = [], ppq = 480) {
  let ticks = 0;
  let lastSeconds = 0;
  let bpm = 120;
  for (const tempo of [...tempos].sort((a, b) => a.ticks - b.ticks)) {
    const at = lastSeconds + ((tempo.ticks - ticks) / ppq) * (60 / bpm);
    if (at >= seconds) break;
    lastSeconds = at;
    ticks = tempo.ticks;
    bpm = tempo.bpm;
  }
  return ticks + ((seconds - lastSeconds) * bpm * ppq) / 60;
}

/**
 * The written value that a duration in sixteenths is closest to. A player
 * needs the shape, not the exact length: a note held a little long is still a
 * quarter note, and a note held for six sixteenths is a dotted quarter.
 */
export function noteValueOf(sixteenths) {
  const span = Math.max(sixteenths, 0.05);
  let best = SIXTEENTHS[SIXTEENTHS.length - 1];
  let closest = Infinity;
  for (const value of SIXTEENTHS) {
    // Compare on a log scale, so a dotted value wins its own neighbourhood and
    // not the wide one that a plain value of the next size would take.
    const distance = Math.abs(Math.log(value / span));
    if (distance < closest) {
      closest = distance;
      best = value;
    }
  }
  const base = VALUE_BASE.get(best);
  return {
    name: VALUE_NAME.get(best),
    sixteenths: base,
    dotted: best !== base,
    flags: FLAGS_OF.get(base) || 0,
    open: base >= 8, // a half note or a whole note prints a hollow head
    stem: base !== 16, // a whole note has no stem
  };
}

/**
 * The time signatures in force over the piece, each with the time it starts.
 * A file with no signature gets 4/4, which is what the MIDI standard means.
 */
export function signatureSegments(timeSignatures = [], tempos = [], ppq = 480) {
  const sigs = [...(timeSignatures || [])].sort((a, b) => a.ticks - b.ticks);
  if (!sigs.length) sigs.push({ ticks: 0, timeSignature: [4, 4] });
  const segments = [];
  for (const sig of sigs) {
    const [beats, unit] = sig.timeSignature || [4, 4];
    if (!(beats > 0) || !(unit > 0)) continue;
    const time = ticksToSeconds(sig.ticks || 0, tempos, ppq);
    if (segments.length && Math.abs(time - segments[segments.length - 1].time) < 1e-3) {
      segments[segments.length - 1] = { time, beats, unit };
    } else {
      segments.push({ time, beats, unit });
    }
  }
  if (!segments.length) segments.push({ time: 0, beats: 4, unit: 4 });
  return segments;
}

/**
 * The key signatures in force over the piece, each with the time it starts.
 * A file with no key-signature event gives an empty list.
 */
export function keySegments(keySignatures = [], tempos = [], ppq = 480) {
  const events = [...(keySignatures || [])].sort((a, b) => (a.ticks || 0) - (b.ticks || 0));
  const segments = [];
  for (const event of events) {
    const accidentals = keyAccidentalsOf(event);
    const time = ticksToSeconds(event.ticks || 0, tempos, ppq);
    const last = segments[segments.length - 1];
    // Two events at one instant describe one key: the later event wins.
    if (last && Math.abs(time - last.time) < 1e-3) last.accidentals = accidentals;
    else if (last && last.accidentals === accidentals) continue;
    else segments.push({ time, accidentals, guessed: false });
  }
  // The first event holds from the start, as the MIDI standard says.
  if (segments.length && segments[0].time > 1e-3) {
    segments.unshift({ time: 0, accidentals: segments[0].accidentals, guessed: false });
  }
  return segments;
}

/** The time signature in force at a time, in seconds. */
export function signatureAt(segments, time) {
  let found = segments[0];
  for (const segment of segments) {
    if (segment.time <= time + 1e-6) found = segment;
  }
  return found;
}

/** The key signature in force at a time, in seconds. */
export const keyAt = signatureAt;

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
export function layoutScore(notes, {
  bars = [], width = 1200, maxHeight = 190, tempos = [], ppq = 480, timeSignatures = [],
  keySignatures = [],
} = {}) {
  const sorted = notes
    .filter((n) => Number.isFinite(n.time) && Number.isFinite(n.midi))
    .slice()
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  // The key signature decides how a note is spelled, so it comes before any
  // pitch is placed on the staff. A file without a key-signature event takes
  // the signature that needs the fewest marks for its own notes.
  const signatures = signatureSegments(timeSignatures, tempos, ppq);
  let keys = keySegments(keySignatures, tempos, ppq);
  if (!keys.length) keys = [{ time: 0, accidentals: guessAccidentals(sorted), guessed: true }];
  const accidentalsAt = (time) => keyAt(keys, time).accidentals;

  let minStep = BASS_TOP_STEP - STAFF_STEPS; // G2, the bottom line of the lower staff
  let maxStep = TREBLE_TOP_STEP; // F5, the top line of the upper staff
  let midiMin = null;
  let midiMax = null;
  for (const note of sorted) {
    const { step } = pitchOf(note.midi, accidentalsAt(note.time));
    if (step < minStep) minStep = step;
    if (step > maxStep) maxStep = step;
    if (midiMin === null || note.midi < midiMin) midiMin = note.midi;
    if (midiMax === null || note.midi > midiMax) midiMax = note.midi;
  }
  // A sign outside the staff still needs its room on the paper.
  for (const segment of keys) {
    for (const staff of [TREBLE, BASS]) {
      for (const mark of keyMarkSteps(segment.accidentals, staff)) {
        if (mark.step < minStep) minStep = mark.step;
        if (mark.step > maxStep) maxStep = mark.step;
      }
    }
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
      if (chord.length) {
        glyphs.push(glyphOf(chord, staff, {
          gap, yOfStep, pxPerSecond, tempos, ppq, height, accidentalsAt,
        }));
      }
    }
  }
  glyphs.sort((a, b) => a.time - b.time || a.staff.localeCompare(b.staff));

  const duration = sorted.length ? Math.max(...sorted.map((n) => n.time + (n.duration || 0))) : 0;
  // A player holds a note past the next onset. A printed score cannot: without a
  // tie the value stops at the next note on that staff, so the shape reads true
  // and a legato touch does not fill the paper with dots.
  for (const staff of [TREBLE, BASS]) {
    const list = glyphs.filter((g) => g.staff === staff);
    const grid = ppq / 4;
    for (let index = 0; index + 1 < list.length; index++) {
      const glyph = list[index];
      const next = list[index + 1].time;
      if (!(next > glyph.time) || next >= glyph.end) continue;
      // Quantise to the sixteenth grid: a played position is never exactly on
      // it, and a value taken from raw milliseconds is dotted for no reason.
      const from = Math.round(secondsToTicks(glyph.time, tempos, ppq) / grid) * grid;
      const to = Math.round(secondsToTicks(next, tempos, ppq) / grid) * grid;
      setValue(glyph, Math.max(1, (to - from) / grid), gap, height);
    }
  }
  const barSeconds = bars.filter((t) => Number.isFinite(t) && t >= 0 && t <= duration);
  const beams = applyBeams(glyphs, {
    gap, tempos, ppq, height, sigAt: (time) => signatureAt(signatures, time),
  });
  const rests = layoutRests(glyphs, {
    bars: barSeconds, sigs: signatures, tempos, ppq, pxPerSecond, duration, yOfStep,
    middleSteps: { [TREBLE]: TREBLE_TOP_STEP - 4, [BASS]: BASS_TOP_STEP - 4 },
  });
  const marks = [...beams, ...rests].sort((a, b) => a.time - b.time);

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
    beams,
    rests,
    marks,
    signatures,
    keys,
    bars: barSeconds,
    duration,
  };
}

function glyphOf(chord, staff, {
  gap, yOfStep, pxPerSecond, tempos = [], ppq = 480, height = Infinity,
  accidentalsAt = () => 0,
}) {
  const first = chord[0];
  const heads = chord.map((note) => {
    const { step, accidental } = pitchOf(note.midi, accidentalsAt(note.time));
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

  // The written value comes from the longest note under the stem, measured in
  // sixteenths so a dotted value and a plain one are both on the same scale.
  const held = Math.max(...chord.map((note) => note.duration || 0));
  const startTicks = secondsToTicks(first.time, tempos, ppq);
  const endTicks = secondsToTicks(first.time + held, tempos, ppq);
  const value = noteValueOf((endTicks - startTicks) / (ppq / 4));

  const top = Math.min(...heads.map((h) => h.y));
  const bottom = Math.max(...heads.map((h) => h.y));
  // A stem points away from the middle line of its own staff.
  const middleStep = staffTopStep(staff) - 4;
  const meanStep = heads.reduce((sum, h) => sum + h.step, 0) / heads.length;
  const up = meanStep < middleStep;

  const ledgers = [...new Set(heads.flatMap((h) => ledgerStepsOf(h.step, staff)))].map((step) => ({
    y: yOfStep(step, staff),
    x1: -1.5 * gap,
    x2: 1.5 * gap,
  }));

  const glyph = {
    kind: 'note',
    time: first.time,
    x: first.time * pxPerSecond,
    staff,
    hand: first.hand || (staff === BASS ? 'L' : 'R'),
    heads,
    stem: null,
    ledgers,
    dots: [],
    top,
    bottom,
    meanStep,
    up,
    value: null,
    flags: 0,
    beam: null,
    // The sounding span stays as the file gives it: the highlight follows the
    // audio, and only the printed value is rounded.
    start: Math.min(...heads.map((h) => h.start)),
    end: Math.max(...heads.map((h) => h.end)),
    held,
  };
  setValue(glyph, Math.max(1, Math.round((endTicks - startTicks) / (ppq / 4))), gap, height);
  return glyph;
}

/**
 * Give a note the written value nearest a span in sixteenths, and rebuild the
 * marks that depend on it: the flags, the augmentation dots, and the stem.
 */
function setValue(glyph, sixteenths, gap, height) {
  const value = noteValueOf(sixteenths);
  glyph.value = value;
  glyph.flags = value.flags;
  glyph.stem = value.stem ? stemOf(glyph, glyph.up, gap, height) : null;
  // A dot sits in the space beside the head: above the head when the head is on
  // a line, on the head when it is already in a space.
  glyph.dots = value.dotted
    ? glyph.heads.map((head) => ({
      x: (value.open ? OPEN_RX : HEAD_RX) * gap + DOT_GAP * gap,
      y: Math.abs(head.step % 2) === 0 ? head.y - gap / 2 : head.y,
    }))
    : [];
}

/** The stem of one note, in paper coordinates. `y2` is the end away from the head. */
function stemOf(glyph, up, gap, height = Infinity) {
  const offset = (glyph.value.open ? OPEN_RX : HEAD_RX) * gap;
  // A note on a ledger line near an edge would push its stem off the paper, so
  // the tip stops short of the edge rather than leaving the band.
  const tip = up
    ? Math.max(glyph.top - STEM_LEN * gap, 3)
    : Math.min(glyph.bottom + STEM_LEN * gap, height - 3);
  return {
    x: up ? offset : -offset,
    y1: up ? glyph.bottom : glyph.top,
    y2: tip,
    tip,
    up,
  };
}

/**
 * Group flagged notes into beams.
 *
 * A beam joins the notes of one beat, and it never crosses a bar line. The
 * stems of a beamed group all point the same way, and the average pitch of the
 * group decides which way, as a printed score does.
 */
function applyBeams(glyphs, {
  gap, tempos, ppq, sigAt, height = Infinity,
}) {
  const beams = [];
  // A beam groups the notes of one beat. In a compound metre the beat is a
  // dotted value, so 6/8 groups three eighths and not one.
  const beamTicks = (sig) => {
    if (sig.unit === 4) return ppq;
    if (sig.unit === 2) return ppq * 2;
    if (sig.unit === 8) return sig.beats % 3 === 0 ? (ppq * 3) / 2 : ppq / 2;
    return (ppq * 4) / sig.unit;
  };
  for (const staff of [TREBLE, BASS]) {
    const middleStep = staffTopStep(staff) - 4;
    const list = glyphs.filter((g) => g.staff === staff && g.value.flags > 0);
    const beatOf = (glyph) => Math.floor(
      secondsToTicks(glyph.time, tempos, ppq) / beamTicks(sigAt(glyph.time)),
    );
    let start = 0;
    while (start < list.length) {
      const beat = beatOf(list[start]);
      let end = start + 1;
      while (end < list.length && beatOf(list[end]) === beat) end++;
      const group = list.slice(start, end);
      start = end;
      if (group.length < 2) continue; // a lone short note keeps its flag
      const meanStep = group.reduce((sum, g) => sum + g.meanStep, 0) / group.length;
      const up = meanStep < middleStep;
      // The group decides the direction, so every stem turns the same way and
      // takes the side of the head that matches it.
      for (const glyph of group) glyph.stem = stemOf(glyph, up, gap, height);
      // The beam runs stem to stem, not note to note: a beam that stopped at
      // the note centre would stop one head short of the stem it belongs to.
      const axes = group.map((glyph) => ({ glyph, x: glyph.x + glyph.stem.x }));
      const firstX = axes[0].x;
      const lastX = axes[axes.length - 1].x;
      const run = lastX - firstX;
      const tipAt = (y1, rise, x) => (run > 0 ? y1 + (rise * (x - firstX)) / run : y1);
      // One straight line joins the group, and its rise is limited, so a wide
      // leap does not tilt the beam past the angle a score allows.
      const first = axes[0].glyph.stem.y2;
      const rise = clamp(
        axes[axes.length - 1].glyph.stem.y2 - first,
        -BEAM_SLOPE * Math.abs(run),
        BEAM_SLOPE * Math.abs(run),
      );
      // A beam must not cut a stem below its minimum length. The whole line
      // moves away from the heads until every stem has room.
      let shift = 0;
      let worst = 0;
      for (const { glyph, x } of axes) {
        const limit = up ? glyph.bottom - MIN_STEM * gap : glyph.top + MIN_STEM * gap;
        const at = tipAt(first, rise, x);
        const short = up ? at - limit : limit - at;
        if (short > worst) worst = short;
      }
      if (worst > 0) shift = up ? -worst : worst;
      // Keep the beam inside the paper.
      const tips = axes.map(({ x }) => tipAt(first, rise, x));
      const edge = BEAM_THICK * gap;
      if (Math.min(...tips) + shift < edge) shift = edge - Math.min(...tips);
      if (Number.isFinite(height) && Math.max(...tips) + shift > height - edge) {
        shift = Math.min(shift, height - edge - Math.max(...tips));
      }
      const y1 = first + shift;
      const y2 = y1 + rise;
      const id = beams.length;
      const count = Math.max(...group.map((g) => g.value.flags));
      // Every stem ends on the beam line, so the group reads as one shape. The
      // group decides the direction, so a stem that wanted the other way turns
      // round: its head end moves to the matching edge of the chord.
      for (const { glyph, x } of axes) {
        glyph.stem.up = up;
        glyph.stem.y1 = up ? glyph.bottom : glyph.top;
        glyph.stem.y2 = tipAt(y1, rise, x);
        glyph.stem.tip = glyph.stem.y2;
        glyph.beam = { id, count };
        glyph.flags = 0; // the beam replaces the flags
      }
      beams.push({
        kind: 'beam',
        staff,
        time: group[0].time,
        x1: firstX,
        y1,
        x2: lastX,
        y2,
        count,
        up,
        slope: run > 0 ? rise / run : 0,
      });
    }
  }
  return beams;
}

/**
 * Fill the silent beats of each staff with rests, so every bar adds up.
 *
 * A run of two silent beats merges into a half rest, and a bar that is silent
 * from its first beat fills with one whole rest. A staff the piece never uses
 * draws no rests at all.
 */
function layoutRests(glyphs, {
  bars, sigs, tempos, ppq, pxPerSecond, duration, middleSteps, yOfStep,
}) {
  const rests = [];
  for (const staff of [TREBLE, BASS]) {
    const spans = glyphs
      .filter((g) => g.staff === staff)
      .map((g) => ({ start: g.start, end: g.end }))
      .sort((a, b) => a.start - b.start);
    if (!spans.length) continue;
    const middleStep = middleSteps[staff];
    // A beat takes a rest only when no note sounds through it. A half note held
    // across a beat fills that beat, so no rest belongs there.
    let cursor = 0;
    let sounding = -Infinity;
    for (let index = 0; index < bars.length; index++) {
      const barStart = bars[index];
      if (barStart > duration) break;
      const sig = signatureAt(sigs, barStart);
      const barTicks = secondsToTicks(barStart, tempos, ppq);
      const unitTicks = (ppq * 4) / sig.unit;
      const beats = [];
      for (let beat = 0; beat < sig.beats; beat++) {
        const t0 = ticksToSeconds(barTicks + beat * unitTicks, tempos, ppq);
        // A beat past the last note is silence after the piece, not a rest.
        if (t0 >= duration - 1e-6) break;
        const t1 = ticksToSeconds(barTicks + (beat + 1) * unitTicks, tempos, ppq);
        while (cursor < spans.length && spans[cursor].start < t1 - 1e-6) {
          sounding = Math.max(sounding, spans[cursor].end);
          cursor += 1;
        }
        beats.push({ t0, silent: sounding <= t0 + 1e-6 });
      }

      let beat = 0;
      while (beat < beats.length) {
        if (!beats[beat].silent) {
          beat += 1;
          continue;
        }
        let run = 1;
        while (beat + run < beats.length && beats[beat + run].silent) run += 1;
        const plain = REST_OF_BEAT.get(sig.unit) || 'quarter';
        let left = run;
        let at = beat;
        while (left > 0) {
          let symbol = plain;
          let span = 1;
          // Merge only where the merged shape is honest: a whole rest fills a
          // bar from its first beat, and a half rest covers two plain beats.
          if (plain === 'quarter' && left >= 4 && at === 0) {
            symbol = 'whole';
            span = 4;
          } else if (left >= 2) {
            symbol = plain === 'quarter' ? 'half' : 'quarter';
            span = 2;
          }
          const time = beats[at].t0;
          // A whole rest hangs from the fourth line; every other rest reads
          // from the middle line of its staff.
          const anchor = symbol === 'whole' ? middleStep - 2 : middleStep;
          rests.push({
            kind: 'rest',
            staff,
            symbol,
            time,
            x: time * pxPerSecond,
            y: yOfStep(anchor, staff),
            beats: span,
          });
          at += span;
          left -= span;
        }
        beat += run;
      }
    }
  }
  return rests;
}