// Live streaming through the relay.
//
// A browser cannot open an RTMP socket, so the page records WebM with
// MediaRecorder and sends the chunks over a WebSocket. The relay runs ffmpeg,
// which transcodes VP8/Opus to H.264/AAC and pushes FLV to the platform.
//
// The stream key is a bearer credential:
// - it lives in this object's `_target` for the length of the session only,
// - it is never written to storage, the DOM, or a log,
// - anything the UI shows goes through redactTarget(),
// - it is cleared on stop and on any failure.
//
// A dropped socket retries twice with a backoff, then gives up with a message.

import * as Tone from 'tone';
import { releaseCapture, captureStream } from './capture.js';
import { DEFAULT_FRAME, FRAMES } from './frames.js';
import { STATE, nextState, retryDelay } from './streamstate.js';
import { findQuality, redactTarget, streamTarget } from './streampresets.js';

const MIME_OPTIONS = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export class Streamer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ setFrame: (frame: string | null) => void }} scene
   * @param {{ relayUrl?: string }} [options]
   */
  constructor(canvas, scene, { relayUrl = '' } = {}) {
    this.canvas = canvas;
    this.scene = scene;
    this.relayUrl = relayUrl;
    this.state = STATE.IDLE;
    this.error = '';
    this.frame = DEFAULT_FRAME;
    this.onState = null;
    this.bytes = 0;
    this.startedAt = 0;

    this._target = '';       // includes the key; never shown or stored
    this._quality = findQuality('');
    this._ws = null;
    this._rec = null;
    this._capture = null;
    this._ticker = 0;
    this._tail = 0;
    this._attempt = 0;
    this._stopping = false;
    this._ticker = 0;
  }

  /** A relay must be configured, or the button stays disabled. */
  get available() {
    return Boolean(this.relayUrl);
  }

  get onAir() {
    return this.state === STATE.LIVE;
  }

  /** The platform and key, with the key hidden. Safe for the UI. */
  get safeTarget() {
    return redactTarget(this._target);
  }

  mime() {
    return MIME_OPTIONS.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  }

  /**
   * @param {{ key: string, base: string, quality: string, frame?: string }} options
   */
  start({ key, base, quality, frame = DEFAULT_FRAME }) {
    if (this.state !== STATE.IDLE) return;
    const target = streamTarget(base, key);
    if (!target) {
      this.error = 'Enter a stream key and an ingest address.';
      this._emit();
      return;
    }
    this._target = target;
    this._quality = findQuality(quality);
    this.frame = FRAMES[frame] ? frame : DEFAULT_FRAME;
    this.error = '';
    this.bytes = 0;
    this._attempt = 0;
    this._stopping = false;
    this._setState(STATE.CONNECTING, 'start');
    this._connect();
  }

  stop() {
    if (this.state === STATE.IDLE || this.state === STATE.STOPPING) return;
    clearTimeout(this._tail);
    this._tail = 0;
    this._stopping = true;
    this._setState(STATE.STOPPING, 'stop');
    this._teardown();
    this._setState(STATE.IDLE, 'done');
  }

  /** Stop after a delay, so the last chord stays in the stream. */
  stopIn(seconds) {
    if (!this.onAir && this.state !== STATE.CONNECTING) return;
    clearTimeout(this._tail);
    this._tail = setTimeout(() => {
      this._tail = 0;
      this.stop();
    }, Math.max(0, seconds) * 1000);
  }

  toggle(options) {
    if (this.state === STATE.IDLE) this.start(options);
    else this.stop();
  }

  _connect() {
    let ws;
    try {
      ws = new WebSocket(this.relayUrl);
    } catch (error) {
      this._fail(`The relay address is not valid: ${error.message}`);
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start',
        ingest: this._target,
        mime: this.mime(),
        quality: {
          width: this._quality.width,
          height: this._quality.height,
          fps: this._quality.fps,
          bitrate: this._quality.bitrate,
        },
      }));
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'ready') this._goLive();
      else if (message.type === 'error') this._fail(message.message || 'The relay refused the stream.');
    };
    ws.onerror = () => {
      if (this.state === STATE.CONNECTING) this._fail('The relay did not answer. Is it running?');
    };
    ws.onclose = () => {
      if (this._stopping || this.state === STATE.STOPPING || this.state === STATE.IDLE) return;
      this._dropped();
    };
  }

  async _goLive() {
    if (this.state !== STATE.CONNECTING && this.state !== STATE.RECONNECTING) return;
    // A running audio context is what puts sound in the stream. The click that
    // started this stream is the gesture the browser needs to run it.
    try { await Tone.start(); } catch { /* the stream continues without audio */ }
    // Hold the recording frame for the length of the stream.
    this.scene.setFrame(this.frame);
    this._capture = captureStream(this.canvas, { fps: this._quality.fps });
    this._rec = new MediaRecorder(this._capture.stream, {
      mimeType: this.mime(),
      videoBitsPerSecond: this._quality.bitrate,
    });
    this._rec.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (this._ws?.readyState !== WebSocket.OPEN) return;
      this.bytes += event.data.size;
      this._ws.send(event.data);
      this._emit();
    };
    this._rec.start(250);
    this.startedAt = Date.now();
    this._attempt = 0;
    this._setState(STATE.LIVE, 'ready');
    this._startTicker();
    this._emit();
  }

  /** The status line carries elapsed time and bytes, so it needs a clock. */
  _startTicker() {
    this._stopTicker();
    this._ticker = setInterval(() => this._emit(), 1000);
  }

  _stopTicker() {
    clearInterval(this._ticker);
    this._ticker = 0;
  }

  _dropped() {
    const delay = retryDelay(this._attempt);
    if (delay === null) {
      this._fail('The connection to the relay dropped, and the retries did not help.');
      return;
    }
    this._attempt += 1;
    this._setState(STATE.RECONNECTING, 'drop');
    this.error = `Connection lost. Retrying in ${Math.round(delay / 1000)} s…`;
    this._stopRecorder();
    setTimeout(() => {
      if (this.state !== STATE.RECONNECTING) return;
      this._connect();
    }, delay);
  }

  _stopRecorder() {
    try { this._rec?.stop(); } catch { /* already stopped */ }
    this._rec = null;
    releaseCapture(this._capture);
    this._capture = null;
  }

  _teardown() {
    this._stopTicker();
    if (this._ws?.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closing */ }
    }
    try { this._ws?.close(); } catch { /* already closed */ }
    this._ws = null;
    this._stopRecorder();
    // The key leaves memory here, and nowhere else.
    this._target = '';
    this.scene.setFrame(null);
  }

  _fail(message) {
    this._stopping = true;
    this.error = message;
    this._teardown();
    this._stopping = false;
    this.state = STATE.IDLE;
    this._emit();
  }

  _setState(state, event) {
    const next = nextState(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this._emit();
  }

  _emit() {
    if (this.onState) {
      this.onState({
        state: this.state,
        onAir: this.onAir,
        error: this.error,
        target: this.safeTarget,
        bytes: this.bytes,
        seconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
      });
    }
  }
}