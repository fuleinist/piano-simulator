# Piano Simulator

A browser piano visualizer for practice and video recording. It loads a MIDI file, draws all 88 keys, and animates two hands that play the piece. Colored bars glide from far behind the piano toward the keys to show each note before it sounds. A sampled grand piano plays the audio.

![Performance view](docs/screenshots/perform.png)

## Features

### Full 88-key keyboard
The keyboard spans A0 to C8. It holds 52 white keys and 36 black keys. Each key uses the correct width and offset. A key dips when a note sounds and glows in the color of its hand. The case, nameboard, and grand rim frame the keys.

### Flowing note bars
Each note draws a bar that travels in depth. The bar starts on the grand rim far behind the keyboard and slides toward the keys. This far-to-near motion reads clearly from the default overhead view. The bar fades out just behind the keyboard, before it reaches the keys. The key glow marks the actual strike.

Bar width encodes note weight. Loud melody notes draw wide bars. Soft accompaniment notes draw thin bars. Width ranges from about 0.29 to 0.56 key units. Bar color encodes the hand. Blue bars belong to the left hand. Orange bars belong to the right hand.

### Two rigged hands
Each hand is a skinned mesh with 25 joints, the WebXR hand skeleton. The mesh comes from the `generic-hand` profile of the WebXR Input Profiles, which is the asset Three.js uses for hand tracking. A rig module poses the bones, and a contact solve places the wrist so the playing fingertips meet their keys.

The hand does not slide its fingers sideways. It rotates each metacarpal to spread the knuckles, and it lifts the wrist when a chord lies beyond the hand's reach. Between notes the fingers hover above the keys. On a strike they curl to the key surface.

A fingering engine assigns the fingers. It groups notes into chords, splits them between the hands, and searches for a comfortable assignment. A beam search limits the hand span and prefers small shifts. The layout, fingering, and rig modules import no Three.js, so you can test them in Node.

The original primitive hands remain as a fallback. Add `?hands=procedural` to the URL to use them, or `?hands=debug` to draw the skeletons.

### Selectable music
The menu lists 15 famous pieces. You can also load any standard MIDI file from your disk. The player parses the file, splits the notes between the hands, and marks the melody.

### Sampled audio
A Tone.js sampler plays the Salamander grand piano set. The set holds 30 samples across the range. A freeverb adds room tone. The browser needs one click before it can start audio.

### Camera and tempo
The default view looks straight down at the keyboard. Five presets are available: top, perform, front, side, and close. The front, side, and close views slide along the keys with the player, so the hands stay in frame. A manual drag or pan releases the follow until you pick a preset again. OrbitControls lets you rotate, zoom, and pan left and right along the keys. The speed slider sets the tempo from 0.25x to 2x. A seek slider moves to any point. A loop toggle repeats the piece.

### Video recording
The recorder captures the canvas and the audio to a WebM file. It uses the browser MediaRecorder API at 60 frames per second. Use it to save a performance for review or sharing.

## Screenshots

| View | Image |
|---|---|
| Top (default) | ![Top view](docs/screenshots/top.png) |
| Perform | ![Perform view](docs/screenshots/perform.png) |
| Front | ![Front view](docs/screenshots/front.png) |
| Close (hands) | ![Close view](docs/screenshots/close.png) |

## Stack

| Library | Version | Role |
|---|---|---|
| [Three.js](https://threejs.org/) | 0.187.0 | 3D rendering, materials, and controls |
| [Tone.js](https://tonejs.github.io/) | 15.1.22 | Audio sampler, reverb, and transport |
| [@tonejs/midi](https://github.com/Tonejs/Midi) | 2.0.28 | MIDI parsing |
| [Vite](https://vite.dev/) | 7 | Dev server and static build |

The renderer uses ACES filmic tone mapping and soft shadows. The hand material uses `MeshPhysicalMaterial` with sheen to approximate skin. The build output is about 279 kB gzipped.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173. The first piece loads automatically. Click Play to start.

To build the static site:

```bash
npm run build
npm run preview
```

## Controls

| Control | Action |
|---|---|
| Piece menu | Select one of 15 built-in pieces. |
| Load MIDI | Open any standard MIDI file from your disk. |
| Play / Pause | Start or stop the performance. |
| Seek slider | Move to any point in the piece. |
| Speed slider | Set the tempo from 0.25x to 2x. |
| Loop | Repeat the piece when it ends. |
| View buttons | Switch between top, perform, front, side, and close views. |
| Mouse drag | Rotate the camera. |
| Mouse wheel | Zoom in and out. |
| Right drag | Move the view left and right along the keys. |
| Record | Save a WebM video with audio. |
| `?hands=procedural` | Use the primitive hands instead of the rigged mesh. |
| `?hands=debug` | Draw the hand skeletons over the mesh. |

## Architecture

The code separates pure logic from rendering. You can test the logic in Node without a browser.

| File | Role |
|---|---|
| `src/layout.js` | Key geometry for all 88 keys. No Three.js import. |
| `src/fingering.js` | Hand split, chord grouping, and finger assignment. No Three.js import. |
| `src/scene.js` | Renderer, lights, camera presets, and OrbitControls. |
| `src/piano.js` | The keyboard, the keys, and the press animation. |
| `src/bars.js` | The depth-travelling note bars. |
| `src/hands.js` | The hand models and the motion controller. |
| `src/handrig.js` | Rig math: bind-pose calibration, finger pose, and key contact. No Three.js import. |
| `src/player.js` | MIDI parsing, the Tone.js sampler, and the transport. |
| `src/recorder.js` | Canvas and audio capture to WebM. |
| `src/songs.js` | The built-in piece catalog. |
| `src/main.js` | App wiring and UI events. |

## Tests

```bash
npm test
```

`npm test` runs two suites. The rig test checks the hand calibration, finger proportions, and key contact against the bind pose in `tests/fixtures/`. The smoke test checks the key layout and runs the fingering engine on all 15 MIDIs. It asserts that no hand span exceeds 19 semitones. All 15 pieces pass.

Regenerate the rig fixtures after changing an asset:

```bash
npm run fixtures
```

## Assets and sources

- MIDI files: `public/midi/`, from the `zz85/midiviz` repository (gh-pages branch).
- Piano samples: `public/samples/piano/`, the Salamander grand piano set from tonejs.github.io.
- Hand meshes: `public/hands/`, the `generic-hand` profile of the WebXR Input Profiles, MIT licence, copyright 2019 Amazon. See `docs/hands-assets.md`.
- The pieces are public-domain compositions. The MIDI renditions and samples belong to their respective authors.

## Limitations

- A few orchestral-reduction MIDIs contain chords wider than two hands can span. The engine stretches the hands to reach them. These chords look extended.
- The rig cannot reach every chord with one curl set. A few wide chords land up to 56 mm from their keys, and the contact solve reports that gap rather than bending the hand further.
- Skin is a single material with no texture maps. The mesh carries no nails, pores, or creases.
- Recording uses the browser MediaRecorder API. Output is WebM. Some browsers may record video only if the audio tap is unavailable.