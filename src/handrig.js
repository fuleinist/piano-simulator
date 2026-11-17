// Hand rig math. Pure module: no Three.js import, runs in Node.
//
// The rig is the WebXR 25-joint hand skeleton that ships with the
// `generic-hand` asset in public/hands/. This module turns joint angles into
// bone quaternions and fingertip positions, and solves the wrist position that
// puts the playing fingertips on their keys.
//
// Axes: model space comes from the GLB. `buildRig` measures the bind pose and
// returns a rotation that maps it into scene space:
//   fingers along -Z, palm normal along -Y, lateral axis along +X.
// One scene unit is one white key (23.5 mm).

import { keyX, keyTopY, STRIKE_Z } from './layout.js';

/** Metres to scene units: one white key is 23.5 mm on a real piano. */
export const SCALE = 1 / 0.0235;

/** Mean MCP spacing of the reference hand (19.5 mm) in white-key units. */
export const SPREAD_UNIT = 0.83;

/** Fingertip pad radius, in scene units, so a tip rests on a key surface. */
export const TIP_PAD = 0.06;

/** Maximum abduction the solver allows, in radians. */
export const MAX_ABDUCTION = 0.35;

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];

// Engine finger numbers: 1 is the thumb, 5 is the pinky. Each chain starts at
// the metacarpal and ends at the tip leaf.
export const CHAINS = {
  1: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  2: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  3: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  4: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  5: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};

// A relaxed playing hand: rounded knuckle, curved fingers. Radians.
export const REST_CURLS = {
  1: [0.05, 0.05],
  2: [0.35, 0.45, 0.20],
  3: [0.35, 0.45, 0.20],
  4: [0.35, 0.45, 0.20],
  5: [0.30, 0.35, 0.20],
};

// --- vector helpers -------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => {
  const len = length(a);
  if (!(len > 1e-9)) throw new Error('zero-length vector');
  return scale(a, 1 / len);
};

// --- quaternion helpers ---------------------------------------------------
// Quaternions are [x, y, z, w].
export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qNorm = (q) => {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > 1e-9)) throw new Error('zero-length quaternion');
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
};
export const qFromAxisAngle = (axis, angle) => {
  const half = angle / 2;
  const s = Math.sin(half);
  const n = normalize(axis);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)];
};
export const qRotate = (q, v) => {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const u = [q[0], q[1], q[2]];
  const t = add(cross(u, v), scale(v, q[3]));
  return add(v, scale(cross(u, t), 2));
};

// --- bind pose ------------------------------------------------------------
/**
 * Measure the bind pose of a hand: joint world positions, the axis basis, and
 * the rotation that maps model space into scene space.
 *
 * @param {{joints: Array<{name: string, parent: ?string, translation: number[], rotation: number[]}>}} bind
 */
export function buildRig(bind) {
  const byName = new Map();
  for (const joint of bind.joints) byName.set(joint.name, joint);
  for (const name of JOINT_NAMES) {
    if (!byName.has(name)) throw new Error(`rig is missing joint ${name}`);
  }

  const worldPos = new Map();
  const worldQuat = new Map();
  const visiting = new Set();

  const resolve = (name) => {
    if (worldPos.has(name)) return;
    if (visiting.has(name)) throw new Error(`cycle at ${name}`);
    visiting.add(name);
    const joint = byName.get(name);
    const local = {
      pos: joint.translation || [0, 0, 0],
      quat: qNorm(joint.rotation || [0, 0, 0, 1]),
    };
    // Fixtures hold skin joints only. A joint whose parent is not in the
    // fixture (an armature node) is treated as the root of the rig.
    const parentJoint = joint.parent ? byName.get(joint.parent) : null;
    if (!parentJoint) {
      worldPos.set(name, local.pos);
      worldQuat.set(name, local.quat);
    } else {
      resolve(parentJoint.name);
      const parentPos = worldPos.get(parentJoint.name);
      const parentQuat = worldQuat.get(parentJoint.name);
      worldPos.set(name, add(parentPos, qRotate(parentQuat, local.pos)));
      worldQuat.set(name, qNorm(qMul(parentQuat, local.quat)));
    }
    visiting.delete(name);
  };

  for (const name of JOINT_NAMES) resolve(name);

  const p = (name) => worldPos.get(name);
  const forward = normalize(sub(p('middle-finger-tip'), p('wrist')));
  const lateralRaw = sub(p('pinky-finger-metacarpal'), p('index-finger-metacarpal'));

  // Palm normal. The sign follows the thumb, which sits on the palm side.
  let normal = normalize(cross(forward, lateralRaw));
  if (dot(sub(p('thumb-tip'), p('wrist')), normal) < 0) normal = scale(normal, -1);

  // Re-derive the lateral axis so the basis is orthonormal even when the bind
  // pose is not perfectly flat.
  const lateral = normalize(cross(normal, forward));

  // Map model space into scene space: fingers -Z, palm normal -Y, lateral +X.
  const targetLateral = [1, 0, 0];
  const targetNormal = [0, -1, 0];
  const targetForward = [0, 0, -1];
  const rotation = matMul(
    matFromColumns(targetLateral, targetNormal, targetForward),
    transpose(matFromColumns(lateral, normal, forward)),
  );

  const segments = {};
  for (const [finger, chain] of Object.entries(CHAINS)) {
    // Phalanx segments only: the metacarpal bone is the base of the chain, so
    // the first segment runs from the MCP (chain[1]) to the next joint.
    segments[finger] = chain.slice(2).map((name, i) => sub(p(name), p(chain[i + 1])));
  }

  return {
    name: bind.source || 'hand',
    joints: bind.joints,
    byName,
    worldPos,
    worldQuat,
    forward,
    lateral,
    normal,
    rotation,
    segments,
    scale: SCALE,
  };
}

