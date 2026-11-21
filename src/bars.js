import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keyX, keyWidth, KEY_BACK_Z, BOARD_W, X_MIN } from './layout.js';
import { PEDAL_ORDER, PEDAL_COLOR, spanOnLane } from './pedals.js';

// Bars glide in depth from far behind the piano toward the keys: each note
// starts on the grand rim well behind the keyboard (-Z) and slides to the
// strike line (+Z). The long runway makes the far-to-near motion obvious.
// PPS is depth speed in world units per second of music.
export const PPS = 3.2;
export const LOOKAHEAD = 6.0; // seconds of music shown ahead
const BAR_Y = 1.1; // glide height above the key tops and nameboard
const BAR_THICK = 0.5;
const RUNWAY = PPS * LOOKAHEAD;
// Bars vanish just behind the keyboard, before they reach the keys.
const BAR_END_Z = KEY_BACK_Z - 0.4;
const FADE_LEN = 1.2; // dim over the last bit of bar length as it drains
// A note shorter than this still draws a sliver. The floor is the only place
// where a bar may stand in for more music than its note holds.
export const MIN_LEN = 0.12;
// Two onsets closer than this are one strike, not two neighbours.
const SAME_ONSET = 1e-4;

// The pedal lane runs beside the keys, outside the left end of the keyboard
// and clear of the case, so no part of the rail hides inside the cheek. Each
// pedal that the piece uses gets one rail, and the rail holds the spans where
// that pedal is down. A span rides in with the note bars, so the pedal reaches
// the strike line at the moment its press sounds.
const PEDAL_X0 = X_MIN - 2.2;
const PEDAL_GAP = 0.62;
const PEDAL_W = 0.44;
const PEDAL_THICK = 0.07;
const PEDAL_Y = 0.98; // above the nameboard, below the bars

const COLORS = {
  L: new THREE.Color(0x2f9dff),
  R: new THREE.Color(0xffab2e),
  Lm: new THREE.Color(0x8fd6ff),
  Rm: new THREE.Color(0xffe08a),
};

// Bar width encodes note weight: soft accompaniment draws thin, the loud
// melody draws wide. importance blends velocity with the melody flag.
function importance(n, velMin, velMax) {
  const velNorm = velMax > velMin ? (n.velocity - velMin) / (velMax - velMin) : 0.6;
  const melodyBoost = n.melody ? 1 : 0.28;
  return THREE.MathUtils.clamp(0.55 * velNorm + 0.45 * melodyBoost, 0, 1);
}

// Drawn length of each bar, in world units. A bar is as long as the music its
// note holds, and it stops at the next onset on the same key. Two notes on one
// key draw bars in one column, so a bar that outran its own note would paint
// over the bar behind it. A file that overlaps two notes on one key (a key
// struck again, or one pitch carried by two tracks) hits this every bar.
export function barLengths(notes, pps = PPS) {
  const onsets = new Map();
  for (const n of notes) {
    if (!onsets.has(n.midi)) onsets.set(n.midi, []);
    onsets.get(n.midi).push(n.time);
  }
  for (const times of onsets.values()) times.sort((a, b) => a - b);
  return notes.map((n) => {
    const len = Math.max(n.duration * pps, MIN_LEN);
    const times = onsets.get(n.midi);
    const next = firstOnsetAfter(times, n.time);
    if (next >= times.length) return len;
    return Math.min(len, (times[next] - n.time) * pps);
  });
}

