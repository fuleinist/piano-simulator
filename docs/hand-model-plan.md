# Realistic Hand Model: Research and Optimisation Plan

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task by task.

**Goal:** Replace the procedural block hands in `src/hands.js` with a rigged human hand. The close-up view and recorded video must read as a person playing, not as mannequins.

**Architecture:** Keep the pure logic pure. A new `src/handrig.js` holds all joint math and imports nothing from Three.js. `src/hands.js` loads one GLB per side, clones it, calibrates the bind pose, and poses bones each frame. Motion stays a spring plus a curl envelope. Realism comes from pose, material, and light. Polygon count is not the lever at this scale.

**Tech Stack:** Three.js 0.187, `GLTFLoader` and `SkeletonUtils` addons, Vite 7, Node 26 test runner, Blender 5.2 for optional asset work.

---

## 1. Current state, measured

All numbers below come from `src/hands.js`, `src/layout.js`, and `src/piano.js`. Lengths use 1 unit = 23.5 mm, the white-key width.

| Aspect | Current build | Reference | Gap |
|---|---|---|---|
| Finger geometry | Capsules plus knuckle spheres | One skinned mesh | Visible seams, flat tips |
| Proximal phalanx (middle finger) | 35.2 mm | 46.9 mm | 25% short |
| MCP to fingertip (middle finger) | 75.6 mm | 86.5 mm | 13% short |
| Palm heel to fingertip | about 158 mm | 193 mm (US adult male mean) | 18% short |
| Knuckle line | One rounded box ridge | Four metacarpal bones | No arch, no per-finger lift |
| Joint count per finger | 3 | 4 (metacarpal, proximal, intermediate, distal) | No knuckle rotation |
| Thumb | 2 segments, aim by slerp | 3 segments plus tip | No abduction control |
| Mesh objects per hand | about 40 | 1 | 40 shadow-pass draws per hand |
| Material | One `MeshPhysicalMaterial` | Albedo, normal, roughness, thin-skin term | Plastic skin |
| Rest curl | 12.6° / 19.5° / 11.5° | Rounded knuckle, about 25–40° at the MCP | Flat, claw-like |

Two behaviours add to the CG look:

1. Fingers spread by sliding sideways (`finger.mcp.position.x = baseX * spread`). A real hand spreads by rotating the metacarpals.
2. The code fixes the fingertip height at chord time. It does not follow the key dip, which is `PRESS_ANGLE = 0.05` rad in `src/piano.js`.

## 2. Research: five candidate hand models

Each candidate is a skinned hand on the WebXR 25-joint skeleton. That skeleton gives one bone per phalanx, plus a metacarpal per finger. The metacarpal is what makes a knuckle arch possible.

I measured the numbers below from the downloaded assets, not from documentation. The SHA-256 values match the values the publisher lists.

| Model | Licence | Tris | Joints | Metacarpals | Texture | Bind pose (bounding box, mm) |
|---|---|---|---|---|---|---|
| WebXR `generic-hand` (Amazon) | MIT | 2,314 | 25 | thumb + 4 fingers | none | 77 × 212 × 146, fingers along −Y |
| Babylon.js hand meshes (Patrick Ryan) | CC BY 4.0 | 1,808 | 26 | thumb + 4 fingers | gradient baseColor only | 148 × 190 × 90, fingers along +Y |
| Godot XR Tools hands (Miodrag Sejic) | CC0 1.0 | 3,052 | 26 | thumb + 4 fingers | none after conversion | 68 × 159 × 212, fingers along −Z |
| MRTK3 OpenXR hand (Microsoft) | BSD-3-Clause | 2,794 | 24 | thumb + 4 fingers | none | 134 × 79 × 212 |
| MRTK2 rigged hand (Microsoft) | MIT | 2,664 | 22 | none, wrist padding only | none | 209 × 77 × 146 |

### Per-model notes

**WebXR `generic-hand`.** Source: `immersive-web/webxr-input-profiles`, `packages/assets/profiles/generic-hand/`. Meta contributed it. Three.js already points at it: `XRHandMeshModel` loads `${path}${handedness}.glb` from a jsDelivr copy of this package. The bone names match the joint list inside `three/addons/webxr/XRHandMeshModel.js` exactly. SHA-256 of `right.glb`: `291790c1…f1bc1f2b96`. Size 94 KB.

