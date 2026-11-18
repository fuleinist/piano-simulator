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

import { keyX, keyTopY, keyTopAtX, keyStrikeZ, keyStrikeRange } from './layout.js';

/** Metres to scene units: one white key is 23.5 mm on a real piano. */
export const SCALE = 1 / 0.0235;

/** Mean MCP spacing of the reference hand (19.5 mm) in white-key units. */
export const SPREAD_UNIT = 0.83;

/** Fingertip pad radius, in scene units, so a tip rests on a key surface. */
export const TIP_PAD = 0.06;

/** Maximum abduction the solver allows, in radians. */
export const MAX_ABDUCTION = 0.35;

/** Finger numbers in anatomical order, thumb to pinky. */
export const FINGERS = [1, 2, 3, 4, 5];

/** Minimum lateral gap between adjacent fingertips, in scene units. A finger
 * is about 0.6 units wide, so this keeps the tips from touching. */
export const MIN_TIP_GAP = 0.66;

/** Minimum distance between the shafts of adjacent fingers, in scene units. */
export const MIN_SHAFT_GAP = 0.62;

/** The wrist stays at least this far above the highest key in the chord. */
export const MIN_WRIST_HEIGHT = 1.6;

/** A resting fingertip hovers this far above the keys, in scene units. */
export const IDLE_HOVER = 0.14;

/** Palm pronation limit, in radians, and the steps the solver tries. */
export const MAX_ROLL = 0.5;
export const ROLL_STEPS = [0, 0.12, 0.24, 0.36, MAX_ROLL];

/** Cost of rolling, so the palm only turns when contact needs it. */
export const ROLL_PENALTY = 0.35;

/** The thumb miss, in millimetres, above which the palm starts to pronate. */
export const ROLL_TRIGGER_MM = 5;

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

  // Which side the thumb sits on in scene space. The right hand puts it at
  // negative X, the left at positive X. Ordering and palm roll both need this.
  const thumbOffset = scale(matApply(rotation, sub(p('thumb-tip'), p('wrist'))), SCALE);
  const thumbSign = thumbOffset[0] < 0 ? -1 : 1;

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
    thumbSign,
    // A positive roll dips the thumb side, for either hand.
    rollSign: -thumbSign,
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
// Rotate a scene-space offset about the forward axis. A positive roll dips
// the thumb side of the hand, the way forearm pronation does.
function rollOffset(offset, angle) {
  if (!angle) return offset;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [offset[0] * c - offset[1] * s, offset[0] * s + offset[1] * c, offset[2]];
}

export function fingerTip(rig, finger, curls, abduction = 0, roll = 0) {
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
  return rollOffset(scale(matApply(rig.rotation, offset), SCALE), rig.rollSign * roll);
}

/**
 * Sample points along a posed finger, in scene units relative to the wrist.
 * Collision checks need the shaft, not just the tip. Analytic, like fingerTip,
 * so the solver can call it thousands of times without allocating a skeleton.
 */
