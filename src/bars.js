import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keyX, keyWidth, KEY_BACK_Z, BOARD_W } from './layout.js';

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

export class Bars {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mesh = null;
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

  load(notes) {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.dispose(); }
    this.data = notes.map((n) => {
      return {
        x: keyX(n.midi),
        len: Math.max(n.duration * PPS, 0.45),
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
  }

  update(t) {
    if (!this.mesh) return;
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

  setVisible(v) { this.group.visible = v; }
}