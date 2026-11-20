import * as THREE from 'three';
import { Scene } from './scene.js';
import { Piano } from './piano.js';
import { Bars } from './bars.js';
import { Hands } from './hands.js';
import { Player } from './player.js';
import { Recorder } from './recorder.js';
import { FramePreview } from './framepreview.js';
import { SONGS } from './songs.js';
import { SongPicker } from './songpicker.js';
import { LibraryStore, libraryAvailable } from './librarystore.js';
import { LibraryPanel } from './libraryui.js';
import {
  buildRecord, contentId, displayName, isQuotaError, sortRecords, stripExtension, toEntry,
} from './library.js';
import { SearchPanel } from './searchui.js';
import { internetArchive } from './sources/internetarchive.js';
import { Streamer } from './streamer.js';
import {
  DEFAULT_PLATFORM, DEFAULT_QUALITY, PLATFORMS, QUALITIES, findPlatform, ingestBase, isSecureRelay,
} from './streampresets.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const scene = new Scene(canvas);
const piano = new Piano(scene.scene);
const bars = new Bars(scene.scene);
const hands = new Hands(scene.scene);
const player = new Player(piano, bars, hands);
const recorder = new Recorder(canvas, scene);
// The relay address is fixed at build time. Without it, live streaming stays
// off and the rest of the app is unchanged.
const RELAY_URL = import.meta.env?.VITE_RELAY_URL || '';
const streamer = new Streamer(canvas, scene, { relayUrl: RELAY_URL });
const preview = new FramePreview(scene, $('framePreview'));

// How long the recorder keeps rolling after the piece ends, in seconds. The
// sampler releases the final chord over about a second, so an instant stop
// would cut the sound off.
const RECORD_TAIL_S = 2;

// --- Song library --------------------------------------------------------
// Everything the picker lists is an entry with a stable id, so a built-in file
// and a stored MIDI share one code path. A built-in reads its bytes from
// /midi/<file>; a stored entry reads them from IndexedDB by content hash.
const BUILTIN = SONGS.map((s) => ({
  id: `builtin:${s.file}`, kind: 'builtin', file: s.file, title: s.title, composer: s.composer,
}));

const store = new LibraryStore();
let libraryReady = false;
let records = [];          // stored records, most recently played first
let currentEntry = null;   // the entry the player holds
let persistAsked = false;

const picker = new SongPicker({
  input: $('songSearch'),
  listbox: $('songListbox'),
  onSelect: (item) => loadEntry(item),
});

const panel = new LibraryPanel({
  dialog: $('libraryDialog'),
  list: $('libList'),
  summary: $('libSummary'),
  storage: $('libStorage'),
  empty: $('libEmpty'),
  onLoad: (key) => {
    const record = records.find((r) => r.id === key);
    if (record) loadEntry(toEntry(record));
  },
  onRename: (key, changes) => renameRecord(key, changes),
  onDelete: (key) => deleteRecord(key),
});

const search = new SearchPanel({
  dialog: $('searchDialog'),
  form: $('searchForm'),
  input: $('searchInput'),
  status: $('searchStatus'),
  results: $('searchResults'),
  providers: [internetArchive],
  onLoad: (result) => loadRemote(result),
  onSave: (result) => saveRemote(result),
});

// The pedals that the piece carries, for the song label. A piece with no
// pedal events adds nothing.
const pedalNote = (pedals) => (pedals && pedals.length ? ` · pedal: ${pedals.join(', ')}` : '');

function renderPicker() {
  const groups = [{ label: 'Built-in', items: BUILTIN }];
  if (records.length) groups.push({ label: 'My MIDI files', items: records.map(toEntry) });
  picker.setGroups(groups);
}

async function refreshLibrary() {
  if (libraryReady) {
    try {
      records = sortRecords(await store.list());
    } catch (e) {
      // A broken database must not take the app down: the built-in list still
      // works, and the next import reports the failure.
      libraryReady = false;
      console.warn('The local library is unavailable:', e);
    }
  }
  renderPicker();
  panel.setRecords(records);
}

/**
 * Load an entry, whether it is built in or stored. A stored file keeps the
 * exact bytes that were imported, so it plays as it did on the first import.
 */
async function loadEntry(entry) {
  currentEntry = entry;
  picker.setSelection(entry.id);
  $('loaderText').textContent = `Loading ${entry.title}…`;
  $('loader').classList.remove('hide');
  try {
    const info = entry.kind === 'local'
      ? await loadStored(entry)
      : await player.loadSong(entry);
    $('songLabel').textContent = `${info.title} · ${info.notes} notes${pedalNote(info.pedals)}`;
  } catch (e) {
    $('songLabel').textContent = `Failed to load ${entry.title}: ${e.message}`;
  }
  maybeHideLoader();
}

