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
export const STRIKE_Z = 1.55; // where fingertips meet the white keys
export const BLACK_FRONT_Z = KEY_BACK_Z + BLACK_LEN; // +0.8, front edge of a black key
export const BLACK_STRIKE_Z = 0.35; // black keys are struck near their front edge

// Where a fingertip meets this key. A black key ends well before a white one,
// so one strike depth for both would leave the tip hanging past the black key.
export function keyStrikeZ(midi) {
  return isBlack(midi) ? BLACK_STRIKE_Z : STRIKE_Z;
}

// The depth range a fingertip may land on and still be on this key's surface.
// The thumb reaches less far forward than the fingers, so a chord needs the
// whole range, not one point, for every tip to stay on its key.
export function keyStrikeRange(midi) {
  const back = KEY_BACK_Z + 0.3;
  return isBlack(midi) ? [back, BLACK_FRONT_Z - 0.3] : [back, KEY_FRONT_Z - 0.3];
}
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

// Black keys indexed by the number of white keys before them, so a lateral
// position can find the key surface above it without scanning all 88 keys.
const BLACK_AT_GAP = new Map();
{
  let white = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (isBlack(m)) BLACK_AT_GAP.set(white, m);
    else white++;
  }
}

// Height of the key surface under a fingertip. A black key rides above the
// white keys beside it, but only over the back part of the keyboard, so a tip
// resting near the front edge clears the white key even beside a black one.
export function keyTopAtX(x, z = STRIKE_Z) {
  if (z < KEY_BACK_Z || z > BLACK_FRONT_Z) return 0;
  const i = Math.floor(x - X_MIN);
  for (const gap of [i, i + 1]) {
    const m = BLACK_AT_GAP.get(gap);
    if (m !== undefined && Math.abs(x - keyX(m)) <= BLACK_W / 2) return BLACK_TOP;
  }
  return 0;
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