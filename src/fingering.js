// Hand split + fingering assignment. Pure module: no three.js imports.
// Produces, for every note: hand ('L'/'R'), finger (1=thumb .. 5=pinky),
// wristX (target hand position in key units) and spread (hand stretch factor).
//
// Method:
//  1. Split notes between hands by MIDI track median pitch, else by pitch.
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
// Chord-aware split: no hand may hold a chord wider than MAX_SPAN semitones
// or more than 5 notes. Wide chords divide between the hands at the best gap.
const MAX_SPAN = 15;
const spanOf = (ns) => ns[ns.length - 1].midi - ns[0].midi;

export function splitHands(notes) {
  const byTrack = new Map();
  for (const n of notes) {
    if (!byTrack.has(n.track)) byTrack.set(n.track, []);
    byTrack.get(n.track).push(n);
  }
  const trackSide = new Map();
  for (const [track, ns] of byTrack) {
    const med = median(ns.map((n) => n.midi));
    trackSide.set(track, med < 57 ? 'L' : med >= 63 ? 'R' : null);
  }

  const out = notes.map((n) => ({ ...n }));
  const chords = groupChords(out);

  for (const chord of chords) {
    const ns = chord.notes; // pitch-ordered
    const n = ns.length;
    const fitsOne = n <= 5 && spanOf(ns) <= MAX_SPAN;

    if (fitsOne) {
      // One hand can play the whole chord: pick by track hint, then register.
      const hints = new Set(ns.map((x) => trackSide.get(x.track)));
      let hand;
      if (hints.size === 1 && !hints.has(null)) hand = [...hints][0];
      else hand = median(ns.map((x) => x.midi)) < 60 ? 'L' : 'R';
      for (const x of ns) x.hand = hand;
      continue;
    }

    // Wide or dense chord: divide between the hands. Choose the partition
    // that minimises the widest hand span, stretching only when forced.
    let best = null;
    for (let k = 1; k < n; k++) {
      const lo = ns.slice(0, k);
      const hi = ns.slice(k);
      if (lo.length > 5 || hi.length > 5) continue;
      const maxSpan = Math.max(spanOf(lo), spanOf(hi));
      const gap = hi[0].midi - lo[lo.length - 1].midi;
      const splitPitch = (hi[0].midi + lo[lo.length - 1].midi) / 2;
      const score =
        maxSpan * 1.0 +
        Math.abs(lo.length - hi.length) * 0.4 -
        Math.min(gap, 6) * 0.3 +
        Math.abs(splitPitch - 60) * 0.02;
      if (!best || score < best.score) best = { k, score };
    }
    if (best) {
      for (let i = 0; i < n; i++) ns[i].hand = i < best.k ? 'L' : 'R';
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