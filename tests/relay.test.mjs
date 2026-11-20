// Relay tests: the ingest check, the ffmpeg command, and redaction.
// Run: node --test tests/relay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, checkIngest, redact } from '../relay/ffmpeg.js';

test('only an rtmp or rtmps address is accepted', () => {
  assert.equal(checkIngest('rtmp://a.rtmp.youtube.com/live2/abc'), true);
  assert.equal(checkIngest('rtmps://live-api-s.facebook.com:443/rtmp/abc'), true);
  assert.equal(checkIngest('http://a.example/rtmp/abc'), false);
  assert.equal(checkIngest('rtmp://'), false, 'no host');
  assert.equal(checkIngest('rtmp://a.example'), false, 'no path, so no key');
  assert.equal(checkIngest(''), false);
  assert.equal(checkIngest(null), false);
  assert.equal(checkIngest('file:///etc/passwd'), false);
});

test('the ffmpeg command transcodes WebM to FLV over RTMP', () => {
  const args = buildArgs({ ingest: 'rtmp://a.example/live2/key', quality: { bitrate: 4_500_000, fps: 30 } });

  assert.deepEqual(args.slice(args.indexOf('-f', 2), args.indexOf('-f', 2) + 2), ['-f', 'webm'], 'the pipe needs its format');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264', 'VP8 cannot be copied into FLV');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-tune') + 1], 'zerolatency');
  assert.deepEqual(args.slice(-3, -1), ['-f', 'flv'], 'the last format is FLV');
  assert.equal(args[args.length - 1], 'rtmp://a.example/live2/key', 'the ingest comes last');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0', 'the browser feeds stdin');
  assert.ok(!args.includes('-c'), 'no stream copy');
});

test('the bitrate and the frame rate stay inside the guard rails', () => {
  const low = buildArgs({ ingest: 'rtmp://a.example/live2/k', quality: { bitrate: 1, fps: 1 } });
  assert.equal(low[low.indexOf('-b:v') + 1], '500000', 'a click does not set the floor below 500 kbps');
  assert.equal(low[low.indexOf('-g') + 1], '30', '15 fps needs a keyframe every 30 frames');

  const high = buildArgs({ ingest: 'rtmp://a.example/live2/k', quality: { bitrate: 99_000_000, fps: 240 } });
  assert.equal(high[high.indexOf('-b:v') + 1], '12000000', 'the ceiling holds');
  assert.equal(high[high.indexOf('-maxrate') + 1], '12000000');
  assert.equal(high[high.indexOf('-g') + 1], '120', '60 fps is the ceiling');
});

test('a bad address cannot reach ffmpeg', () => {
  assert.throws(() => buildArgs({ ingest: 'http://a.example/live2/k' }), /rtmp:\/\/ or rtmps/);
  assert.throws(() => buildArgs({}), /rtmp:\/\/ or rtmps/);
});

test('the relay log never carries the key', () => {
  assert.equal(redact('rtmp://a.example/live2/secret'), 'rtmp://a.example/live2/***');
  assert.ok(!redact('rtmp://a.example/live2/secret').includes('secret'));
  assert.equal(redact(''), '');
});
