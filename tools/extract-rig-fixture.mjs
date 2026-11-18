// Regenerate the hand rig fixtures from the GLB files in public/hands/.
// Usage: node tools/extract-rig-fixture.mjs
// Output: tests/fixtures/hand-right.json, tests/fixtures/hand-left.json
//
// The fixture holds only what the pure rig math needs: each joint's name,
// parent, local translation, and local rotation. No mesh data, no Three.js.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  let offset = 12;
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      return JSON.parse(buf.subarray(start, start + len).toString('utf8'));
    }
    offset = start + len;
  }
  throw new Error(`${file} has no JSON chunk`);
}

function round(n) {
  return Math.round(n * 1e7) / 1e7;
}

function extract(glbPath) {
  const gltf = readGlbJson(glbPath);
  const nodes = gltf.nodes || [];
  const parentOf = new Map();
  nodes.forEach((node, index) => {
    for (const child of node.children || []) parentOf.set(child, index);
  });
  const skin = gltf.skins?.[0];
  if (!skin) throw new Error(`${glbPath} has no skin`);
  const joints = skin.joints.map((index) => {
    const node = nodes[index];
    const parent = parentOf.get(index);
    return {
      name: node.name,
      parent: parent === undefined ? null : nodes[parent].name,
      translation: (node.translation || [0, 0, 0]).map(round),
      rotation: (node.rotation || [0, 0, 0, 1]).map(round),
    };
  });
  const mesh = gltf.meshes?.[0]?.primitives?.[0];
  const position = mesh ? gltf.accessors?.[mesh.attributes.POSITION] : null;
  return {
    source: path.basename(glbPath),
    generator: gltf.asset?.generator || null,
    vertexCount: position?.count ?? null,
    boundsMm: position
      ? position.min.map((min, i) => Math.round((position.max[i] - min) * 1000))
      : null,
    units: 'metres',
    joints,
  };
}

const outDir = path.join(ROOT, 'tests', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

for (const [side, file] of [['right', 'right.glb'], ['left', 'left.glb']]) {
  const data = extract(path.join(ROOT, 'public', 'hands', file));
  const out = path.join(outDir, `hand-${side}.json`);
  fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${side}: ${data.joints.length} joints -> ${path.relative(ROOT, out)}`);
}