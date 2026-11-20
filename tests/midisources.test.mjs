// Remote source tests: licence labels, file choice, normalisation, and the
// fan-out with its timeout and partial-failure rules.
// Run: node --test tests/midisources.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_LICENSE, creatorName, dedupe, describeLicense, normaliseArchiveDoc,
  pickMidiFile, proxyUrl, searchAll,
} from '../src/midisources.js';

test('describeLicense labels the licences the archive carries', () => {
  assert.equal(
    describeLicense('http://creativecommons.org/publicdomain/mark/1.0/').label,
    'Public domain (1.0)',
  );
  assert.equal(describeLicense('https://creativecommons.org/publicdomain/zero/1.0/').label, 'Public domain (1.0)');
  assert.equal(describeLicense('https://creativecommons.org/licenses/by/4.0/').label, 'CC BY 4.0');
  assert.equal(describeLicense('https://creativecommons.org/licenses/by-nc-sa/4.0/').label, 'CC BY-NC-SA 4.0');
  assert.equal(describeLicense('https://creativecommons.org/licenses/by-nd/3.0/').label, 'CC BY-ND 3.0');
});

test('describeLicense keeps an unknown link but says it is unknown', () => {
  const other = describeLicense('https://example.com/licence');
  assert.equal(other.label, UNKNOWN_LICENSE);
  assert.equal(other.known, false);
  assert.equal(other.url, 'https://example.com/licence');

  const none = describeLicense(null);
  assert.equal(none.label, UNKNOWN_LICENSE);
  assert.equal(none.url, null);
  assert.equal(none.known, false);
});

test('pickMidiFile takes the first MIDI in listing order', () => {
  const files = [
    { name: 'cover.jpg', size: '100' },
    { name: 'Piece.MID', size: '3958' },
    { name: 'Other.midi', size: '24' },
  ];
  assert.deepEqual(pickMidiFile(files), { name: 'Piece.MID', size: 3958 });
  assert.equal(pickMidiFile([{ name: 'readme.txt' }]), null);
  assert.equal(pickMidiFile([]), null);
  assert.equal(pickMidiFile(undefined), null);
  assert.deepEqual(pickMidiFile([{ name: 'a.mid', size: 'not a number' }]), { name: 'a.mid', size: 0 });
});

test('creatorName flattens a list and trims a string', () => {
  assert.equal(creatorName(['Frédéric Chopin', 'Edwin Hughes (ed.)']), 'Frédéric Chopin, Edwin Hughes (ed.)');
  assert.equal(creatorName('  Beethoven, Ludwig van '), 'Beethoven, Ludwig van');
  assert.equal(creatorName(undefined), '');
  assert.equal(creatorName(['', null]), '');
});

test('normaliseArchiveDoc builds a result the UI can show', () => {
  const result = normaliseArchiveDoc({
    identifier: 'MoonlightSonata_201303',
    title: 'Moonlight Sonata',
    creator: 'musician',
    licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/',
    item_size: '12345',
  });

  assert.equal(result.id, 'internetarchive:MoonlightSonata_201303');
  assert.equal(result.provider, 'internetarchive');
  assert.equal(result.source, 'Internet Archive');
  assert.equal(result.title, 'Moonlight Sonata');
  assert.equal(result.composer, 'musician');
  assert.equal(result.license, 'Public domain (1.0)');
  assert.equal(result.sourceUrl, 'https://archive.org/details/MoonlightSonata_201303');
  assert.equal(result.size, 12345);
});

test('normaliseArchiveDoc falls back and rejects a document with no identifier', () => {
  for (const doc of [null, undefined, {}, { identifier: '   ' }]) {
    assert.equal(normaliseArchiveDoc(doc), null);
  }
  const bare = normaliseArchiveDoc({ identifier: 'abc' });
  assert.equal(bare.title, 'abc');
  assert.equal(bare.license, UNKNOWN_LICENSE);
});

test('the source link escapes the identifier', () => {
  const result = normaliseArchiveDoc({ identifier: 'a b/c' });
  assert.equal(result.sourceUrl, 'https://archive.org/details/a%20b%2Fc');
});

test('proxyUrl encodes the target', () => {
  const url = proxyUrl('https://archive.org/download/x/a b.mid');
  assert.match(url, /^\/api\/midi\?url=/);
  assert.ok(url.includes(encodeURIComponent('https://archive.org/download/x/a b.mid')));
  assert.ok(!url.includes(' '), 'the query must carry no raw space');
});

const provider = (id, search) => ({ id, label: id, search });

test('searchAll ignores an empty query', async () => {
  let calls = 0;
  const one = provider('one', async () => { calls += 1; return []; });
  assert.deepEqual(await searchAll([one], '   '), { results: [], errors: [] });
  assert.equal(calls, 0);
});

test('one dead provider leaves the other results intact', async () => {
  const good = provider('good', async () => [{ id: 'good:1', title: 'A', source: 'Good' }]);
  const bad = provider('bad', async () => { throw new Error('blocked by CORS'); });

  const { results, errors } = await searchAll([good, bad], 'chopin');
  assert.deepEqual(results.map((r) => r.id), ['good:1']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, 'bad');
  assert.match(errors[0].message, /CORS/);
});

test('a provider that never answers times out without blocking the list', async () => {
  const good = provider('good', async () => [{ id: 'good:1', title: 'A' }]);
  const slow = provider('slow', () => new Promise(() => {})); // ignores its signal

  const started = Date.now();
  const { results, errors } = await searchAll([good, slow], 'tchaikovsky', { timeoutMs: 40 });
  assert.ok(Date.now() - started < 2000, 'the fan-out must not wait for the dead provider');
  assert.deepEqual(results.map((r) => r.id), ['good:1']);
  assert.match(errors[0].message, /did not answer within 40 ms/);
});

test('the fan-out passes its abort signal to the provider', async () => {
  let seen = null;
  const slow = provider('slow', (query, options) => {
    seen = options.signal;
    return new Promise(() => {});
  });
  await searchAll([slow], 'anything', { timeoutMs: 30 });
  assert.ok(seen instanceof AbortSignal, 'the provider must receive a signal');
  assert.equal(seen.aborted, true, 'the signal must abort at the timeout');
});

test('duplicate results collapse and the limit applies after dedupe', async () => {
  const twice = provider('dup', async () => [
    { id: 'dup:1', title: 'A' }, { id: 'dup:1', title: 'A again' }, { id: 'dup:2', title: 'B' },
  ]);
  const { results } = await searchAll([twice], 'x', { limit: 5 });
  assert.deepEqual(results.map((r) => r.id), ['dup:1', 'dup:2']);

  const many = provider('many', async () => Array.from({ length: 10 }, (_, i) => ({ id: `many:${i}` })));
  assert.equal((await searchAll([many], 'x', { limit: 3 })).results.length, 3);
});

test('dedupe keeps the first result for an id', () => {
  const list = [{ id: 'a', title: 'first' }, { id: 'a', title: 'second' }, { id: 'b' }];
  assert.deepEqual(dedupe(list).map((r) => r.title || r.id), ['first', 'b']);
  assert.deepEqual(dedupe(null), []);
});