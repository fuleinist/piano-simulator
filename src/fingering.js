// Hand split + fingering assignment. Pure module: no three.js imports.
// Produces, for every note: hand ('L'/'R'), finger (1=thumb .. 5=pinky),
// wristX (target hand position in key units) and spread (hand stretch factor).
//
// Method:
//  1. Split notes between hands by staff. A MIDI track is the closest thing a
//     file has to a staff, so a track that names its hand keeps that hand for
//     every note. A file with no staff evidence falls back to the register rule
//     at middle C, chord by chord.
//  2. Group each hand's notes into chords (onsets within CHORD_WINDOW).
//  3. Beam search over finger assignments. Cost favours small hand shifts,
//     comfortable spans, finger reuse and pitch-ordered fingers.

import { keyX, isBlack } from './layout.js';

// One shared chord window for grouping, dedup and melody marking. The
// renderer and the measured baseline used the same window, so one constant
// removes the mismatch.
export const CHORD_WINDOW = 0.05; // s
const BEAM = 10;

// Natural finger offsets from the wrist, in white-key widths.
// Right hand: thumb(1) on the left, pinky(5) on the right. Left hand mirrored.
function fingerOffset(hand, finger) {
  return hand === 'R' ? (finger - 3) * 1.0 : (3 - finger) * 1.0;
}

function median(arr) {
  if (!arr.length) return 60;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// --- Step 1: hand split -------------------------------------------------
// A score divides the hands by staff, not by clef or register: the lower staff
// is the left hand even when its notes climb above middle C. A MIDI file has no
// staff, so a track stands in for one. Two kinds of evidence decide a chord.
//   1. A track name that names a hand ("Piano right", "Accompaniment left").
//      This is direct evidence of a staff, so it holds across the whole track.
//   2. The chord's own register, when no track names a hand. A chord wholly
//      above middle C belongs to the right hand, and a chord wholly below it to
//      the left. A chord that straddles middle C stays on one hand.
// A staff split that would put the left hand above the right is refused,
// because a MIDI file cannot mark a real hand crossing. The register decides
// instead, so the two hands never pass through each other.
//
// A chord may still reach beyond one hand. MAX_SPAN caps a single-hand span,
// and a wide chord divides between the hands where each hand can reach.
const MAX_SPAN = 15;
const NOTE_MAX = 5;
const MIDDLE_C = 60;
const spanOf = (ns) => ns[ns.length - 1].midi - ns[0].midi;

const SIDE_WORDS = {
  R: new Set(['right', 'rh', 'treble', 'discant', 'diskant']),
  L: new Set(['left', 'lh', 'bass', 'basso']),
};

// Hand named by a track title, or null. "Piano right", "Accompaniment left",
// "R.H." and "m.s." all resolve here.
function nameSide(name) {
  const tokens = String(name || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const side of ['R', 'L']) {
    if (tokens.some((t) => SIDE_WORDS[side].has(t))) return side;
  }
  return null;
}

// Group a chord by staff. A note with no staff takes the nearer staff by pitch,
// so a chord that names one staff takes every note.
function staffGroups(ns, sides) {
  const groups = { L: [], R: [] };
  const sum = { L: 0, R: 0 };
  for (let i = 0; i < ns.length; i++) {
    const side = sides[i];
    if (!side) continue;
    groups[side].push(ns[i]);
    sum[side] += ns[i].midi;
  }
  const centre = {
    L: groups.L.length ? sum.L / groups.L.length : null,
    R: groups.R.length ? sum.R / groups.R.length : null,
  };
  for (let i = 0; i < ns.length; i++) {
    if (sides[i]) continue;
    const nearL = centre.L === null ? Infinity : Math.abs(ns[i].midi - centre.L);
    const nearR = centre.R === null ? Infinity : Math.abs(ns[i].midi - centre.R);
    groups[nearL <= nearR ? 'L' : 'R'].push(ns[i]);
  }
  return groups;
}

const fitsHand = (ns) => ns.length <= NOTE_MAX && (ns.length < 2 || spanOf(ns) <= MAX_SPAN);

// True when the left-hand group sits above the right-hand group.
const crossed = (groups) => groups.L.length > 0 && groups.R.length > 0 &&
  groups.L[groups.L.length - 1].midi > groups.R[0].midi;

export function splitHands(notes) {
  const byTrack = new Map();
  for (const n of notes) {
    if (!byTrack.has(n.track)) byTrack.set(n.track, []);
    byTrack.get(n.track).push(n);
  }
  // The staff a track declares in its title. A track with no name has no staff
  // evidence, and its chords fall back to the register rule below.
  const namedSide = new Map();
  for (const [track, ns] of byTrack) namedSide.set(track, nameSide(ns[0].trackName));

  const out = notes.map((n) => ({ ...n }));
  const chords = groupChords(out);

  for (const chord of chords) {
    const ns = chord.notes; // pitch-ordered
    const n = ns.length;
    let staff = ns.map((x) => namedSide.get(x.track));
    if (staff.some(Boolean)) {
      // The file names a staff for at least one note of this chord. Keep every
      // note with its own staff, unless a staff group is beyond one hand.
      const groups = staffGroups(ns, staff);
      if (crossed(groups)) {
        // The named staves put the left hand above the right. No MIDI mark says
        // this is a real crossing, so the register decides instead.
        staff = ns.map(() => null);
      } else if (fitsHand(groups.L) && fitsHand(groups.R)) {
        for (const x of groups.L) x.hand = 'L';
        for (const x of groups.R) x.hand = 'R';
        continue;
      }
    }

    const straddles = ns[0].midi < MIDDLE_C && ns[n - 1].midi >= MIDDLE_C;
    const fitsOne = n <= NOTE_MAX && spanOf(ns) <= MAX_SPAN;
    if (fitsOne && !staff.some(Boolean)) {
      // No staff name, so the chord's own register decides. A chord that
      // straddles middle C stays on one hand, which keeps an octave whole: an
      // octave C3-C4 belongs to the left hand, and middle C alone to the right.
      const med = median(ns.map((x) => x.midi));
      const hand = med < MIDDLE_C || (straddles && med === MIDDLE_C) ? 'L' : 'R';
      for (const x of ns) x.hand = hand;
      continue;
    }

    // Wide or dense chord: divide between the hands. Prefer a division that
    // both hands can reach, and inside that set keep each note with its staff.
    // Fall back to the smallest span when no division is reachable.
    let best = null;
    let fallback = null;
    for (let k = 1; k < n; k++) {
      const lo = ns.slice(0, k);
      const hi = ns.slice(k);
      if (lo.length > NOTE_MAX || hi.length > NOTE_MAX) continue;
      const maxSpan = Math.max(spanOf(lo), spanOf(hi));
      const gap = hi[0].midi - lo[lo.length - 1].midi;
      const splitPitch = (hi[0].midi + lo[lo.length - 1].midi) / 2;
      const base =
        maxSpan * 1.0 +
        Math.abs(lo.length - hi.length) * 0.4 -
        Math.min(gap, 6) * 0.3 +
        Math.abs(splitPitch - MIDDLE_C) * 0.02;
      if (!fallback || base < fallback.score) fallback = { k, score: base };
      if (maxSpan > MAX_SPAN) continue;
      let wrongStaff = 0;
      for (let i = 0; i < n; i++) {
        if (staff[i] && staff[i] !== (i < k ? 'L' : 'R')) wrongStaff++;
      }
      const score = base + wrongStaff * 8;
      if (!best || score < best.score) best = { k, score };
    }
    const pick = best || fallback;
    if (pick) {
      for (let i = 0; i < n; i++) ns[i].hand = i < pick.k ? 'L' : 'R';
      continue;
    }

    // More than ten notes at once (rare rolled cluster): split by count.
    const half = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) ns[i].hand = i < half ? 'L' : 'R';
  }
  return out;
}

