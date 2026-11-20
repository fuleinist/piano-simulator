// Proxy tests: the address allowlist, the origin check, the rate limiter, and
// the handler itself against a fake fetch.
// Run: node --test tests/proxy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, handleProxy, isAllowedOrigin, isAllowedTarget } from '../worker/proxy.js';

const SELF = 'https://piano-simulator.fuleinist.workers.dev';

test('only https archive.org downloads pass the allowlist', () => {
  assert.equal(isAllowedTarget('https://archive.org/download/x/a.mid'), true);
  assert.equal(isAllowedTarget('https://dn711309.ca.archive.org/0/items/x/a.mid'), true);
  assert.equal(isAllowedTarget('https://ia801504.us.archive.org/6/items/x/a.mid'), true);
  // The storage host carries no /download/ prefix; the requirement is the host.
  assert.equal(isAllowedTarget('https://ia801504.us.archive.org/anything/else'), true);
  assert.equal(isAllowedTarget('https://archive.org/metadata/x'), false, 'the apex host needs /download/');

  assert.equal(isAllowedTarget('http://archive.org/download/x/a.mid'), false, 'plain http must fail');
  assert.equal(isAllowedTarget('https://example.com/a.mid'), false);
  assert.equal(isAllowedTarget('https://archive.org/details/x'), false, 'only the download path');
  assert.equal(isAllowedTarget('https://archive.org.evil.com/download/x/a.mid'), false);
  assert.equal(isAllowedTarget('https://evilarchive.org/download/x/a.mid'), false);
  assert.equal(isAllowedTarget('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedTarget('not a url'), false);
  assert.equal(isAllowedTarget(''), false);
});

test('the origin check allows the same origin, localhost, and no origin', () => {
  assert.equal(isAllowedOrigin(null, SELF), true);
  assert.equal(isAllowedOrigin(SELF, SELF), true);
  assert.equal(isAllowedOrigin('http://localhost:5173', SELF), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4173', SELF), true);
  assert.equal(isAllowedOrigin('https://evil.example', SELF), false);
  assert.equal(isAllowedOrigin('null', SELF), false);
  assert.equal(isAllowedOrigin('file://', SELF), false);
});

test('the rate limiter blocks past its limit and reopens after the window', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(limiter.check('a', now), true);
  assert.equal(limiter.check('a', now + 1), true);
  assert.equal(limiter.check('a', now + 2), true);
  assert.equal(limiter.check('a', now + 3), false, 'the fourth call in the window is refused');
  assert.equal(limiter.check('b', now + 4), true, 'another client has its own bucket');
  assert.equal(limiter.check('a', now + 1001), true, 'the window reopens');
});

const ok = (bytes, headers = {}) => new Response(bytes, { status: 200, headers });

function proxyRequest(url, headers = {}, method = 'GET') {
  return new Request(`https://site.test/api/midi?url=${encodeURIComponent(url)}`, { method, headers });
}

const target = 'https://archive.org/download/x/a.mid';

test('a preflight is answered with the CORS headers', async () => {
  const response = await handleProxy(proxyRequest(target, { Origin: 'http://localhost:5173' }, 'OPTIONS'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /GET/);
});

test('a write method is refused', async () => {
  const response = await handleProxy(proxyRequest(target, {}, 'POST'));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
});

test('a foreign origin is refused', async () => {
  const response = await handleProxy(proxyRequest(target, { Origin: 'https://evil.example' }));
  assert.equal(response.status, 403);
});

test('a missing or disallowed url is refused before any fetch runs', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return ok(new Uint8Array([1])); };

  const none = await handleProxy(new Request('https://site.test/api/midi'), { fetchImpl });
  assert.equal(none.status, 400);

  const offsite = await handleProxy(proxyRequest('https://evil.example/a.mid'), { fetchImpl });
  assert.equal(offsite.status, 400);
  assert.equal(calls, 0, 'no request may leave for a refused address');
});

test('an allowed download comes back with CORS and a MIDI type', async () => {
  const bytes = new Uint8Array([0x4d, 0x54, 0x68, 0x64]);
  const fetchImpl = async (url) => {
    assert.equal(url, target);
    return ok(bytes, { 'Content-Type': 'application/octet-stream' });
  };
  const response = await handleProxy(
    proxyRequest(target, { Origin: 'http://127.0.0.1:4173' }),
    { fetchImpl, cache: null, clientKey: 'test-happy' },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:4173');
  assert.equal(response.headers.get('Content-Type'), 'audio/midi');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=86400');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('a redirect to an allowed host is followed', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === target) return new Response(null, { status: 302, headers: { Location: 'https://dn711309.ca.archive.org/0/items/x/a.mid' } });
    return ok(new Uint8Array([1, 2]));
  };
  const response = await handleProxy(proxyRequest(target), { fetchImpl, cache: null, clientKey: 'test-redirect' });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /ca\.archive\.org/);
});

test('a redirect off the allowlist is refused', async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://evil.example/steal.mid' },
  });
  const response = await handleProxy(proxyRequest(target), { fetchImpl, cache: null, clientKey: 'test-offsite' });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /redirected off site/);
});

test('a declared oversize file is refused before it is read', async () => {
  const fetchImpl = async () => ok(new Uint8Array([1]), { 'Content-Length': String(9 * 1024 * 1024) });
  const response = await handleProxy(proxyRequest(target), { fetchImpl, cache: null, clientKey: 'test-big' });
  assert.equal(response.status, 413);
});

test('a source error becomes a 502 with a readable message', async () => {
  const fetchImpl = async () => new Response('gone', { status: 404 });
  const response = await handleProxy(proxyRequest(target), { fetchImpl, cache: null, clientKey: 'test-404' });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /404/);
});

test('the endpoint refuses a client after its burst', async () => {
  const response = await handleProxy(
    proxyRequest(target),
    { fetchImpl: async () => ok(new Uint8Array([1])), cache: null, clientKey: 'test-limit', now: 5_000_000 },
  );
  assert.equal(response.status, 200);

  let blocked = null;
  for (let i = 0; i < 70; i++) {
    // Same instant, so the window cannot roll over.
    const next = await handleProxy(
      proxyRequest(target),
      { fetchImpl: async () => ok(new Uint8Array([1])), cache: null, clientKey: 'test-limit', now: 5_000_000 },
    );
    if (next.status === 429) { blocked = next; break; }
  }
  assert.ok(blocked, 'the limiter must refuse a sustained burst');
  assert.equal(blocked.headers.get('Retry-After'), '60');
});

test('a cache hit is served without touching the source', async () => {
  const store = new Map();
  const cache = {
    async match(key) { return store.get(key.url); },
    async put(key, response) { store.set(key.url, response); },
  };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return ok(new Uint8Array([7, 7])); };

  const first = await handleProxy(proxyRequest(target), { fetchImpl, cache, clientKey: 'test-cache' });
  assert.equal(first.status, 200);
  assert.equal(calls, 1);

  const second = await handleProxy(proxyRequest(target), { fetchImpl, cache, clientKey: 'test-cache' });
  assert.equal(second.status, 200);
  assert.equal(calls, 1, 'the second call must come from the cache');
  assert.equal(second.headers.get('Content-Type'), 'audio/midi');
});