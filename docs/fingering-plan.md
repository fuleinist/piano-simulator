# Fingering Accuracy and Motion Plan

> **For Hermes:** Use the subagent-driven-development skill to implement this plan task by task.

**Goal:** Every playing fingertip meets its own key, and the hand reaches that key on time. Two claims, both measured. The current build misses both. 8.5% of chords have a fingertip more than 5 mm off its key. The hand is typically 27 mm short of its target when the note sounds.

**Architecture:** Keep the pure logic pure. Three modules carry the thinking and import no Three.js, so Node can test them. `src/positions.js` (new) partitions each hand's notes into hand positions. `src/fingering.js` assigns fingers inside a position. `src/motion.js` (new) turns positions into a timed path. `src/hands.js` samples that path and writes bones. The spring integrator leaves `src/hands.js`.

**Tech Stack:** Three.js 0.187, Vite 7, Node test runner, the rig fixtures in `tests/fixtures/`.

**Status:** Design and measurement only. I did not touch any file under `src/`. I went over the plan again on 2026-11-18 against the code and against a second measurement run. Section 9 lists every correction and the evidence for it.

---

## 1. The reference: four rules and three situations

Source: Yamaha's "The Basics Of Piano Keyboard Fingering". The numbering is the conventional one: 1 is the thumb, 5 is the pinky.

### Four rules

| Rule | What it asks for | Where it lands |
|---|---|---|
| Keep the thumb off black keys, except in a black-key piece | A rule that reads the key of the passage | Cost term in the position DP |
| Use as many fingers as possible | Favour the middle fingers over the strong pair 1-2 | Cost term on the finger set |
| Keep the hand over as many notes as possible | Group notes into positions, not single chords | `src/positions.js` |
| Learn the scale fingerings | A table of standard scale patterns | `src/positions.js` |

Yamaha states the thumb rule with its own exception. A piece that starts on a black key, or that is mostly on black keys, will need the thumb on a black key. The rule is about the key of the passage, not about the single note. The current code applies one flat penalty of 0.7 to any thumb on any black key.

### Three situations, one of them missing

1. **The phrase fits under the fingers.** Put the hand over the range and play. The current code does this well.
2. **The phrase needs a stretch.** Keep the hand in place and stretch, rather than move. Yamaha offers two fingerings for the same B-flat, thumb-and-4 or thumb-and-5, and says to pick the one that feels better.
3. **The phrase needs a new hand position.** Yamaha describes two tools here. The first is to start bringing the thumb under before the shift is due, so the thumb arrives ready. The second is to group long lines into three or four notes per position.

Situation 3 is the gap. The current solver builds every chord as a grip with the wrist behind it, so a crossing cannot exist. The wrist position is the mean of the fingertip offsets. No cost term can reach a pose that the representation cannot express.

## 2. Current state, measured

Method: `tools/measure-fingering.mjs` replays the `RiggedHand.load` solve over all 15 built-in pieces. It reads each MIDI file, runs `assignFingering`, builds the same chords `src/hands.js` builds, and calls `chooseFingers` and `solveContact` with the rig fixture. Units are millimetres, at 23.5 mm per white key.

The finger counts come from **after** `chooseFingers`. That is the assignment the app renders. The first draft counted before the guard, and section 9 explains why that was wrong.

Sample: 15 pieces. The MIDI files hold 23,537 note events in the playable range, outside the percussion channel. `dedup` in `src/fingering.js` merges 1,183 doubled pitches at one onset, which leaves 22,354 notes. The chord builder drops 4 more, because two notes in one chord share a finger. The app therefore renders 22,350 notes across 15,189 chord events and 15,159 hand shifts.

| Metric | Now | Reads as |
|---|---|---|
| Fingertip miss, median | 0 mm | Most chords land |
| Fingertip miss, p90 | 4.34 mm | |
| Fingertip miss, p95 | 6.83 mm | One chord in 20 is visibly off |
| Fingertip miss, p99 | 25.75 mm | One chord in 100 is a white key wide |
| Fingertip miss, worst chord | 53.95 mm | About two white keys |
| Chords over 5 mm miss | 1,292 (8.5%) | A tip hangs in the air |
| Reach gap at zero roll | 2,077 (13.7%) | `reachRange` sees a gap |
| Of those, pronation rescues the chord | 946 | The contact solve rolls the palm |
| Of those, the tip still misses | 1,131 | |
| Misses where the guard saw no gap | 161 | The guard chose a poor finger set |
| Chords of more than five notes | 0 | The size guard never fires |
| Hand shifts | 15,159 | One per chord |
| Shift distance, median | 48 mm | About two white keys |
| Shift distance, p90 | 138 mm | About six white keys |
| Shift distance, p95 | 197 mm | About eight white keys |
| Shift distance, worst | 556 mm | About 24 white keys |
| Shifts over 20 mm | 12,590 (83.1%) | |
| Short of target at note onset, p50 | 27 mm | Model value, see below |
| Short of target at note onset, p90 | 77 mm | Model value |
| Short of target at note onset, worst | 277 mm | Model value |
| Moves while a key stays down | 2,150 (14.2%) | The held tip drags |
| Abduction snaps over 0.05 rad | 3,520 (23.2%) | Max 0.70 rad, or 40 degrees, in one frame |
| Thumb on a black key, before the guard | 768 of 4,932 (15.6%) | The beam search result |
| Thumb on a black key, after the guard | 1,490 of 6,304 (23.6%) | What the app renders |
| Notes per hand position | 1.66 | Yamaha asks for three or four |
| Notes dropped by the chord builder | 4 | Two notes share one finger |

