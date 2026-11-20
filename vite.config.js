import { defineConfig } from 'vite';
import { handleProxy } from './worker/proxy.js';

// The deployed site runs /api/midi inside the Worker (worker/index.js). The dev
// and preview servers have no Worker, so the same handler runs as middleware.
// One implementation, so a proxy bug shows up in development too.
function midiProxy() {
  const middleware = (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/midi') { next(); return; }

    const request = new Request(url.toString(), { method: req.method, headers: req.headers });
    handleProxy(request)
      .then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        const body = Buffer.from(await response.arrayBuffer());
        res.end(body);
      })
      .catch((error) => {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      });
  };

  return {
    name: 'piano-midi-proxy',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

export default defineConfig({
  base: './',
  plugins: [midiProxy()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});