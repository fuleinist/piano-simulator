// Hands: chord model, two controllers, and the facade the player talks to.
//
// Two controllers share one chord model:
//   - RiggedHand drives the generic-hand skeleton from public/hands/. It poses
//     bones through src/handrig.js and places the wrist from a contact solve.
//   - ProceduralHand keeps the original primitive hands. It stays available as
//     a fallback and as the A/B reference.
//
// Flags: ?hands=procedural skips the GLB load, ?hands=debug adds skeletons.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { keyX, keyTopY, isBlack } from './layout.js';
import { buildHand, SKIN } from './handprocedural.js';
import { SCALE, REST_CURLS, buildRig, poseChain, solveContact } from './handrig.js';

const params = new URLSearchParams(window.location.search);
const flag = params.get('hands') || 'rigged';
const USE_PROCEDURAL = flag === 'procedural';
const SHOW_SKELETON = flag === 'debug';

// How far each joint curls past its rest angle when a finger strikes, in
// radians: MCP, PIP, DIP. A thumb has two joints.
const STRIKE_CURL = {
  1: [0.25, 0.30],
  2: [0.08, 0.12, 0.10],
  3: [0.08, 0.12, 0.10],
  4: [0.08, 0.12, 0.10],
  5: [0.07, 0.10, 0.09],
};

// Quaternion from a row-major 3x3 rotation matrix.
function quatFromMatrix(m) {
  const matrix = new THREE.Matrix4().set(
    m[0], m[1], m[2], 0,
    m[3], m[4], m[5], 0,
    m[6], m[7], m[8], 0,
    0, 0, 0, 1,
  );
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

// --- Chords ---------------------------------------------------------------
export function buildChords(notes, hand) {
  const ns = notes.filter((n) => n.hand === hand).sort((a, b) => a.time - b.time);
  const chords = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1].time - ns[i].time <= 0.05) j++;
    const group = ns.slice(i, j + 1);
    const fingers = {};
    let sx = 0, sz = 0, top = 0;
    for (const n of group) {
      fingers[n.finger] = n;
      sx += n.wristX;
      sz += isBlack(n.midi) ? 0.1 : 1.9;
      top = Math.max(top, keyTopY(n.midi));
    }
    chords.push({
      time: group[0].time,
      end: Math.max(...group.map((n) => n.time + n.duration)),
      wristX: sx / group.length,
      spread: group[0].spread || 1,
      strikeZ: sz / group.length,
      keyTop: top,
      fingers,
    });
    i = j + 1;
  }
  return chords;
}

// --- Procedural controller (fallback) -------------------------------------
class ProceduralHand {
  constructor(side) {
    const built = buildHand(side);
    this.kind = 'procedural';
    this.root = built.root;
    this.fingers = built.fingers;
    this.side = side;
    this.chords = [];
    this.pos = new THREE.Vector3(0, 3, 9);
    this.vel = new THREE.Vector3();
    this.spread = 1;
    this.bob = Math.random() * 6;
    this.idx = 0;
  }

  load(notes, hand) {
    this.chords = buildChords(notes, hand);
    this.idx = 0;
    if (this.chords.length) {
      this.pos.set(this.chords[0].wristX, 3, this.chords[0].strikeZ + 4.7);
    }
  }

  seek(t) {
    this.idx = 0;
    while (this.idx + 1 < this.chords.length && this.chords[this.idx + 1].time <= t + 0.12) this.idx++;
    const c = this.chords[this.idx];
    if (c) {
      this.pos.set(c.wristX, c.keyTop + 2.15, c.strikeZ + 4.7);
      this.vel.set(0, 0, 0);
      this.spread = c.spread;
    }
  }