**Chord size.** Most chord events hold a single note.

| Notes in the chord | Count | Share |
|---|---|---|
| 1 | 9,960 | 65.6% |
| 2 | 3,584 | 23.6% |
| 3 | 1,367 | 9.0% |
| 4 | 269 | 1.8% |
| 5 | 9 | 0.1% |

**Finger share after the guard.** The left hand plays 7,600 notes, the right hand 14,750.

| Finger | Left hand | Right hand |
|---|---|---|
| 1, thumb | 30.9% | 26.8% |
| 2, index | 21.1% | 15.4% |
| 3, middle | 9.0% | 12.1% |
| 4, ring | 6.9% | 11.7% |
| 5, pinky | 32.2% | 34.0% |

The onset figure comes from a model, not from a screen capture. It is the step response of the critically damped spring in `src/hands.js`, with `w = 14`, against the 0.12 s look-ahead in `RiggedHand.update`. The model integrates over the real gap between two chords, and it switches the target at 0.12 s before the note. At 0.12 s that spring covers 50.1% of a step. It needs 0.339 s to cover 95%. For a median shift of 48 mm, the hand is 27 mm short at the note and still moving.

### What the numbers mean

1. **The hand moves on every chord.** 1.66 notes per position, against the three or four that Yamaha asks for. The hand travels 48 mm, on median, between notes that a pianist would play without moving.
2. **Most chords are one note.** 65.6% of chord events hold a single note. The hand solves a fresh grip and re-centres the wrist for each one. This is the main cause of point 1.
3. **The hand arrives late.** The look-ahead is a fixed 0.12 s, but the spring needs about 0.34 s. A short passage cannot finish its travel.
4. **The lag grows with the playback speed.** The 0.12 s lead is in song time, not in real time. `src/player.js:100` advances the clock by `dt * speed`, and `src/player.js:112` passes that clock to the hand. The real travel time is therefore `0.12 / speed`:

   | Playback speed | Real travel time | Distance covered at onset |
   |---|---|---|
   | 0.25x | 0.480 s | 99.1% |
   | 0.5x | 0.240 s | 84.9% |
   | 1x | 0.120 s | 50.1% |
   | 2x | 0.060 s | 20.6% |

   A slow practice run looks almost right. A fast run looks wrong.
5. **The hand leaves held keys behind.** 14.2% of transitions move the hand while a previous note is still down. The held fingertip slides across its key. `RiggedHand.update` picks the next chord with `c.time >= t - 0.02`. Once the clock passes a chord by 0.02 s, that chord is no longer the target, even while its notes still sound. The target also jumps in one frame when the following chord enters the window.
6. **Abduction is not animated.** `_pose` writes `c.solve.spread[finger]` straight onto the bones each frame, while the curls ease. 23.2% of transitions jump the spread by more than 0.05 rad, and the worst jump is 40 degrees in one frame.
7. **The fingers do not follow a scale.** The beam search has no cost for finger adjacency. A C-major scale from C4 to C5, in the right hand, gets 1-2-3-4-5-5-4-5. The hand runs out of fingers and reuses the pinky. A pianist plays 1-2-3-1-2-3-4-5. The same scale descending gets 5-4-3-3-2-1-2-1, and a broken C-major triad gets 1-3-5-5 on the way up and 1-1-1 on the way down.
8. **The reach guard breaks the thumb rule.** `chooseFingers` scores a finger set by its reach gap at zero roll only. It has no thumb rule, no adjacency cost, and no finger-use cost. It also stops at the first set with a gap of zero, so it never compares two good sets. The thumb lands on a black key in 15.6% of thumb notes before the guard, and 23.6% after it. The guard makes rule 1 worse. A new fingering layer must fix the guard too, or the guard will undo the layer.
9. **Two fingers do almost nothing.** The ring finger plays 6.9% of left-hand notes and the middle finger 9.0%. Together they cover 15.9%, while the thumb and pinky cover 63.1%. Rule 2 asks for the opposite balance.
10. **The rig sets the accuracy limit.** See section 2.1.

### 2.1 The rig limit, measured

`tools/probe-reach.mjs` takes every chord the app misses by more than 5 mm. For an even sample of 400 such chords across all 15 pieces, it tries **every** finger set and keeps the best contact error.

