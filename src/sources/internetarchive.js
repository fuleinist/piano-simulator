// Internet Archive as a MIDI source.
//
// Search goes to advancedsearch.php, which allows a browser to call it (the
// response carries `Access-Control-Allow-Origin: *`). The download does not:
// archive.org answers a .mid request with a 302 to a storage host that carries
// no CORS header, so the bytes come through the /api/midi proxy instead.
//
// A search hit is only useful when the item really holds a MIDI file, so each
// candidate is checked against its metadata before it reaches the list. A
// search of twelve hits therefore costs twelve small metadata requests, and the
// results the player shows all load.

import { normaliseArchiveDoc, pickMidiFile, proxyUrl } from '../midisources.js';

const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata/';
const DOWNLOAD = 'https://archive.org/download/';

const FIELDS = ['identifier', 'title', 'creator', 'licenseurl', 'item_size'];

// One metadata response per identifier per session. The result list and the
// later download both read it.
const metadataCache = new Map();

async function getJson(url, { signal } = {}) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Internet Archive answered ${response.status}`);
  return response.json();
}

function searchUrl(query, limit) {
  const params = new URLSearchParams({
    q: `${query} AND format:(MIDI)`,
    rows: String(limit),
    page: '1',
    output: 'json',
  });
  for (const field of FIELDS) params.append('fl[]', field);
  return `${SEARCH}?${params}`;
}

async function metadata(identifier, { signal } = {}) {
  if (metadataCache.has(identifier)) return metadataCache.get(identifier);
  const data = await getJson(`${METADATA}${encodeURIComponent(identifier)}`, { signal });
  metadataCache.set(identifier, data);
  return data;
}

function filesOf(data) {
  const files = data?.files;
  if (Array.isArray(files)) return files;
  // A single-file item returns an object, not a list.
  if (files && typeof files === 'object') return [files];
  return [];
}

export const internetArchive = {
  id: 'internetarchive',
  label: 'Internet Archive',

  /**
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<object[]>}
   */
  async search(query, { limit = 12, signal } = {}) {
    const data = await getJson(searchUrl(query, limit), { signal });
    const docs = data?.response?.docs ?? [];
    const results = docs.map(normaliseArchiveDoc).filter(Boolean);
    if (!results.length) return [];

    // Check each hit in parallel but keep the search order, and drop an entry
    // that holds no MIDI file or that the archive will not serve.
    const checked = await Promise.all(results.map(async (result) => {
      try {
        const data = await metadata(result.identifier, { signal });
        if (data?.is_dark) return null;
        const file = pickMidiFile(filesOf(data));
        if (!file) return null;
        return { ...result, fileName: file.name, size: file.size || result.size };
      } catch {
        return null;
      }
    }));

    return checked.filter(Boolean);
  },

  /**
   * Download a result through the proxy. The proxy is the only component that
   * can reach the storage host from a browser.
   *
   * @param {object} result
   * @param {{ signal?: AbortSignal, base?: string }} [options]
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchMidi(result, { signal, base } = {}) {
    const file = result.fileName || pickMidiFile(filesOf(await metadata(result.identifier, { signal })))?.name;
    if (!file) throw new Error('This item holds no MIDI file');
    const target = `${DOWNLOAD}${encodeURIComponent(result.identifier)}/${encodeURIComponent(file)}`;
    const response = await fetch(proxyUrl(target, base), { signal });
    if (!response.ok) throw new Error(`The download failed (${response.status})`);
    return response.arrayBuffer();
  },

  /** Exposed for tests and for a full reset between sessions. */
  clearCache() {
    metadataCache.clear();
  },
};