  update(t, dt) {
    while (this.idx + 1 < this.chords.length && this.chords[this.idx + 1].time <= t + 0.12) this.idx++;
    const c = this.chords[this.idx];
    if (!c) { this.root.visible = false; return; }
    this.root.visible = true;
    const active = t >= c.time - 0.04 && t <= c.end + 0.1;
    const next = this.chords[this.idx + 1];

    // Anticipatory lift: raise the wrist while travelling a long way.
    const travel = next ? Math.abs(next.wristX - c.wristX) : 0;
    const lift = active ? 0 : Math.min(1.2, travel * 0.12);

    const targetX = c.wristX;
    const targetZ = c.strikeZ + 4.7;
    const targetY = c.keyTop + 2.15 + lift + (active ? -0.25 : 0.15);

    // Critically-damped spring toward the target (fast, natural settle).
    const w = 14;
    const acc = new THREE.Vector3(
      (targetX - this.pos.x) * w * w - this.vel.x * 2 * w,
      (targetY - this.pos.y) * w * w - this.vel.y * 2 * w,
      (targetZ - this.pos.z) * w * w - this.vel.z * 2 * w,
    );
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    this.spread += (c.spread - this.spread) * Math.min(1, dt * 10);
    const bob = Math.sin(t * 1.7 + this.bob) * 0.05;
    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.root.rotation.z = THREE.MathUtils.clamp(-this.vel.x * 0.02, -0.18, 0.18) * this.side;
    this.root.rotation.y = THREE.MathUtils.clamp(this.vel.x * 0.015, -0.15, 0.15) * this.side;
    this.root.rotation.x = active ? 0.06 : 0.0;

    this._curl(t, dt, c, active);
  }

  _curl(t, dt, c, active) {
    for (const f of [1, 2, 3, 4, 5]) {
      const finger = this.fingers[f];
      const note = c.fingers[f];
      const striking = active && note && t >= note.time - 0.03;
      const joints = finger.joints;
      const rest = finger.rest;
      if (finger.isThumb) {
        // Aim the thumb at its key when it plays; tuck it back at rest.
        const thumb = joints[0];
        if (striking) {
          thumb.position.x = (this.side < 0 ? 2 : -2) * this.spread;
          const base = thumb.getWorldPosition(new THREE.Vector3());
          const target = new THREE.Vector3(keyX(note.midi), keyTopY(note.midi) + 0.12, isBlack(note.midi) ? 0.1 : 1.9);
          const dir = target.sub(base).normalize();
          const inv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
          dir.applyQuaternion(inv);
          const aim = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
          thumb.quaternion.slerp(aim, Math.min(1, dt * 16));
        } else {
          thumb.position.x += (-1.95 * this.side - thumb.position.x) * Math.min(1, dt * 8);
          const restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, this.side * 0.5, this.side * -0.2));
          thumb.quaternion.slerp(restQ, Math.min(1, dt * 8));
        }
        const dip = striking ? 0.3 : 0;
        finger.curl[1] += (rest[1] + dip - finger.curl[1]) * Math.min(1, dt * 16);
        joints[1].rotation.x = -finger.curl[1];
      } else {
        for (let k = 0; k < joints.length; k++) {
          const dip = striking ? (k === 0 ? 0.32 : k === 1 ? 0.42 : 0.3) : 0;
          const target = rest[k] + dip;
          finger.curl[k] += (target - finger.curl[k]) * Math.min(1, dt * (striking ? 26 : 12));
          joints[k].rotation.x = -finger.curl[k];
        }
        // Spread the knuckles sideways with the chord span.
        const baseX = { 2: -1.0, 3: 0.0, 4: 1.0, 5: 2.0 }[f];
        finger.mcp.position.x = baseX * this.spread * this.side;
      }
    }
  }
}