// --- 3x3 matrices, row-major ---------------------------------------------
function matFromColumns(c0, c1, c2) {
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}
function transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
function matMul(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}
function matApply(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export function matDet(m) {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}
export function applyCalibration(rig, v) {
  return matApply(rig.rotation, v);
}

// --- finger kinematics ----------------------------------------------------
/** Flexion axis of one finger, in model space, from its bind geometry. */
export function flexionAxis(rig, finger) {
  const chain = CHAINS[finger];
  const dir = normalize(sub(rig.worldPos.get(chain[chain.length - 1]), rig.worldPos.get(chain[0])));
  return normalize(cross(dir, rig.normal));
}

/**
 * Fingertip position relative to the wrist bone, in scene units, with the
 * calibration applied. `curls` holds one angle per joint: MCP, PIP, DIP.
 */
export function fingerTip(rig, finger, curls, abduction = 0) {
  const chain = CHAINS[finger];
  const axis = flexionAxis(rig, finger);
  const abduct = abduction === 0 ? null : qFromAxisAngle(rig.normal, abduction);

  // Abduction swings the metacarpal, so the MCP itself moves.
  const cmc = rig.worldPos.get(chain[0]);
  const mcp = rig.worldPos.get(chain[1]);
  let tip = abduct ? add(cmc, qRotate(abduct, sub(mcp, cmc))) : mcp.slice();
  let total = 0;
  for (let i = 0; i < rig.segments[finger].length; i++) {
    total += curls[i] ?? 0;
    // Flexion happens in the finger's own frame; abduction rotates that whole
    // frame at the metacarpal head, so it applies outside the flexion.
    let seg = qRotate(qFromAxisAngle(axis, total), rig.segments[finger][i]);
    if (abduct) seg = qRotate(abduct, seg);
    tip = add(tip, seg);
  }
  const offset = sub(tip, rig.worldPos.get('wrist'));
  return scale(matApply(rig.rotation, offset), SCALE);
}

/** Rest segment lengths of one finger, in millimetres. */
export function segmentLengths(rig, finger) {
  return rig.segments[finger].map((seg) => Math.round(length(seg) * SCALE * 23.5 * 10) / 10);
}

/** Lateral position of each metacarpal, in millimetres, in scene space. */
export function metacarpalSpacing(rig) {
  const xs = [2, 3, 4, 5].map((finger) => {
    const chain = CHAINS[finger];
    const p = sub(rig.worldPos.get(chain[1]), rig.worldPos.get('wrist'));
    return matApply(rig.rotation, p)[0] * SCALE * 23.5;
  });
  return xs.map((x, i) => (i === 0 ? 0 : Math.round((x - xs[i - 1]) * 10) / 10)).slice(1);
}

/**
 * Pose a whole finger.
 *
 * Returns, for each bone, its posed transform in model space plus the local
 * transform the skeleton stores:
 *   - `position`, `world`: absolute pose, measured from the armature origin.
 *   - `localPosition`, `localQuaternion`: pose relative to the rest parent, so
 *     a renderer can write them straight onto a bone.
 *
 * Bones take the rotation of the joint they start at, so the metacarpal takes
 * abduction and the proximal phalanx takes the MCP curl. The WebXR
 * `generic-hand` skeleton is flat (every joint is a child of the armature), so
 * the local and absolute values coincide there.
 */
export function poseChain(rig, finger, curls, abduction = 0) {
  const chain = CHAINS[finger];
  const axis = flexionAxis(rig, finger);
  const abduct = qFromAxisAngle(rig.normal, abduction);

  const bones = [];
  let position = rig.worldPos.get(chain[0]).slice();
  let rotation = abduct;

  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const restQuat = rig.worldQuat.get(name);
    const parentName = rig.byName.get(name).parent;
    const parentRestQuat = rig.worldQuat.get(parentName) || [0, 0, 0, 1];
    const parentRestPos = rig.worldPos.get(parentName) || [0, 0, 0];

    const world = qNorm(qMul(rotation, restQuat));
    const localQuaternion = qNorm(qMul(qConj(parentRestQuat), world));
    const localPosition = qRotate(qConj(parentRestQuat), sub(position, parentRestPos));

    bones.push({ name, position: position.slice(), world, localPosition, localQuaternion });

    // Advance to the next joint: the segment from this joint to the next one
    // rotates by the curl applied at this joint.
    if (i + 1 < chain.length) {
      const nextName = chain[i + 1];
      const segment = sub(rig.worldPos.get(nextName), rig.worldPos.get(name));
      position = add(position, qRotate(rotation, segment));
      if (i + 1 < chain.length - 1) {
        rotation = qMul(rotation, qFromAxisAngle(axis, curls[i] ?? 0));
      }
    }
  }
  return { bones, tip: position };
}