// --- Step 2: chord grouping ---------------------------------------------
function groupChords(notes) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const chords = [];
  for (const n of sorted) {
    const last = chords[chords.length - 1];
    if (last && n.time - last.time <= CHORD_WINDOW) {
      last.notes.push(n);
      last.time = Math.min(last.time, n.time);
    } else {
      chords.push({ time: n.time, notes: [n] });
    }
  }
  for (const c of chords) c.notes.sort((a, b) => a.midi - b.midi);
  return chords;
}

// --- Step 3: fingering beam search --------------------------------------
function combos(arr, k) {
  const res = [];
  const rec = (start, cur) => {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return res;
}

function candidates(hand, chord) {
  const ns = chord.notes;
  const n = ns.length;
  const xs = ns.map((x) => keyX(x.midi));
  const spanX = xs[xs.length - 1] - xs[0];
  const scale = Math.min(3.4, Math.max(0.72, spanX / 4 || 0.72));
  const list = [];
  if (n > 5) {
    // Very dense chord: keep the outer five notes, fold extras onto fingers.
    const keep = [ns[0], ns[1], ns[Math.floor(n / 2)], ns[n - 2], ns[n - 1]];
    return candidates(hand, { time: chord.time, notes: keep }).map((c) => ({ ...c, overflow: n - 5 }));
  }
  const fingers = [1, 2, 3, 4, 5];
  const orders = hand === 'R' ? combos(fingers, n) : combos(fingers, n).map((c) => c.reverse());
  for (const fs of orders) {
    // RH: finger number rises with pitch. LH: finger number falls with pitch.
    let ok = true;
    for (let i = 1; i < n; i++) {
      const gap = hand === 'R' ? fs[i] - fs[i - 1] : fs[i - 1] - fs[i];
      if (gap <= 0) { ok = false; break; }
      const interval = ns[i].midi - ns[i - 1].midi;
      const maxReach = 5 + 4 * gap;
      if (interval > maxReach) { ok = false; break; }
    }
    if (!ok) continue;
    let wristX = 0;
    for (let i = 0; i < n; i++) wristX += xs[i] - fingerOffset(hand, fs[i]) * scale;
    wristX /= n;
    let cost = 0;
    if (scale > 1.45) cost += (scale - 1.45) * 4;
    if (scale < 0.8 && n >= 3) cost += (0.8 - scale) * 2;
    // Thumb on a black key is awkward; penalise lightly.
    for (let i = 0; i < n; i++) if (fs[i] === 1 && isBlack(ns[i].midi)) cost += 0.7;
    list.push({ fingers: fs, wristX, scale, cost, notes: ns });
  }
  if (!list.length) {
    // Fallback: one finger per note in pitch order, spread across the span.
    const fs = hand === 'R'
      ? ns.map((_, i) => Math.min(5, i + 1))
      : ns.map((_, i) => Math.max(1, 5 - i));
    const fbScale = Math.min(3.4, Math.max(0.72, spanX / 4 || 0.72));
    let wristX = 0;
    for (let i = 0; i < n; i++) wristX += xs[i] - fingerOffset(hand, fs[i]) * fbScale;
    list.push({ fingers: fs, wristX: wristX / n, scale: fbScale, cost: 5, notes: ns });
  }
  return list;
}

function transitionCost(prev, next, gap) {
  const shift = Math.abs(next.wristX - prev.wristX);
  const urgency = 1 / (0.25 + Math.min(gap, 2));
  let c = shift * 0.32 * (0.5 + urgency);
  if (shift > 9) c += (shift - 9) * 0.9;
  // Reward keeping the same finger on the same pitch.
  const prevMap = new Map(prev.notes.map((n, i) => [n.midi, prev.fingers[i]]));
  for (let i = 0; i < next.notes.length; i++) {
    const f = prevMap.get(next.notes[i].midi);
    if (f === next.fingers[i]) c -= 0.5;
  }
  // Penalise repeating one finger across different nearby pitches.
  const used = new Map();
  for (let i = 0; i < next.notes.length; i++) {
    const f = next.fingers[i];
    if (used.has(f)) c += 0.8;
    used.set(f, true);
  }
  return c;
}

function assignHand(hand, notes) {
  const chords = groupChords(notes);
  if (!chords.length) return;
  let beam = candidates(hand, chords[0]).map((c) => ({ ...c, total: c.cost, path: [c] }));
  for (let k = 1; k < chords.length; k++) {
    const gap = chords[k].time - chords[k - 1].time;
    const cands = candidates(hand, chords[k]);
    const next = [];
    for (const b of beam) {
      for (const c of cands) {
        next.push({
          ...c,
          total: b.total + c.cost + transitionCost(b, c, gap),
          path: [...b.path, c],
        });
      }
    }
    next.sort((a, b) => a.total - b.total);
    beam = next.slice(0, BEAM);
  }
  const best = beam[0];
  for (const c of best.path) {
    for (let i = 0; i < c.notes.length; i++) {
      const n = c.notes[i];
      n.finger = c.fingers[i];
      n.wristX = c.wristX;
      n.spread = c.scale;
    }
  }
}

// --- Public API ----------------------------------------------------------
// Merge duplicate pitches at the same onset (doubled tracks press one key).
function dedup(notes) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const kept = [];
  for (const n of sorted) {
    const dup = kept.find((k) => k.midi === n.midi && Math.abs(k.time - n.time) <= CHORD_WINDOW);
    if (dup) {
      dup.duration = Math.max(dup.duration, n.duration);
      dup.velocity = Math.max(dup.velocity, n.velocity);
    } else {
      kept.push({ ...n });
    }
  }
  return kept;
}

export function assignFingering(notes) {
  const split = splitHands(dedup(notes));
  assignHand('L', split.filter((n) => n.hand === 'L'));
  assignHand('R', split.filter((n) => n.hand === 'R'));
  // Safety: every note must carry a valid assignment.
  for (const n of split) {
    if (!n.finger) {
      n.finger = 3;
      n.wristX = keyX(n.midi);
      n.spread = 1;
    }
  }
  return split;
}

// Melody flag: the highest note of each simultaneous group carries the tune.
// Used by the bar renderer: melody + loud notes draw wide, soft notes thin.
export function markMelody(notes) {
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].time - sorted[i].time <= CHORD_WINDOW) j++;
    let top = i;
    for (let k = i; k <= j; k++) if (sorted[k].midi > sorted[top].midi) top = k;
    for (let k = i; k <= j; k++) sorted[k].melody = k === top;
    i = j + 1;
  }
  return notes;
}