// --- Rigged controller ----------------------------------------------------
class RiggedHand {
  constructor(side, gltf) {
    this.kind = 'rigged';
    this.side = side === 'R' ? 1 : -1;
    this.chords = [];
    this.pos = new THREE.Vector3(0, 3, 9);
    this.vel = new THREE.Vector3();
    this.bob = Math.random() * 6;
    this.idx = 0;
    this.visible = true;

    this.root = new THREE.Group();
    // Bones stay in metres; the group scales the whole rig into scene units.
    this.root.scale.setScalar(SCALE);
    const model = cloneSkeleton(gltf.scene);
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        o.material = SKIN;
      }
    });
    this.root.add(model);

    // Read the bind pose off the loaded skeleton. Joints are in metres, in
    // armature space; handrig converts them to scene units.
    const joints = [];
    this.bones = {};
    model.traverse((o) => {
      if (!o.isBone) return;
      this.bones[o.name] = o;
      joints.push({
        name: o.name,
        parent: o.parent && o.parent.isBone ? o.parent.name : null,
        translation: o.position.toArray(),
        rotation: o.quaternion.toArray(),
      });
    });
    if (joints.length < 20) throw new Error(`hand-${side} skeleton has ${joints.length} joints`);

    this.rig = buildRig({ source: `hand-${side}`, joints });
    this.calibration = quatFromMatrix(this.rig.rotation);
    this.wristModel = new THREE.Vector3()
      .fromArray(this.rig.worldPos.get('wrist'))
      .multiplyScalar(SCALE);
    this.tilt = new THREE.Quaternion();

    this.curls = {};
    for (const finger of [1, 2, 3, 4, 5]) this.curls[finger] = REST_CURLS[finger].slice();
    this.abduction = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    if (SHOW_SKELETON) {
      this.helper = new THREE.SkeletonHelper(model);
      this.helper.material.depthTest = false;
      this.root.add(this.helper);
    }
  }

  load(notes, hand) {
    this.chords = buildChords(notes, hand);
    this.idx = 0;

    // Solve each chord once: wrist position plus per-finger abduction.
    for (const c of this.chords) {
      // Solve at the strike pose, so a pressed finger meets the key surface and
      // the relaxed pose rests just above it.
      const entries = Object.entries(c.fingers).map(([finger, note]) => ({
        finger: Number(finger),
        midi: note.midi,
        curls: REST_CURLS[finger].map((v, i) => v + STRIKE_CURL[finger][i]),
      }));
      const solve = solveContact(this.rig, entries);
      c.entries = entries;
      c.solve = solve;

      // A finger that cannot reach its key would otherwise push through the
      // surface, so lift the wrist until the lowest strike tip clears it.
      const lowest = Math.min(...solve.tips.map((tip) => tip[1]));
      const base = Math.max(solve.wrist[1], c.keyTop + 1.6);
      const lift = lowest < c.keyTop + 0.02 ? c.keyTop + 0.02 - lowest : 0;
      c.lift = lift + (base - solve.wrist[1]);
      c.wrist = new THREE.Vector3(solve.wrist[0], base + lift, solve.wrist[2]);
    }

    if (this.chords.length) {
      this.pos.copy(this.chords[0].wrist);
      this.seek(this.chords[0].time);
    }
  }

  seek(t) {
    this.idx = 0;
    while (this.idx + 1 < this.chords.length && this.chords[this.idx + 1].time <= t + 0.12) this.idx++;
    const c = this.chords[this.idx];
    if (!c) return;
    this.pos.copy(c.wrist);
    this.vel.set(0, 0, 0);
    for (const finger of [1, 2, 3, 4, 5]) this.curls[finger] = REST_CURLS[finger].slice();
    this._pose(c);
    this._place();
  }

  update(t, dt) {
    while (this.idx + 1 < this.chords.length && this.chords[this.idx + 1].time <= t + 0.12) this.idx++;
    const c = this.chords[this.idx];
    if (!c) { this.root.visible = false; return; }
    this.root.visible = this.visible;

    const active = t >= c.time - 0.04 && t <= c.end + 0.1;
    const next = this.chords[this.idx + 1];

    // Anticipatory lift on a long shift.
    const travel = next ? Math.abs(next.wrist.x - c.wrist.x) : 0;
    const lift = active ? 0 : Math.min(1.0, travel * 0.1);
    const target = new THREE.Vector3(c.wrist.x, c.wrist.y + lift + (active ? -0.12 : 0.1), c.wrist.z);

    const w = 14;
    const acc = new THREE.Vector3(
      (target.x - this.pos.x) * w * w - this.vel.x * 2 * w,
      (target.y - this.pos.y) * w * w - this.vel.y * 2 * w,
      (target.z - this.pos.z) * w * w - this.vel.z * 2 * w,
    );
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    // Roll into the travel direction, the way a forearm leads a shift.
    this.tilt.setFromEuler(new THREE.Euler(
      active ? 0.06 : 0,
      THREE.MathUtils.clamp(this.vel.x * 0.015, -0.15, 0.15) * this.side,
      THREE.MathUtils.clamp(-this.vel.x * 0.02, -0.18, 0.18) * this.side,
    ));

    this._curl(t, dt, c, active);
    this._pose(c);
    this._place();
  }

  _curl(t, dt, c, active) {
    for (const finger of [1, 2, 3, 4, 5]) {
      const note = c.fingers[finger];
      const striking = active && note && t >= note.time - 0.03;
      const rest = REST_CURLS[finger];
      const bump = striking ? STRIKE_CURL[finger] : null;
      const rate = Math.min(1, dt * (striking ? 26 : 12));
      this.curls[finger] = this.curls[finger].map((v, i) =>
        v + (rest[i] + (bump ? bump[i] : 0) - v) * rate);
    }
  }

  _pose(c) {
    for (const finger of [1, 2, 3, 4, 5]) {
      const index = c.entries.findIndex((e) => e.finger === finger);
      const abduction = index >= 0 ? c.solve.abductions[index] : 0;
      this.abduction[finger] = abduction;
      for (const bone of poseChain(this.rig, finger, this.curls[finger], abduction).bones) {
        const target = this.bones[bone.name];
        if (!target) continue;
        target.position.fromArray(bone.localPosition);
        target.quaternion.fromArray(bone.localQuaternion);
      }
    }
  }

  _place() {
    const q = this.root.quaternion.copy(this.calibration).multiply(this.tilt);
    const offset = this.wristModel.clone().applyQuaternion(q);
    this.root.position.copy(this.pos).sub(offset);
    if (this.helper) this.root.updateMatrixWorld(true);
  }
}