async function loadStored(entry) {
  const record = await store.get(entry.key);
  if (!record) throw new Error('this file is no longer in your library');
  const info = await player.loadBuffer(record.bytes, displayName(record));
  // Recency drives the picker order, but it must not hold up playback.
  store.touch(entry.key).then(refreshLibrary).catch(() => {});
  return info;
}

$('loadBtn').addEventListener('click', () => $('fileInput').click());
$('libraryBtn').addEventListener('click', async () => {
  panel.open(records, libraryReady ? await store.estimate() : null);
});
$('libClose').addEventListener('click', () => panel.close());
$('libDone').addEventListener('click', () => panel.close());
$('libImport').addEventListener('click', () => {
  panel.close();
  $('fileInput').click();
});
$('searchBtn').addEventListener('click', () => search.open());
$('searchClose').addEventListener('click', () => search.close());
$('searchDone').addEventListener('click', () => search.close());

$('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await importFiles(files);
});

async function importFiles(files) {
  const results = [];
  for (const file of files) {
    results.push(await importFile(file));
  }
  if (results.length > 1) {
    const saved = results.filter((r) => r.saved).length;
    $('songLabel').textContent = `${saved} of ${results.length} files saved to your library`;
  }
}

/**
 * Import one file: parse it, store it under its content hash, then play it.
 * The parse comes first, so an invalid file never reaches the library.
 */
async function importFile(file) {
  $('loaderText').textContent = `Loading ${file.name}…`;
  $('loader').classList.remove('hide');
  try {
    const bytes = await file.arrayBuffer();
    const info = await player.loadBuffer(bytes, stripExtension(file.name));
    const label = `${info.title} · ${info.notes} notes${pedalNote(info.pedals)}`;

    if (!libraryReady) {
      currentEntry = null;
      picker.clearSelection();
      $('songLabel').textContent = `${label} · not saved, this browser has no local library`;
      return { saved: false };
    }

    const id = await contentId(bytes);
    const existing = await store.get(id);
    if (existing) {
      await store.touch(id);
      const entry = toEntry(existing);
      currentEntry = entry;
      await refreshLibrary();
      picker.setSelection(entry.id);
      $('songLabel').textContent = `${label} · already in your library`;
      return { saved: true };
    }

    const record = buildRecord({ id, name: file.name, bytes, info });
    try {
      await store.put(record);
    } catch (err) {
      if (!isQuotaError(err)) throw err;
      currentEntry = null;
      picker.clearSelection();
      $('songLabel').textContent = `${label} · not saved, browser storage is full. Delete a file in Library and try again.`;
      return { saved: false };
    }

    // Ask the browser to keep the library once, not on every import.
    if (!persistAsked) {
      persistAsked = true;
      store.persist().catch(() => {});
    }

    const entry = toEntry(record);
    currentEntry = entry;
    await refreshLibrary();
    picker.setSelection(entry.id);
    $('songLabel').textContent = `${label} · saved to your library`;
    return { saved: true };
  } catch (err) {
    picker.clearSelection();
    $('songLabel').textContent = `Invalid MIDI: ${err.message}`;
    return { saved: false };
  } finally {
    maybeHideLoader();
  }
}

/**
 * Play a remote result. The bytes pass through the proxy, then take the same
 * path as a local file, so notes, hands and pedals behave the same.
 */
async function loadRemote(result) {
  $('loaderText').textContent = `Downloading ${result.title}…`;
  $('loader').classList.remove('hide');
  try {
    const bytes = await internetArchive.fetchMidi(result);
    const info = await player.loadBuffer(bytes, result.composer ? `${result.title} — ${result.composer}` : result.title);
    currentEntry = null;
    picker.clearSelection();
    $('songLabel').textContent = `${info.title} · ${info.notes} notes${pedalNote(info.pedals)} · ${result.source}`;
    search.close();
    return info;
  } finally {
    maybeHideLoader();
  }
}

