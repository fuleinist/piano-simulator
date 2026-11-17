import fs from 'node:fs';
import MidiPkg from '@tonejs/midi';
const { Midi } = MidiPkg;

const cases = [
  ['grieg_op12_1_arietta.mid', 32.7, 33.0],
  ['liz_liebestraum.mid', 100.6, 100.9],
  ['pachelbel_canon.mid', 198.5, 198.8],
];
for (const [f, t0, t1] of cases) {
  const midi = new Midi(fs.readFileSync('public/midi/' + f));
  console.log('\n=== ' + f + ' window ' + t0 + '-' + t1 + ' ===');
  const rows = [];
  midi.tracks.forEach((t, ti) => {
    if (t.channel === 9) return;
    for (const n of t.notes) if (n.time >= t0 && n.time <= t1)
      rows.push({ t: n.time, midi: n.midi, track: ti, dur: n.duration });
  });
  rows.sort((a, b) => a.t - b.t);
  for (const r of rows) console.log(`  t=${r.t.toFixed(4)} midi=${r.midi} track=${r.track} dur=${r.dur.toFixed(3)}`);
}