// The streaming relay.
//
// A browser cannot speak RTMP, so the page sends WebM chunks over a WebSocket
// and this process transcodes them with ffmpeg to the platform ingest.
//
// Safety rules:
// - The origin allowlist keeps a foreign page from opening a session.
// - A session cap and a hard duration limit bound the cost of an abuse attempt.
// - ffmpeg receives an argument array, so the stream key never passes through
//   a shell.
// - The log prints the ingest with the key redacted, and never the key.

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { buildArgs, checkIngest, redact } from './ffmpeg.js';

const PORT = Number(process.env.PORT || 8088);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 4);
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 4 * 3600);
const START_TIMEOUT_MS = 10_000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:4174,http://127.0.0.1:5173,http://127.0.0.1:4174')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

let sessions = 0;

function originAllowed(origin) {
  if (!origin) return false; // a browser always sends Origin on a WebSocket
  return ALLOWED_ORIGINS.includes(origin);
}

const wss = new WebSocketServer({ port: PORT, maxPayload: 8 * 1024 * 1024 });

wss.on('listening', () => {
  console.log(`relay: listening on ws://127.0.0.1:${PORT}`);
  console.log(`relay: origins ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`relay: max ${MAX_SESSIONS} sessions, ${MAX_SECONDS} s each`);
});

wss.on('connection', (socket, request) => {
  const origin = request.headers.origin;
  if (!originAllowed(origin)) {
    socket.send(JSON.stringify({ type: 'error', message: 'This page may not stream through the relay.' }));
    socket.close(1008, 'origin');
    return;
  }
  if (sessions >= MAX_SESSIONS) {
    socket.send(JSON.stringify({ type: 'error', message: 'The relay is at its session limit. Try again later.' }));
    socket.close(1013, 'busy');
    return;
  }

  sessions += 1;
  let ffmpeg = null;
  let target = '';
  let timer = null;
  let closed = false;

  const finish = (code = 1000, reason = 'done') => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    sessions = Math.max(0, sessions - 1);
    if (ffmpeg) {
      try { ffmpeg.stdin.end(); } catch { /* already closed */ }
      // Give ffmpeg a moment to write the trailer, then insist.
      const kill = setTimeout(() => { try { ffmpeg.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      ffmpeg.once('exit', () => clearTimeout(kill));
      try { ffmpeg.kill('SIGTERM'); } catch { /* gone */ }
      ffmpeg = null;
    }
    target = '';
    try { socket.close(code, reason); } catch { /* already closed */ }
  };

  const startTimer = setTimeout(() => {
    if (!ffmpeg) {
      socket.send(JSON.stringify({ type: 'error', message: 'The start message did not arrive.' }));
      finish(1008, 'timeout');
    }
  }, START_TIMEOUT_MS);

  socket.on('message', (data, isBinary) => {
    if (closed) return;

    if (isBinary) {
      if (!ffmpeg) return;
      if (ffmpeg.stdin.writable) ffmpeg.stdin.write(data);
      return;
    }

    let message;
    try { message = JSON.parse(String(data)); } catch { return; }

    if (message.type === 'stop') { finish(); return; }

    if (message.type === 'start') {
      if (ffmpeg) return;
      clearTimeout(startTimer);
      if (!checkIngest(message.ingest)) {
        socket.send(JSON.stringify({ type: 'error', message: 'The ingest address is not an rtmp:// or rtmps:// address.' }));
        finish(1008, 'bad-ingest');
        return;
      }
      target = message.ingest;

      let args;
      try {
        args = buildArgs({ ingest: target, quality: message.quality });
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', message: error.message }));
        finish(1008, 'bad-args');
        return;
      }

      ffmpeg = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      console.log(`relay: session open → ${redact(target)}`);

      ffmpeg.on('error', (error) => {
        console.error('relay: ffmpeg did not start:', error.message);
        socket.send(JSON.stringify({ type: 'error', message: 'The relay could not start ffmpeg.' }));
        finish(1011, 'ffmpeg');
      });
      ffmpeg.stderr.on('data', (chunk) => {
        // ffmpeg warnings only; the ingest URL is not printed here.
        const line = String(chunk).trim();
        if (line) console.warn('relay: ffmpeg:', line.slice(0, 200));
      });
      ffmpeg.on('exit', (code, signal) => {
        console.log(`relay: ffmpeg exited (${signal || code})`);
        if (!closed) {
          socket.send(JSON.stringify({ type: 'error', message: 'ffmpeg stopped. Check the ingest address and the key.' }));
          finish(1011, 'ffmpeg-exit');
        }
      });

      socket.send(JSON.stringify({ type: 'ready', target: redact(target) }));
      timer = setTimeout(() => {
        socket.send(JSON.stringify({ type: 'error', message: `The session reached its ${MAX_SECONDS} s limit.` }));
        finish(1000, 'limit');
      }, MAX_SECONDS * 1000);
    }
  });

  socket.on('close', () => finish(1000, 'client-closed'));
  socket.on('error', () => finish(1011, 'socket-error'));
});

process.on('SIGINT', () => {
  console.log('relay: stopping');
  wss.close(() => process.exit(0));
});
