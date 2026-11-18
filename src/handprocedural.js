// Procedural hand geometry. Kept as the fallback when the rigged asset does
// not load, and as the A/B reference in the close view.
//
// One unit ~= one white-key width (23.5 mm). A hand is ~8 units long (~19 cm).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const SKIN = new THREE.MeshPhysicalMaterial({
  color: 0xc8875f, roughness: 0.55, metalness: 0,
  sheen: 0.22, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xe89a70),
  clearcoat: 0.04, clearcoatRoughness: 0.6,
});

export const NAIL = new THREE.MeshPhysicalMaterial({
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

export function buildHand(side) {
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