import fs from 'node:fs';
import MidiPkg from '@tonejs/midi';
const { Midi } = MidiPkg;
import { assignFingering } from '../src/fingering.js';

for (const f of ['grieg_op12_1_arietta.mid', 'liz_liebestraum.mid', 'pachelbel_canon.mid']) {
  const midi = new Midi(fs.readFileSync('public/midi/' + f));
  const notes = [];
  midi.tracks.forEach((t, ti) => {
    if (t.channel === 9) return;
    for (const n of t.notes) if (n.midi >= 21 && n.midi <= 108)
      notes.push({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity, track: ti });
  });
  const a = assignFingering(notes);
  for (const hand of ['L', 'R']) {
    const ns = a.filter((n) => n.hand === hand).sort((x, y) => x.time - y.time);
    let i = 0;
    while (i < ns.length) {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1].time - ns[i].time <= 0.045) j++;
      const span = ns[j].midi - ns[i].midi;
      if (span > 16) {
        console.log(f, hand, 't=' + ns[i].time.toFixed(3), 'count=' + (j - i + 1), 'span=' + span,
          'pitches=' + ns.slice(i, j + 1).map((n) => n.midi).join(','));
      }
      i = j + 1;
    }
  }
}