// --- Facade ---------------------------------------------------------------
export class Hands {
  constructor(scene) {
    this.scene = scene;
    this.L = new ProceduralHand(-1);
    this.R = new ProceduralHand(1);
    scene.add(this.L.root);
    scene.add(this.R.root);
    this.visible = true;
    this.notes = null;
    this.upgraded = false;

    if (!USE_PROCEDURAL) this._upgrade();
  }

  // Swap in the rigged hands once both GLBs arrive. On any failure the
  // procedural hands stay, so the app never renders without hands.
  async _upgrade() {
    try {
      const loader = new GLTFLoader();
      const base = `${import.meta.env.BASE_URL}hands/`;
      const [left, right] = await Promise.all([
        loader.loadAsync(`${base}left.glb`),
        loader.loadAsync(`${base}right.glb`),
      ]);
      const L = new RiggedHand('L', left);
      const R = new RiggedHand('R', right);

      for (const hand of [this.L, this.R]) this.scene.remove(hand.root);
      this.L = L;
      this.R = R;
      this.scene.add(L.root);
      this.scene.add(R.root);
      this.upgraded = true;
      this.setVisible(this.visible);

      if (this.notes) {
        L.load(this.notes, 'L');
        R.load(this.notes, 'R');
      }
    } catch (error) {
      console.warn('[hands] rigged asset unavailable, keeping the procedural hands', error);
    }
  }

  load(notes) {
    this.notes = notes;
    this.L.load(notes, 'L');
    this.R.load(notes, 'R');
  }

  seek(t) { this.L.seek(t); this.R.seek(t); }

  update(t, dt) {
    if (!this.visible) {
      this.L.root.visible = false;
      this.R.root.visible = false;
      return;
    }
    this.L.update(t, dt);
    this.R.update(t, dt);
  }

  setVisible(v) {
    this.visible = v;
    this.L.root.visible = v;
    this.R.root.visible = v;
  }
}