| Result | Count | Share |
|---|---|---|
| Some finger set lands within 5 mm | 63 | 15.8% |
| No finger set lands within 5 mm | 337 | 84.3% |

A perfect finger choice therefore removes only about 16% of the misses. The estimate for the whole corpus is 1,089 misses of 15,189, or **7.2%**. Fingering work alone cannot take the miss rate below that value. The other 84% need a larger rig span, a wider abduction limit, or a different contact model. Section 4.5 sets out the choice.

The largest single gains are real but small: a three-note right-hand chord in `pachelbel_canon.mid` goes from 8.62 mm to 0 mm with a better finger set. Most chords do not have that option.

### 2.2 Limits of the measurement

- The onset figures come from a spring model, not from a rendered frame. The model starts each transition at rest on the previous target. In a fast run the hand carries lag from one shift into the next, so the real error is larger, not smaller.
- The chord window in the harness is 0.05 s, which matches `src/hands.js:49`. A window of 0.045 s gives a different count for 8 groups of 15,189, so the choice of window does not drive the result.
- The reach probe uses an even sample of 400 chords, not all 1,292. Its output lists the count per piece, so a reader can see the spread.
- The harness reads the rig from `tests/fixtures/hand-left.json` and `hand-right.json`. A different rig gives different contact numbers.
- Two runs of the harness give identical numbers, apart from the timing field.

## 3. Gaps

| Gap | Rule | Evidence | Phase |
|---|---|---|---|
| No hand positions, so no economy of motion | 3 | 1.66 notes per position | 3 |
| Most chords hold one note | 3 | 65.6% of events | 3 |
| No crossings, so no thumb-under | 3 | Representation cannot express one | 4 |
| Fixed look-ahead against a slow spring | motion | 27 mm short at onset | 2 |
| The lag grows with the playback speed | motion | 20.6% covered at 2x | 2 |
| The target jumps when the next chord enters the window | motion | `c.time >= t - 0.02` | 2 |
| Hand moves under held keys | motion | 14.2% of transitions | 2 |
| Abduction is not animated | motion | 23.2% of transitions snap | 1 |
| The release ignores the note length | motion | `_curl` uses a fixed rate | 1 |
| No finger-adjacency cost | 2 | Pinky 32.2% L, ring 6.9% L | 5 |
| Two fingers on one note in a run | 2 | 1-2-3-4-5-5-4-5 | 5 |
| The reach guard has no musical cost | 1, 2 | Thumb on black rises from 15.6% to 23.6% | 3 |
| Flat thumb-on-black penalty | 1 | No key context | 5 |
| No scale fingerings | 4 | C major up gives 1-2-3-4-5-5-4-5 | 5 |
| Two chord window values in five places | code | 0.045 s in three files, 0.05 s in two | 1 |
| The chord builder drops a shared finger | code | 4 notes lost | 1 |
| A tip hangs in the air | rig | 8.5% of chords, worst 53.95 mm | 0, 3 |
| No finger set can land the chord | rig | 84.3% of the misses | 0 |

A rule of `motion` means a rendering problem, not a fingering rule. A rule of `code` means a contract between two modules. A rule of `rig` means the hand model itself is too small.

The chord window mismatch is small. It matters because five places disagree about what a chord is, so a future fix to one will move the others. `src/fingering.js:13`, `tests/smoke.mjs:54`, and `tests/diag.mjs:20` use 0.045 s. `src/hands.js:49` and the harness use 0.05 s.

## 4. Design

### 4.1 Hand positions

A hand position is a contiguous span of white keys plus the fingers that cover it. Represent it as `{ lo, hi, fingers, notes }`, where `lo` and `hi` are white-key indices.

Find the positions with a dynamic program over each hand's note stream, in time order. The states are candidate spans. A span starts on a note and reaches four to nine white keys above it. The cost of a path is the sum of:

- a span cost, which grows with the stretch past five keys. A tenth is the limit.
- a group reward, which falls with every note beyond the first. Three notes per position pay less than one.
- a shift cost, which grows with the distance between span centres.
- a legato cost, which is high when a note of the new position starts before a note of the old one ends. The hand cannot lift then.
- a crossing cost for each crossing the path needs.

The DP replaces the per-chord beam search. It can see the whole phrase, so it can trade a stretch now against a shift later, which the current beam cannot do at all.

### 4.2 Crossings

A crossing is a note that a finger outside the current span plays while another finger holds its key. Two forms:

- **Thumb under.** The thumb plays a note above the hand, so the wrist stays near the old position and the thumb abducts.
- **Finger over.** A finger plays below the thumb's note, or the hand passes over the thumb.

Each crossing becomes an explicit entry `{ from, to, note, when }` in the position stream. `solveContact` gains an optional `anchors` argument: fingers that must stay on their keys. An anchored finger takes priority in the wrist solve, and the crossing finger gets a wider abduction limit for that chord. This turns the crossing into a solvable pose rather than a cost term.

### 4.3 A timed path

New pure module `src/motion.js`. `planMotion(chords, options)` returns keyframes:

| Keyframe | Time | Holds |
|---|---|---|
| `ready` | before the note | The pose for the next chord, with the wrist still on the old one |
| `press` | `note.time` | The solved strike pose, wrist on target |
| `release` | `note.time + duration` | The relaxed pose, tip just off the key |
| `travel` | between chords | The wrist path, an arc in Y |

`sampleMotion(frames, t)` interpolates between two keyframes with a raised-cosine speed profile. The hand starts and ends at rest, so it is at the target exactly at `press`. No `dt` integration, so the result does not depend on frame rate.

Travel duration comes from the distance, not from a constant. A shift of one white key takes about 60 ms. A shift of seven white keys takes about 260 ms. The time the music allows bounds both. When the music allows less, the hand lifts higher, which shortens its path.

Two rules hold through the whole path:

1. **The wrist does not move while a finger holds a key**, unless a crossing owns that note. The planner inserts a `hold` keyframe and starts the travel at the release.
2. **Curls and abduction interpolate together**, along one path in pose space. The finger keeps its order and its minimum gap during the travel, so it cannot cross a neighbour on the way.

### 4.4 Costs, in one place

All costs live in `src/positions.js` as named constants, with the value and the reason beside each one. The four rules of the reference map to four costs, so a reader can trace a fingering decision back to a rule.

### 4.5 The rig limit and the route choice

Section 2.1 puts a floor of 7.2% under the miss rate. The plan must choose one of three routes before it sets a contact target:

| Route | Work | Effect |
|---|---|---|
| A: accept the limit | None | Target the miss rate at 7.5%, and report the rig limit as a known gap |
| B: widen the rig | Longer fingers, or a wider abduction limit, in the rig fixtures | The floor falls, but the hand looks less like the reference scan |
| C: a new contact model | Let the wrist roll further, or let a tip press a key edge | The floor falls, and the solve stays inside the current rig |

Route A is the default for this plan. Task 0.3 measures the span of the rig and records the exact limit. A later plan can then choose B or C with a number in hand. Do not promise a 1% miss rate from fingering work. The measurement does not support it.

### 4.6 A test constraint

`src/hands.js` reads `window` at import time, so Node cannot import it. A unit test against `RiggedHand` fails with `window is not defined`. Two routes work:

1. Put the logic in a pure module and test that module in Node. This is the route the plan takes.
2. Test the rendering in the browser through `tests/smoke.mjs`.

Do not write a Node test that imports `src/hands.js`. Task 1.3 and Task 2.4 follow this rule. `src/handrig.js` and `src/songs.js` import cleanly in Node.

## 5. Phases

Branch: `feat/fingering-motion`, one pull request against `main` at the end of each phase that stands alone.

### Phase 0: Measure before and after

#### Task 0.1: Commit the harness

**Files:**
- Create: `tools/measure-fingering.mjs`
- Create: `tools/probe-reach.mjs`
- Modify: `package.json`

**Steps:**

1. Add both scripts to the repo. They exist and run now.
2. Add `"metrics": "node tools/measure-fingering.mjs elise.mid mond_1.mid bach_846.mid"` to the scripts.
3. Add `"reach": "node tools/probe-reach.mjs elise.mid mond_1.mid bach_846.mid"`.
4. Add a `--all` flag that reads the file list from `src/songs.js`.

**Verify:** `npm run metrics` prints the aggregate block for three pieces. `npm run reach` prints the fixable share.

#### Task 0.2: Add the missing metrics

**Files:**
- Modify: `tools/measure-fingering.mjs`

**Steps:**

1. Add a finger-adjacency counter: the share of same-hand note pairs one white key apart that sit on neighbouring fingers.
2. Add a per-piece JSON file, so a later run can compare two builds.
3. Print the count of distinct positions, not the run-length estimate.
4. Keep the post-guard finger counts, the reach split, and the chord-size histogram. They are in the harness now.

**Verify:** The output covers every row of the table in section 6. Two runs of the same build give the same numbers, apart from the timing field.

#### Task 0.3: Measure the rig span

**Files:**
- Modify: `tools/probe-reach.mjs`
- Create: `docs/rig-span.md`

**Steps:**

1. For each hand, find the widest interval that some finger set can land within 5 mm.
2. Report the limit in white keys and in millimetres, for two, three, four, and five notes.
3. Record how much of the 7.2% floor each chord size causes.
4. Write the result to `docs/rig-span.md`, with the route choice from section 4.5.

**Verify:** The document states a span limit for each chord size, and names route A, B, or C.

#### Task 0.4: Guard against regression

**Files:**
- Create: `tests/metrics.budget.test.mjs`
- Modify: `package.json`

**Steps:**

1. Run three pieces and read the aggregate.
2. Assert each metric against a ceiling of twice the value in section 2, so the test passes now and fails on a large regression.
3. Add the file to the `test` script.

**Verify:** `npm run test` passes. Raising a cost term so the shift count doubles makes it fail.

### Phase 1: Continuity fixes