// --- contact solve --------------------------------------------------------
/** Scene-space contact point for a key: key top plus the fingertip pad. */
export function keyContact(midi) {
  return [keyX(midi), keyTopY(midi) + TIP_PAD, STRIKE_Z];
}

function ternaryMin(fn, lo, hi, iterations = 18) {
  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    if (fn(m1) <= fn(m2)) b = m2;
    else a = m1;
  }
  return (a + b) / 2;
}

/**
 * Solve the wrist position, and a bounded abduction for each finger, so the
 * playing fingertips reach their keys.
 *
 * @param {object} rig
 * @param {Array<{finger: number, midi: number, curls?: number[]}>} notes
 * @returns {{wrist: number[], tips: number[][], residuals: number[], maxResidual: number, abductions: number[]}}
 *   residuals are millimetres.
 */
export function solveContact(rig, notes) {
  const items = notes.map((note) => ({
    finger: note.finger,
    midi: note.midi,
    curls: note.curls || REST_CURLS[note.finger],
    abduction: 0,
  }));

  let wrist = [0, 0, 0];
  for (let pass = 0; pass < 3; pass++) {
    // Least-squares wrist for the current finger poses.
    const offsets = items.map((item) => fingerTip(rig, item.finger, item.curls, item.abduction));
    const targets = items.map((item) => keyContact(item.midi));
    wrist = [0, 1, 2].map((axis) =>
      targets.reduce((sum, t, i) => sum + t[axis] - offsets[i][axis], 0) / items.length,
    );

    // Bounded abduction per finger, then re-solve the wrist next pass.
    for (const item of items) {
      const target = keyContact(item.midi);
      const err = (abduction) => {
        const tip = fingerTip(rig, item.finger, item.curls, abduction);
        return Math.hypot(
          wrist[0] + tip[0] - target[0],
          wrist[1] + tip[1] - target[1],
          wrist[2] + tip[2] - target[2],
        );
      };
      item.abduction = ternaryMin(err, -MAX_ABDUCTION, MAX_ABDUCTION);
    }
  }

  const tips = items.map((item) => fingerTip(rig, item.finger, item.curls, item.abduction));
  const residuals = tips.map((tip, i) => {
    const target = keyContact(items[i].midi);
    return Math.hypot(
      wrist[0] + tip[0] - target[0],
      wrist[1] + tip[1] - target[1],
      wrist[2] + tip[2] - target[2],
    ) * 23.5;
  });

  return {
    wrist,
    tips: tips.map((tip) => add(wrist, tip)),
    residuals,
    maxResidual: Math.max(...residuals),
    abductions: items.map((item) => item.abduction),
  };
}