// Index of the first onset later than this one. Onsets that share the strike
// window belong to the same chord, so neither cuts the other.
function firstOnsetAfter(times, time) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time + SAME_ONSET) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Bars {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    // The pedal lane is its own group, so the Show panel can hide it alone.
    this.pedalGroup = new THREE.Group();
    scene.add(this.pedalGroup);
    this.mesh = null;
    this.pedalMesh = null;
    this.pedalSpans = [];
    this.data = [];
    this.velMin = 0; this.velMax = 1;
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
    this._landingStrip();
  }

  _landingStrip() {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W + 2, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x2a3550, transparent: true, opacity: 0.5, toneMapped: false })
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.56, BAR_END_Z);
    this.group.add(strip);
  }

  /**
   * Draw the note bars, and one rail for each pedal that the piece uses.
   * A pedal with no spans gets no rail, so a piece that carries no pedal
   * events looks exactly as it did before.
   */
  load(notes, pedals = {}) {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.dispose(); }
    const lens = barLengths(notes);
    this.data = notes.map((n, i) => {
      return {
        x: keyX(n.midi),
        len: lens[i],
        width: keyWidth(n.midi) * 0.92,
        imp: 0,
        color: (n.hand === 'L' ? (n.melody ? COLORS.Lm : COLORS.L) : (n.melody ? COLORS.Rm : COLORS.R)),
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
      };
    });
    const vels = notes.map((n) => n.velocity);
    this.velMin = Math.min(...vels);
    this.velMax = Math.max(...vels);
    for (const d of this.data) d.imp = importance(d, this.velMin, this.velMax);

    const geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.12);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, this.data.length));
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this._loadPedals(pedals);
  }

  // One rail per pedal that the piece uses, in reading order from the keys
  // outward: damper, then sostenuto, then soft.
  _loadPedals(pedals) {
    this.pedalGroup.clear();
    this.pedalSpans = [];
    this.pedalMesh = null;

    let lane = 0;
    for (const name of PEDAL_ORDER) {
      const spans = pedals[name] || [];
      if (!spans.length) continue;
      const x = PEDAL_X0 - lane * PEDAL_GAP;
      this._pedalRail(x, PEDAL_COLOR[name]);
      for (const span of spans) this.pedalSpans.push({ name, x, span });
      lane++;
    }
    if (!this.pedalSpans.length) return;

    const geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.pedalMesh = new THREE.InstancedMesh(geo, mat, this.pedalSpans.length);
    this.pedalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pedalMesh.frustumCulled = false;
    this.pedalGroup.add(this.pedalMesh);
  }

  // The fixed track a pedal rides in, drawn dim so an empty lane still reads.
  _pedalRail(x, color) {
    const rail = new THREE.Mesh(
      new THREE.PlaneGeometry(PEDAL_W * 2.4, RUNWAY),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.1, toneMapped: false, depthWrite: false,
      })
    );
    rail.rotation.x = -Math.PI / 2;
    rail.position.set(x, PEDAL_Y - 0.04, BAR_END_Z - RUNWAY / 2);
    this.pedalGroup.add(rail);
  }

  update(t) {
    if (this.mesh) this._updateBars(t);
    if (this.pedalMesh) this._updatePedals(t);
  }

  _updateBars(t) {
    const d = this._dummy;
    let idx = 0;
    for (const n of this.data) {
      if (n.time > t + LOOKAHEAD) continue;
      // Near edge advances in +Z and stops at BAR_END_Z, behind the keys.
      const rawNear = BAR_END_Z - (n.time - t) * PPS;
      const rawFar = rawNear - n.len; // tail trails behind in -Z
      if (rawFar >= BAR_END_Z - 0.02) continue; // fully drained before the keys
      const near = Math.min(rawNear, BAR_END_Z); // never reach the keys
      const length = near - rawFar;
      if (length <= 0.02) continue;
      const factor = 0.34 + 0.66 * n.imp;
      d.position.set(n.x, BAR_Y, (near + rawFar) / 2);
      d.scale.set(n.width * factor, BAR_THICK, length);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      this.mesh.setMatrixAt(idx, d.matrix);
      // Dim as the bar drains so it fades out before the keys. The key glow
      // marks the actual strike.
      const fade = THREE.MathUtils.clamp(length / FADE_LEN, 0, 1);
      this._color.copy(n.color).multiplyScalar(0.35 + 0.65 * fade);
      this.mesh.setColorAt(idx, this._color);
      idx++;
    }
    this.mesh.count = idx;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  _updatePedals(t) {
    const d = this._dummy;
    let idx = 0;
    for (const p of this.pedalSpans) {
      const seg = spanOnLane(p.span, t, { pps: PPS, endZ: BAR_END_Z, runway: RUNWAY });
      if (!seg) continue;
      d.position.set(p.x, PEDAL_Y, (seg.near + seg.far) / 2);
      d.scale.set(PEDAL_W, PEDAL_THICK, seg.length);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      this.pedalMesh.setMatrixAt(idx, d.matrix);
      const fade = THREE.MathUtils.clamp(seg.length / FADE_LEN, 0, 1);
      this._color.setHex(PEDAL_COLOR[p.name]).multiplyScalar(0.45 + 0.55 * fade);
      this.pedalMesh.setColorAt(idx, this._color);
      idx++;
    }
    this.pedalMesh.count = idx;
    this.pedalMesh.instanceMatrix.needsUpdate = true;
    if (this.pedalMesh.instanceColor) this.pedalMesh.instanceColor.needsUpdate = true;
  }

  setVisible(v) { this.group.visible = v; }

  setPedalsVisible(v) { this.pedalGroup.visible = v; }
}