**Babylon.js hands.** Source: `BabylonJS/Assets`, `core/HandMeshes/r_hand_rhs.glb`. CC BY 4.0 needs an attribution line in the UI or the README. The baseColor texture is a gradient ramp, not skin. Joint names use the `index_proxPhalanx_R` form, so the name map needs a translation table.

**Godot XR Tools.** Source: `GodotVR/godot-xr-tools`, `addons/godot-xr-tools/hands/model/hand_r.gltf`. CC0, so attribution is optional. It has the densest mesh and an extra `Palm_R` bone. Its wrist runs longer than the others, so part of the mesh must sit inside the sleeve or the cuff.

**MRTK3.** Source: `MixedRealityToolkit-Unity`, `org.mixedrealitytoolkit.input/Visualizers/RiggedHandVisualizer/openxr_hand.fbx`. Ships only as FBX, so it needs an Assimp or Blender conversion before the browser can load it. Joint names follow the OpenXR form, which is offset by one bone from the WebXR form.

**MRTK2.** Source: `microsoft/MixedRealityToolkit-Unity`, `Assets/MRTK/SDK/Features/UX/Prefabs/RiggedHandVisualizer/R_Hand_MRTK_Rig.fbx`. No metacarpal joints at all, so the knuckle arch cannot be posed. Excluded for that reason alone.

### Rejected options

| Option | Reason |
|---|---|
| MANO / SMPL-H | Non-commercial licence, no redistribution |
| Meta's older WebXR hand samples | Licence unclear outside the profiles package |
| Ultraleap `GenericHand` | Apache-2.0, but left hand only, 4,350 tris, faceted |
| Shadow Hand | Robot hand, 51k tris, non-human proportions |
| Sketchfab scans | Login wall, mixed licences |

### Scoring

Scores are 1 (worst) to 5 (best) for this project.

| Model | Licence safety | Pose fidelity | Silhouette | Close-up headroom | Integration effort | Total |
|---|---|---|---|---|---|---|
| `generic-hand` | 5 | 4 | 3 | 3 | 5 | 20 |
| Godot XR Tools | 5 | 4 | 4 | 3 | 3 | 19 |
| Babylon.js | 4 | 4 | 3 | 3 | 3 | 17 |
| MRTK3 | 5 | 3 | 3 | 3 | 2 | 16 |
| MRTK2 | 5 | 2 | 3 | 2 | 3 | 15 |

## 3. Decision

**Use WebXR `generic-hand` as the first rig.** Then treat the mesh as a swappable asset.

Reasons:

1. MIT licence. Safe for a public repo and for recorded video.
2. 25 joints with metacarpals, so the knuckle arch is real.
3. Three.js ships the loader and the exact joint-name list, so the integration path is already proven.
4. 94 KB per hand, 2,314 triangles. The runtime cost is negligible.
5. Its bind pose is measurable and stable, so the calibration in Phase B is verifiable.

**Do not hard-code Euler angles for a model.** Measure the bind pose instead. Phase B builds an orthonormal basis from the wrist, the index MCP, and the pinky MCP. The same code then works for all five candidates. Mesh choice becomes one config value in `src/hands.js`.

**Keep the procedural hand.** Move it to `src/handprocedural.js` and load it with `?hands=procedural`. It is the fallback when the GLB fails to load, and it is the reference for the A/B screenshot.

### Why realism will not come from the mesh

2,314 triangles cover about 425 cm² of skin, so each triangle carries about 18 mm². The silhouette is smooth enough at the `close` camera preset. Faceting appears only in a tight crop at 4K. Phase E adds maps and a lighting term. Phase F lists the optional high-poly path, which costs asset work in Blender.

## 4. Acceptance criteria

A task is not complete until these hold. Each one is testable.

| ID | Criterion | Test |
|---|---|---|
| A1 | A single-note fingertip lands within 0.5 mm of its key top | `tests/handrig.test.mjs` |
| A1b | A chord reports per-finger residuals, and every value stays finite | `tests/handrig.test.mjs` |
| A2 | No fingertip drops more than 1 mm below a key top during a full piece | `tests/handrig.test.mjs` |
| A3 | Rig proportions match the reference within 5% per segment | `tests/handrig.test.mjs` |
| A4 | Calibration maps the reference fingertip to scene −Z within 2° | `tests/handrig.test.mjs` |
| A5 | No NaN or zero-length quaternion reaches the skeleton | `tests/handrig.test.mjs` |
| A6 | All 15 bundled MIDIs still pass the smoke test | `npm test` |
| A7 | Production build succeeds | `npm run build` |
| A8 | The close preset renders 60 fps at 1440p on the RTX 3090 class machine | Manual, `?stats=1` overlay |
| A9 | Licence and provenance are in the repo | `public/hands/LICENSE`, `docs/hands-assets.md` |

