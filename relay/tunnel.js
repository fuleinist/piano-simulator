// Route A helpers: read the quick tunnel address, turn it into the build
// value, and describe what a first run needs. Pure functions only, so the test
// suite covers them without a browser, a tunnel, or a network.

/** cloudflared prints ANSI colour codes. They break a naive match. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Read the address out of cloudflared output. The banner puts the address on
 * its own line between box characters, and a log line also names it, so the
 * first https address on a trycloudflare host wins.
 */
export function parseTunnelUrl(text) {
  const clean = stripAnsi(text);
  const match = clean.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return match ? match[0].toLowerCase() : null;
}

/** The build wants wss://. The tunnel prints https://. */
export function toWss(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com\/?$/i.test(trimmed)) return null;
  return `wss://${trimmed.replace(/^https:\/\//i, '').replace(/\/$/, '')}`;
}

/** The two commands that put the address on the site. */
export function buildCommands(wssUrl, { repo = '' } = {}) {
  if (!wssUrl) return [];
  const set = repo
    ? `gh variable set VITE_RELAY_URL --repo ${repo} --body "${wssUrl}"`
    : `gh variable set VITE_RELAY_URL --body "${wssUrl}"`;
  const run = repo ? `gh workflow run deploy.yml --repo ${repo}` : 'gh workflow run deploy.yml';
  return [set, run];
}

/** ffmpeg must carry both encoders the relay asks for. */
export function parseEncoders(text) {
  const clean = stripAnsi(text);
  return {
    libx264: /\blibx264\b/.test(clean),
    aac: /\b(libfdk_aac|aac)\b/.test(clean),
  };
}

export function encodersOk(text) {
  const found = parseEncoders(text);
  return found.libx264 && found.aac;
}

/**
 * One line per requirement, in the order a person hits them. `ok` false carries
 * the fix, so the caller prints an answer and not just a failure.
 */
export function preflightReport(checks) {
  const rows = [];
  const add = (ok, label, fix) => rows.push({ ok: Boolean(ok), label, fix });
  add(checks.nodeOk, `Node ${checks.nodeMajor} (needs 20 or newer)`, 'Install Node 20 or newer.');
  add(checks.ffmpegOk, 'ffmpeg has libx264 and aac', 'Install a full ffmpeg build, or set FFMPEG_PATH.');
  add(checks.tunnelOk, 'cloudflared is on PATH', 'Run: winget install --id Cloudflare.cloudflared');
  add(checks.portFree, `port ${checks.port} is free`, 'Stop the other process, or pass --port with a free port.');
  add(Boolean(checks.origin), `site origin ${checks.origin}`, 'Pass --origin https://your-site');
  return rows;
}

export function allOk(rows) {
  return rows.every((row) => row.ok);
}