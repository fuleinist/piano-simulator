// Search and ranking for the song picker.
//
// The module holds no DOM and no Three.js imports, so tests/songsearch.test.mjs
// can run it under `node --test`. Matching ignores case and diacritics, because
// the built-in list carries pieces such as "Fur Elise" and "Pathetique" that a
// player will type without accents.
//
// A query is split on whitespace, and every term must match the title or the
// composer. Rank is a sum of per-term scores, so "chopin nocturne" puts the
// Chopin nocturnes above a piece whose composer merely contains "chopin".

const COMBINING = /\p{M}+/gu;

// A term that opens the title is the strongest signal, then a term that opens a
// word inside the title, then any title substring. Composer matches score lower
// at the same position, so a title match always wins.
const SCORE = {
  titlePrefix: 100,
  titleWord: 70,
  titleSub: 45,
  composerPrefix: 40,
  composerWord: 30,
  composerSub: 20,
};

/**
 * Lower-case a string and strip its diacritics, keeping a map from each output
 * character back to the index of the character it came from. The map lets a
 * caller highlight the match inside the original, accented string.
 *
 * @param {string} text
 * @returns {{ text: string, map: number[] }}
 */
export function normalize(text) {
  const src = String(text ?? '');
  let out = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    // A single character can decompose into several ("é" -> "e" + accent), and
    // lower-casing can change the length ("İ"), so push one map entry per
    // character that survives.
    const piece = src[i].normalize('NFD').replace(COMBINING, '').toLowerCase();
    for (const ch of piece) {
      out += ch;
      map.push(i);
    }
  }
  return { text: out, map };
}

/** Split a raw query into normalised terms. */
export function terms(query) {
  return normalize(query).text.split(/\s+/).filter(Boolean);
}

const isWordStart = (hay, at) => at === 0 || !/[\p{L}\p{N}]/u.test(hay[at - 1]);

/** Score one term against one field, and return the best match position. */
function bestIn(hay, term, scores) {
  let best = 0;
  let at = -1;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(term, from);
    if (i < 0) break;
    const s = i === 0 ? scores.prefix : isWordStart(hay, i) ? scores.word : scores.sub;
    if (s > best) { best = s; at = i; }
    if (s === scores.prefix) break; // nothing can beat this
    from = i + 1;
  }
  return best ? { score: best, at, length: term.length } : null;
}

/** Every occurrence of a term, for highlighting. A term that starts a word is
 *  the only useful highlight: "op" inside "Raindrop" is noise, so when at least
 *  one word-start match exists the substring matches are dropped. */
function allIn(hay, term) {
  const hits = [];
  if (!term) return hits;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(term, from);
    if (i < 0) break;
    hits.push({ at: i, length: term.length, word: isWordStart(hay, i) });
    from = i + 1;
  }
  const words = hits.filter((h) => h.word);
  return words.length ? words : hits.slice(0, 1);
}

/** Map match positions in the normalised string back onto the original. */
function toRanges(hits, map) {
  return hits
    .map((h) => {
      const start = map[h.at];
      const end = map[h.at + h.length - 1];
      return [start, end + 1];
    })
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start);
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * Score one song against a query.
 *
 * @param {{ title: string, composer?: string }} song
 * @param {string} query
 * @param {string[]} [termList] pre-split terms, so a list search splits once
 * @returns {{ score: number, titleRanges: number[][], composerRanges: number[][] } | null}
 *   null when a term matches neither field.
 */
export function matchSong(song, query, termList = terms(query)) {
  const title = normalize(song.title ?? '');
  const composer = normalize(song.composer ?? '');
  const titleRanges = [];
  const composerRanges = [];

  if (!termList.length) return { score: 0, titleRanges, composerRanges };

  let score = 0;
  for (const term of termList) {
    const t = bestIn(title.text, term, {
      prefix: SCORE.titlePrefix, word: SCORE.titleWord, sub: SCORE.titleSub,
    });
    const c = bestIn(composer.text, term, {
      prefix: SCORE.composerPrefix, word: SCORE.composerWord, sub: SCORE.composerSub,
    });
    if (!t && !c) return null;
    score += Math.max(t ? t.score : 0, c ? c.score : 0);
    titleRanges.push(...toRanges(allIn(title.text, term), title.map));
    composerRanges.push(...toRanges(allIn(composer.text, term), composer.map));
  }

  return {
    score,
    titleRanges: mergeRanges(titleRanges),
    composerRanges: mergeRanges(composerRanges),
  };
}

/**
 * Rank a list of songs against a query. An empty query keeps the incoming
 * order, so the picker can list everything before the player types.
 *
 * Ties break on the shorter title and then on the incoming order, so the list
 * is stable across keystrokes.
 *
 * @template {{ title: string, composer?: string }} T
 * @param {T[]} songs
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {(T & { score: number, titleRanges: number[][], composerRanges: number[][] })[]}
 */
export function searchSongs(songs, query, { limit = 0 } = {}) {
  const termList = terms(query);
  const scored = [];
  songs.forEach((song, index) => {
    const match = matchSong(song, query, termList);
    if (!match) return;
    scored.push({ ...song, ...match, index });
  });

  if (termList.length) {
    scored.sort((a, b) => (
      b.score - a.score
      || String(a.title).length - String(b.title).length
      || a.index - b.index
    ));
  }

  return limit > 0 ? scored.slice(0, limit) : scored;
}