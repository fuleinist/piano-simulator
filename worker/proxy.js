// The MIDI download proxy.
//
// The Internet Archive serves a .mid file with a 302 to a storage host that
// sends no Access-Control-Allow-Origin, so a browser cannot read the bytes.
// This handler adds that header for one host family, and nothing else:
//
// - Only https requests to archive.org or a subdomain, under /download/, pass.
//   The allowlist runs again on every redirect hop, so the archive cannot
//   bounce the request somewhere else.
// - Only GET and HEAD pass, so the proxy cannot be used to write.
// - A foreign Origin is refused, which keeps the endpoint from becoming a
//   general-purpose fetcher for other sites.
// - Responses are cached at the edge for a day.
// - A small token bucket limits each client address. Isolates do not share the
//   map, so this is a speed bump rather than a hard quota.

const ALLOWED_SUFFIX = '.archive.org';
const ALLOWED_HOST = 'archive.org';
const ALLOWED_PATH = '/download/';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_SECONDS = 86_400;

/**
 * True when this URL may be fetched on a visitor's behalf.
 * @param {string} raw
 */
export function isAllowedTarget(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === ALLOWED_HOST) return url.pathname.startsWith(ALLOWED_PATH);
  // A download redirects to a storage host such as dn711309.ca.archive.org,
  // whose path carries no /download/ prefix. Those hosts serve archive files
  // only, so any path on them is acceptable.
  return host.endsWith(ALLOWED_SUFFIX);
}

/** True when this origin may call the proxy. */
export function isAllowedOrigin(origin, self) {
  if (!origin) return true; // same-origin GET sends no Origin header
  if (origin === self) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/** Small sliding window limiter, kept per isolate. */
export class RateLimiter {
  constructor({ limit = 60, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {boolean} true when the call is allowed */
  check(key, now = Date.now()) {
    if (this.hits.size > 5_000) {
      for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}

const limiter = new RateLimiter();

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  Vary: 'Origin',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept',
  'Access-Control-Max-Age': '86400',
});

const fail = (status, message, origin, extra = {}) => new Response(JSON.stringify({ error: message }), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...cors(origin),
    ...extra,
  },
});

/**
 * @param {Request} request
 * @param {{ fetchImpl?: Function, cache?: Cache, clientKey?: string, now?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function handleProxy(request, options = {}) {
  const {
    fetchImpl = fetch,
    cache = globalThis.caches?.default,
    clientKey = request.headers.get('cf-connecting-ip') || 'unknown',
    now = Date.now(),
  } = options;

  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;

  if (!isAllowedOrigin(origin, self)) return fail(403, 'Origin not allowed', null);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'Method not allowed', origin, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (!limiter.check(clientKey, now)) {
    return fail(429, 'Too many requests', origin, { 'Retry-After': '60' });
  }

  const target = new URL(request.url).searchParams.get('url');
  if (!target) return fail(400, 'Missing url', origin);
  if (!isAllowedTarget(target)) return fail(400, 'That address is not allowed', origin);

  const cacheKey = new Request(`https://proxy.invalid/?url=${encodeURIComponent(target)}`);
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
        return new Response(request.method === 'HEAD' ? null : hit.body, { status: 200, headers });
      }
    } catch {
      /* a cache miss must not block the download */
    }
  }

  // Follow redirects by hand, so every hop meets the allowlist.
  let url = target;
  let response = null;
  for (let hop = 0; hop < 4; hop++) {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (!location) return fail(502, 'The source returned no location', origin);
      const next = new URL(location, url).toString();
      if (!isAllowedTarget(next)) return fail(502, 'The source redirected off site', origin);
      url = next;
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    return fail(502, `The source answered ${response ? response.status : 'nothing'}`, origin);
  }

  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return fail(413, 'That file is too large', origin);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return fail(413, 'That file is too large', origin);

  const headers = new Headers(cors(origin));
  headers.set('Content-Type', 'audio/midi');
  headers.set('Content-Length', String(bytes.byteLength));
  headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);

  if (cache) {
    try {
      await cache.put(cacheKey, new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'audio/midi', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
      }));
    } catch {
      /* the download still succeeds without a cache entry */
    }
  }

  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}