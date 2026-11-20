// Platform and quality presets for live streaming.
//
// A stream key is a bearer credential, so this module never logs a finished
// ingest URL. Ingests are editable, because TikTok and Instagram hostnames
// change and the platform rules move.

export const PLATFORMS = [
  {
    id: 'youtube',
    label: 'YouTube',
    ingest: 'rtmp://a.rtmp.youtube.com/live2',
    secureIngest: 'rtmps://a.rtmps.youtube.com:443/live2',
    note: 'YouTube Studio → Go live → Stream key.',
  },
  {
    id: 'twitch',
    label: 'Twitch',
    ingest: 'rtmp://live.twitch.tv/app/',
    secureIngest: 'rtmps://live.twitch.tv:443/app/',
    note: 'Twitch dashboard → Settings → Stream → Primary stream key.',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    ingest: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    secureIngest: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    note: 'Facebook Live Producer → Stream key.',
  },
  {
    id: 'tiktok',
    label: 'TikTok (best effort)',
    ingest: '',
    secureIngest: '',
    note: 'TikTok LIVE Studio gives a region-specific key. LIVE access needs about 1,000 followers.',
  },
  {
    id: 'instagram',
    label: 'Instagram (best effort)',
    ingest: 'rtmps://live-upload.instagram.com:443/rtmp/',
    secureIngest: 'rtmps://live-upload.instagram.com:443/rtmp/',
    note: 'Professional accounts only. The key comes from the Professional Dashboard.',
  },
  {
    id: 'custom',
    label: 'Custom RTMP',
    ingest: '',
    secureIngest: '',
    note: 'Paste the ingest address from any RTMP or RTMPS service.',
  },
];

export const QUALITIES = [
  { id: '1080p30', label: '1080p30 · 4.5 Mbps', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  { id: '720p30', label: '720p30 · 2.5 Mbps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  { id: '720p60', label: '720p60 · 3.5 Mbps', width: 1280, height: 720, fps: 60, bitrate: 3_500_000 },
];

export const DEFAULT_PLATFORM = 'youtube';
export const DEFAULT_QUALITY = '1080p30';

export const findPlatform = (id) => PLATFORMS.find((p) => p.id === id) || null;
export const findQuality = (id) => QUALITIES.find((q) => q.id === id) || QUALITIES[0];

/**
 * The ingest address without the key. A custom platform uses the typed base.
 * @param {string} platformId
 * @param {string} [customBase]
 */
export function ingestBase(platformId, customBase = '') {
  if (platformId === 'custom') return String(customBase || '').trim();
  return findPlatform(platformId)?.ingest || '';
}

/**
 * Join the ingest base and the key. A base that already ends in a slash keeps
 * one slash, and a key that starts with one loses it.
 * @param {string} base
 * @param {string} key
 */
export function streamTarget(base, key) {
  const cleanBase = String(base || '').trim();
  const cleanKey = String(key || '').trim().replace(/^\/+/, '');
  if (!cleanBase || !cleanKey) return '';
  return `${cleanBase.replace(/\/+$/, '')}/${cleanKey}`;
}

/**
 * A target with the key hidden, for a status line or a log. The last path
 * segment is replaced, so the host stays readable.
 * @param {string} target
 */
export function redactTarget(target) {
  const text = String(target || '');
  if (!text) return '';
  const cut = text.lastIndexOf('/');
  if (cut <= text.indexOf('://') + 2) return `${text}/***`;
  return `${text.slice(0, cut)}/***`;
}

/** A browser may reach a local relay without TLS; a remote one may not. */
export function isSecureRelay(url) {
  try {
    const { protocol, hostname } = new URL(String(url));
    if (protocol === 'wss:') return true;
    if (protocol !== 'ws:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}