#### Task 1.1: One chord window

**Files:**
- Modify: `src/fingering.js`
- Modify: `src/hands.js`
- Modify: `tests/smoke.mjs`
- Modify: `tests/diag.mjs`
- Modify: `tools/measure-fingering.mjs`

**Steps:**

1. Export `CHORD_WINDOW` from `src/fingering.js`. Its value today is 0.045 s.
2. Import it in the other four files in place of the local constant.
3. Set the shared value to 0.05 s, because that is what the renderer uses and what the baseline measured. Record the choice in a comment.

**Verify:** A test asserts that `buildChords` groups a pair of notes 0.047 s apart into one chord. A search for a chord window finds one constant, not five.

#### Task 1.2: Interpolate the whole pose

**Files:**
- Modify: `src/handrig.js`
- Modify: `src/hands.js`

**Steps:**

1. Add `blendPose(from, to, s)` to `src/handrig.js`. It returns the curls and abductions at `s`, with `s = 0` at the old chord and `s = 1` at the new one.
2. In `RiggedHand.update`, sample the blend across the transition window instead of writing the new spread in one frame.
3. Keep the endpoints exact, so contact at `press` does not move.

**Verify:** The abduction snap metric reads 0 for transitions over 0.05 rad. `tests/handrig.test.mjs` still passes.

#### Task 1.3: Use the note length

**Files:**
- Create: `src/envelope.js`
- Create: `tests/envelope.test.mjs`
- Modify: `src/hands.js`

**Steps:**

1. Put the press and release envelope in a pure module, `src/envelope.js`. It takes the note length and the time since the press, and returns a curl factor.
2. Set the release time from the note length, so a staccato note lifts early and a long note holds.
3. Cap the release rate so a very short note does not snap.
4. Call the module from `_curl` in `src/hands.js`.

**Verify:** `node --test tests/envelope.test.mjs` passes. It gives different release times for a 0.08 s note and a 2 s note. Do not import `src/hands.js` in the test, because it reads `window`.

#### Task 1.4: Keep every note of a chord

**Files:**
- Modify: `src/hands.js`
- Modify: `tests/smoke.mjs`

**Steps:**

1. `buildChords` writes `fingers[n.finger] = n`, so a second note on the same finger overwrites the first. Four notes disappear across the corpus.
2. Keep a list of notes per finger, or give the second note a free finger.
3. Report the choice in a comment.

**Verify:** The harness reports 22,354 rendered notes, not 22,350. The dropped-note count reads 0.

### Phase 2: A timed path

#### Task 2.1: The motion module

**Files:**
- Create: `src/motion.js`
- Create: `tests/motion.test.mjs`

**Steps:**

1. Write `planMotion(chords)` and `sampleMotion(frames, t)`.
2. Use a raised-cosine profile. The value at the start and the end of a segment is the keyframe value.
3. Test the boundaries, a sample at the midpoint, and the case where no time exists between two chords.

**Verify:** `node --test tests/motion.test.mjs` passes. A sample at a `press` time equals the solved wrist for that chord to 1e-6.

#### Task 2.2: Travel time from distance

**Files:**
- Modify: `src/motion.js`

**Steps:**

1. Map shift distance to travel time: 60 ms at one white key, 260 ms at seven.
2. Clamp the result to the gap between the two chords.
3. When the gap is too small, raise the arc height, so the path shortens.

**Verify:** A test asserts that the planned arrival time is at or before the chord time. It covers shifts of up to 16 white keys.

#### Task 2.3: Hold the wrist under a held key

**Files:**
- Modify: `src/motion.js`

**Steps:**

1. Find the last release time before the next chord.
2. Start the travel at that release, not 0.12 s before the note.
3. If no time remains, mark the transition as a crossing and hand it to Task 4.3.

**Verify:** The held-key metric falls below 2%.

#### Task 2.4: Render from the path

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Remove the spring integrator, `this.vel`, and the fixed `w = 14`.
2. Read the wrist, curls, and abduction from `sampleMotion`.
3. Keep the anticipation lift, the palm tilt, and the `centerX` offset. They are separate from the spring, and the camera presets depend on them.
4. Keep `ProceduralHand` working. It is the fallback when the rig fixtures fail to load, and it has no contact solve. Give it the same path, or leave its own smoother in place and say so in a comment.
5. Read the clock in song time, so the playback speed no longer moves the arrival error.

**Verify:** The short-at-onset metric falls below 5 mm at 1x and at 2x. The app plays `elise.mid` with no visible lag. The fallback hand still moves when the fixtures are absent. Test both in the browser, because Node cannot import `src/hands.js`.

#### Task 2.5: Keep the seek path exact

**Files:**
- Modify: `src/hands.js`

**Steps:**

1. Make `seek(t)` sample the same path at `t`, so a seek and a playthrough agree.
2. Drop the rest-curl reset in `seek`.

**Verify:** A browser test seeks to a time and compares the pose with the pose after a playthrough to the same time.