## 5. Phase A — Asset intake

### Task A1: Add the asset and its licence

**Objective:** Put the chosen GLB in `public/` with provenance.

**Files:**
- Create: `public/hands/left.glb`
- Create: `public/hands/right.glb`
- Create: `public/hands/LICENSE`
- Create: `docs/hands-assets.md`

**Steps:**

1. Download `left.glb` and `right.glb` from `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/`.
2. Record the SHA-256 of `right.glb`: `291790c14f7f88a7f9bd35330c47392ed8e8d395ae6728f4bb7089f1bc1f2b96`.
3. Copy the MIT text from `webxr-input-profiles/packages/assets/LICENSE.md` into `public/hands/LICENSE`.
4. Write `docs/hands-assets.md` with source URL, package version, SHA-256 per file, and the attribution line.

**Verify:** `ls -l public/hands` shows two files of about 94 KB each. `sha256sum` matches the digest in step 2.

### Task A2: Record the licence in the README

**Objective:** A reader can find the asset licence without opening `docs/`.

**Files:**
- Modify: `README.md` (section `Assets and sources`)

**Steps:**

1. Add one bullet under `Assets and sources`.

```
- Hand meshes: `public/hands/`, the `generic-hand` profile of the WebXR Input Profiles, MIT licence, copyright 2019 Amazon. See `docs/hands-assets.md`.
```

**Verify:** `grep -n "generic-hand" README.md` returns one line.

## 6. Phase B — Rig math (pure module)

### Task B1: Define the joint names and finger chains

**Objective:** One table that maps engine fingers to rig bones.

**Files:**
- Create: `src/handrig.js`
- Create: `tests/handrig.test.mjs`

**Steps:**

1. Export a frozen `JOINTS` list in WebXR order.
2. Export `CHAINS`, which maps engine finger numbers 1–5 to bone names. Include the `tip` leaf.

```js
export const CHAINS = {
  1: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  2: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  3: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  4: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  5: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};
```

3. Assert in the test that the engine uses fingers 1–5 and that each chain starts with a metacarpal.

**Verify:** `node --test tests/handrig.test.mjs` passes with 1 test.

### Task B2: Calibrate the bind pose

**Objective:** Turn a loaded skeleton into a basis that fits the scene axes.

**Files:**
- Modify: `src/handrig.js`
- Modify: `tests/handrig.test.mjs`

**Steps:**

1. Accept a plain object of bind data: name, local position, local quaternion, parent name. This keeps the module free of Three.js types.
2. Compute world positions with forward kinematics.
3. Build three axes:
   - `forward` = normalize(middle tip − wrist).
   - `lateral` = normalize(pinky MCP − index MCP).
   - `normal` = normalize(cross(forward, lateral)). Flip the sign when the thumb tip sits on the other side.
4. Return the basis plus a quaternion that maps the model into scene space: fingers to −Z, lateral to +X, normal to +Y.

Measured on `generic-hand`, this basis is `forward ≈ (0, −1, 0)` and `normal ≈ (−1, 0, 0)`. Do not assume those numbers. Compute them.

**Verify:** A test loads the bind data fixture and asserts that the mapped forward axis is within 2° of −Z (criterion A4).

### Task B3: Turn a curl angle into a bone quaternion

**Objective:** Pose any bone by its joint angle, in model space, without per-model tuning.

**Files:**
- Modify: `src/handrig.js`

**Steps:**

1. Compute one flexion axis per finger: `normalize(cross(fingerDir, palmNormal))`.
2. Apply the rotation about the joint origin, then convert back to local space:

```js
// qParent is the parent's world quaternion at bind, qRot the curl
// rotation in model space, qRest the bone's local bind quaternion.
export function curlLocal(qParent, qRot, qRest) {
  return mul(mul(mul(conj(qParent), qRot), qParent), qRest);
}
```

