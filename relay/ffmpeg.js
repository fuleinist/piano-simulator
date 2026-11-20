// Build the ffmpeg command for one stream.
//
// The command is an argument array, never a shell string, so a stream key
// cannot inject a command and the key never shows in a process list that
// prints arguments. Keep it that way: spawn('ffmpeg', args), never exec().

const MIN_BITRATE = 500_000;
const MAX_BITRATE = 12_000_000;

/** True for an ingest address ffmpeg can push to. */
export function checkIngest(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') return false;
  if (!url.hostname) return false;
  return url.pathname.replace(/\/+$/, '').length > 0;
}

/**
 * The ffmpeg arguments that turn the relayed WebM into FLV over RTMP.
 *
 * @param {{ ingest: string, quality?: { width?: number, height?: number, fps?: number, bitrate?: number } }} options
 * @returns {string[]}
 */
export function buildArgs({ ingest, quality = {} } = {}) {
  if (!checkIngest(ingest)) throw new Error('The ingest address must be rtmp:// or rtmps://');

  const requested = Number(quality.bitrate) || 4_500_000;
  const bitrate = Math.min(Math.max(Math.round(requested), MIN_BITRATE), MAX_BITRATE);
  const fps = Math.min(Math.max(Math.round(Number(quality.fps) || 30), 15), 60);

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    // The browser sends WebM chunks over a pipe, so the format is explicit.
    '-fflags', 'nobuffer',
    '-f', 'webm',
    '-i', 'pipe:0',
    // VP8/Opus must become H.264/AAC for RTMP. A copy cannot work.
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', String(bitrate),
    '-maxrate', String(bitrate),
    '-bufsize', String(bitrate * 2),
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '44100',
    '-f', 'flv',
    ingest,
  ];
}

/** A target with the key hidden, for the relay log. */
export function redact(value) {
  const text = String(value ?? '');
  const cut = text.lastIndexOf('/');
  return cut > text.indexOf('://') + 2 ? `${text.slice(0, cut)}/***` : text;
}