### Phase 3: Hand positions

#### Task 3.1: The position DP

**Files:**
- Create: `src/positions.js`
- Create: `tests/positions.test.mjs`

**Steps:**

1. Build candidate spans from each note: four to nine white keys wide.
2. Score a path with the five costs in section 4.1.
3. Return `{ spans, notes }`, with a span index on every note.
4. Test a C-major scale, a broken triad, and a legato run.

**Verify:** A C-major scale from C4 to C5 becomes two spans, not eight. A broken triad stays in one span.

#### Task 3.2: Fingers inside a span

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Assign fingers in pitch order, with the thumb low in the right hand and high in the left.
2. Respect the stretch limit: one finger per white key, two keys for a stretch of a third.
3. Return one finger per note.

**Verify:** A five-note span uses five fingers. A four-note span inside five keys uses four neighbouring fingers.

#### Task 3.3: Give the reach guard a musical cost

**Files:**
- Modify: `src/handrig.js`
- Modify: `tests/handrig.test.mjs`

**Steps:**

1. `chooseFingers` scores a set by its reach gap at zero roll only, and stops at the first set with a gap of zero. Point 8 of section 2 shows that this raises the thumb-on-black rate from 15.6% to 23.6%.
2. Score every candidate set with three terms: the contact error after the solve, the thumb-on-black penalty, and the finger-adjacency cost.
3. Keep the reach gap as a hard filter, not as the only score.
4. Cache the solve per set, because the full search costs more than the current first-fit loop.

**Verify:** The thumb-on-black rate after the guard falls to the rate before it, or below. The miss rate does not rise. `tests/handrig.test.mjs` still passes.

**Order:** Do this task before Task 3.4. Otherwise the guard undoes the new fingering.

#### Task 3.4: Replace the beam search

**Files:**
- Modify: `src/fingering.js`

**Steps:**

1. Call `positions.js` for each hand in place of `assignHand`.
2. Keep `splitHands` and `markMelody` as they are.
3. Keep `chooseFingers` as the last guard against an unreachable chord, with the musical cost from Task 3.3.

**Verify:** `notesPerPos` rises above 2.6. The finger share for the pinky falls below 20%.

#### Task 3.5: Stretch against shift

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Add the span cost and the shift cost as separate constants.
2. Test one phrase that the two costs resolve in opposite ways.
3. Record the chosen balance in a comment, with the Yamaha rule it follows.

**Verify:** A phrase from the reference, the C-to-B-flat stretch with the ring finger, keeps one span. A phrase two octaves wide uses two spans.

#### Task 3.6: One wrist target per span

**Files:**
- Modify: `src/fingering.js`
- Modify: `src/hands.js`

**Steps:**

1. Attach the span index to each note.
2. Build chords from the span's wrist target, not from the mean of the chord's tips.
3. Solve contact once per chord, with the span target as the start point.

**Verify:** The shift median falls below 30 mm. The count of shifts over 20 mm falls below 55%.

### Phase 4: Crossings

#### Task 4.1: Find the crossings

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. For each legato transition between spans, test whether a crossing can carry the note.
2. Emit `{ from, to, note, when }` on the span.
3. Allow at most one crossing per span.

**Verify:** A rising five-finger passage with a continuing legato note produces one crossing, not a shift.

#### Task 4.2: Anchored contact solve

**Files:**
- Modify: `src/handrig.js`
- Modify: `tests/handrig.test.mjs`

**Steps:**

1. Add an optional `anchors` argument to `solveContact`. Each anchor is a finger that must stay on its key.
2. Weight an anchored finger above an unanchored one in the wrist solve.
3. Allow a wider abduction for the crossing finger only.

**Verify:** A chord with one anchor keeps that tip within 1 mm of its key while the crossing finger lands within 3 mm.

#### Task 4.3: Render the crossing

**Files:**
- Modify: `src/motion.js`
- Modify: `src/hands.js`

**Steps:**

1. Plan a crossing as a path with a fixed wrist and a moving finger.
2. Roll the palm toward the crossing finger, as the thumb-under needs.
3. Keep the elbow-side wrist off the keys.

**Verify:** The thumb-under reads as a thumb reaching under the hand in the `close` camera preset.

#### Task 4.4: Bound the crossings

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Reject a crossing that needs more than the abduction limit.
2. Reject a crossing on a black key unless the span is mostly black keys.
3. Fall back to a shift when both reject.

**Verify:** The count of crossings per piece stays under one in ten chords. No crossing puts the thumb on a black key in a white-key piece.

### Phase 5: Fingering costs

#### Task 5.1: The thumb rule with its exception

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Measure the black-key share of each span.
2. Waive the thumb penalty when that share is above 50%.
3. Keep the penalty when the span is mostly white keys.

**Verify:** A passage in E-flat major places the thumb on a black key. A passage in C major does not.

#### Task 5.2: Scale fingerings

**Files:**
- Modify: `src/positions.js`
- Create: `tests/scale-fingerings.test.mjs`

