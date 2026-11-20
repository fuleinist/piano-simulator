import * as Tone from 'tone';

/**
 * Build the canvas video stream plus the Tone.js mix. The recorder and the
 * streamer need the same stream, so both call this.
 *
 * The audio track joins the stream only when the AudioContext is running. A
 * suspended context produces no samples, and a MediaRecorder that holds a track
 * with no data stalls: it emits no chunk at all, so the recording or the stream
 * is empty with no error. A browser needs one gesture before it may start
 * audio, so the caller starts the context first.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ fps?: number, audio?: boolean }} [options]
 * @returns {{ stream: MediaStream, dest: MediaStreamAudioDestinationNode | null, audio: boolean }}
 */
export function captureStream(canvas, { fps = 60, audio = true } = {}) {
  const stream = canvas.captureStream(fps);
  let dest = null;
  const contextRunning = Tone.getContext().state === 'running';

  if (audio && !contextRunning) {
    console.warn('The audio context is not running yet, so this capture has no audio. Start playback first.');
  }

  if (audio && contextRunning) {
    try {
      const ctx = Tone.getContext().rawContext;
      dest = ctx.createMediaStreamDestination();
      Tone.getDestination().connect(dest);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    } catch (error) {
      // A capture without audio still records the frames.
      console.warn('Audio capture unavailable, capturing video only.', error);
    }
  }
  return { stream, dest, audio: Boolean(dest) };
}

/**
 * Disconnect the audio tap and stop every track. A null or undefined argument
 * is a no-op: a default parameter covers undefined only, and the callers run
 * this twice on a stop.
 */
export function releaseCapture(capture) {
  if (!capture) return;
  const { stream, dest } = capture;
  if (dest) {
    try { Tone.getDestination().disconnect(dest); } catch { /* already gone */ }
  }
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}
