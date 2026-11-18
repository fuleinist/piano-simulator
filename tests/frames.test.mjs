// Recording frame tests. Run: node --test tests/frames.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { FRAMES, DEFAULT_FRAME, frameAspect, frameSize, fitBox } from '../src/frames.js';

test('the two frames hold the 16:9 and 9:16 shapes', () => {
  const wide = frameSize('16:9');
  assert.equal(wide.width * 9, wide.height * 16, '16:9 frame is 16 by 9');

  const tall = frameSize('9:16');
  assert.equal(tall.width * 16, tall.height * 9, '9:16 frame is 9 by 16');

  assert.ok(frameAspect('16:9') > 1, 'a landscape frame is wider than it is tall');
  assert.ok(frameAspect('9:16') < 1, 'a portrait frame is taller than it is wide');
  assert.equal(frameAspect('16:9') * frameAspect('9:16'), 1, 'the two shapes are reciprocal');

  // Both are 1080 short-side frames, which is what the recorder expects.
  assert.equal(Math.min(wide.width, wide.height), 1080);
  assert.equal(Math.min(tall.width, tall.height), 1080);
});

test('an unknown frame name falls back to the default', () => {
  assert.equal(DEFAULT_FRAME, '16:9');
  assert.deepEqual(frameSize('1:1'), FRAMES['16:9']);
  assert.equal(frameAspect(undefined), frameAspect(DEFAULT_FRAME));
});

test('a frame fills the window without a letterbox of its own', () => {
  // Wide window, portrait frame: the height fills and the width shrinks.
  const portrait = fitBox(1920, 1080, 9 / 16);
  assert.equal(portrait.height, 1080);
  assert.equal(portrait.width, 1080 * (9 / 16));

  // Tall window, landscape frame: the width fills and the height shrinks.
  const landscape = fitBox(1000, 2000, 16 / 9);
  assert.equal(landscape.width, 1000);
  assert.equal(landscape.height, 1000 * (9 / 16));

  // The box never leaves the window.
  for (const [w, h, aspect] of [[1920, 1080, 16 / 9], [800, 1400, 9 / 16], [300, 200, 1]]) {
    const box = fitBox(w, h, aspect);
    assert.ok(box.width <= w + 1e-9 && box.height <= h + 1e-9, 'box fits the window');
    assert.ok(Math.abs(box.width / box.height - aspect) < 1e-9, 'box keeps the frame shape');
    // Largest fit: one side touches the window edge.
    assert.ok(Math.abs(box.width - w) < 1e-9 || Math.abs(box.height - h) < 1e-9, 'box is the largest fit');
  }
});

test('a window with no size gives an empty box', () => {
  assert.deepEqual(fitBox(0, 0, 16 / 9), { width: 0, height: 0 });
  assert.deepEqual(fitBox(800, 600, 0), { width: 0, height: 0 });
});