**Steps:**

1. Add a table of standard fingerings: major and harmonic minor, both hands, one and two octaves.
2. Match a run of six or more scale steps against the table.
3. Use the table fingering when it matches, and the DP result otherwise.

**Verify:** C major from C4 to C5 in the right hand returns 1-2-3-1-2-3-4-5. A natural minor run in the left hand returns the mirrored pattern.

#### Task 5.3: Adjacent pitches, adjacent fingers

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Add a cost when two notes one white key apart take fingers two or more apart.
2. Weight the cost by the interval, so a semitone costs more than a whole tone.

**Verify:** The finger share for the pinky falls below 20%, and the ring finger rises above 14% in the left hand.

#### Task 5.4: Use the whole hand

**Files:**
- Modify: `src/positions.js`

**Steps:**

1. Add a cost when a span leaves a finger unused while a note sits under it.
2. Keep the cost below the shift cost, so a shift still wins when it must.

**Verify:** A four-note phrase inside five keys uses four fingers, with no repeat.

### Phase 6: Docs

#### Task 6.1: State the rules in the README

**Files:**
- Modify: `README.md`

**Steps:**

1. Add a short section on the fingering rules, with the four rules of the reference.
2. Name the three situations and which one the code handles with a crossing.
3. Keep the existing paragraph on the contact solve.
4. State the rig limit from Task 0.3, so the reader knows why some tips hang in the air.

**Verify:** The README makes no claim that the hand search works per chord.

#### Task 6.2: Refresh the numbers

**Files:**
- Modify: `docs/fingering-plan.md`

**Steps:**

1. Run `npm run metrics --all`.
2. Replace the table in section 2 with the new figures.
3. Keep the old figures in a `Baseline` column.

**Verify:** Every number in the table comes from a run of the harness.

#### Task 6.3: Capture the crossings

**Files:**
- Modify: `docs/screenshots/*.png`

**Steps:**

1. Start `npm run dev` and load `bach_846.mid`.
2. Press `5` for the close preset.
3. Capture a thumb-under frame at 1600 × 900.

**Verify:** The frame shows the thumb under the hand, and the palm rolled toward it.

## 6. Acceptance targets

The contact rows are split, because section 2.1 puts a floor under the miss rate. Fingering work cannot pass that floor.

| Metric | Now | Target | Scope |
|---|---|---|---|
| Notes per hand position | 1.66 | 2.6 or more | fingering |
| Shift distance, median | 48 mm | 30 mm or less | fingering |
| Shifts over 20 mm | 83.1% | 55% or less | fingering |
| Short of target at note onset, p50 | 27 mm | 5 mm or less | motion |
| Short of target at note onset at 2x, p50 | worse than 27 mm | 5 mm or less | motion |
| Moves while a key stays down | 14.2% | 2% or less | motion |
| Abduction snaps over 0.05 rad | 23.2% | 0 | motion |
| Notes dropped by the chord builder | 4 | 0 | code |
| Chords over 5 mm miss, all chords | 8.5% | 7.5% or less | fingering, route A |
| Chords over 5 mm miss, chords the rig can span | not split yet | 1% or less | fingering |
| Chords no finger set can land | 7.2% | the same | rig, out of scope |
| Finger share, pinky | 32.2% L, 34.0% R | 20% or less | fingering |
| Finger share, ring, left hand | 6.9% | 14% or more | fingering |
| Thumb on a black key, after the guard | 23.6% | under 8% in white-key pieces | fingering |
| Neighbouring fingers on neighbouring keys | not measured | 85% or more | fingering |

Two rows need new harness work. Task 0.2 adds the adjacency row. Task 0.3 splits the contact row by rig span. The others read from the harness today.

If a later plan takes route B or C from section 4.5, the all-chords target can fall below 7.5%. This plan does not promise that.

## 7. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The reach guard undoes the new fingering | Measured: thumb on black rises 8 points | Task 3.3 gives the guard a musical cost, and runs before Task 3.4 |
| The rig cannot span the chord | Measured: 84.3% of the misses | Task 0.3 records the limit, and section 6 splits the target |
| The DP picks spans that the rig cannot span | Tips in the air | `chooseFingers` stays as the last guard, and the budget test holds the rate |
| A crossing needs more abduction than the rig has | The thumb leaves its key | Task 4.4 rejects the crossing and falls back to a shift |
| The motion path fights the contact solve | Tips slide on their keys | The keyframes at `press` come from the solve, and a test compares the two |
| Removing the spring breaks the tilt or the camera framing | The hand looks flat, or sits off-centre | Task 2.4 keeps the tilt, the lift, and `centerX` |
| The fallback hand stops moving | No hand at all when the fixtures fail | Task 2.4 keeps `ProceduralHand` working |
| A Node test imports `src/hands.js` | The test fails on `window` | Put the logic in a pure module, or test in the browser |
| Longer look-ahead makes the hand move before the music | The hand anticipates too early | The travel starts at the last release, never earlier than the phrase allows |
| The scale table is wrong for a real piece | A fingering looks odd to a pianist | The table covers one and two octaves only, and the DP decides elsewhere |
| Rewriting the fingering breaks the hand split | Notes jump between hands | `splitHands` stays as it is in this plan |
| The full finger search in the guard costs too much | The load takes longer | Task 3.3 caches the solve per set, and the budget test watches the load time |

