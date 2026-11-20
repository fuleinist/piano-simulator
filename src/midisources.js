// Normalisation and fan-out for remote MIDI catalogues.
//
// A provider turns a query into results with a licence, and turns a result into
// bytes. This module holds the parts that do not touch the network: the result
// shape, the licence labels, the file choice, the timeout wrapper, and the
// deduplication. tests/midisources.test.mjs runs it under `node --test`.

/** The proxy path that adds CORS to a third-party download. */
export const PROXY_PATH = '/api/midi';

/** The label shown when a record carries no licence. */
export const UNKNOWN_LICENSE = 'Licence not stated';

const CC_HOST = /creativecommons\.org\/(licenses\/([a-z-]+)\/(\d\.\d)|publicdomain\/(mark|zero)\/(\d\.\d))/i;

/**
 * Turn a licence URL into a short label the UI can show next to a result.
 * Unrecognised or missing URLs return the unknown label, so the result still
 * shows something honest.
 *
 * @param {string | null | undefined} url
 * @returns {{ label: string, url: string | null, known: boolean }}
 */
export function describeLicense(url) {
  const link = String(url ?? '').trim();
  if (!link) return { label: UNKNOWN_LICENSE, url: null, known: false };

  const match = link.match(CC_HOST);
  if (!match) return { label: UNKNOWN_LICENSE, url: link, known: false };

  if (match[4]) {
    return { label: `Public domain (${match[5]})`, url: link, known: true };
  }
  const code = match[2].toUpperCase();
  return { label: `CC ${code} ${match[3]}`, url: link, known: true };
}

/**
 * Choose the file to download from an item's file list. Files arrive in the
 * order the archive lists them, so the choice stays stable between calls.
 *
 * @param {{ name?: string, size?: string | number }[]} files
 * @returns {{ name: string, size: number } | null}
 */
export function pickMidiFile(files) {
  for (const file of files ?? []) {
    const name = String(file?.name ?? '');
    if (!/\.midi?$/i.test(name)) continue;
    const size = Number(file.size);
    return { name, size: Number.isFinite(size) ? size : 0 };
  }
  return null;
}

/** A readable creator string: the archive returns a string or a list. */
export function creatorName(creator) {
  if (Array.isArray(creator)) return creator.filter(Boolean).join(', ');
  return String(creator ?? '').trim();
}

/**
 * Build a canonical result from one archive search document. The result is
 * what the UI shows, so every field it needs is filled here.
 *
 * @param {Record<string, unknown>} doc
 * @returns {object | null}
 */
export function normaliseArchiveDoc(doc) {
  const identifier = String(doc?.identifier ?? '').trim();
  if (!identifier) return null;
  const title = String(doc.title ?? identifier).trim() || identifier;
  const licence = describeLicense(doc.licenseurl);
  return {
    id: `internetarchive:${identifier}`,
    provider: 'internetarchive',
    source: 'Internet Archive',
    identifier,
    title,
    composer: creatorName(doc.creator),
    license: licence.label,
    licenseUrl: licence.url,
    sourceUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    size: Number(doc.item_size) || 0,
  };
}

/** The proxy URL for one third-party download. */
export function proxyUrl(target, base = PROXY_PATH) {
  return `${base}?url=${encodeURIComponent(target)}`;
}

/** How long a provider may take before the fan-out gives up on it. */
export const DEFAULT_TIMEOUT_MS = 7000;

async function withTimeout(provider, query, { limit, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  // Race the provider against a timer, so a provider that ignores its signal
  // cannot stall the fan-out. The abort still reaches a provider that listens.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${provider.label} did not answer within ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.search(query, { limit, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query every provider at once. One dead provider must not blank the list, so
 * a failure becomes an entry in `errors` and the rest of the results stay.
 *
 * @param {{ id: string, label: string, search: Function }[]} providers
 * @param {string} query
 * @param {{ limit?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ results: object[], errors: { source: string, message: string }[] }>}
 */
export async function searchAll(providers, query, { limit = 12, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed || !providers?.length) return { results: [], errors: [] };

  const settled = await Promise.allSettled(
    providers.map((provider) => withTimeout(provider, trimmed, { limit, timeoutMs })),
  );

  const results = [];
  const errors = [];
  settled.forEach((outcome, index) => {
    const provider = providers[index];
    if (outcome.status === 'fulfilled') {
      for (const result of outcome.value ?? []) if (result) results.push(result);
    } else {
      errors.push({ source: provider.label || provider.id, message: String(outcome.reason?.message || outcome.reason) });
    }
  });

  return { results: dedupe(results).slice(0, limit), errors };
}

/** Drop repeated results, keeping the first. */
export function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const result of results ?? []) {
    const key = result?.id || `${result?.source}:${result?.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}