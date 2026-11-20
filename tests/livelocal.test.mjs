// Route A tests: the tunnel banner, the build value, and the starter script.
// Run: node --test tests/livelocal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  allOk, buildCommands, encodersOk, parseEncoders, parseTunnelUrl, preflightReport, stripAnsi, toWss,
} from '../relay/tunnel.js';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('the banner address is read past the box drawing', () => {
  const banner = [
    '2026-11-20T10:00:00Z INF +--------------------------------------------------------------------------------------------+',
    '2026-11-20T10:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
    '2026-11-20T10:00:00Z INF |  https://plain-river-1234.trycloudflare.com                                                |',
    '2026-11-20T10:00:00Z INF +--------------------------------------------------------------------------------------------+',
  ].join('\n');
  assert.equal(parseTunnelUrl(banner), 'https://plain-river-1234.trycloudflare.com');
});

test('colour codes do not hide the address', () => {
  const line = '\u001b[36mINF\u001b[0m |  \u001b[32mhttps://quiet-pond-88.trycloudflare.com\u001b[0m  |';
  assert.equal(stripAnsi(line).includes('\u001b'), false);
  assert.equal(parseTunnelUrl(line), 'https://quiet-pond-88.trycloudflare.com');
});

test('a foreign host is refused', () => {
  assert.equal(parseTunnelUrl('https://example.com/tunnel'), null);
  assert.equal(parseTunnelUrl('INF no address yet'), null);
  assert.equal(parseTunnelUrl(''), null);
});

test('the build value uses wss and keeps the host', () => {
  assert.equal(toWss('https://plain-river-1234.trycloudflare.com'), 'wss://plain-river-1234.trycloudflare.com');
  assert.equal(toWss('https://plain-river-1234.trycloudflare.com/'), 'wss://plain-river-1234.trycloudflare.com');
  assert.equal(toWss('https://example.com'), null, 'only a tunnel host is accepted');
  assert.equal(toWss('wss://plain-river-1234.trycloudflare.com'), null, 'an address, not a socket');
  assert.equal(toWss(null), null);
});

test('the printed commands carry the value', () => {
  const [set, deploy] = buildCommands('wss://plain-river-1234.trycloudflare.com');
  assert.match(set, /^gh variable set VITE_RELAY_URL --body "wss:\/\/plain-river-1234\.trycloudflare\.com"$/);
  assert.match(deploy, /^gh workflow run deploy\.yml$/);
  assert.deepEqual(buildCommands(null), [], 'no value, no commands');
  const withRepo = buildCommands('wss://a-b.trycloudflare.com', { repo: 'fuleinist/piano-simulator' });
  assert.match(withRepo[0], /--repo fuleinist\/piano-simulator/);
});

test('the encoder check needs libx264 and aac together', () => {
  const full = `Encoders:
 V..... = Video
 V....D libx264              H.264 / AVC (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)`;
  assert.deepEqual(parseEncoders(full), { libx264: true, aac: true });
  assert.equal(encodersOk(full), true);
  assert.equal(encodersOk(' V....D libvpx  VP8'), false, 'a build without the encoders fails');
  assert.equal(encodersOk(' A....D libfdk_aac'), false, 'aac alone fails');
  assert.equal(encodersOk(' A....D libfdk_aac\n V....D libx264'), true, 'the alternative aac counts');
});

test('the report names the fix for each failure', () => {
  const rows = preflightReport({
    nodeOk: true, nodeMajor: '26', ffmpegOk: false, tunnelOk: false, portFree: true, port: 8088, origin: '',
  });
  assert.equal(rows.length, 5);
  assert.equal(allOk(rows), false);
  const failed = rows.filter((row) => !row.ok);
  assert.equal(failed.length, 3);
  for (const row of failed) assert.ok(row.fix.length > 0, `${row.label} needs a fix line`);
  assert.match(failed[0].fix, /ffmpeg/i);
  assert.match(failed[1].fix, /cloudflared/);
  assert.match(failed[2].fix, /--origin/);
});

test('the starter prints the value and the commands from a stub tunnel', async (t) => {
  // A stub stands in for cloudflared. No real tunnel opens, so nothing leaves
  // this machine.
  const dir = mkdtempSync(join(tmpdir(), 'live-local-'));
  const stub = join(dir, 'stub-tunnel.mjs');
  writeFileSync(stub, [
    'process.stderr.write("INF |  https://stub-river-77.trycloudflare.com  |\\n");',
    'setTimeout(() => {}, 5000);',
  ].join('\n'));

  try {
    const { stdout } = await run(
      process.execPath,
      [
        join(ROOT, 'scripts', 'live-local.mjs'),
        '--once',
        '--port', '8098',
        '--tunnel-cmd', stub,
        '--relay-cmd', 'server.js',
      ],
      { timeout: 30000 },
    );
    assert.match(stdout, /VITE_RELAY_URL=wss:\/\/stub-river-77\.trycloudflare\.com/);
    assert.match(stdout, /gh variable set VITE_RELAY_URL --body "wss:\/\/stub-river-77\.trycloudflare\.com"/);
    assert.match(stdout, /gh workflow run deploy\.yml/);
    assert.match(stdout, /address changes when this process restarts/);
  } catch (error) {
    if (t.diagnostic) t.diagnostic(String(error.stdout || error.message));
    throw error;
  }
});