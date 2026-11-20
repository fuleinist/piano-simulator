#!/usr/bin/env node
// Start Route A: the relay on this machine plus a Cloudflare quick tunnel, then
// print the address the site build needs. One command replaces the manual dance
// in docs/live-relay-deploy.md, and the address changes each run, so the printed
// commands are the point.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allOk, buildCommands, encodersOk, parseTunnelUrl, preflightReport, toWss,
} from '../relay/tunnel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(HERE, '..', 'relay');
const SITE_ORIGIN = 'https://piano-simulator.fuleinist.workers.dev';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

const port = Number(arg('port', 8088));
const origin = arg('origin', SITE_ORIGIN);
const once = Boolean(arg('once', false));
// Test hook: a stub that prints a tunnel banner and exits. Never a real tunnel.
const tunnelCmd = arg('tunnel-cmd', '');
const relayCmd = arg('relay-cmd', '');

function portFree(value) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(value, '127.0.0.1');
  });
}

function which(binary) {
  // A missing binary sets `error`. A present one may still exit non-zero on an
  // unknown flag, so the error field decides, not the status.
  const probe = spawnSync(binary, ['--version'], { stdio: 'ignore', shell: false });
  return !probe.error;
}

function encoders() {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return probe.status === 0 ? encodersOk(probe.stdout + probe.stderr) : false;
}

async function main() {
  const rows = preflightReport({
    nodeOk: Number(process.versions.node.split('.')[0]) >= 20,
    nodeMajor: process.versions.node.split('.')[0],
    ffmpegOk: encoders(),
    tunnelOk: Boolean(tunnelCmd) || which('cloudflared'),
    portFree: await portFree(port),
    port,
    origin,
  });

  console.log('\nRoute A preflight');
  for (const row of rows) {
    console.log(`  ${row.ok ? 'ok  ' : 'FAIL'}  ${row.label}`);
    if (!row.ok) console.log(`        ${row.fix}`);
  }
  if (!allOk(rows)) {
    console.log('\nFix the failures above, then run this again.\n');
    process.exitCode = 1;
    return;
  }

  const relay = spawn(
    process.execPath,
    relayCmd ? relayCmd.split(' ') : ['server.js'],
    {
      cwd: RELAY_DIR,
      env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  relay.stdout.on('data', (chunk) => process.stdout.write(`relay: ${chunk}`));
  relay.stderr.on('data', (chunk) => process.stderr.write(`relay: ${chunk}`));

  // A test stub arrives as a script path or as a JSON array. A plain command such
  // as `cloudflared` splits on spaces, which is enough for a name on PATH.
  const tunnelArgv = (() => {
    if (!tunnelCmd) return ['cloudflared', 'tunnel', '--url', `http://127.0.0.1:${port}`];
    const text = String(tunnelCmd).trim();
    if (text.startsWith('[')) return JSON.parse(text);
    if (/\.(mjs|js)$/i.test(text)) return [process.execPath, text];
    return text.split(/\s+/);
  })();
  if (tunnelArgv.length === 0 || typeof tunnelArgv[0] !== 'string') {
    throw new Error('--tunnel-cmd needs a command');
  }
  const tunnel = spawn(tunnelArgv[0], tunnelArgv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });

  let printed = false;
  const stop = (code = 0) => {
    for (const child of [relay, tunnel]) {
      if (!child || child.killed) continue;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
    setTimeout(() => process.exit(code), 300);
  };

  const onData = (chunk) => {
    const text = String(chunk);
    process.stderr.write(`tunnel: ${text}`);
    if (printed) return;
    const url = parseTunnelUrl(text);
    const wss = url ? toWss(url) : null;
    if (!wss) return;
    printed = true;
    const [set, run] = buildCommands(wss);
    console.log('\nThe tunnel is up. The site needs this value:\n');
    console.log(`  VITE_RELAY_URL=${wss}\n`);
    console.log('Run these two commands:\n');
    console.log(`  ${set}`);
    console.log(`  ${run}\n`);
    console.log('The address changes when this process restarts. Run them again then.');
    console.log('Leave this terminal open while you stream. Press Ctrl+C to stop.\n');
    if (once) stop(0);
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('error', (error) => {
    console.error(`\nThe tunnel did not start: ${error.message}`);
    stop(1);
  });
  relay.on('error', (error) => {
    console.error(`\nThe relay did not start: ${error.message}`);
    stop(1);
  });

  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  tunnel.on('exit', (code) => {
    if (!printed) {
      console.error(`\nThe tunnel stopped before it printed an address (exit ${code}).`);
      stop(1);
    }
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});