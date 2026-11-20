import * as Tone from 'tone';
import { DEFAULT_FRAME, FRAMES } from './frames.js';

// Records the canvas plus the mixed audio to a downloadable WebM video.
//
// The video takes one of two shapes (see src/frames.js). While a recording
// runs, the stage holds that shape, so the player sees the frame that is
// saved. The recorder can also stop itself a set time after the piece ends, so
// a long video stops without a manual click.
export class Recorder {
  constructor(canvas, scene) {
    this.canvas = canvas;
    this.scene = scene;
    this.frame = DEFAULT_FRAME;
    this.rec = null;
    this.chunks = [];
    this.recording = false;
    this.stopping = false;
    this.onState = null;
    this._tail = 0;
  }

  _mime() {
    const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return opts.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  start() {
    if (this.recording) return;
    const frame = FRAMES[this.frame] ? this.frame : DEFAULT_FRAME;
    // Set the frame before capture starts, so no saved frame has the window
    // shape.
    this.scene.setFrame(frame);
    const stream = this.canvas.captureStream(60);
    // A track from a suspended AudioContext carries no samples, and a
    // MediaRecorder that holds a track with no data emits no chunk at all: the
    // recording is empty with no error. So audio joins the stream only when the
    // audio context runs, which needs one gesture on the page.
    const audioRunning = Tone.getContext().state === 'running';
    if (!audioRunning) {
      console.warn('The audio context is not running, so this recording has no audio. Press Play first.');
    }
    try {
      if (audioRunning) {
        const ctx = Tone.getContext().rawContext;
        const dest = ctx.createMediaStreamDestination();
        Tone.getDestination().connect(dest);
        for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
        this._audioDest = dest;
      }
    } catch (e) {
      console.warn('Audio capture unavailable, recording video only.', e);
    }
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: this._mime(), videoBitsPerSecond: 12_000_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this._save();
    this.rec.start(250);
    this.recording = true;
    this.stopping = false;
    this._emit();
  }

  stop() {
    if (!this.recording) return;
    clearTimeout(this._tail);
    this._tail = 0;
    this.rec.stop();
    this.recording = false;
    this.stopping = false;
    this._emit();
  }

  /**
   * Stop after a delay, in seconds. The sampler releases the last chord over
   * about a second, so a stop at the exact end of the piece cuts the sound. A
   * manual stop or a new start cancels the timer.
   */
  stopIn(seconds) {
    if (!this.recording) return;
    clearTimeout(this._tail);
    this.stopping = true;
    this._emit();
    this._tail = setTimeout(() => {
      this._tail = 0;
      this.stopping = false;
      this.stop();
    }, Math.max(0, seconds) * 1000);
  }

  toggle() { this.recording ? this.stop() : this.start(); }

  _save() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const shape = String(this.frame).replace(':', 'x');
    a.href = url;
    a.download = `piano-${shape}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (this._audioDest) { try { Tone.getDestination().disconnect(this._audioDest); } catch {} }
    // The capture is complete, so the stage can take the window shape again.
    this.scene.setFrame(null);
  }

  _emit() { if (this.onState) this.onState(this); }
}