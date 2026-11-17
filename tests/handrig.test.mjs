// Rig math tests. Run: node --test tests/handrig.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  JOINT_NAMES, CHAINS, REST_CURLS, SCALE, SPREAD_UNIT, MAX_ABDUCTION,
  buildRig, applyCalibration, fingerTip, solveContact, poseChain,
  segmentLengths, metacarpalSpacing, flexionAxis, keyContact,
  qMul, qFromAxisAngle,
} from '../src/handrig.js';

const fixtureDir = path.join(import.meta.dirname, 'fixtures');
const load = (side) =>
  buildRig(JSON.parse(fs.readFileSync(path.join(fixtureDir, `hand-${side}.json`), 'utf8')));

const right = load('right');
const left = load('left');

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} +/- ${tol}, got ${a}`);
const qDist = (a, b) =>
  Math.min(
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]),
    Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]),
  );

test('fixture carries the WebXR 25-joint skeleton', () => {
  for (const rig of [right, left]) {
    assert.equal(rig.joints.length, 25);
    for (const name of JOINT_NAMES) {
      assert.ok(rig.byName.has(name), `missing ${name}`);
      assert.ok(rig.worldPos.has(name), `no world position for ${name}`);
    }
    assert.equal(right.segments[3].length, 3, 'a finger has three phalanx segments');
    assert.equal(right.segments[1].length, 2, 'a thumb has two phalanges after the metacarpal');
  }
});

test('calibration maps the bind pose into scene axes', () => {
  for (const [label, rig] of [['right', right], ['left', left]]) {
    const f = applyCalibration(rig, rig.forward);
    const n = applyCalibration(rig, rig.normal);
    assert.ok(Math.abs(f[0]) < 1e-6 && Math.abs(f[1]) < 1e-6, `${label}: forward has no lateral lean`);
    near(f[2], -1, 1e-6, `${label}: forward points at -Z`);
    assert.ok(Math.abs(n[0]) < 1e-6, `${label}: palm normal has no lateral lean`);
    near(n[1], -1, 1e-6, `${label}: palm normal points down`);

    // The rotation must be proper, not a mirror.
    const det =
      rig.rotation[0] * (rig.rotation[4] * rig.rotation[8] - rig.rotation[5] * rig.rotation[7]) -
      rig.rotation[1] * (rig.rotation[3] * rig.rotation[8] - rig.rotation[5] * rig.rotation[6]) +
      rig.rotation[2] * (rig.rotation[3] * rig.rotation[7] - rig.rotation[4] * rig.rotation[6]);
    near(det, 1, 1e-6, `${label}: calibration determinant`);
  }
});

test('rig proportions match the measured reference hand', () => {
  const middle = segmentLengths(right, 3);
  near(middle[0], 46.9, 2.4, 'proximal phalanx mm');
  near(middle[1], 27.5, 1.4, 'intermediate phalanx mm');
  near(middle[2], 12.2, 0.7, 'distal phalanx mm');

  // The thumb is short, the pinky is shorter than the middle finger.
  const pinky = segmentLengths(right, 5);
  assert.ok(pinky[0] < middle[0], 'pinky proximal is shorter than the middle proximal');
});

test('a curl moves the fingertip toward the palm', () => {
  const flat = fingerTip(right, 3, [0, 0, 0]);
  const curled = fingerTip(right, 3, REST_CURLS[3]);

  const dropMm = (flat[1] - curled[1]) * 23.5;
  assert.ok(dropMm > 10, `tip drops toward the palm by ${dropMm.toFixed(1)} mm`);

  const toWrist = (p) => Math.hypot(p[0], p[1], p[2]);
  assert.ok(toWrist(curled) < toWrist(flat), 'curled finger is closer to the wrist');
});

test('a single note solves to the key surface', () => {
  const chord = [{ finger: 3, midi: 60 }];
  const { residuals, wrist, maxResidual } = solveContact(right, chord);

  assert.ok(Number.isFinite(maxResidual));
  assert.ok(maxResidual < 0.5, `single-note residual ${maxResidual.toFixed(3)} mm`);

  const target = keyContact(60);
  near(wrist[0], target[0], 0.5, 'wrist x tracks the key');
  assert.ok(wrist[1] > 1, `wrist sits above the keys (y=${wrist[1].toFixed(2)})`);
  assert.ok(residuals.every((r) => Number.isFinite(r)));
});

test('a triad reports bounded residuals and stays finite', () => {
  const chord = [
    { finger: 2, midi: 60 },
    { finger: 3, midi: 64 },
    { finger: 5, midi: 67 },
  ];
  const { residuals, abductions, wrist, maxResidual } = solveContact(right, chord);

  assert.equal(residuals.length, 3);
  assert.ok(residuals.every((r) => Number.isFinite(r) && r >= 0));
  assert.ok(maxResidual < 25, `triad residual ${maxResidual.toFixed(1)} mm`);
  for (const a of abductions) {
    assert.ok(Math.abs(a) <= MAX_ABDUCTION + 1e-9, 'abduction stays inside the limit');
  }
  assert.ok(wrist[1] > 1 && wrist[1] < 4, 'wrist height is plausible');
});

test('poseChain reproduces the accumulated rotation and the fingertip', () => {
  const curls = [0.4, 0.5, 0.2];
  const abduction = 0.12;
  const { bones, tip } = poseChain(right, 3, curls, abduction);

  assert.equal(bones.length, 5, 'metacarpal, three phalanx bones, and the tip');

  const axis = flexionAxis(right, 3);
  const abduct = qFromAxisAngle(right.normal, abduction);
  let rotation = abduct;
  let total = 0;

  bones.forEach((bone, i) => {
    near(Math.hypot(...bone.world), 1, 1e-9, `${bone.name} world quaternion length`);
    near(Math.hypot(...bone.localQuaternion), 1, 1e-9, `${bone.name} local quaternion length`);

    const expected = qMul(rotation, right.worldQuat.get(bone.name));
    assert.ok(qDist(bone.world, expected) < 1e-9, `${bone.name} world rotation matches`);

    // Joints in this asset hang off the armature, so local equals absolute.
    assert.ok(qDist(bone.localQuaternion, bone.world) < 1e-9, `${bone.name} local equals world`);

    // The bone at each joint carries the curl applied before it, so the last
    // bone (the tip leaf) repeats the distal rotation.
    if (i < curls.length) {
      total += curls[i];
      rotation = qMul(abduct, qFromAxisAngle(axis, total));
    }
  });

  // The chain's tip must agree with fingerTip, which solves the same pose.
  const wristModel = right.worldPos.get('wrist');
  const offset = [tip[0] - wristModel[0], tip[1] - wristModel[1], tip[2] - wristModel[2]];
  const calibrated = applyCalibration(right, offset).map((v) => v * SCALE);
  const direct = fingerTip(right, 3, curls, abduction);
  near(Math.hypot(...direct.map((v, i) => v - calibrated[i])), 0, 1e-9, 'tip agrees with fingerTip');
});

test('zero curls leave every bone at rest', () => {
  const { bones } = poseChain(right, 2, [0, 0, 0], 0);
  for (const bone of bones) {
    assert.ok(qDist(bone.world, right.worldQuat.get(bone.name)) < 1e-9, `${bone.name} keeps its bind rotation`);
    const restPos = right.worldPos.get(bone.name);
    near(
      Math.hypot(...bone.position.map((v, i) => v - restPos[i])),
      0,
      1e-9,
      `${bone.name} keeps its bind position`,
    );
  }
});

test('metacarpal spacing matches the spread unit', () => {
  const spacing = metacarpalSpacing(right);
  assert.equal(spacing.length, 3);
  for (const gap of spacing) {
    assert.ok(gap > 15 && gap < 24, `MCP gap ${gap} mm sits inside a hand's range`);
  }
  const mean = spacing.reduce((a, b) => a + b, 0) / spacing.length;
  near(mean, SPREAD_UNIT * 23.5, 2.0, 'mean gap matches SPREAD_UNIT');
  assert.ok(SCALE > 40 && SCALE < 45, 'metres to scene units');
});

