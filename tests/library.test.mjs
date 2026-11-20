// Local library tests: the content hash, the metadata a record carries, the
// picker entry built from it, and the sort order.
// Run: node --test tests/library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, WARN_BYTES, buildRecord, contentId, displayName, formatBytes,
  isQuotaError, pickTitle, sortRecords, stripExtension, summarise, toEntry, totalBytes, usableRecords,
} from '../src/library.js';

const bytesOf = (text) => new TextEncoder().encode(text).buffer;

test('contentId is a stable SHA-256 of the bytes', async () => {
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(await contentId(new ArrayBuffer(0)), empty);

  const a = await contentId(bytesOf('MThd\u0000\u0000\u0000\u0006'));
  const b = await contentId(bytesOf('MThd\u0000\u0000\u0000\u0006'));
  const c = await contentId(bytesOf('MThd\u0000\u0000\u0000\u0007'));

  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/, 'the id must be lower-case hex');
  assert.equal(a, b, 'the same bytes must dedupe to the same key');
  assert.notEqual(a, c);
});

test('stripExtension removes .mid and .midi in any case', () => {
  assert.equal(stripExtension('elise.mid'), 'elise');
  assert.equal(stripExtension('elise.MIDI'), 'elise');
  assert.equal(stripExtension('no extension'), 'no extension');
  assert.equal(stripExtension('a.mid.mid'), 'a.mid');
  assert.equal(stripExtension(undefined), '');
});

test('pickTitle prefers the sequence name, then a real track name, then the file name', () => {
  assert.equal(pickTitle({ name: 'x.mid', midiTitle: 'Nocturne Op.9 No.2', trackNames: ['Piano'] }), 'Nocturne Op.9 No.2');
  assert.equal(pickTitle({ name: 'x.mid', midiTitle: '   ', trackNames: ['Piano right', 'Arabesque No.1'] }), 'Arabesque No.1');
  assert.equal(pickTitle({ name: 'Raindrop.MID', midiTitle: '', trackNames: [] }), 'Raindrop');
  assert.equal(pickTitle({}), 'Untitled MIDI');
});

test('a generic track name never becomes the title', () => {
  for (const name of ['', '  ', 'Piano', 'Piano Left', 'Piano right', 'Track 3', 'Right Hand', '1']) {
    assert.equal(
      pickTitle({ name: 'Sonata.mid', midiTitle: '', trackNames: [name] }),
      'Sonata',
      `"${name}" should not win over the file name`,
    );
  }
});

test('buildRecord captures the bytes and the parse result', () => {
  const bytes = bytesOf('MThd');
  const record = buildRecord({
    id: 'abc',
    name: 'Raindrop.MID',
    bytes,
    info: { notes: 1518, duration: 270.4, midiTitle: '', trackNames: ['Piano'] },
    now: 1700000000000,
  });

  assert.equal(record.id, 'abc');
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.equal(record.title, 'Raindrop');
  assert.equal(record.name, 'Raindrop.MID');
  assert.equal(record.composer, '');
  assert.equal(record.size, 4);
  assert.equal(record.noteCount, 1518);
  assert.equal(record.duration, 270.4);
  assert.equal(record.addedAt, 1700000000000);
  assert.equal(record.lastPlayedAt, 0, 'a new record has never been played');
  assert.equal(record.bytes, bytes, 'the exact bytes are kept for playback');
});

test('buildRecord copes with a missing parse result', () => {
  const record = buildRecord({ id: 'x', name: 'x.mid', bytes: bytesOf('a') });
  assert.equal(record.noteCount, 0);
  assert.equal(record.duration, 0);
  assert.equal(record.title, 'x');
});

test('usableRecords skips what this build cannot read', () => {
  const good = { id: 'a', title: 'A', schemaVersion: SCHEMA_VERSION, bytes: bytesOf('a'), size: 1 };
  const future = { ...good, id: 'b', schemaVersion: SCHEMA_VERSION + 1 };
  const noBytes = { ...good, id: 'c', bytes: null };
  const noTitle = { ...good, id: 'd', title: undefined };
  const noId = { ...good, id: 7 };
  const list = usableRecords([good, future, noBytes, noTitle, noId, null]);

  assert.deepEqual(list.map((r) => r.id), ['a']);
  assert.deepEqual(usableRecords(undefined), []);
});

test('toEntry carries the picker fields and a namespaced id', () => {
  const entry = toEntry({ id: 'abc', title: 'Raindrop', composer: 'Chopin', size: 12, noteCount: 40, lastPlayedAt: 9 });
  assert.equal(entry.id, 'local:abc');
  assert.equal(entry.key, 'abc', 'the store key is the bare hash');
  assert.equal(entry.kind, 'local');
  assert.equal(entry.title, 'Raindrop');
  assert.equal(entry.composer, 'Chopin');
});

test('toEntry renames a record with no title or composer', () => {
  const entry = toEntry({ id: 'abc' });
  assert.equal(entry.title, 'Untitled MIDI');
  assert.equal(entry.composer, '');
});

test('displayName adds the composer only when there is one', () => {
  assert.equal(displayName({ title: 'Raindrop', composer: 'Chopin' }), 'Raindrop — Chopin');
  assert.equal(displayName({ title: 'Raindrop', composer: '' }), 'Raindrop');
  assert.equal(displayName(null), '');
});

test('sortRecords puts the most recently played first, then title', () => {
  const list = [
    { id: 'a', title: 'Zebra', lastPlayedAt: 0 },
    { id: 'b', title: 'Beta', lastPlayedAt: 500 },
    { id: 'c', title: 'Alpha', lastPlayedAt: 500 },
    { id: 'd', title: 'Apple', lastPlayedAt: 0 },
  ];
  assert.deepEqual(sortRecords(list).map((r) => r.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(list.map((r) => r.id), ['a', 'b', 'c', 'd'], 'the input order must not change');
  assert.deepEqual(sortRecords(undefined), []);
});

test('formatBytes switches unit at the right size', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(20480), '20 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB');
});

test('totalBytes and summarise describe the library', () => {
  const list = [{ size: 100 }, { size: 2048 }];
  assert.equal(totalBytes(list), 2148);
  assert.equal(totalBytes(undefined), 0);
  assert.equal(summarise([]), 'No files yet');
  assert.equal(summarise([{ size: 1024 }]), '1 file · 1.0 KB');
  assert.equal(summarise(list), '2 files · 2.1 KB');
  assert.ok(WARN_BYTES >= 1024 * 1024, 'the warning threshold must be a real size');
});

test('isQuotaError recognises the shapes browsers throw', () => {
  assert.equal(isQuotaError({ name: 'QuotaExceededError' }), true);
  assert.equal(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
  assert.equal(isQuotaError({ code: 22 }), true);
  assert.equal(isQuotaError(new Error('nope')), false);
  assert.equal(isQuotaError(null), false);
});