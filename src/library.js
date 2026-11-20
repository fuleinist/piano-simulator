// Pure helpers for the local MIDI library.
//
// The store itself lives in src/librarystore.js, because IndexedDB only exists
// in a browser. Everything that can be reasoned about without a database sits
// here: the content hash that deduplicates an import, the metadata that a
// stored record carries, the picker entry built from it, and the sort order.
// tests/library.test.mjs runs this module under `node --test`.

/** Bumped when a stored record gains or changes a field. */
export const SCHEMA_VERSION = 1;

/** Library bytes above which the UI starts warning about browser storage. */
export const WARN_BYTES = 5 * 1024 * 1024;

const GENERIC_TRACK = /^(piano|piano\s*(left|right|l|r)|treble|bass|melody|right hand|left hand|track\s*\d+|instrument\s*\d+|\d+)$/i;

/** Strip a .mid or .midi extension, whatever its case. */
export function stripExtension(name) {
  return String(name ?? '').replace(/\.midi?$/i, '').trim();
}

/**
 * SHA-256 of the file bytes, as lower-case hex. Two imports of the same file
 * land on the same key, so the second one selects the first one instead of
 * adding a copy.
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function contentId(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isGenericTrackName(name) {
  const value = String(name ?? '').trim();
  return !value || GENERIC_TRACK.test(value);
}

/**
 * Choose the title a record shows. A sequence name from the MIDI wins, then a
 * meaningful track name, then the file name. A track called "Piano" says less
 * than the file name, so it is skipped.
 */
export function pickTitle({ name, midiTitle, trackNames } = {}) {
  const sequence = String(midiTitle ?? '').trim();
  if (sequence) return sequence;

  for (const track of trackNames ?? []) {
    const value = String(track ?? '').trim();
    if (!isGenericTrackName(value)) return value;
  }

  const stem = stripExtension(name);
  return stem || 'Untitled MIDI';
}

/** Human-readable size for the library panel. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** True when a failed write hit the browser storage quota. */
export function isQuotaError(error) {
  if (!error) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22;
}

/**
 * Build the record that goes into IndexedDB.
 *
 * @param {{
 *   id: string, name: string, bytes: ArrayBuffer,
 *   info: { notes?: number, duration?: number, midiTitle?: string, trackNames?: string[] },
 *   now?: number,
 * }} input
 */
export function buildRecord({ id, name, bytes, info, now = Date.now() }) {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    name: String(name || 'Untitled MIDI'),
    title: pickTitle({ name, midiTitle: info?.midiTitle, trackNames: info?.trackNames }),
    composer: '',
    bytes,
    size: bytes.byteLength ?? bytes.length ?? 0,
    addedAt: now,
    lastPlayedAt: 0,
    duration: Number(info?.duration) || 0,
    noteCount: Number(info?.notes) || 0,
  };
}

/**
 * Drop records this build cannot read: a record from a newer schema, or a
 * record whose bytes are missing. They stay in the database untouched, so a
 * later version can still open them.
 */
export function usableRecords(records) {
  return (records ?? []).filter((r) => (
    r
    && r.schemaVersion === SCHEMA_VERSION
    && typeof r.id === 'string'
    && typeof r.title === 'string'
    && r.bytes
    && typeof r.bytes.byteLength === 'number'
  ));
}

/** The name shown for a record: title, then composer when there is one. */
export function displayName(record) {
  if (!record) return '';
  return record.composer ? `${record.title} — ${record.composer}` : String(record.title || '');
}

/** A record as the picker wants it. */
export function toEntry(record) {
  return {
    id: `local:${record.id}`,
    kind: 'local',
    key: record.id,
    title: record.title || 'Untitled MIDI',
    composer: record.composer || '',
    size: record.size || 0,
    duration: record.duration || 0,
    noteCount: record.noteCount || 0,
    addedAt: record.addedAt || 0,
    lastPlayedAt: record.lastPlayedAt || 0,
  };
}

/**
 * Recently played first, then title. A piece that was never played sorts after
 * the played ones, because its lastPlayedAt is 0.
 */
export function sortRecords(records) {
  return [...(records ?? [])].sort((a, b) => (
    (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0)
    || String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base' })
  ));
}

/** Total stored bytes. */
export function totalBytes(records) {
  return (records ?? []).reduce((sum, r) => sum + (Number(r?.size) || 0), 0);
}

/** One-line summary for the library dialog. */
export function summarise(records) {
  const list = records ?? [];
  if (!list.length) return 'No files yet';
  return `${list.length} ${list.length === 1 ? 'file' : 'files'} · ${formatBytes(totalBytes(list))}`;
}