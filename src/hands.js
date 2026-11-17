import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keyX, keyTopY, isBlack, STRIKE_Z } from './layout.js';

// One unit ~= one white-key width (23.5 mm). A hand is ~8 units long (~19 cm).
const SKIN = new THREE.MeshPhysicalMaterial({
  color: 0xc8875f, roughness: 0.55, metalness: 0,
  sheen: 0.22, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xe89a70),
  clearcoat: 0.04, clearcoatRoughness: 0.6,
});
const NAIL = new THREE.MeshPhysicalMaterial({
  color: 0xf0d3c4, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.2,
});

function capsule(radius, len) {
  const g = new THREE.CapsuleGeometry(radius, len, 6, 14);
  g.rotateX(-Math.PI / 2); // lie along -Z
  g.translate(0, 0, -(len / 2 + radius));
  const m = new THREE.Mesh(g, SKIN);
  m.castShadow = true;
  return m;
}

// A three-joint finger. joints[0]=MCP, 1=PIP, 2=DIP. Curl = flex downward.
function buildFinger(side, mcpX, scale) {
  const lens = [1.5 * scale, 1.0 * scale, 0.72 * scale];
  const rads = [0.30 * scale, 0.26 * scale, 0.22 * scale];
  const mcp = new THREE.Group();
  mcp.position.set(mcpX * side, 0.02, -3.55);
  const joints = [mcp];
  let parent = mcp;
  for (let i = 0; i < 3; i++) {
    parent.add(capsule(rads[i], lens[i]));
    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(rads[i] * 1.08, 12, 10), SKIN);
    knuckle.castShadow = true;
    parent.add(knuckle);
    if (i < 2) {
      const next = new THREE.Group();
      next.position.z = -lens[i];
      parent.add(next);
      joints.push(next);
      parent = next;
    }
  }
  // Fingertip pad + nail on the distal joint.
  const tip = new THREE.Mesh(new THREE.SphereGeometry(rads[2] * 1.12, 12, 10), SKIN);
  tip.position.z = -lens[2] * 0.7;
  tip.castShadow = true;
  parent.add(tip);
  const nail = new THREE.Mesh(new RoundedBoxGeometry(rads[2] * 1.5, 0.06, rads[2] * 1.7, 2, 0.03), NAIL);
  nail.position.set(0, rads[2] * 0.85, -lens[2] * 0.55);
  nail.rotation.x = 0.25;
  parent.add(nail);
  return { mcp, joints, rest: [0.22, 0.34, 0.2], curl: [0.22, 0.34, 0.2] };
}

function buildHand(side) {
  const root = new THREE.Group();

  // Palm + thenar (thumb muscle) bulge.
  const palm = new THREE.Mesh(new RoundedBoxGeometry(3.5, 0.95, 3.7, 3, 0.35), SKIN);
  palm.position.set(0.35 * side, 0, -1.9);
  palm.castShadow = true;
  root.add(palm);
  const thenar = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 12), SKIN);
  thenar.scale.set(1, 0.7, 1.3);
  thenar.position.set(-1.4 * side, -0.05, -1.2);
  thenar.castShadow = true;
  root.add(thenar);
  // Wrist stub.
  const wrist = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.85, 1.6, 3, 0.3), SKIN);
  wrist.position.set(0.2 * side, 0.02, 0.7);
  wrist.castShadow = true;
  root.add(wrist);
  // Forearm: tapers toward the elbow and rises toward the player.
  const forearm = new THREE.Group();
  forearm.position.set(0.2 * side, 0.05, 1.4);
  forearm.rotation.x = -0.34;
  const fa = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 0.95, 6.5, 18), SKIN);
  fa.rotation.x = Math.PI / 2;
  fa.position.z = 3.2;
  fa.castShadow = true;
  forearm.add(fa);
  root.add(forearm);
  // Knuckle ridge.
  const ridge = new THREE.Mesh(new RoundedBoxGeometry(3.4, 0.5, 0.7, 2, 0.2), SKIN);
  ridge.position.set(0.4 * side, 0.12, -3.5);
  root.add(ridge);

  // Fingers: index, middle, ring, pinky at canonical MCP x = -1, 0, 1, 2.
  const specs = [
    { x: -1.0, s: 0.95 }, { x: 0.0, s: 1.0 }, { x: 1.0, s: 0.95 }, { x: 2.0, s: 0.78 },
  ];
  const fingers = {};
  specs.forEach((sp, i) => { fingers[i + 2] = buildFinger(side, sp.x, sp.s); root.add(fingers[i + 2].mcp); });

  // Thumb: two segments, splayed outward toward the bass side.
  const thumb = new THREE.Group();
  thumb.position.set(-1.95 * side, -0.15, -2.0);
  thumb.rotation.y = side * 0.7;
  thumb.rotation.z = side * -0.25;
  const t1 = capsule(0.34, 1.7);
  thumb.add(t1);
  const tj = new THREE.Group();
  tj.position.z = -1.7;
  tj.rotation.x = -0.3;
  thumb.add(tj);
  tj.add(capsule(0.28, 1.4));
  const tNail = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.06, 0.5, 2, 0.03), NAIL);
  tNail.position.set(0, 0.24, -1.1);
  tj.add(tNail);
  root.add(thumb);
  fingers[1] = { mcp: thumb, joints: [thumb, tj], rest: [0.5, 0.6], curl: [0.5, 0.6], isThumb: true };

  return { root, fingers, side };
}

// --- Motion controller ---------------------------------------------------
function buildChords(notes, hand) {
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

class Hand {
  constructor(side) {
    const built = buildHand(side);
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

  _current(t) {
    // Advance to the chord that is sounding or imminent.
    while (this.idx + 1 < this.chords.length && this.chords[this.idx + 1].time <= t + 0.12) this.idx++;
    const c = this.chords[this.idx];
    if (!c) return null;
    // If we are well past this chord and the next is far, hold position.
    return c;
  }

  update(t, dt) {
    const c = this._current(t);
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
      (targetZ - this.pos.z) * w * w - this.vel.z * 2 * w
    );
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    this.spread += (c.spread - this.spread) * Math.min(1, dt * 10);
    const bob = Math.sin(t * 1.7 + this.bob) * 0.05;
    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    // Slight forearm tilt toward the travel direction + expressive roll.
    this.root.rotation.z = THREE.MathUtils.clamp(-this.vel.x * 0.02, -0.18, 0.18) * this.side;
    this.root.rotation.y = THREE.MathUtils.clamp(this.vel.x * 0.015, -0.15, 0.15) * this.side;
    this.root.rotation.x = active ? 0.06 : 0.0;

    // Finger curls: strike the active notes, relax the others.
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

export class Hands {
  constructor(scene) {
    this.L = new Hand(-1);
    this.R = new Hand(1);
    scene.add(this.L.root);
    scene.add(this.R.root);
    this.visible = true;
  }
  load(notes) {
    this.L.load(notes, 'L');
    this.R.load(notes, 'R');
  }
  seek(t) { this.L.seek(t); this.R.seek(t); }
  update(t, dt) {
    if (!this.visible) { this.L.root.visible = false; this.R.root.visible = false; return; }
    this.L.update(t, dt);
    this.R.update(t, dt);
  }
  setVisible(v) { this.visible = v; }
}