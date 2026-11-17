# Hand assets

The player's hands use one rigged GLB per side. This file records where the files came from, what they contain, and how to verify them.

## Source

| Field | Value |
|---|---|
| Package | `@webxr-input-profiles/assets` |
| Version | 1.0 |
| Profile | `generic-hand` |
| Repository | https://github.com/immersive-web/webxr-input-profiles |
| Path | `packages/assets/profiles/generic-hand/` |
| CDN | https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/ |
| Licence | MIT, Copyright (c) 2019 Amazon |
| Attribution | Hand meshes from the WebXR Input Profiles `generic-hand` profile, MIT licence, copyright 2019 Amazon |

Meta contributed these meshes to the WebXR Input Profiles project. Three.js loads the same package by default in `XRHandMeshModel`.

## Files

| File | SHA-256 | Size |
|---|---|---|
| `left.glb` | `bc67783144944ea1cda54d9247885825ea5fb9d4651469fe7d00be517a5c2b87` | 92.4 KB |
| `right.glb` | `291790c14f7f88a7f9bd35330c47392ed8e8d395ae6728f4bb7089f1bc1f2b96` | 91.8 KB |

Verify a file with:

```bash
sha256sum public/hands/left.glb public/hands/right.glb
```

These hashes match the values that the WebXR Input Profiles project publishes for this profile.

## Contents

Each file holds one skinned mesh on the WebXR 25-joint hand skeleton.

| Property | Value |
|---|---|
| Vertices | 1,360 |
| Triangles | 2,314 |
| Joints | 25 |
| Materials | 1, flat base colour, no texture |
| Mesh islands | 3 |
| Bounding box | 77 × 212 × 146 mm |
| Units | Metres |
| Bind pose | Fingers along −Y, palm normal along −X |

The joint names match the list in `three/addons/webxr/XRHandMeshModel.js`: `wrist`, `thumb-metacarpal`, `index-finger-phalanx-proximal`, and so on.

## Scale

One scene unit is one white key, which is 23.5 mm on a real piano. Multiply a GLB length by `1 / 0.0235 = 42.553` to convert metres into scene units.

`src/handrig.js` exports this value as `SCALE`.

## Licence text

The full MIT text sits next to the assets in `public/hands/LICENSE`. Keep that file with any copy of the meshes.