/** Download a remote result and keep it in the local library. */
async function saveRemote(result) {
  if (!libraryReady) throw new Error('this browser has no local library');
  $('loaderText').textContent = `Downloading ${result.title}…`;
  $('loader').classList.remove('hide');
  try {
    const bytes = await internetArchive.fetchMidi(result);
    const info = await player.loadBuffer(bytes, result.title);
    const id = await contentId(bytes);
    const existing = await store.get(id);
    if (!existing) {
      const record = buildRecord({ id, name: `${result.title}.mid`, bytes, info });
      await store.put(record);
      if (!persistAsked) { persistAsked = true; store.persist().catch(() => {}); }
    }
    const record = await store.get(id);
    const entry = toEntry(record);
    currentEntry = entry;
    await refreshLibrary();
    picker.setSelection(entry.id);
    $('songLabel').textContent = `${displayName(entry)} · ${info.notes} notes${pedalNote(info.pedals)} · saved to your library`;
    return entry;
  } finally {
    maybeHideLoader();
  }
}

async function renameRecord(key, { title, composer }) {
  try {
    const record = await store.get(key);
    if (!record) return;
    await store.put({ ...record, title, composer });
    if (currentEntry && currentEntry.key === key) {
      currentEntry = { ...currentEntry, title, composer };
      $('songLabel').textContent = `${displayName(currentEntry)} · ${player.notes.length} notes${pedalNote(player.pedalsUsed)}`;
    }
    await refreshLibrary();
    picker.setSelection(currentEntry && currentEntry.key === key ? currentEntry.id : picker.selectedId);
  } catch (e) {
    console.warn('The rename failed:', e);
  }
}

async function deleteRecord(key) {
  const wasLoaded = currentEntry && currentEntry.kind === 'local' && currentEntry.key === key;
  try {
    await store.delete(key);
  } catch (e) {
    console.warn('The delete failed:', e);
    return;
  }
  if (wasLoaded) {
    player.pause();
    currentEntry = null;
    picker.clearSelection();
    $('songLabel').textContent = 'That file was removed from your library';
  }
  await refreshLibrary();
}

async function initLibrary() {
  if (!libraryAvailable()) {
    renderPicker();
    return;
  }
  try {
    await store.open();
    libraryReady = true;
    await refreshLibrary();
  } catch (e) {
    console.warn('The local library is unavailable; imports play but are not kept.', e);
    renderPicker();
  }
}

function maybeHideLoader() {
  if (player.ready && player.notes.length) $('loader').classList.add('hide');
}

// --- Transport -----------------------------------------------------------
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let seeking = false;
let lastPedalText = '';

player.onState = (p) => {
  $('playBtn').textContent = p.playing ? '❚❚' : '▶';
  $('seek').max = 1000;
};

$('playBtn').addEventListener('click', () => player.toggle());
$('seek').addEventListener('pointerdown', () => { seeking = true; });
window.addEventListener('pointerup', () => { seeking = false; });
$('seek').addEventListener('input', (e) => player.seek((e.target.value / 1000) * player.duration));
$('speed').addEventListener('input', (e) => {
  player.setSpeed(parseFloat(e.target.value));
  $('speedLabel').textContent = player.speed.toFixed(2) + '×';
});
$('loopToggle').addEventListener('change', (e) => { player.loop = e.target.checked; });
$('volume').addEventListener('input', (e) => { player.gain.gain.value = parseFloat(e.target.value); });
$('handsToggle').addEventListener('change', (e) => hands.setVisible(e.target.checked));
$('barsToggle').addEventListener('change', (e) => bars.setVisible(e.target.checked));
$('pedalsToggle').addEventListener('change', (e) => bars.setPedalsVisible(e.target.checked));

// --- View ----------------------------------------------------------------
document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    scene.setPreset(b.dataset.view);
  });
});
$('panL').addEventListener('click', () => scene.panBy(-3));
$('panR').addEventListener('click', () => scene.panBy(3));
$('zoomIn').addEventListener('click', () => scene.zoomBy(0.8));
$('zoomOut').addEventListener('click', () => scene.zoomBy(1.25));

// --- Record --------------------------------------------------------------
recorder.onState = (r) => {
  const b = $('recordBtn');
  b.classList.toggle('on', r.recording);
  b.textContent = r.recording ? '■ Stop recording' : '● Record video';
  // The shape cannot change while a capture runs, so lock the buttons.
  document.querySelectorAll('[data-frame]').forEach((x) => { x.disabled = r.recording; });
  $('liveBtn').disabled = r.recording || Boolean(liveBlockedReason());
  if (r.stopping) $('recHint').textContent = 'Finishing the last chord…';
  else if (r.recording) $('recHint').textContent = `Recording ${recorder.frame}. Press Stop to save now.`;
  else $('recHint').textContent = 'Saves a WebM with audio. Stops when the piece ends.';
};
$('recordBtn').addEventListener('click', () => { preview.clear(); recorder.toggle(); });

