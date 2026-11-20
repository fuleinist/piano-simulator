// Streaming preset tests: ingest addresses, key handling and redaction.
// Run: node --test tests/streampresets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLATFORM, DEFAULT_QUALITY, PLATFORMS, QUALITIES, findPlatform, findQuality,
  ingestBase, isSecureRelay, redactTarget, streamTarget,
} from '../src/streampresets.js';

test('every platform has a label, a note, and a stable id', () => {
  const ids = new Set();
  for (const platform of PLATFORMS) {
    assert.equal(typeof platform.label, 'string');
    assert.ok(platform.label.length > 0);
    assert.ok(platform.note.length > 0, `${platform.id} needs a note`);
    assert.ok(!ids.has(platform.id), `duplicate id ${platform.id}`);
    ids.add(platform.id);
  }
  assert.ok(ids.has('youtube') && ids.has('twitch') && ids.has('facebook') && ids.has('custom'));
});

test('the first-class presets carry an ingest address', () => {
  for (const id of ['youtube', 'twitch', 'facebook', 'instagram']) {
    assert.match(ingestBase(id), /^rtmps?:\/\//, `${id} has no ingest`);
  }
  assert.equal(ingestBase('custom'), '', 'a custom platform supplies its own');
  assert.equal(ingestBase('nonexistent'), '');
});

test('the quality presets stay inside a sensible range', () => {
  for (const quality of QUALITIES) {
    assert.ok(quality.bitrate >= 2_000_000 && quality.bitrate <= 6_000_000, `${quality.id} bitrate`);
    assert.ok([30, 60].includes(quality.fps), `${quality.id} fps`);
    assert.ok(quality.width >= 1280 && quality.height >= 720, `${quality.id} size`);
  }
  assert.equal(findQuality(DEFAULT_QUALITY).id, DEFAULT_QUALITY);
  assert.equal(findQuality('nope').id, QUALITIES[0].id, 'an unknown id falls back');
  assert.equal(findPlatform(DEFAULT_PLATFORM).id, DEFAULT_PLATFORM);
  assert.equal(findPlatform('nope'), null);
});

test('the target joins the base and the key with one slash', () => {
  assert.equal(streamTarget('rtmp://a.example/live2', 'abcd-1234'), 'rtmp://a.example/live2/abcd-1234');
  assert.equal(streamTarget('rtmp://a.example/live2/', 'abcd-1234'), 'rtmp://a.example/live2/abcd-1234');
  assert.equal(streamTarget('rtmp://a.example/live2/', '/abcd-1234'), 'rtmp://a.example/live2/abcd-1234');
  assert.equal(streamTarget('', 'key'), '', 'no base means no target');
  assert.equal(streamTarget('rtmp://a.example/live2', ''), '', 'no key means no target');
  assert.equal(streamTarget('rtmp://a.example/live2', '   '), '');
});

test('redactTarget hides the key and keeps the host readable', () => {
  assert.equal(
    redactTarget('rtmp://a.rtmp.youtube.com/live2/secret-key'),
    'rtmp://a.rtmp.youtube.com/live2/***',
  );
  assert.equal(redactTarget('rtmps://live-api-s.facebook.com:443/rtmp/secret'), 'rtmps://live-api-s.facebook.com:443/rtmp/***');
  assert.equal(redactTarget(''), '');
  assert.ok(!redactTarget('rtmp://a.example/live2/abcd-1234').includes('abcd-1234'));
});

test('a key may cross wss, or ws on this machine, and nothing else', () => {
  assert.equal(isSecureRelay('wss://relay.example.com'), true);
  assert.equal(isSecureRelay('ws://localhost:8088'), true);
  assert.equal(isSecureRelay('ws://127.0.0.1:8088'), true);
  assert.equal(isSecureRelay('ws://[::1]:8088'), true);
  assert.equal(isSecureRelay('ws://relay.example.com'), false, 'an open socket off the machine');
  assert.equal(isSecureRelay('http://relay.example.com'), false);
  assert.equal(isSecureRelay(''), false);
  assert.equal(isSecureRelay('not a url'), false);
});
