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
import { buildChords } from './chords.js';
import { buildHand, SKIN, FAN_PER_UNIT, MAX_FAN } from './handprocedural.js';
import {
  SCALE, REST_CURLS, STRIKE_CURLS, TIP_PAD, buildRig, poseChain, solveContact, fingerTip, chooseFingers,
} from './handrig.js';
import { travelLead, easeInOut, blendPose } from './motion.js';

// Scene forward, the axis a palm rolls about.
const FORWARD_AXIS = new THREE.Vector3(0, 0, 1);

const params = new URLSearchParams(window.location.search);
const flag = params.get('hands') || 'rigged';
const USE_PROCEDURAL = flag === 'procedural';
const SHOW_SKELETON = flag === 'debug';

// Strike curls live in handrig so the solver and the pose share one source.
const STRIKE_CURL = STRIKE_CURLS;

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
// The grouping lives in src/chords.js so Node tests can import it.
// Re-export keeps the previous public surface so existing importers do not break.
export { buildChords } from './chords.js';

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
        // Aim the thumb at its key when it plays; tuck it back at rest. The
        // base joint stays put, so the thumb swings instead of sliding out of
        // the palm.
        const thumb = joints[0];
        thumb.position.x = -1.95 * this.side;
        if (striking) {
          const base = thumb.getWorldPosition(new THREE.Vector3());
          const target = new THREE.Vector3(keyX(note.midi), keyTopY(note.midi) + 0.12, isBlack(note.midi) ? 0.1 : 1.9);
          const dir = target.sub(base).normalize();
          const inv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
          dir.applyQuaternion(inv);
          const aim = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
          thumb.quaternion.slerp(aim, Math.min(1, dt * 16));
        } else {
          const yaw = this.side * (0.5 + (this.spread - 1) * 0.25);
          const restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, yaw, this.side * -0.2));
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
        // Fan the finger at its knuckle. The knuckle keeps its place, so the
        // palm holds its width while the finger opens away from the others.
        const baseX = { 2: -1.0, 3: 0.0, 4: 1.0, 5: 2.0 }[f];
        finger.mcp.position.x = baseX * this.side;
        const fan = THREE.MathUtils.clamp(
          (baseX - 0.5) * (this.spread - 1) * FAN_PER_UNIT, -MAX_FAN, MAX_FAN);
        finger.mcp.rotation.y = -fan * this.side;
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
    this.rollQuat = new THREE.Quaternion();
    this.roll = 0;

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
      // The beam search picks fingers by a generic hand model. Where this rig
      // cannot span the keys with that choice, spread the notes over a wider
      // finger set instead of leaving the thumb short of its key.
      const ordered = Object.values(c.fingers).sort((a, b) => a.midi - b.midi);
      const midis = ordered.map((n) => n.midi);
      const chosen = chooseFingers(this.rig, midis, hand, ordered.map((n) => n.finger));
      if (chosen.some((f, i) => f !== ordered[i].finger)) {
        c.fingers = {};
        ordered.forEach((n, i) => { n.finger = chosen[i]; c.fingers[chosen[i]] = n; });
      }

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

      // Each tip clears its OWN key, not the highest key of the chord: a
      // thumb on a white key must not be lifted to the height of a black one.
      const base = Math.max(solve.wrist[1], c.keyTop + 1.6);
      const lift = Math.max(0, ...solve.tips.map((tip, i) =>
        keyTopY(entries[i].midi) + 0.02 - tip[1]));
      c.lift = lift + (base - solve.wrist[1]);
      c.wrist = new THREE.Vector3(solve.wrist[0], base + lift, solve.wrist[2]);
      // The strike pose the solve settled on, so the rendered curl matches it.
      c.strikeCurls = solve.curls;
      // Resting fingers straighten to hover above the keys beneath them.
      c.idleCurls = solve.idleCurls;
    }

    if (this.chords.length) {
      this.pos.copy(this.chords[0].wrist);
      this.seek(this.chords[0].time);
    }
  }

  // How long, in song time, the hand takes to move to chord `i`. The window
  // ends at the chord's own time, so the fingers arrive as the note sounds,
  // and it is sized to the distance the wrist actually travels.
  _lead(i) {
    const c = this.chords[i];
    const prev = i > 0 ? this.chords[i - 1] : null;
    if (!c || !prev) return 0;
    return travelLead(c.wrist.distanceTo(prev.wrist), c.time - prev.time);
  }

  // Pick the chord the hand is playing or moving to. A chord becomes current
  // only when its own travel window opens, so the previous pose holds until
  // the movement can start.
  _advance(t) {
    while (this.idx + 1 < this.chords.length
      && this.chords[this.idx + 1].time - t <= this._lead(this.idx + 1)) this.idx++;
  }

  // Where the pose is along the travel: the chord it left, the chord it is
  // reaching for, and how far it has got. A seek and a playthrough both sample
  // this, so the hand looks the same whether the clock ran or jumped.
  _transition(t) {
    const to = this.chords[this.idx];
    const from = this.idx > 0 ? this.chords[this.idx - 1] : null;
    if (!from) return { from: to, to, s: 1 };
    const lead = this._lead(this.idx);
    const s = lead > 0 ? Math.min(1, Math.max(0, (t - (to.time - lead)) / lead)) : 1;
    return { from, to, s };
  }

  seek(t) {
    this.idx = 0;
    this._advance(t);
    const c = this.chords[this.idx];
    if (!c) return;
    const tr = this._transition(t);
    // Land on the path the frame loop would have driven, so a seek into the
    // middle of a shift shows a hand in transit rather than one that jumped.
    this.pos.lerpVectors(tr.from.wrist, tr.to.wrist, easeInOut(tr.s));
    this.vel.set(0, 0, 0);
    for (const finger of [1, 2, 3, 4, 5]) this.curls[finger] = REST_CURLS[finger].slice();
    this._pose(tr);
    this._place();
  }

  update(t, dt) {
    this._advance(t);
    const c = this.chords[this.idx];
    if (!c) { this.root.visible = false; return; }
    this.root.visible = this.visible;

    const tr = this._transition(t);
    const active = t >= c.time - 0.04 && t <= c.end + 0.1;

    // The wrist arcs over the keys while the pose travels, and settles as the
    // fingers land: sin(pi s) is zero at both ends of the window, so the strike
    // still meets the key. The arc grows with the distance travelled, because a
    // leap lifts the whole hand and a neighbouring key does not.
    const travelled = c.wrist.distanceTo(tr.from.wrist);
    const lift = Math.sin(Math.PI * tr.s) * Math.min(1.0, travelled * 0.18);
    // The press dip matches the fingertip pad, so a struck tip meets the key
    // surface instead of punching through it.
    const target = new THREE.Vector3(c.wrist.x, c.wrist.y + lift + (active ? -TIP_PAD : 0.1), c.wrist.z);

    const w = 14;
    const acc = new THREE.Vector3(
      (target.x - this.pos.x) * w * w - this.vel.x * 2 * w,
      (target.y - this.pos.y) * w * w - this.vel.y * 2 * w,
      (target.z - this.pos.z) * w * w - this.vel.z * 2 * w,
    );
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    // Pronation belongs to the pose: the palm turns as the hand travels and is
    // at its solved angle when the fingers land.

    // Expressive tilt belongs to the travel, not the strike. A pitch while the
    // fingers are down would lift the tips off the keys the solve just placed
    // them on, so it stays off during contact.
    const travelling = active ? 0 : 1;
    this.tilt.setFromEuler(new THREE.Euler(
      0,
      THREE.MathUtils.clamp(this.vel.x * 0.015, -0.15, 0.15) * this.side * travelling,
      THREE.MathUtils.clamp(-this.vel.x * 0.02, -0.18, 0.18) * this.side * travelling,
    ));

    this._curl(t, dt, c, active);
    this._pose(tr);
    this._place();
  }

  _curl(t, dt, c, active) {
    for (const finger of [1, 2, 3, 4, 5]) {
      const note = c.fingers[finger];
      const striking = active && note && t >= note.time - 0.03;
      const rest = (c.idleCurls && c.idleCurls[finger]) || REST_CURLS[finger];
      const solved = c.strikeCurls && c.strikeCurls[finger];
      const target = striking ? (solved || rest.map((v, i) => v + STRIKE_CURL[finger][i])) : rest;
      const rate = Math.min(1, dt * (striking ? 26 : 12));
      this.curls[finger] = this.curls[finger].map((v, i) => v + (target[i] - v) * rate);
    }
  }

  _pose(tr) {
    const eased = easeInOut(tr.s);
    // The spread and the palm roll travel with the hand. The press stays with
    // the note: `_curl` animates each strike off its own onset, so a finger
    // whose note starts a little after the chord holds its relaxed pose.
    const pose = blendPose(
      { abduction: tr.from.solve.spread },
      { abduction: tr.to.solve.spread },
      eased,
    );
    const rollFrom = tr.from.solve.roll || 0;
    const rollTo = tr.to.solve.roll || 0;
    this.roll = rollFrom + (rollTo - rollFrom) * eased;

    for (const finger of [1, 2, 3, 4, 5]) {
      // Every finger takes its place from the ordered solve, so idle fingers
      // fan out with the playing ones instead of staying put and colliding.
      const abduction = pose.abduction[finger];
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
    // Pronation turns the palm about the forward axis, in scene space, so the
    // thumb side dips onto its key. The wrist stays the pivot.
    const roll = this.roll || 0;
    this.rollQuat.setFromAxisAngle(FORWARD_AXIS, roll * this.rig.rollSign);
    const q = this.root.quaternion.copy(this.rollQuat).multiply(this.calibration).multiply(this.tilt);
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

  // Centre of the playing hands, for a camera that follows the player.
  centerX() {
    if (!this.visible) return null;
    const xs = [this.L, this.R].filter((h) => h.chords.length).map((h) => h.pos.x);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  }

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