document.querySelectorAll('[data-frame]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-frame]').forEach((x) => x.classList.toggle('active', x === b));
    recorder.frame = b.dataset.frame;
    // Show the frame for a few seconds, so the shape can be checked first.
    preview.show(recorder.frame);
    $('recHint').textContent = `Records at ${recorder.frame}. Stops when the piece ends.`;
  });
});

// A recording follows the piece: it stops itself a moment after the last note.
player.onEnd = () => {
  if (recorder.recording) recorder.stopIn(RECORD_TAIL_S);
  if (streamer.onAir) streamer.stopIn(RECORD_TAIL_S);
};

// --- Live ----------------------------------------------------------------
const qualityOf = (id) => QUALITIES.find((q) => q.id === id) || QUALITIES[0];

for (const platform of PLATFORMS) {
  const option = document.createElement('option');
  option.value = platform.id;
  option.textContent = platform.label;
  $('livePlatform').append(option);
}
for (const quality of QUALITIES) {
  const option = document.createElement('option');
  option.value = quality.id;
  option.textContent = quality.label;
  $('liveQuality').append(option);
}
$('livePlatform').value = DEFAULT_PLATFORM;
$('liveQuality').value = DEFAULT_QUALITY;

function applyPlatform() {
  const platform = findPlatform($('livePlatform').value);
  $('liveIngest').value = platform?.ingest || '';
  $('liveIngest').readOnly = platform ? platform.id !== 'custom' : false;
  $('liveNote').textContent = platform?.note || '';
}
applyPlatform();

$('livePlatform').addEventListener('change', applyPlatform);

// The key is a password field with a reveal toggle, and the value never leaves
// the field until a start clears it.
$('liveReveal').addEventListener('click', () => {
  const input = $('liveKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('liveReveal').textContent = show ? 'Hide' : 'Show';
  $('liveReveal').setAttribute('aria-pressed', String(show));
});

function liveBlockedReason() {
  if (!streamer.available) return 'Live streaming needs a relay. Set VITE_RELAY_URL when you build the site.';
  if (!isSecureRelay(RELAY_URL)) return 'The relay needs wss:// (or ws:// on localhost). A key must not cross an open socket.';
  if (recorder.recording) return 'Stop the local recording first. One capture at a time.';
  return '';
}

$('liveHint').textContent = liveBlockedReason() || 'Streams to YouTube, Twitch, Facebook, or a custom RTMP address.';
$('liveBtn').disabled = Boolean(liveBlockedReason());
if (!streamer.available) $('liveBtn').title = 'No relay is configured for this build.';

function openLive() {
  const reason = liveBlockedReason();
  if (reason) { $('liveHint').textContent = reason; return; }
  $('liveError')?.remove();
  $('liveConfirm').hidden = true;
  $('liveSetup').hidden = false;
  $('liveKey').value = '';
  $('liveKey').type = 'password';
  $('liveReveal').textContent = 'Show';
  $('liveReveal').setAttribute('aria-pressed', 'false');
  $('liveStatus').textContent = '';
  $('liveDialog').showModal();
  $('livePlatform').focus();
}

$('liveBtn').addEventListener('click', () => {
  if (streamer.onAir) { streamer.stop(); return; }
  openLive();
});
$('liveClose').addEventListener('click', () => $('liveDialog').close());

$('liveForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = $('liveKey').value.trim();
  const base = $('liveIngest').value.trim();
  if (!key || !base) {
    $('liveStatus').textContent = 'Enter the stream key and the ingest address.';
    return;
  }
  // An explicit second step, because this starts a public broadcast.
  $('liveConfirmText').textContent = `Start a public broadcast to ${findPlatform($('livePlatform').value)?.label || base} at ${qualityOf($('liveQuality').value).label}?`;
  $('liveConfirm').hidden = false;
  $('liveSetup').hidden = true;
  $('liveStart').focus();
});

$('liveCancel').addEventListener('click', () => {
  $('liveConfirm').hidden = true;
  $('liveSetup').hidden = false;
  $('liveKey').focus();
});

$('liveStart').addEventListener('click', () => {
  const key = $('liveKey').value.trim();
  const base = $('liveIngest').value.trim();
  $('liveKey').value = '';
  $('liveDialog').close();
  streamer.start({ key, base, quality: $('liveQuality').value, frame: recorder.frame });
});

