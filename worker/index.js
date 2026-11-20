// Worker entry.
//
// The site is a static build, with one dynamic route: /api/midi, which exists
// only to add CORS to a third-party MIDI download. Every other request goes to
// the assets binding, which serves dist/ and falls back to index.html.

import { handleProxy } from './proxy.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/midi') return handleProxy(request);
    return env.ASSETS.fetch(request);
  },
};