3. Test the math against the real asset before you write more code. A curl of 0.5 / 0.6 / 0.35 rad on the middle finger moves the fingertip 58.6 mm toward the palm. The same curl shortens the MCP-to-tip span from 86.5 mm to 82.1 mm. I measured both values in a prototype run against `right.glb`.

**Verify:** A test asserts that a positive curl moves the tip toward the palm normal by more than 20 mm. It also asserts that the fingertip moves closer to the wrist.

### Task B4: Solve the wrist position for finger contact

**Objective:** Place the wrist so the playing fingertips touch the keys.

**Files:**
- Modify: `src/handrig.js`

**Steps:**

1. Run forward kinematics for the five chains at the current curl set.
2. Collect the world-space tip offsets relative to the wrist bone.
3. Set `wrist = keyContact − lowestTipOffset`, where `keyContact` is the key top of the sounding note at strike time.
4. Clamp so no tip passes below the key plane. Report the residual.

This is a direct solve, not an iterative IK. The curl set is rigid within a frame, so one subtraction is exact.

**Verify:** Test with the chord `[60, 64, 67]` and curls from `src/hands.js`. Every tip lands within 2 mm of its key top (criterion A1).

### Task B5: Expose the engine's finger spacing as data

**Objective:** Stop hiding a proportion mismatch in a magic number.

**Files:**
- Modify: `src/handrig.js`

**Steps:**

1. Export `SPREAD_UNIT = 0.83`. The reference hand has a mean MCP spacing of 19.5 mm, and one white key is 23.5 mm.
2. Return per-finger MCP offsets from the calibration, so `src/hands.js` can place fingers at real spacing.

**Verify:** A test asserts `SPREAD_UNIT` sits between 0.78 and 0.9.

## 7. Phase C — Renderer integration

### Task C1: Load, clone, and scale the mesh

**Objective:** Two hands in the scene, at real size, with shadows.

**Files:**
- Modify: `src/hands.js`
- Create: `src/handprocedural.js`

**Steps:**

1. Move the current builders (`buildHand`, `buildFinger`, `capsule`) and the skin materials into `src/handprocedural.js`, unchanged.
2. In `src/hands.js`, load `public/hands/left.glb` and `public/hands/right.glb` once with `GLTFLoader`. Clone with `SkeletonUtils.clone`.
3. Apply the scale factor `1 / 0.0235 = 42.553` so the model draws at scene units.
4. Apply the calibration quaternion from Task B2.
5. Set `frustumCulled = false` on the `SkinnedMesh`, `castShadow = true`, `receiveShadow = true`.
6. Load the procedural build when `?hands=procedural` is present, and when the GLB request fails.
7. Add `?hands=debug` to add a `SkeletonHelper` for each hand. Use it to fault-find a bad bind pose.

**Verify:** Hands appear at the keyboard at the right size in the `close` preset. No console error. `?hands=debug` shows both skeletons, with bones inside the mesh.

### Task C2: Pose the skeleton each frame

**Objective:** Drive bones from the engine's chord data.

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Build a bone lookup once per hand: name to `THREE.Bone`.
2. Per frame, write `bone.quaternion` from `curlLocal`.
3. Keep the existing spring for wrist translation. Replace the fingertip height with the result of Task B4.
4. Replace the current sideways MCP translation with metacarpal rotation. Abduction angle comes from `spread`, mapped to ±0.35 rad.

**Verify:** Play one piece at 0.25× speed. Fingers curl without mesh tearing.

### Task C3: Remove the old hand path from the hot loop

**Objective:** One code path is live, the fallback is opt-in.

**Files:**
- Modify: `src/main.js`
- Modify: `src/hands.js`

**Steps:**

1. Keep the `handsToggle` checkbox working for both paths.
2. Keep `window.__piano.hands` shape identical, so the debug handle and the recorder keep working.

**Verify:** `grep -rn "buildFinger" src/` shows only `src/handprocedural.js`.

## 8. Phase D — Motion realism

### Task D1: Use a playing-hand rest pose

**Objective:** Start from a rounded hand, not a flat one.

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Set rest curls from the rig, per finger, in radians: MCP 0.35, PIP 0.45, DIP 0.20 for fingers 2–4. Use 0.30 / 0.35 for the pinky.
2. Keep the thumb abducted with 0.25 rad at the metacarpal.
3. Assert that no rest curl exceeds 0.8 rad, which would look like a fist.

