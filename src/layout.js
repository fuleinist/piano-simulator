// 88-key keyboard layout. Pure module: no three.js imports, testable in Node.
// Units: 1 unit = one white key width (~23.5 mm on a real piano).
// Axes: X = along the keys (left = low), Y = up, Z = front(+)/back(-) of keys.

export const MIDI_MIN = 21; // A0
export const MIDI_MAX = 108; // C8
export const WHITE_W = 1.0;
export const WHITE_LEN = 6.4;
export const WHITE_H = 0.5;
export const BLACK_W = 0.6;
export const BLACK_LEN = 4.0;
export const BLACK_TOP = 0.5;
export const KEY_FRONT_Z = WHITE_LEN / 2; // +3.2
export const KEY_BACK_Z = -WHITE_LEN / 2; // -3.2
export const STRIKE_Z = 1.55; // where fingertips meet the keys
export const FALL_Z = -1.9; // where the note bars land
export const WHITE_COUNT = 52;
export const BOARD_W = WHITE_COUNT * WHITE_W; // 52
export const X_MIN = -BOARD_W / 2;

const BLACK_SET = new Set([1, 3, 6, 8, 10]); // pitch classes of black keys
// Small lateral offsets of black keys from the white-key gap (real pianos).
const BLACK_OFFSET = { 1: -0.09, 3: 0.09, 6: -0.13, 8: 0.0, 10: 0.13 };

export function isBlack(midi) {
  return BLACK_SET.has(((midi % 12) + 12) % 12);
}

export function keyTopY(midi) {
  return isBlack(midi) ? BLACK_TOP : 0;
}

// Build midi -> x center map for all 88 keys.
const X = new Map();
{
  let white = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isBlack(m)) {
      // Black key sits at the gap after the previous white key.
      const pc = ((m % 12) + 12) % 12;
      X.set(m, X_MIN + white * WHITE_W + (BLACK_OFFSET[pc] ?? 0));
    } else {
      X.set(m, X_MIN + white * WHITE_W + WHITE_W / 2);
      white++;
    }
  }
}

export function keyX(midi) {
  const x = X.get(midi);
  if (x === undefined) throw new RangeError(`MIDI ${midi} outside 88-key range`);
  return x;
}

export function keyWidth(midi) {
  return isBlack(midi) ? BLACK_W : WHITE_W;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi) {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function midiFromName(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}