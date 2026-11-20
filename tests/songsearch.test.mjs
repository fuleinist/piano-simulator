// Search and ranking tests for the song picker. Run: node --test tests/songsearch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, terms, matchSong, searchSongs } from '../src/songsearch.js';

// A small slice of the built-in list, with the spellings the app ships
// (Fur Elise is stored accented, so the accent must not matter either way).
const SONGS = [
  { id: 'a', title: 'Für Elise', composer: 'Beethoven' },
  { id: 'b', title: 'Moonlight Sonata, 1st mvmt', composer: 'Beethoven' },
  { id: 'c', title: 'Pathétique, 2nd mvmt', composer: 'Beethoven' },
  { id: 'd', title: 'Nocturne Op.27 No.2', composer: 'Chopin' },
  { id: 'e', title: 'Raindrop Prelude Op.28 No.15', composer: 'Chopin' },
  { id: 'f', title: 'Prelude in C (WTC I)', composer: 'Bach' },
  { id: 'g', title: 'River Flows in You', composer: 'Yiruma' },
  { id: 'h', title: 'Kiss the Rain', composer: 'Yiruma' },
];

const ids = (list) => list.map((s) => s.id);

test('normalize strips accents and keeps a map back to the original', () => {
  const n = normalize('Für Elise');
  assert.equal(n.text, 'fur elise');
  // "u" came from the accented "ü" at index 1, and "r" from index 2.
  assert.equal(n.map[1], 1);
  assert.equal(n.map[2], 2);
  assert.equal(n.map[4], 4);
  assert.equal(n.map.length, n.text.length);
});

test('normalize is lower-case and leaves plain ASCII alone', () => {
  const n = normalize('Bach WTC I');
  assert.equal(n.text, 'bach wtc i');
  assert.deepEqual(n.map, [...Array(10).keys()]);
});

test('normalize copes with empty and missing text', () => {
  assert.deepEqual(normalize(''), { text: '', map: [] });
  assert.deepEqual(normalize(undefined), { text: '', map: [] });
});

test('terms splits on any run of whitespace', () => {
  assert.deepEqual(terms('  Chopin   nocturne '), ['chopin', 'nocturne']);
  assert.deepEqual(terms(''), []);
});

test('a query matches a title with or without its accents', () => {
  for (const q of ['fur elise', 'Für Elise', 'FUR']) {
    const hits = searchSongs(SONGS, q);
    assert.equal(hits[0]?.id, 'a', `query "${q}" missed Für Elise`);
  }
  assert.equal(searchSongs(SONGS, 'pathetique')[0].id, 'c');
  assert.equal(searchSongs(SONGS, 'Pathétique')[0].id, 'c');
});

test('a composer alone finds every piece by that composer', () => {
  // Both are composer-prefix matches, so the shorter title ("Kiss the Rain")
  // comes first and the order stays stable.
  const hits = searchSongs(SONGS, 'yiruma');
  assert.deepEqual(ids(hits), ['h', 'g']);
  assert.equal(hits[0].score, 40, 'a composer prefix scores below any title match');
});

test('every term must match, and terms may span title and composer', () => {
  assert.deepEqual(ids(searchSongs(SONGS, 'chopin nocturne')), ['d']);
  assert.deepEqual(ids(searchSongs(SONGS, 'yiruma rain')), ['h']);
  assert.deepEqual(searchSongs(SONGS, 'chopin beethoven'), []);
});

test('a title match outranks a composer match', () => {
  // "Prelude in C" starts with the query; the Chopin prelude only contains it
  // inside its title; Bach appears in neither title.
  const hits = searchSongs(SONGS, 'prelude');
  assert.deepEqual(ids(hits), ['f', 'e']);
  assert.ok(hits[0].score > hits[1].score);
});

test('a title-prefix match outranks a title-substring match', () => {
  const hits = searchSongs(SONGS, 'rain');
  // "Raindrop..." is a prefix, "Kiss the Rain" is a word inside the title.
  assert.deepEqual(ids(hits), ['e', 'h']);
});

test('ranges point at the match inside the original string', () => {
  const hit = searchSongs(SONGS, 'elise')[0];
  assert.deepEqual(hit.titleRanges, [[4, 9]]);

  const accented = searchSongs(SONGS, 'fur')[0];
  assert.deepEqual(accented.titleRanges, [[0, 3]], 'the accent must not shift the range');

  const pathetique = searchSongs(SONGS, 'pathetique')[0];
  assert.deepEqual(pathetique.titleRanges, [[0, 10]]);
});

test('a composer match carries composer ranges and no title ranges', () => {
  const hit = searchSongs(SONGS, 'yiruma')[0];
  assert.deepEqual(hit.composerRanges, [[0, 6]]);
  assert.deepEqual(hit.titleRanges, []);
});

test('multi-term queries highlight every term and merge overlaps', () => {
  const hit = searchSongs(SONGS, 'prelude op')[0];
  assert.equal(hit.id, 'e');
  // "op" inside "Raindrop" is not a word start, so only the real "Op." is marked.
  assert.deepEqual(hit.titleRanges, [[9, 16], [17, 19]]);
});

test('an empty query returns every entry in its incoming order', () => {
  const hits = searchSongs(SONGS, '   ');
  assert.deepEqual(ids(hits), ids(SONGS));
  assert.ok(hits.every((h) => h.score === 0 && h.titleRanges.length === 0));
});

test('a query with no match returns nothing', () => {
  assert.deepEqual(searchSongs(SONGS, 'zzzz'), []);
});

test('equal scores keep the incoming order, so the list is stable', () => {
  const twin = [
    { id: 'x', title: 'Sonata in A', composer: 'Mozart' },
    { id: 'y', title: 'Sonata in B', composer: 'Mozart' },
  ];
  assert.deepEqual(ids(searchSongs(twin, 'sonata')), ['x', 'y']);
  assert.deepEqual(ids(searchSongs(twin, 'sonata')), ['x', 'y']);
});

test('a limit caps the result list after ranking', () => {
  // All three are composer-prefix matches, so the tie breaks on title length:
  // "Für Elise", then "Pathétique, 2nd mvmt", then the longer Moonlight entry.
  const hits = searchSongs(SONGS, 'beethoven', { limit: 2 });
  assert.equal(hits.length, 2);
  assert.deepEqual(ids(hits), ['a', 'c']);
});

test('an entry with no composer is still searchable by title', () => {
  const lone = [{ id: 'z', title: 'Untitled Import' }];
  assert.deepEqual(ids(searchSongs(lone, 'untitled')), ['z']);
  assert.deepEqual(ids(searchSongs(lone, 'import')), ['z']);
  assert.deepEqual(lone[0].composer, undefined, 'matchSong must not write to the entry');
});

test('matchSong reports null for a non-match and a score for a match', () => {
  assert.equal(matchSong({ title: 'Canon in D', composer: 'Pachelbel' }, 'liszt'), null);
  assert.ok(matchSong({ title: 'Canon in D', composer: 'Pachelbel' }, 'canon').score > 0);
});