**Verify:** Screenshot the `close` preset. The hand shows a knuckle arch and rounded fingers.

### Task D2: Drive the strike from a timed envelope

**Objective:** Separate timing from geometry.

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Per note, compute `down` and `up` envelope times: `down = note.time − 0.025`, `up = note.time + 0.06`.
2. Curl to the strike value with a 25 ms ramp. Release with a 60 ms ramp.
3. Scale the strike depth by note velocity, from 0.55 at `velocity 0.2` to 1.0 at `velocity 1.0`.
4. Follow the key dip. The key rotates by `PRESS_ANGLE * (0.6 + 0.4 * velocity)`, so the contact height moves by that angle times the key length. Read the constant from `src/piano.js` and do not duplicate it.

**Verify:** Record a 20 s clip at the `close` preset. No fingertip hovers above a sounding key.

### Task D3: Move the thumb like a thumb

**Objective:** Replace the slerp-to-target hack.

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Keep abduction at the metacarpal, flexion at the proximal and distal bones.
2. Contact with the side of the tip, not the pad. Offset the contact point by one tip radius toward the index side.
3. Tuck the thumb under the palm when idle. Do not park it on the key surface.

**Verify:** Play a piece with repeated thumb crossings (`Für Elise` is in the set). The thumb does not clip through the index finger.

### Task D4: Fix the hand span to the rig

**Objective:** Stop over-stretching wide chords.

**Files:**
- Modify: `src/hands.js`
- Modify: `src/fingering.js` only if the test in Task D5 fails

**Steps:**

1. Clamp the engine `spread` of 0.72–3.4 to an abduction range of ±0.35 rad and a wrist roll of ±0.25 rad.
2. When a chord needs more than the rig can reach, raise the wrist. Do not slide metacarpals apart.

**Verify:** `npm test` still passes the 19-semitone span assertion.

### Task D5: Add a rig test for span

**Objective:** Prove that reach is geometric, not cosmetic.

**Files:**
- Modify: `tests/handrig.test.mjs`

**Steps:**

1. Compute the maximum reachable span for the rest curl set.
2. Assert that it covers the engine's `MAX_SPAN` of 15 semitones.
3. Assert that wider spans force wrist lift and never a detached fingertip.

**Verify:** `node --test tests/handrig.test.mjs` passes.

## 9. Phase E — Material and light

### Task E1: Build a skin material with maps

**Objective:** Stop the plastic look.

**Files:**
- Modify: `src/hands.js`
- Create: `public/hands/skin-albedo.webp`, `public/hands/skin-normal.webp`, `public/hands/skin-roughness.webp`

**Steps:**

1. Use `MeshPhysicalMaterial` with `map`, `normalMap`, `roughnessMap`, `sheen: 0.25`, `sheenRoughness: 0.6`, `clearcoat: 0.05`, `envMapIntensity: 0.55`.
2. Set `sheenColor` to a warm tone, so the rim reads as translucent skin.
3. Source the maps in one of two ways:
   - Bake them from the mesh in Blender, with knuckle creases and nail beds painted in.
   - Start from a CC0 texture set on ambientCG or Poly Haven, then tint per skin preset.
4. Keep one texture set for both hands. The left hand reuses the right hand's material.

**Verify:** The hand shows knuckle creases and a soft rim. No visible UV seam on the back of the hand.

### Task E2: Add a thin-skin term

**Objective:** Light the edge of fingers and the web between them.

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. `MeshPhysicalMaterial` has no subsurface term. Its `thickness` and `transmission` path is screen-space refraction, so it looks like glass on skin.
2. Take the low-risk path first. Patch the material with `onBeforeCompile`. Add a wrap-diffuse term and a back-light term driven by the view vector, so thin edges glow.
3. Keep two upgrade paths, and choose one only after Task E1 bakes a thickness map.
   - WebGL: `three/addons/shaders/SubsurfaceScatteringShader.js` is in the installed package. It uses the `meshphong` shader chunks, so it drops the physical maps and the roughness response. It samples a `thicknessMap` in the red channel at the mesh UV.
   - WebGPU: `MeshSSSNodeMaterial` is in the installed `three.webgpu.js`. It extends `MeshPhysicalNodeMaterial` and adds a `thicknessColorNode` term, with the Barre-Brisebois translucency approximation. It needs `WebGPURenderer` in place of `WebGLRenderer`, which is a renderer-level swap.

