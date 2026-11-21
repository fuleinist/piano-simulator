import * as THREE from 'three';
import { Scene } from './scene.js';
import { Piano } from './piano.js';
import { Bars } from './bars.js';
import { Hands } from './hands.js';
import { Player } from './player.js';
import { Recorder } from './recorder.js';
import { FramePreview } from './framepreview.js';
import { ScoreView } from './scoreui.js';
import { SONGS } from './songs.js';
import { SongPicker } from './songpicker.js';
import { LibraryStore, libraryAvailable } from './librarystore.js';
import { LibraryPanel } from './libraryui.js';
import {
  buildRecord, contentId, displayName, isQuotaError, sortRecords, stripExtension, toEntry,
} from './library.js';
import { SearchPanel } from './searchui.js';
import { internetArchive } from './sources/internetarchive.js';
import { musicBox, upcomingSpan } from './framing.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const scene = new Scene(canvas);
const piano = new Piano(scene.scene);
const bars = new Bars(scene.scene);
const hands = new Hands(scene.scene);
const player = new Player(piano, bars, hands);
const recorder = new Recorder(canvas, scene);
const preview = new FramePreview(scene, $('framePreview'));
const score = new ScoreView({ root: $('score'), svg: $('scoreSvg') });

// The paper takes the notes of every piece the player loads, and the bar lines
// that the file's own time signatures define.
player.onLoad = (p) => score.setSong({ notes: p.notes, bars: p.barlines, meta: p.scoreMeta });
// The toggle starts checked, so the paper starts on screen.
score.setVisible($('scoreToggle').checked);

// How long the recorder keeps rolling after the piece ends, in seconds. The
// sampler releases the final chord over about a second, so an instant stop
// would cut the sound off.
const RECORD_TAIL_S = 2;

// How a recording holds its view. A note that needs more room pulls the camera
// back three seconds before it lands, and the wider view is kept while any note
// in the next ten seconds still needs it. Both windows are off by a few
// seconds on purpose: a view that answers every chord makes a jittery video.
const FIT_OUT_S = 3;
const FIT_HOLD_S = 10;

/**
 * The two boxes a capture must hold in frame: the keys that arrive inside the
 * three second lead, and the keys that arrive inside the ten second hold.
 * Both start from the keys the piece holds down now. Null when nothing is
 * pressed, so the fit lets the view back to the one the player chose.
 */
function fitBoxes() {
  const held = [...player.active.keys()];
  const near = upcomingSpan(player.notes, player.time, player.time + FIT_OUT_S);
  const wide = upcomingSpan(player.notes, player.time, player.time + FIT_HOLD_S);
  return {
    box: musicBox(near ? [...held, ...near] : held),
    hold: musicBox(wide ? [...held, ...wide] : held),
  };
}

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
$('scoreToggle').addEventListener('change', (e) => score.setVisible(e.target.checked));

// --- View ----------------------------------------------------------------
document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    scene.setPreset(b.dataset.view);
  });
});
document.querySelectorAll('[data-orbit]').forEach((b) => {
  b.addEventListener('click', () => scene.orbitBy(Number(b.dataset.orbit)));
});
$('zoomIn').addEventListener('click', () => scene.zoomBy(0.8));
$('zoomOut').addEventListener('click', () => scene.zoomBy(1.25));

// --- Record --------------------------------------------------------------
recorder.onState = (r) => {
  const b = $('recordBtn');
  b.classList.toggle('on', r.recording);
  b.textContent = r.recording ? '■ Stop recording' : '● Record video';
  // The shape cannot change while a capture runs, so lock the buttons.
  document.querySelectorAll('[data-frame]').forEach((x) => { x.disabled = r.recording; });
  // A capture holds the canvas only, so the paper must not claim a place in
  // the file. It comes back as soon as the capture stops.
  score.setRecording(r.recording);
  if (r.stopping) $('recHint').textContent = 'Finishing the last chord…';
  else if (r.recording) $('recHint').textContent = `Recording ${recorder.frame}. Press Stop to save now.`;
  else $('recHint').textContent = 'Saves a WebM with audio. Stops when the piece ends. The camera pulls back to keep the hands in frame.';
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
    case 'KeyM': $('scoreToggle').checked = !$('scoreToggle').checked; score.setVisible($('scoreToggle').checked); break;
    case 'KeyP': $('pedalsToggle').checked = !$('pedalsToggle').checked; bars.setPedalsVisible($('pedalsToggle').checked); break;
    case 'KeyR': preview.clear(); recorder.toggle(); break;
    case 'Digit1': scene.setPreset('top'); break;
    case 'Digit2': scene.setPreset('perform'); break;
    case 'Digit3': scene.setPreset('front'); break;
    case 'Digit4': scene.setPreset('side'); break;
    case 'Digit5': scene.setPreset('close'); break;
  }
});

// --- Controls sheet ------------------------------------------------------
// A narrow screen has no room for the side panel, so the panel opens as a
// sheet over the stage. The Controls button and the scrim both toggle it, and
// Escape closes it. A wide screen ignores the state: the panel is always open.
const sidePanel = $('side');
const panelBtn = $('panelBtn');
const panelScrim = $('panelScrim');
const sheetOpen = () => sidePanel.dataset.open === 'true';

function setSheet(open) {
  sidePanel.dataset.open = String(open);
  panelBtn.setAttribute('aria-expanded', String(open));
  panelScrim.hidden = !open;
}

panelBtn.addEventListener('click', () => setSheet(!sheetOpen()));
$('panelClose').addEventListener('click', () => setSheet(false));
panelScrim.addEventListener('click', () => setSheet(false));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && sheetOpen()) setSheet(false);
});

window.addEventListener('resize', () => {
  scene.resize();
  preview.refresh();
  sizePaper();
  // A rotation to a wide window shows the panel in the corner, so the sheet
  // must not leave its scrim behind.
  if (sheetOpen() && window.innerWidth > 720) setSheet(false);
});

// The paper sits under the header, whose height changes with the layout. The
// measured edge keeps the paper clear of it at every width.
function sizePaper() {
  const top = $('topbar').getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--score-top', `${Math.round(top + 8)}px`);
  score.resize();
}
sizePaper();

// --- Main loop -----------------------------------------------------------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  player.update(dt);
  // Following presets need this frame's hand position before the camera moves.
  scene.setFocus(hands.centerX());
  // A capture holds the pressed keys in its frame, whatever shape it takes.
  const fit = recorder.recording ? fitBoxes() : { box: null, hold: null };
  scene.setFitBox(fit.box, fit.hold);
  scene.update(dt);
  piano.update(dt);
  score.update(player.time);
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
  player, scene, piano, bars, hands, recorder, preview, score, THREE, picker, store, panel, search,
  library: () => ({ ready: libraryReady, records, currentEntry }),
};