$('liveStop').addEventListener('click', () => { streamer.stop(); $('liveDialog').close(); });
$('liveDone').addEventListener('click', () => $('liveDialog').close());

streamer.onState = (live) => {
  const button = $('liveBtn');
  button.textContent = live.onAir ? '■ Stop streaming' : '● Go live';
  button.classList.toggle('on', live.onAir);
  button.disabled = !live.onAir && Boolean(liveBlockedReason());
  $('liveBadge').hidden = !live.onAir;
  $('liveRunning').hidden = !live.onAir;
  $('liveSetup').hidden = live.onAir;

  const seconds = Math.round(live.seconds);
  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const sent = live.bytes ? `${(live.bytes / 1024 / 1024).toFixed(1)} MB` : '0 MB';

  if (live.error) $('liveHint').textContent = live.error;
  else if (live.onAir) $('liveHint').textContent = `On air ${minutes} · ${sent} sent · ${live.target}`;
  else if (live.state === 'connecting') $('liveHint').textContent = 'Connecting to the relay…';
  else if (live.state === 'reconnecting') $('liveHint').textContent = live.error || 'Reconnecting…';
  else $('liveHint').textContent = liveBlockedReason() || 'Streams to YouTube, Twitch, Facebook, or a custom RTMP address.';

  // One capture at a time: a live stream locks the recorder, and the reverse
  // is handled in recorder.onState.
  if (live.onAir) {
    $('recordBtn').disabled = true;
    document.querySelectorAll('[data-frame]').forEach((x) => { x.disabled = true; });
  } else {
    $('recordBtn').disabled = false;
    document.querySelectorAll('[data-frame]').forEach((x) => { x.disabled = false; });
  }
};

// --- Keyboard ------------------------------------------------------------
// No shortcut may fire while the player is typing in a field or picking a
// piece. The song picker keeps its own keys (arrows, Home/End, Enter, Escape)
// on the input, so the guard covers the whole combobox, not just <input>.
const isTypingTarget = (target) => {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  return target.closest('#songPicker') !== null;
};

window.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  switch (e.code) {
    case 'Space': e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft': scene.panBy(-3); break;
    case 'ArrowRight': scene.panBy(3); break;
    case 'Equal': case 'NumpadAdd': scene.zoomBy(0.8); break;
    case 'Minus': case 'NumpadSubtract': scene.zoomBy(1.25); break;
    case 'KeyL': $('loopToggle').checked = player.loop = !player.loop; break;
    case 'KeyP': $('pedalsToggle').checked = !$('pedalsToggle').checked; bars.setPedalsVisible($('pedalsToggle').checked); break;
    case 'KeyR': preview.clear(); recorder.toggle(); break;
    case 'Digit1': scene.setPreset('top'); break;
    case 'Digit2': scene.setPreset('perform'); break;
    case 'Digit3': scene.setPreset('front'); break;
    case 'Digit4': scene.setPreset('side'); break;
    case 'Digit5': scene.setPreset('close'); break;
  }
});

window.addEventListener('resize', () => { scene.resize(); preview.refresh(); });

// --- Main loop -----------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  player.update(dt);
  // Following presets need this frame's hand position before the camera moves.
  scene.setFocus(hands.centerX());
  scene.update(dt);
  piano.update(dt);
  scene.render();
  if (!seeking && player.duration) {
    $('seek').value = Math.round((player.time / player.duration) * 1000);
  }
  $('timeLabel').textContent = `${fmt(player.time)} / ${fmt(player.duration)}`;
  // Show the pedals that are down. The text changes only on a pedal event, so
  // the frame loop does not write the DOM on every frame.
  const down = player.pedalState.active();
  const pedalText = down.length ? `Pedal: ${down.join(' + ')}` : '';
  if (pedalText !== lastPedalText) {
    $('pedalLabel').textContent = pedalText;
    lastPedalText = pedalText;
  }
  requestAnimationFrame(frame);
}

// Boot: open the library, load the first piece, then reveal once samples are ready.
initLibrary()
  .then(() => loadEntry(BUILTIN[0]))
  .then(() => {
    const wait = setInterval(() => { if (player.ready) { maybeHideLoader(); clearInterval(wait); } }, 120);
  });
frame();

// Debug/test handle (harmless in production).
window.__piano = {
  player, scene, piano, bars, hands, recorder, preview, THREE, picker, store, panel, search, streamer,
  library: () => ({ ready: libraryReady, records, currentEntry }),
};