**Verify:** A finger lit from behind shows a red-orange edge. The palm shows no glow. With the WebGL shader path, the roughness maps still respond and the shadow pass still works.

### Task E3: Tune the light for close shots

**Objective:** Read the form of the hand at the `close` preset.

**Files:**
- Modify: `src/scene.js`

**Steps:**

1. Add a low-intensity fill from the keyboard side, so the palm is not black.
2. Raise `scene.environmentIntensity` from 0.55 to about 0.7 for the close preset only.
3. Tighten the shadow camera to the hand area when the active preset is `close`, so the 2048 map covers less area.

**Verify:** Fingers separate from the palm in shadow. No banding on the keybed.

## 10. Phase F — Validation, docs, optional high-poly path

### Task F1: Wire the tests into `npm test`

**Files:**
- Modify: `package.json`
- Modify: `tests/smoke.mjs`

**Steps:**

1. Set `test` to `node --test tests/*.test.mjs && node tests/smoke.mjs`.
2. Keep the smoke test output format.

**Verify:** `npm test` prints the rig tests, then `ALL SMOKE TESTS PASSED`.

### Task F2: Update the README

**Files:**
- Modify: `README.md`

**Steps:**

1. Rewrite `Two animated hands` with the rig facts: joint count, mesh source, contact solve.
2. Replace the limitation `The hands are procedural models`.
3. Add the `?hands=procedural` flag to the controls table.

**Verify:** The README has no claim that the hands are procedural by default.

### Task F3: Refresh the screenshots

**Files:**
- Modify: `docs/screenshots/close.png`
- Modify: `docs/screenshots/perform.png`

**Steps:**

1. Run `npm run dev`, then press `5` for the close preset.
2. Capture at 1600 × 900 with the hands visible.
3. Replace the two images.

**Verify:** The README table renders the new images.

### Task F4 (optional): Sculpt a high-poly hand

**Objective:** Reach photoreal in a tight crop.

**Files:**
- Create: `tools/hand-sculpt/README.md`
- Replace: `public/hands/*.glb`

**Steps:**

1. Sculpt or scan a hand at 20k–40k triangles in Blender.
2. Retopologise to about 8k triangles.
3. Rig to the same 25 joints, with the same names.
4. Bake albedo, normal, roughness, and thickness maps at 2048².
5. Export with Draco compression, then re-run Task A1 for provenance.

**Gate:** Do this only if Task F3 shows faceting that the normal map cannot hide. The rig code stays as it is, because the joint names are the contract.

**Verify:** The GLB loads, all A1–A7 tests pass, and the build size stays under 400 KB gzipped.

## 11. Files touched by this plan

| File | Action | Phase |
|---|---|---|
| `public/hands/left.glb`, `public/hands/right.glb` | Create | A |
| `tools/extract-rig-fixture.mjs` | Create | B |
| `tests/fixtures/hand-{left,right}.json` | Create | B |
| `src/handrig.js` | Create | B |
| `tests/handrig.test.mjs` | Create | B |
| `public/hands/LICENSE` | Create | A |
| `docs/hands-assets.md` | Create | A |
| `src/handrig.js` | Create | B |
| `src/handprocedural.js` | Create (moved code) | C |
| `src/hands.js` | Rewrite | C, D |
| `src/scene.js` | Modify | E |
| `src/main.js` | Modify | C |
| `src/piano.js` | Export the dip constant | D |
| `tests/handrig.test.mjs` | Create | B, D |
| `tests/smoke.mjs` | Modify | F |
| `package.json` | Modify | F |
| `README.md` | Modify | A, F |
| `docs/screenshots/*.png` | Replace | F |

## 12. Risks and tradeoffs

| Risk | Effect | Mitigation |
|---|---|---|
| Bind-pose assumption fails on a swap | Hand faces the wrong way | The code measures the calibration and tests it (A4) |
| Mesh seams open at extreme curl | Visible gaps | Clamp curls, inspect the `?hands=debug` skeleton view |
| GLTFLoader raises bundle size | Slower first load | Measure gzipped size before and after, lazy-load on demand |
| Skin maps cost memory | 3 textures × 2 hands if not shared | One material instance, shared by both hands |
| `onBeforeCompile` patch breaks on a Three.js upgrade | Black material | Fail open, keep a plain `MeshPhysicalMaterial` in a variable |
| Rig has 4 bones per finger, engine gives 3 angles | Extra bone unused or wrong | Map distal-to-tip as a leaf, test the mapping (B1) |
| Wide chords in orchestral MIDIs | Stretched hands again | Wrist lift, then a visible warning |