export function fingerSamples(rig, finger, curls, abduction = 0, roll = 0) {
  const chain = CHAINS[finger];
  const axis = flexionAxis(rig, finger);
  const abduct = abduction === 0 ? null : qFromAxisAngle(rig.normal, abduction);
  const cmc = rig.worldPos.get(chain[0]);
  const mcp = rig.worldPos.get(chain[1]);
  const joints = [cmc, abduct ? add(cmc, qRotate(abduct, sub(mcp, cmc))) : mcp];
  let total = 0;
  for (let i = 0; i < rig.segments[finger].length; i++) {
    total += curls[i] ?? 0;
    let seg = qRotate(qFromAxisAngle(axis, total), rig.segments[finger][i]);
    if (abduct) seg = qRotate(abduct, seg);
    joints.push(add(joints[joints.length - 1], seg));
  }
  const wrist = rig.worldPos.get('wrist');
  const out = [];
  for (let i = 1; i < joints.length; i++) {
    const a = joints[i - 1], b = joints[i];
    for (const t of [0.35, 0.75, 1]) {
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const off = scale(matApply(rig.rotation, sub(p, wrist)), SCALE);
      out.push(rollOffset(off, rig.rollSign * roll));
    }
  }
  return out;
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
  return [keyX(midi), keyTopY(midi) + TIP_PAD, keyStrikeZ(midi)];
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
 * Place all five fingers for one chord, in anatomical order and without
 * collisions.
 *
 * Playing fingers aim at the lateral position of their key. Idle fingers take
 * a position interpolated from their playing neighbours, so the whole hand
 * fans out together instead of one finger swinging across a static one. A
 * forward and backward pass then keeps the tips in thumb-to-pinky order with a
 * minimum gap, and a relaxation pass pushes apart any shafts that still come
 * too close.
 *
 * Returns { abduction, lateral } keyed by finger number. Lateral positions are
 * scene units measured from the wrist, positive from thumb towards pinky.
 */
export function placeFingers(rig, items, roll = 0, wristX = 0) {
  const sign = rig.thumbSign;
  const lateralOf = (x) => -sign * x;
  const playing = new Map(items.map((it) => [it.finger, it]));
  const curlsOf = (f) => (playing.has(f) ? playing.get(f).curls : REST_CURLS[f]);

  // Lateral position at a given abduction, relative to the wrist. Monotonic,
  // so bisection finds the abduction for any reachable position.
  const lateralAt = (f, abduction) =>
    lateralOf(fingerTip(rig, f, curlsOf(f), abduction, roll)[0]);
  const bounds = {};
  const increasing = {};
  for (const f of FINGERS) {
    const a = lateralAt(f, -MAX_ABDUCTION), b = lateralAt(f, MAX_ABDUCTION);
    bounds[f] = { lo: Math.min(a, b), hi: Math.max(a, b) };
    increasing[f] = b > a;
  }
  const abductionFor = (f, want) => {
    const { lo, hi } = bounds[f];
    const target = Math.min(hi, Math.max(lo, want));
    let a = -MAX_ABDUCTION, b = MAX_ABDUCTION;
    for (let k = 0; k < 16; k++) {
      const mid = (a + b) / 2;
      if ((lateralAt(f, mid) < target) === increasing[f]) a = mid; else b = mid;
    }
    return (a + b) / 2;
  };

  // Rest laterals give the spacing the hand keeps when nothing plays.
  const restU = {};
  for (const f of FINGERS) restU[f] = lateralOf(fingerTip(rig, f, REST_CURLS[f], 0, roll)[0]);

  const want = {};
  for (const f of FINGERS) {
    if (playing.has(f)) {
      // The key position measured from the wrist, which is what a finger can
      // actually be aimed at.
      want[f] = lateralOf(keyContact(playing.get(f).midi)[0] - wristX);
      continue;
    }
    // Idle: keep the rest spacing relative to the nearest playing finger on
    // each side, so the fan follows the stretch instead of staying put.
    let left = null, right = null;
    for (const g of FINGERS) {
      if (!playing.has(g)) continue;
      if (g < f) left = g;
      if (g > f && right === null) right = g;
    }
    if (left !== null && right !== null) {
      const span = restU[right] - restU[left];
      const t = span === 0 ? 0.5 : (restU[f] - restU[left]) / span;
      want[f] = want[left] + (want[right] - want[left]) * t;
    } else if (left !== null) {
      want[f] = want[left] + (restU[f] - restU[left]);
    } else if (right !== null) {
      want[f] = want[right] + (restU[f] - restU[right]);
    } else {
      want[f] = restU[f];
    }
  }

  // Keep thumb-to-pinky order with a minimum gap. A playing finger is an
  // anchor: it stays on its key, and an idle neighbour yields instead. Only
  // when two playing fingers sit closer than the gap does the order give way,
  // because no hand can separate keys that close.
  const u = {};
  for (const f of FINGERS) u[f] = Math.min(Math.max(want[f], bounds[f].lo), bounds[f].hi);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < FINGERS.length; i++) {
      const f = FINGERS[i], prev = FINGERS[i - 1];
      if (u[f] >= u[prev] + MIN_TIP_GAP) continue;
      if (!playing.has(f)) u[f] = Math.min(u[prev] + MIN_TIP_GAP, bounds[f].hi);
      else if (!playing.has(prev)) u[prev] = Math.max(u[f] - MIN_TIP_GAP, bounds[prev].lo);
    }
    for (let i = FINGERS.length - 2; i >= 0; i--) {
      const f = FINGERS[i], next = FINGERS[i + 1];
      if (u[f] <= u[next] - MIN_TIP_GAP) continue;
      if (!playing.has(f)) u[f] = Math.max(u[next] - MIN_TIP_GAP, bounds[f].lo);
      else if (!playing.has(next)) u[next] = Math.min(u[f] + MIN_TIP_GAP, bounds[next].hi);
    }
  }

  const abduction = {};
  for (const f of FINGERS) abduction[f] = abductionFor(f, u[f]);

  // Relaxation: push apart shafts that still come closer than a finger width.
  for (let pass = 0; pass < 5; pass++) {
    let moved = false;
    for (let i = 0; i < FINGERS.length - 1; i++) {
      const a = FINGERS[i], b = FINGERS[i + 1];
      const pa = fingerSamples(rig, a, curlsOf(a), abduction[a], roll);
      const pb = fingerSamples(rig, b, curlsOf(b), abduction[b], roll);
      let closest = Infinity;
      for (const p of pa) for (const q of pb) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < closest) closest = d;
      }
      if (closest >= MIN_SHAFT_GAP) continue;
      // An idle finger yields; when both play they share the correction. The
      // push stops short of the next finger, so separating one pair never
      // drives a finger across its neighbour.
      const ua = lateralAt(a, abduction[a]), ub = lateralAt(b, abduction[b]);
      const roomB = b < 5 ? lateralAt(b + 1, abduction[b + 1]) - MIN_TIP_GAP - ub : Infinity;
      const roomA = a > 1 ? ua - (lateralAt(a - 1, abduction[a - 1]) + MIN_TIP_GAP) : Infinity;
      const push = (MIN_SHAFT_GAP - closest) * 0.9;
      const aIdle = !playing.has(a), bIdle = !playing.has(b);
      if (bIdle || !aIdle) {
        const step = Math.min(push, Math.max(0, roomB));
        if (step > 1e-4) { abduction[b] = abductionFor(b, ub + step); moved = true; }
      }
      if (aIdle && !bIdle) {
        const step = Math.min(push, Math.max(0, roomA));
        if (step > 1e-4) { abduction[a] = abductionFor(a, ua - step); moved = true; }
      }
    }
    if (!moved) break;
  }

  const lateral = {};
  for (const f of FINGERS) lateral[f] = lateralAt(f, abduction[f]);
  return { abduction, lateral };
}

