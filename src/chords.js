// Chord grouping for the hand controllers. Pure module: no three.js and no
// window access, so Node tests and measurement tools can import it.
import { isBlack, keyTopY } from './layout.js';
import { CHORD_WINDOW } from './fingering.js';

export function buildChords(notes, hand) {
  const ns = notes.filter((n) => n.hand === hand).sort((a, b) => a.time - b.time);
  const chords = [];
  let i = 0;
  while (i < ns.length) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1].time - ns[i].time <= CHORD_WINDOW) j++;
    const group = ns.slice(i, j + 1);
    const fingers = {};
    let sx = 0, sz = 0, top = 0;
    for (const n of group) {
      fingers[n.finger] = n;
      sx += n.wristX;
      sz += isBlack(n.midi) ? 0.1 : 1.9;
      top = Math.max(top, keyTopY(n.midi));
    }
    chords.push({
      time: group[0].time,
      end: Math.max(...group.map((n) => n.time + n.duration)),
      wristX: sx / group.length,
      spread: group[0].spread || 1,
      strikeZ: sz / group.length,
      keyTop: top,
      fingers,
    });
    i = j + 1;
  }
  return chords;
}