## 13. Open questions

1. Do you want a skin-tone selector in the UI, or one fixed tone?
2. Should the forearm and sleeve stay procedural, or come from the same asset?
3. Is a Blender-built hand acceptable as a follow-up, given it needs sculpt and bake work?
4. Should the procedural hand stay available in the build, or move to a dev-only flag?

## 14. Implementation notes (Phase A and B)

Implementation surfaced two findings.

### The skeleton is flat

Every joint in `generic-hand` is a direct child of the armature. The file has no bone-to-bone hierarchy. A renderer must therefore write each bone's absolute pose, not a chain of local rotations.

`src/handrig.js` returns both forms. `poseChain()` gives `position` and `world` in model space, plus `localPosition` and `localQuaternion` relative to the rest parent. For this asset the two forms are equal. A nested rig, such as the Godot mesh, uses the local form.

A test asserts the equality. A future asset swap fails loudly if the assumption breaks.

### Chord contact is not a translation problem

A single note solves to under 0.5 mm. A triad does not, because the wrist holds one position and each finger holds a fixed curl set.

Measured on the rig, with fingers 2-3-5 on C4-E4-G4: 27 mm worst residual, with abduction at its 0.35 rad limit.

Real chords need per-finger IK over abduction, curl, and wrist orientation. That work belongs to Phase D. Phase B reports the residual so the motion stage can act on it.

### Figures measured during Phase B

| Quantity | Value |
|---|---|
| Single-note contact residual | under 0.5 mm |
| Triad residual, fingers 2-3-5 | 27 mm |
| Mean MCP spacing | 19.5 mm |
| `SPREAD_UNIT` | 0.83 |
| Middle finger phalanx lengths | 46.9 / 27.5 / 12.2 mm |
| Metres to scene units | 42.553 |

## Sources

- Three.js `XRHandMeshModel`: https://threejs.org/docs/pages/XRHandMeshModel.html
- WebXR Input Profiles assets: https://github.com/immersive-web/webxr-input-profiles/tree/main/packages/assets
- Babylon.js hand meshes: https://github.com/BabylonJS/Assets/tree/master/core/HandMeshes
- Godot XR Tools hands: https://github.com/GodotVR/godot-xr-tools/tree/master/addons/godot-xr-tools/hands
- MRTK3 rigged hand visualizer: https://github.com/MixedRealityToolkit/MixedRealityToolkit-Unity
- MRTK2 rigged hand visualizer: https://github.com/microsoft/MixedRealityToolkit-Unity
- Independent survey of mesh licences and counts: https://github.com/Frametop/frametop/blob/main/screens/assets/hands/README.md
- Hand anthropometry (US adults): https://ergocenter.ncsu.edu/wp-content/uploads/sites/358/2026/02/01-Anthropometry-Summary-Tables.pdf
- MANO licence (non-commercial): https://mano.is.tue.mpg.de/

### Phase C results

| Measure | Value |
|---|---|
| Hand meshes per hand | 1 skinned mesh, 25 bones |
| Draw calls per hand | 1, down from about 40 |
| Fingertip clearance at strike | 0.5 mm minimum, no chord below the surface |
| Idle fingertip hover | 3 to 14 mm above the keys |
| Worst chord residual, right hand | 56 mm |
| Worst chord residual, left hand | 39 mm |
| Bundle, gzipped | 295.38 kB, up from 278.89 kB |

Two defects surfaced while wiring the mesh.

1. `poseChain` skipped the tip leaf, so the last finger joint never moved and the fingertip stayed at its bind position. The mesh stretched instead of bending. The chain now poses every joint. A test asserts that a pose built from a solve lands on the solved tips.
2. The new rig renders in metres. It needed an explicit group scale of 42.553, or the hand appeared at 1/42.5 of its size.

The scene keeps three modes: rigged (default), `?hands=procedural`, and `?hands=debug`.
