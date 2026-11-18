import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  MIDI_MIN, MIDI_MAX, WHITE_W, WHITE_LEN, WHITE_H, BLACK_W, BLACK_LEN, BLACK_TOP,
  KEY_BACK_Z, KEY_FRONT_Z, BOARD_W, keyX, isBlack, noteName,
} from './layout.js';
import { keyHighlight } from './keylight.js';

const PRESS_ANGLE = 0.05;

export class Piano {
  constructor(scene) {
    this.group = new THREE.Group();
    this.keys = new Map(); // midi -> { pivot, mat, target, glow, color }
    this._buildKeys();
    this._buildBody();
    this._buildLabels();
    scene.add(this.group);
  }

  _buildKeys() {
    const whiteGeo = new RoundedBoxGeometry(WHITE_W * 0.95, WHITE_H, WHITE_LEN, 2, 0.05);
    const blackGeo = new RoundedBoxGeometry(BLACK_W, 0.5, BLACK_LEN, 2, 0.05);
    const whiteBase = new THREE.MeshPhysicalMaterial({
      color: 0xf6f2e7, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.25,
    });
    const blackBase = new THREE.MeshPhysicalMaterial({
      color: 0x151517, roughness: 0.26, clearcoat: 0.7, clearcoatRoughness: 0.2,
    });

    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      const black = isBlack(m);
      const mat = (black ? blackBase : whiteBase).clone();
      mat.emissive = new THREE.Color(0x000000);
      const mesh = new THREE.Mesh(black ? blackGeo : whiteGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(keyX(m), 0, KEY_BACK_Z);
      mesh.position.set(0, black ? BLACK_TOP - 0.25 : -WHITE_H / 2, (black ? BLACK_LEN : WHITE_LEN) / 2);
      pivot.add(mesh);
      this.group.add(pivot);
      this.keys.set(m, {
        pivot, mat, black,
        baseColor: mat.color.clone(),
        target: 0, glow: 0, glowTarget: 0, color: new THREE.Color(0xffffff),
      });
    }
  }

  _buildBody() {
    const gloss = new THREE.MeshPhysicalMaterial({
      color: 0x0c0c0f, roughness: 0.16, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12,
    });
    const add = (geo, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(geo, gloss);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    // Key bed + cheeks + nameboard.
    add(new RoundedBoxGeometry(BOARD_W + 2.6, 0.9, WHITE_LEN + 1.8, 2, 0.1), 0, -0.85, 0);
    add(new RoundedBoxGeometry(1.4, 1.5, WHITE_LEN + 1.8, 2, 0.1), -(BOARD_W / 2 + 0.8), 0.05, 0);
    add(new RoundedBoxGeometry(1.4, 1.5, WHITE_LEN + 1.8, 2, 0.1), BOARD_W / 2 + 0.8, 0.05, 0);
    add(new RoundedBoxGeometry(BOARD_W + 2.6, 1.2, 0.9, 2, 0.08), 0, 0.3, KEY_BACK_Z - 0.55);
    // The note highway glides over the grand rim behind the keys, so no
    // music desk stands in the bar path.

    // Stylised grand rim sweeping back from the keyboard.
    const s = new THREE.Shape();
    const L = -(BOARD_W / 2 + 1), R = BOARD_W / 2 + 1;
    s.moveTo(L, 3.7);
    s.lineTo(L, 20.5);
    s.quadraticCurveTo(L + 1, 23.4, -13, 23.4);
    s.lineTo(3, 22);
    s.quadraticCurveTo(R - 4, 19, R, 12);
    s.lineTo(R, 3.7);
    s.lineTo(L, 3.7);
    const rimGeo = new THREE.ExtrudeGeometry(s, { depth: 1.0, bevelEnabled: false });
    const rim = new THREE.Mesh(rimGeo, gloss);
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = -0.45;
    rim.castShadow = true; rim.receiveShadow = true;
    this.group.add(rim);
  }

  _buildLabels() {
    for (let m = 24; m <= MIDI_MAX; m += 12) {
      const tex = this._labelTexture(noteName(m));
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4), mat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(keyX(m), 0.02, KEY_FRONT_Z - 0.55);
      this.group.add(plane);
    }
  }

  _labelTexture(text) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.fillStyle = 'rgba(70,74,86,0.9)';
    g.font = '600 34px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 64, 34);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  }

  press(midi, colorHex, velocity = 0.8) {
    const k = this.keys.get(midi);
    if (!k) return;
    k.target = PRESS_ANGLE * (0.6 + 0.4 * velocity);
    k.color.set(colorHex);
    k.glowTarget = 0.55 + 0.45 * velocity;
  }

  release(midi) {
    const k = this.keys.get(midi);
    if (!k) return;
    k.target = 0;
    k.glowTarget = 0;
  }

  update(dt) {
    const k = 1 - Math.pow(0.0001, dt);
    for (const key of this.keys.values()) {
      key.pivot.rotation.x += (key.target - key.pivot.rotation.x) * k;
      key.glow += (key.glowTarget - key.glow) * k;
      const light = keyHighlight(key.glow, key.black);
      // Ivory keys need their body colour moved to show the press at all: see
      // keylight.js for why emissive alone is invisible on them.
      key.mat.color.copy(key.baseColor).lerp(key.color, light.tint);
      key.mat.emissive.copy(key.color).multiplyScalar(light.emissive);
    }
  }
}