/**
 * Solve the wrist position, the palm roll, and the placement of all five
 * fingers, so every playing fingertip meets its own key.
 *
 * Three placements, three anatomical limits:
 *   - sideways, the wrist slides into the range where every finger can still
 *     reach its key, and the fingers fan out in thumb-to-pinky order;
 *   - in depth, each key offers a range rather than a point, because the thumb
 *     reaches less far forward than the fingers;
 *   - in height, each finger trims its own curl so its tip lands on its key,
 *     which a single wrist height cannot do across white and black keys.
 *
 * When the thumb still misses, the palm pronates: a small roll about the
 * forward axis dips the thumb side. The smallest roll that helps wins.
 *
 * @param {object} rig
 * @param {Array<{finger: number, midi: number, curls?: number[]}>} notes
 * @returns {{wrist: number[], tips: number[][], residuals: number[], maxResidual: number, abductions: number[], spread: object, curls: object, roll: number}}
 *   tips are absolute scene positions; residuals are millimetres of miss.
 */
export function solveContact(rig, notes) {
  const items = notes.map((note) => {
    const rest = REST_CURLS[note.finger];
    // Default to the strike pose, so the curl trim has a delta to work with.
    const curls = note.curls || rest.map((v, i) => v + STRIKE_CURLS[note.finger][i]);
    return {
      finger: note.finger,
      midi: note.midi,
      curls: curls.slice(),
      delta: curls.map((v, i) => v - rest[i]),
    };
  });
  if (!items.length) {
    const spread = placeFingers(rig, [], 0, 0);
    return { wrist: [0, 0, 0], tips: [], residuals: [], maxResidual: 0,
             abductions: [], spread: spread.abduction, curls: {}, roll: 0 };
  }

  const targets = items.map((it) => keyContact(it.midi));
  const ranges = items.map((it) => keyStrikeRange(it.midi));
  const topY = Math.max(...items.map((it) => keyTopY(it.midi)));
  const restOffsets = items.map((it) => fingerTip(rig, it.finger, it.curls, 0, 0));
  const thumbIndex = items.findIndex((it) => it.finger === 1);
  const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;

  // Trim one finger's curl until its tip sits at the given height. More curl
  // lowers the tip, so bisection on the strike delta finds the pose. The delta
  // stays bounded: past the fold a fingertip curls back up toward the palm,
  // and bisection would pick the wrong branch.
  const trimToHeight = (it, abduction, roll, wristY, wantY) => {
    const rest = REST_CURLS[it.finger];
    const at = (s) => wristY + fingerTip(
      rig, it.finger, rest.map((v, i) => v + s * it.delta[i]), abduction, roll)[1];
    let lo = 0.2, hi = 1.9;
    if (at(lo) <= wantY) return rest.map((v, i) => v + lo * it.delta[i]);
    if (at(hi) >= wantY) return rest.map((v, i) => v + hi * it.delta[i]);
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (at(mid) > wantY) lo = mid; else hi = mid;
    }
    const s = (lo + hi) / 2;
    return rest.map((v, i) => v + s * it.delta[i]);
  };

  const evaluate = (roll) => {
    let wrist = [0, 1, 2].map((axis) =>
      mean(targets.map((t, i) => t[axis] - restOffsets[i][axis])));
    let spread, offsets;
    const idleCurls = {};

    for (let pass = 0; pass < 2; pass++) {
      spread = placeFingers(rig, items, roll, wrist[0]);
      offsets = items.map((it) =>
        fingerTip(rig, it.finger, it.curls, spread.abduction[it.finger], roll));

      // Sideways: the range of wrist positions where every finger reaches.
      let xLo = -Infinity, xHi = Infinity;
      const xRanges = [];
      for (let i = 0; i < items.length; i++) {
        const a = fingerTip(rig, items[i].finger, items[i].curls, -MAX_ABDUCTION, roll)[0];
        const b = fingerTip(rig, items[i].finger, items[i].curls, MAX_ABDUCTION, roll)[0];
        const rlo = targets[i][0] - Math.max(a, b);
        const rhi = targets[i][0] - Math.min(a, b);
        xRanges.push([rlo, rhi]);
        xLo = Math.max(xLo, rlo);
        xHi = Math.min(xHi, rhi);
      }
      wrist[0] = mean(targets.map((t, i) => t[0] - offsets[i][0]));
      if (xLo <= xHi) {
        wrist[0] = Math.min(xHi, Math.max(xLo, wrist[0]));
      } else {
        const miss = (x) => xRanges.reduce((sum, [a, b]) => {
          const d = x < a ? a - x : x > b ? x - b : 0;
          return sum + d * d;
        }, 0);
        let a = Math.min(...xRanges.map((r) => r[0]));
        let b = Math.max(...xRanges.map((r) => r[1]));
        for (let k = 0; k < 20; k++) {
          const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
          if (miss(m1) <= miss(m2)) b = m2; else a = m1;
        }
        wrist[0] = (a + b) / 2;
      }

      // Depth: every tip stays on its key's surface, which spans a range.
      let zLo = -Infinity, zHi = Infinity;
      for (let i = 0; i < items.length; i++) {
        zLo = Math.max(zLo, ranges[i][0] - offsets[i][2]);
        zHi = Math.min(zHi, ranges[i][1] - offsets[i][2]);
      }
      const zMean = mean(targets.map((t, i) => t[2] - offsets[i][2]));
      wrist[2] = zLo <= zHi ? Math.min(zHi, Math.max(zLo, zMean)) : (zLo + zHi) / 2;

      // Height: the wrist clears the highest key of the chord, and every
      // resting finger hovers above the keys instead of poking through them.
      wrist[1] = Math.max(
        mean(targets.map((t, i) => t[1] - offsets[i][1])),
        topY + MIN_WRIST_HEIGHT);
      // Resting fingers straighten to hover above the keys. Lifting the whole
      // wrist instead would pull the playing fingers off their own keys, so
      // contact wins: a finger that cannot straighten clear stays as high as
      // it can.
      for (const f of FINGERS) {
        if (items.some((it) => it.finger === f)) continue;
        const rest = REST_CURLS[f];
        const at = (s) => wrist[1] + fingerTip(
          rig, f, rest.map((v) => v * s), spread.abduction[f], roll)[1];
        const restTip = fingerTip(rig, f, rest, spread.abduction[f], roll);
        const under = keyTopAtX(wrist[0] + restTip[0], wrist[2] + restTip[2]);
        const want = under + IDLE_HOVER;
        if (at(0) <= want) {
          idleCurls[f] = rest.map(() => 0);
        } else if (at(1) >= want) {
          idleCurls[f] = rest.slice();
        } else {
          let lo = 0, hi = 1;
          for (let k = 0; k < 12; k++) {
            const mid = (lo + hi) / 2;
            if (at(mid) > want) lo = mid; else hi = mid;
          }
          const s = (lo + hi) / 2;
          idleCurls[f] = rest.map((v) => v * s);
        }
      }

      // Each finger then trims its own curl onto its own key.
      for (let i = 0; i < items.length; i++) {
        items[i].curls = trimToHeight(
          items[i], spread.abduction[items[i].finger], roll, wrist[1], targets[i][1]);
      }
      offsets = items.map((it) =>
        fingerTip(rig, it.finger, it.curls, spread.abduction[it.finger], roll));
    }

    let error = 0;
    const residuals = offsets.map((off, i) => {
      const dx = wrist[0] + off[0] - targets[i][0];
      const dy = wrist[1] + off[1] - targets[i][1];
      const z = wrist[2] + off[2];
      // Depth only counts as a miss once the tip leaves the key's surface.
      const dz = z < ranges[i][0] ? ranges[i][0] - z : z > ranges[i][1] ? z - ranges[i][1] : 0;
      error += dx * dx + dy * dy + dz * dz;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) * 23.5;
    });
    const curlsNow = {};
    for (const it of items) curlsNow[it.finger] = it.curls.slice();
    const idleNow = {};
    for (const f of FINGERS) idleNow[f] = (idleCurls[f] || REST_CURLS[f]).slice();
    return { score: error + ROLL_PENALTY * roll * roll, wrist, offsets, roll, spread, residuals,
             curls: curlsNow, idleCurls: idleNow };
  };

  let best = evaluate(0);
  // Pronation only earns its keep when the thumb still misses its key.
  if (thumbIndex >= 0 && best.residuals[thumbIndex] > ROLL_TRIGGER_MM) {
    for (const roll of ROLL_STEPS) {
      if (roll === 0) continue;
      const candidate = evaluate(roll);
      if (candidate.score < best.score) best = candidate;
    }
  }

  const { wrist, roll, spread, curls, idleCurls } = best;

  // A resting finger that cannot straighten clear of the keys lifts the wrist,
  // but only as far as the playing fingers can curl back onto their own keys:
  // contact is the hard requirement, hover is the soft one.
  const retrim = () => {
    for (let i = 0; i < items.length; i++) {
      items[i].curls = trimToHeight(
        items[i], spread.abduction[items[i].finger], roll, wrist[1], targets[i][1]);
      curls[items[i].finger] = items[i].curls.slice();
    }
  };
  const tipOf = (i) => fingerTip(
    rig, items[i].finger, items[i].curls, spread.abduction[items[i].finger], roll);
  const missOf = (i, off) => {
    const dx = wrist[0] + off[0] - targets[i][0];
    const dy = wrist[1] + off[1] - targets[i][1];
    const z = wrist[2] + off[2];
    const dz = z < ranges[i][0] ? ranges[i][0] - z : z > ranges[i][1] ? z - ranges[i][1] : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * 23.5;
  };
  const settleIdle = () => {
    let deficit = 0;
    for (const f of FINGERS) {
      if (items.some((it) => it.finger === f)) continue;
      const rest = REST_CURLS[f];
      const at = (s) => wrist[1] + fingerTip(
        rig, f, rest.map((v) => v * s), spread.abduction[f], roll)[1];
      const straight = fingerTip(rig, f, rest.map(() => 0), spread.abduction[f], roll);
      const under = keyTopAtX(wrist[0] + straight[0], wrist[2] + straight[2]);
      const want = under + IDLE_HOVER;
      deficit = Math.max(deficit, want - at(0));
      if (at(0) <= want) idleCurls[f] = rest.map(() => 0);
      else if (at(1) >= want) idleCurls[f] = rest.slice();
      else {
        let lo = 0, hi = 1;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2;
          if (at(mid) > want) lo = mid; else hi = mid;
        }
        idleCurls[f] = rest.map((v) => v * ((lo + hi) / 2));
      }
    }
    return deficit;
  };

  const deficit = settleIdle();
  if (deficit > 0) {
    const baseY = wrist[1];
    let lo = 0, hi = deficit;
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2;
      wrist[1] = baseY + mid;
      retrim();
      if (Math.max(...items.map((_, i) => missOf(i, tipOf(i)))) <= 0.5) lo = mid; else hi = mid;
    }
    wrist[1] = baseY + lo;
    retrim();
    settleIdle();
  }

  const offsets = items.map((_, i) => tipOf(i));
  const residuals = items.map((_, i) => missOf(i, offsets[i]));
  return {
    wrist,
    tips: offsets.map((tip) => add(wrist, tip)),
    residuals,
    maxResidual: Math.max(...residuals),
    abductions: items.map((it) => spread.abduction[it.finger]),
    spread: spread.abduction,
    curls,
    idleCurls,
    roll,
  };
}