test('flexion axes are perpendicular to their fingers', () => {
  for (const finger of [1, 2, 3, 4, 5]) {
    const axis = flexionAxis(right, finger);
    const chain = CHAINS[finger];
    const tip = right.worldPos.get(chain[chain.length - 1]);
    const base = right.worldPos.get(chain[0]);
    const dir = [tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]];
    const dot = axis[0] * dir[0] + axis[1] * dir[1] + axis[2] * dir[2];
    assert.ok(Math.abs(dot) < 1e-6, `finger ${finger} axis is perpendicular (${dot})`);
    near(Math.hypot(...axis), 1, 1e-9, 'axis is a unit vector');
  }
});

test('the left hand solves as well as the right', () => {
  const { maxResidual } = solveContact(left, [{ finger: 3, midi: 60 }]);
  assert.ok(maxResidual < 0.5, `left-hand single note ${maxResidual.toFixed(3)} mm`);
});

test('no rig output is NaN', () => {
  const { residuals, abductions } = solveContact(left, [
    { finger: 1, midi: 55 },
    { finger: 5, midi: 72 },
  ]);
  for (const value of [...residuals, ...abductions]) {
    assert.ok(Number.isFinite(value), `finite value expected, got ${value}`);
  }
  const { bones } = poseChain(right, 1, REST_CURLS[1], 0.1);
  for (const bone of bones) {
    assert.ok([...bone.world, ...bone.position].every(Number.isFinite), `${bone.name} is finite`);
  }
});

test('a pose built from the solve lands on the solved tips', () => {
  const chord = [
    { finger: 2, midi: 64 },
    { finger: 3, midi: 67 },
  ];
  const curlsFor = (finger) => REST_CURLS[finger].map((v) => v + 0.08);
  const solved = solveContact(
    right,
    chord.map((n) => ({ ...n, curls: curlsFor(n.finger) })),
  );
  const wristModel = right.worldPos.get('wrist');

  chord.forEach((note, i) => {
    const { tip } = poseChain(right, note.finger, curlsFor(note.finger), solved.abductions[i]);
    const offset = applyCalibration(right, [
      tip[0] - wristModel[0],
      tip[1] - wristModel[1],
      tip[2] - wristModel[2],
    ]).map((v) => v * SCALE);
    const expected = solved.tips[i];
    const actual = [solved.wrist[0] + offset[0], solved.wrist[1] + offset[1], solved.wrist[2] + offset[2]];
    const gapMm = Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2]) * 23.5;
    assert.ok(gapMm < 0.05, `finger ${note.finger} pose matches the solve (${gapMm.toFixed(3)} mm)`);
  });
});
