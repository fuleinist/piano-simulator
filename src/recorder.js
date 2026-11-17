import * as Tone from 'tone';

// Records the canvas plus the mixed audio to a downloadable WebM video.
export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.rec = null;
    this.chunks = [];
    this.recording = false;
    this.onState = null;
  }

  _mime() {
    const opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return opts.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  start() {
    if (this.recording) return;
    const stream = this.canvas.captureStream(60);
    try {
      const ctx = Tone.getContext().rawContext;
      const dest = ctx.createMediaStreamDestination();
      Tone.getDestination().connect(dest);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
      this._audioDest = dest;
    } catch (e) {
      console.warn('Audio capture unavailable, recording video only.', e);
    }
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: this._mime(), videoBitsPerSecond: 12_000_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this._save();
    this.rec.start(250);
    this.recording = true;
    this._emit();
  }

  stop() {
    if (!this.recording) return;
    this.rec.stop();
    this.recording = false;
    this._emit();
  }

  toggle() { this.recording ? this.stop() : this.start(); }

  _save() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `piano-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (this._audioDest) { try { Tone.getDestination().disconnect(this._audioDest); } catch {} }
  }

  _emit() { if (this.onState) this.onState(this); }
}