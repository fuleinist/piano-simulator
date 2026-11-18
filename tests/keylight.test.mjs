// Press-highlight curve tests. Run: node --test tests/keylight.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  keyHighlight, WHITE_TINT, WHITE_EMISSIVE, BLACK_EMISSIVE,
} from '../src/keylight.js';

test('a held white key shifts its body colour, not just its emissive', () => {
  const held = keyHighlight(1, false);
  // The regression this guards: emissive alone washed out on ivory keys, so the
  // tint has to be the dominant cue at full glow.
  assert.equal(held.tint, WHITE_TINT);
  assert.ok(held.tint >= 0.5, `white tint ${held.tint} too weak to see`);
  assert.ok(held.tint > held.emissive, 'white highlight must lean on albedo, not emissive');
  assert.equal(held.emissive, WHITE_EMISSIVE);
});

test('a held black key keeps the emissive-only look', () => {
  const held = keyHighlight(1, true);
  assert.equal(held.tint, 0, 'black keys must not be colour-shifted');
  assert.equal(held.emissive, BLACK_EMISSIVE);
});

test('released keys are untouched', () => {
  for (const black of [true, false]) {
    const off = keyHighlight(0, black);
    assert.equal(off.tint, 0);
    assert.equal(off.emissive, 0);
  }
});

test('the highlight rises with glow and stays in range', () => {
  let prev = -1;
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    const { tint, emissive } = keyHighlight(g, false);
    assert.ok(tint > prev, 'white tint must grow with glow');
    prev = tint;
    assert.ok(tint >= 0 && tint <= 1, `tint ${tint} out of range`);
    assert.ok(emissive >= 0 && emissive <= 1, `emissive ${emissive} out of range`);
  }
});

test('a release fade never overshoots or goes negative', () => {
  for (const g of [-1, -0.2, 1.5, Number.NaN]) {
    const { tint, emissive } = keyHighlight(g, false);
    assert.ok(Number.isFinite(tint) && Number.isFinite(emissive), `non-finite at glow ${g}`);
    assert.ok(tint >= 0 && tint <= 1, `tint ${tint} at glow ${g}`);
    assert.ok(emissive >= 0 && emissive <= 1, `emissive ${emissive} at glow ${g}`);
  }
});