/** Extra curl at each joint when a finger strikes, in radians past rest. */
export const STRIKE_CURLS = {
  1: [0.25, 0.30],
  2: [0.08, 0.12, 0.10],
  3: [0.08, 0.12, 0.10],
  4: [0.08, 0.12, 0.10],
  5: [0.07, 0.10, 0.09],
};

/** The curl set a finger holds while it strikes its key. */
export function strikeCurls(finger) {
  return REST_CURLS[finger].map((v, i) => v + STRIKE_CURLS[finger][i]);
}

/**
 * The range of wrist positions where every note of an assignment stays within
 * sideways reach. A positive gap means the hand cannot span the chord with
 * those fingers, whatever the wrist does.
 *
 * @param {number[]} midis pitch-ordered notes of one chord
 * @param {number[]} fingers one finger per note, in the same order
 */
export function reachRange(rig, midis, fingers) {
  let lo = -Infinity, hi = Infinity;
  for (let i = 0; i < midis.length; i++) {
    const f = fingers[i];
    const curls = strikeCurls(f);
    const a = fingerTip(rig, f, curls, -MAX_ABDUCTION, 0)[0];
    const b = fingerTip(rig, f, curls, MAX_ABDUCTION, 0)[0];
    const kx = keyContact(midis[i])[0];
    lo = Math.max(lo, kx - Math.max(a, b));
    hi = Math.min(hi, kx - Math.min(a, b));
  }
  return { lo, hi, gap: Math.max(0, lo - hi) };
}

/**
 * Keep the musical fingering unless the rig cannot reach the keys with it.
 * A wide chord given consecutive fingers leaves the thumb hanging in the air;
 * spreading the same notes over a wider finger set brings it back down.
 *
 * @param {number[]} midis pitch-ordered notes of one chord
 * @param {'L'|'R'} hand
 * @param {number[]} current the fingering the beam search chose
 * @returns {number[]} the fingers to use, in note order
 */
export function chooseFingers(rig, midis, hand, current) {
  const n = midis.length;
  if (n < 2 || n > 5) return current;
  const here = reachRange(rig, midis, current);
  if (here.gap <= 0) return current;

  const orders = [];
  const rec = (start, cur) => {
    if (cur.length === n) {
      orders.push(hand === 'R' ? [...cur] : [...cur].reverse());
      return;
    }
    for (let i = start; i < 5; i++) { cur.push(i + 1); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);

  let best = { fingers: current, gap: here.gap };
  for (const fingers of orders) {
    const r = reachRange(rig, midis, fingers);
    if (r.gap < best.gap - 1e-6) best = { fingers, gap: r.gap };
    if (best.gap <= 0) break;
  }
  return best.fingers;
}