## 8. Open questions

1. Should a crossing show a wrist lift, as a concert pianist does, or stay flat as a beginner does?
2. How much stretch is acceptable before the code prefers a shift? The reference gives a tenth as a natural limit.
3. Should the app show the finger number at the key, as a practice aid?
4. Is 60 ms the right time for a one-key shift at normal tempo, or should it follow the measured hand speed of a pianist?
5. Which route from section 4.5 should a later plan take: accept the rig limit, widen the rig, or use a new contact model?
6. Should the chord window stay at 0.05 s, or move to 0.045 s? The difference is 8 groups of 15,189, so either value works. The plan keeps 0.05 s because the baseline used it.

## 9. Review log

I went over the plan against the code and against a second measurement run on 2026-11-18. Every number below comes from a tool run, not from an estimate.

| Claim in the first draft | Verdict | Correction |
|---|---|---|
| Notes per hand position 1.68 | Wrong | 1.66 over 13,461 runs |
| Short at onset 28 mm p50, 79 mm p90, 339 mm max | Wrong | 27 mm, 77 mm, 277 mm. The spring model now integrates the real gap, not a fixed 2 s window |
| "Chords the rig cannot span: 2,077 (13.7%)" | Wrong | `reachRange` tests zero roll only. Pronation rescues 946 of the 2,077. The real miss count is 1,292 |
| Thumb on black 15.6%, "the flat penalty works" | Wrong | The harness counted that before `chooseFingers`. After the guard it is 23.6%. The guard breaks rule 1 |
| Finger shares: pinky 30.9%, ring 8.7% | Wrong | Those were pre-guard. Post-guard: pinky 32.2% L and 34.0% R, ring 6.9% L and 11.7% R |
| "Two chord windows" | Incomplete | Two values in five places: `src/fingering.js`, `src/hands.js`, `tests/smoke.mjs`, `tests/diag.mjs`, `tools/measure-fingering.mjs` |
| Contact miss target 1% | Not supported | An exhaustive finger search fixes only 15.8% of the misses. The floor is 7.2%. Section 6 now splits the target |
| Chords of more than five notes share fingers | Not found | The corpus has none. The size guard never fires |
| Unit tests can import `src/hands.js` | Wrong | It reads `window` at import time. Task 1.3 now uses a pure module |
| The lag is the same at every playback speed | Wrong | The 0.12 s lead is in song time. At 2x the hand covers 20.6% of the distance |
| Worst shift "two and a half octaves" | Wrong | 556 mm is about 24 white keys |
| Median shift 49 mm | Wrong | 48 mm |
| "22,354 playable notes" | Wrong label | 22,354 is the count after `dedup`. The MIDI files hold 23,537 note events. `dedup` merges 1,183 doubled pitches by design |

New findings added by the review:

- 65.6% of chord events hold one note, which explains the short positions.
- The chord builder drops 4 notes when two notes share a finger.
- The wrist target jumps when the next chord enters the look-ahead window, even while the current notes sound.
- `ProceduralHand` is a fallback with no contact solve, and Phase 2 must keep it working.
- The palm tilt and `centerX` are separate from the spring, and the camera presets depend on them.
- 161 of the 1,292 misses sit on chords the guard thought were reachable, so a better guard choice fixes those without any rig work.

What held up:

- Two runs of the harness give identical numbers, apart from the timing field.
- The chord window choice gives a different count for 8 groups of 15,189, so it does not drive the baseline.
- `src/handrig.js` and `src/songs.js` import cleanly in Node. Only `src/hands.js` does not.
- The reach probe uses an even sample across all 15 pieces, not the first pieces in file order. A first-fit sample gave 16.3% fixable. The even sample gives 15.8%, so the estimate is stable.
- A second run of the even sample returned the same figures: 63 of 400 fixable, 337 not fixable, and 1,089 projected misses of 15,189.
- `dedup` in `src/fingering.js` accounts for every note between the MIDI file and the hand split. No note goes missing without a cause.
- Shift p90 is 138 mm and p95 is 197 mm, as the first draft stated.

## Sources

- Yamaha, "The Basics Of Piano Keyboard Fingering": https://hub.yamaha.com/keyboards/k-how-to/the-basics-of-piano-keyboard-fingering/
- Rig facts and the contact solve: `docs/hand-model-plan.md`
- Measured baseline: `tools/measure-fingering.mjs`, run over the 15 pieces in `public/midi/`
- Rig limit: `tools/probe-reach.mjs`, an even sample of 400 missed chords across the same 15 pieces
- Clock and speed: `src/player.js:100` and `src/player.js:112`
