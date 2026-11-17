import * as THREE from 'three';
import { Scene } from './scene.js';
import { Piano } from './piano.js';
import { Bars } from './bars.js';
import { Hands } from './hands.js';
import { Player } from './player.js';
import { Recorder } from './recorder.js';
import { SONGS } from './songs.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const scene = new Scene(canvas);
const piano = new Piano(scene.scene);
const bars = new Bars(scene.scene);
const hands = new Hands(scene.scene);
const player = new Player(piano, bars, hands);
const recorder = new Recorder(canvas);

// --- Song library --------------------------------------------------------
const sel = $('songSelect');
for (const s of SONGS) {
  const o = document.createElement('option');
  o.value = s.file;
  o.textContent = `${s.title} — ${s.composer}`;
  sel.appendChild(o);
}

async function loadSong(song) {
  $('loaderText').textContent = `Loading ${song.title}…`;
  $('loader').classList.remove('hide');
  try {
    const info = await player.loadSong(song);
    $('songLabel').textContent = `${info.title} · ${info.notes} notes`;
  } catch (e) {
    $('songLabel').textContent = 'Failed to load: ' + e.message;
  }
  maybeHideLoader();
}
sel.addEventListener('change', () => loadSong(SONGS.find((s) => s.file === sel.value)));

$('loadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('loaderText').textContent = `Loading ${f.name}…`;
  $('loader').classList.remove('hide');
  try {
    const info = await player.loadFile(f);
    $('songLabel').textContent = `${info.title} · ${info.notes} notes`;
    sel.value = '';
  } catch (err) {
    $('songLabel').textContent = 'Invalid MIDI: ' + err.message;
  }
  maybeHideLoader();
  e.target.value = '';
});

function maybeHideLoader() {
  if (player.ready && player.notes.length) $('loader').classList.add('hide');
}

// --- Transport -----------------------------------------------------------
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let seeking = false;

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
  $('recHint').textContent = r.recording ? 'Recording… press Stop to save.' : 'Saves a WebM with audio.';
};
$('recordBtn').addEventListener('click', () => recorder.toggle());

// --- Keyboard ------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft': scene.panBy(-3); break;
    case 'ArrowRight': scene.panBy(3); break;
    case 'Equal': case 'NumpadAdd': scene.zoomBy(0.8); break;
    case 'Minus': case 'NumpadSubtract': scene.zoomBy(1.25); break;
    case 'KeyL': $('loopToggle').checked = player.loop = !player.loop; break;
    case 'KeyR': recorder.toggle(); break;
    case 'Digit1': scene.setPreset('top'); break;
    case 'Digit2': scene.setPreset('perform'); break;
    case 'Digit3': scene.setPreset('front'); break;
    case 'Digit4': scene.setPreset('side'); break;
    case 'Digit5': scene.setPreset('close'); break;
  }
});

window.addEventListener('resize', () => scene.resize());

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
  requestAnimationFrame(frame);
}

// Boot: load the first piece, then reveal once samples are ready.
loadSong(SONGS[0]).then(() => {
  const wait = setInterval(() => { if (player.ready) { maybeHideLoader(); clearInterval(wait); } }, 120);
});
frame();

// Debug/test handle (harmless in production).
window.__piano = { player, scene, piano, bars, hands, recorder, THREE };