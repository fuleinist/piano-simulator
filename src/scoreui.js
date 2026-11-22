// The sheet-music overlay: a white paper band over the stage that scrolls the
// piece past a fixed marker. It reads the layout from src/score.js and builds
// only the blocks near the marker, so a long piece keeps a small DOM.
//
// The paper is an HTML overlay, not part of the WebGL scene. A recording
// captures the canvas only, so the view hides the paper while a capture runs.

import {
  BASS, BEAM_SPACE, BEAM_THICK, HEAD_RX, HEAD_RY, OPEN_RX, TREBLE, keyAt, keyMarkSteps,
  layoutScore, signatureAt,
} from './score.js';

const NS = 'http://www.w3.org/2000/svg';
const SVG = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

const CLEF = { treble: '\u{1D11E}', bass: '\u{1D122}' };
const CLEF_FONT = '"Bravura", "Segoe UI Symbol", "Noto Music", serif';
const ACC_FONT = '"Segoe UI Symbol", serif';
const FLAG_LEN = 1.5; // flag length, in line gaps
const SIG_FONT = '"Segoe UI Symbol", "Noto Music", serif';
// A sign from the layout reads as its music glyph: a sharp, a flat, a natural.
const ACC_GLYPH = { '#': '\u266F', b: '\u266D', n: '\u266E' };
const signGlyph = (sign) => ACC_GLYPH[sign] || sign;

/** The flag that hangs from the stem of an eighth or a sixteenth note. */
function flagPath(stem, gap, index) {
  const dir = stem.up ? 1 : -1;
  const x = stem.x;
  const y = stem.tip + dir * index * 0.5 * gap;
  const len = FLAG_LEN * gap;
  const w = 0.55 * gap;
  return `M ${x} ${y} C ${x + w} ${y + dir * len * 0.45}, ${x + w * 0.35} ${y + dir * len * 0.8}, ${x - w * 0.2} ${y + dir * len}`;
}

/** One rest, in paper coordinates. `y` is the line the rest reads from. */
function restNode(rest, gap, x) {
  if (rest.symbol === 'whole' || rest.symbol === 'half') {
    const height = 0.5 * gap;
    // A whole rest hangs under the fourth line, and a half rest sits on the
    // middle line, so each one reads from the line the layout gives it.
    const y = rest.symbol === 'whole' ? rest.y : rest.y - height;
    return SVG('rect', {
      class: 'sc-rest sc-rest-block', x: x - 0.6 * gap, y, width: 1.2 * gap, height,
    });
  }
  if (rest.symbol === 'eighth' || rest.symbol === 'sixteenth') {
    // The hooks hang in the spaces above the middle line.
    const group = SVG('g');
    const hooks = rest.symbol === 'sixteenth' ? 2 : 1;
    for (let hook = 0; hook < hooks; hook++) {
      const top = rest.y - 1.45 * gap + hook * 0.55 * gap;
      group.append(
        SVG('path', {
          class: 'sc-rest',
          d: `M ${x + 0.42 * gap} ${top} C ${x + 0.2 * gap} ${top + 0.45 * gap}, ${x - 0.05 * gap} ${rest.y - 0.35 * gap}, ${x - 0.32 * gap} ${rest.y + 0.3 * gap}`,
          'stroke-width': 0.22 * gap,
          fill: 'none',
        }),
        SVG('circle', {
          class: 'sc-rest-fill', cx: x + 0.32 * gap, cy: top + 0.2 * gap, r: 0.2 * gap,
        }),
      );
    }
    return group;
  }
  // A quarter rest reads as the classic zigzag, centred on the middle line.
  return SVG('path', {
    class: 'sc-rest',
    d: `M ${x - 0.3 * gap} ${rest.y - 0.95 * gap} L ${x + 0.4 * gap} ${rest.y - 0.3 * gap} L ${x - 0.2 * gap} ${rest.y + 0.1 * gap} L ${x + 0.45 * gap} ${rest.y + 0.85 * gap}`,
    'stroke-width': 0.26 * gap,
    fill: 'none',
  });
}

// A glyph must be centred on a staff line, but a font places its own ink above
// and below the baseline. The measured box gives the shift that puts the ink
// centre on the line, whatever font the browser falls back to.
const BASELINE = new Map();
function centredBaseline(char, size, family, target, host) {
  const key = `${char}|${size}|${family}`;
  let offset = BASELINE.get(key);
  if (offset === undefined) {
    const probe = SVG('text', { x: 0, y: 0, 'font-size': size, 'font-family': family });
    probe.textContent = char;
    host.appendChild(probe);
    const box = probe.getBBox();
    probe.remove();
    offset = -(box.y + box.height / 2);
    BASELINE.set(key, offset);
  }
  return target + offset;
}

export class ScoreView {
  constructor({ root, svg }) {
    this.root = root;
    this.svg = svg;
    this.notes = [];
    this.bars = [];
    this.meta = {};
    this.layout = null;
    this.chunks = new Map();
    this.buckets = new Map();
    this.visible = false;
    this.recording = false;
    this.time = 0;
    this.paintedAt = NaN;
  }

  /** Take a new piece. `bars` holds the bar-line times in seconds. */
  setSong({ notes = [], bars = [], meta = {} } = {}) {
    this.notes = notes;
    this.bars = bars;
    this.meta = meta;
    this.layout = null;
    this.paintedAt = NaN;
    this._clear();
    if (this.visible) this._build();
  }

  setVisible(on) {
    this.visible = Boolean(on);
    this.root.hidden = !this.visible || this.recording;
    if (this.visible) {
      if (!this.layout) this._build();
      this.paintedAt = NaN;
      this.update(this.time);
    }
  }

  /** A recording captures the canvas, so the paper must not claim to be in it. */
  setRecording(on) {
    this.recording = Boolean(on);
    this.root.hidden = !this.visible || this.recording;
  }

  resize() {
    if (!this.visible) {
      this.layout = null;
      return;
    }
    this._build();
    this.paintedAt = NaN;
    this.update(this.time);
  }

  /** Move the paper to the piece time, in seconds. */
  update(time) {
    this.time = time;
    if (!this.visible || this.recording || !this.layout) return;
    if (!Number.isFinite(time) || time === this.paintedAt) return;
    this.paintedAt = time;
    this._paint(time);
  }

  // --- Build -------------------------------------------------------------

  _clear() {
    for (const chunk of this.chunks.values()) chunk.g.remove();
    this.chunks.clear();
    this.buckets.clear();
    this.svg.replaceChildren();
    this.world = null;
    this.gutter = null;
    this.needle = null;
    this.staves = null;
    this.marks = new Map();
    this.sigNodes = null;
    this.sigKey = null;
    this.keyNodes = null;
    this.keyKey = null;
  }

  _build() {
    const width = Math.max(260, Math.round(this.root.clientWidth || window.innerWidth * 0.7));
    // The band is the first thing the eye needs, so it takes a third of the
    // window. The camera sits lower, so a taller band stays clear of the keys.
    const maxHeight = Math.min(280, Math.max(120, window.innerHeight * 0.38));
    const layout = layoutScore(this.notes, {
      bars: this.bars,
      width,
      maxHeight,
      tempos: this.meta.tempos || [],
      ppq: this.meta.ppq || 480,
      timeSignatures: this.meta.timeSignatures || [],
      keySignatures: this.meta.keySignatures || [],
    });
    this.layout = layout;
    this._clear();

    const height = Math.max(64, Math.round(layout.height));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', height);

    this.buckets = new Map();
    this.marks = new Map();
    const bucketOf = (map, time) => {
      const index = Math.floor(time / layout.chunkSeconds);
      if (!map.has(index)) map.set(index, []);
      return map.get(index);
    };
    for (const glyph of layout.glyphs) bucketOf(this.buckets, glyph.time).push(glyph);
    for (const mark of layout.marks) bucketOf(this.marks, mark.time).push(mark);

    const defs = SVG('defs');
    const fade = SVG('linearGradient', { id: 'sc-gutter', x1: 0, y1: 0, x2: 1, y2: 0 });
    fade.append(
      SVG('stop', { offset: '0.55', 'stop-color': '#fcfcfa', 'stop-opacity': 0.4 }),
      SVG('stop', { offset: '1', 'stop-color': '#fcfcfa', 'stop-opacity': 0 }),
    );
    defs.appendChild(fade);
    this.svg.appendChild(defs);

    this._drawStaves();
    this.world = SVG('g', { class: 'sc-world' });
    this.svg.append(this.world);
    this._drawGutter();
    this._drawNeedle();

    this.paintedAt = NaN;
    if (this.visible && !this.recording) this.update(this.time);
  }

  /** The clefs, the key signature, the time signature, the bracket, and the paper that fades the notes. */
  _drawGutter() {
    const layout = this.layout;
    const { gap, height } = layout;
    // Room for a clef, the key signature and a time signature, so none of them
    // covers a scrolling note. The widest signature of the piece sets the room.
    const signs = Math.max(0, ...layout.keys.map((key) => Math.abs(key.accidentals)));
    this.keyGap = gap * 1.05;
    this.clefX = gap * 2.5;
    this.keyX = gap * 5.2;
    this.sigX = this.keyX + signs * this.keyGap + gap * 0.9;
    const width = Math.min(180, Math.max(70, this.sigX + gap * 1.6));
    this.gutterWidth = width;

    this.gutter = SVG('g', { class: 'sc-gutter' });
    this.gutter.appendChild(
      SVG('rect', { x: 0, y: 0, width, height, fill: 'url(#sc-gutter)' }),
    );

    const staves = layout.staves;
    const size = gap * 5;
    for (const staff of [TREBLE, BASS]) {
      // The ink of a clef is centred on the middle line of its own staff.
      const middle = this._yOf(staff === BASS ? staves.bassTop - 4 : staves.trebleTop - 4, staff);
      const clef = SVG('text', {
        class: 'sc-clef', x: this.clefX,
        y: centredBaseline(CLEF[staff], size, CLEF_FONT, middle, this.svg),
        'font-size': size, 'text-anchor': 'middle',
      });
      clef.textContent = CLEF[staff];
      this.gutter.appendChild(clef);
    }

    // The key signature sits right of the clefs, and it follows the playhead the
    // way the time signature does. Each staff keeps an empty group to fill.
    this.keyNodes = [];
    for (const staff of [TREBLE, BASS]) {
      const group = SVG('g', { class: 'sc-key', 'data-staff': staff });
      this.gutter.appendChild(group);
      this.keyNodes.push({ staff, group });
    }
    this.keyKey = null;
    this._showKey(null);

    // The time signature sits right of the key signature, on both staves, and it
    // follows the playhead when the piece changes signature. Each digit fills
    // two of the spaces next to the middle line, as a printed score sets them.
    const sigSize = gap * 2.3;
    this.sigNodes = [];
    for (const staff of [TREBLE, BASS]) {
      const middle = this._yOf(staff === BASS ? staves.bassTop - 4 : staves.trebleTop - 4, staff);
      const pair = {};
      for (const [key, target] of [['top', middle - gap], ['bottom', middle + gap]]) {
        const node = SVG('text', {
          class: 'sc-sig', x: this.sigX, 'text-anchor': 'middle',
          'font-size': sigSize, y: target,
        });
        this.gutter.appendChild(node);
        pair[key] = { node, target };
      }
      this.sigNodes.push(pair);
    }
    this.sigKey = null;
    this._showSignature(null);

    const top = staves.trebleTopY;
    const bottom = staves.bassBottomY;
    this.gutter.appendChild(SVG('path', {
      class: 'sc-bracket',
      d: `M ${width - 5} ${top} h -4 v ${bottom - top} h 4`,
    }));
    this.svg.appendChild(this.gutter);
  }

  /** The y of a step on a staff, in paper coordinates. */
  _yOf(step, staff) {
    const { gap, staves } = this.layout;
    return (staff === BASS ? staves.bassTopY : staves.trebleTopY)
      + ((staff === BASS ? staves.bassTop : staves.trebleTop) - step) * (gap / 2);
  }

  /** Write the marks of the key in force at a time into the gutter. */
  _showKey(time) {
    const keys = this.layout ? this.layout.keys : [];
    if (!keys.length || !this.keyNodes) return;
    const key = time === null ? keys[0] : keyAt(keys, time);
    if (!key || this.keyKey === key.accidentals) return;
    this.keyKey = key.accidentals;
    // A mark reads a little larger than an accidental beside a notehead, as the
    // engraver sets it.
    const size = this.layout.gap * 1.9;
    for (const { staff, group } of this.keyNodes) {
      group.replaceChildren(...keyMarkSteps(key.accidentals, staff).map((mark, index) => {
        const sign = signGlyph(mark.sign);
        const node = SVG('text', {
          class: 'sc-key-mark',
          x: this.keyX + index * this.keyGap,
          'text-anchor': 'middle',
          'font-size': size,
          y: centredBaseline(sign, size, ACC_FONT, this._yOf(mark.step, staff), this.svg),
        });
        node.textContent = sign;
        return node;
      }));
    }
  }

  /** Write the time signature of the current time into the gutter. */
  _showSignature(time) {
    const segments = this.layout ? this.layout.signatures : [];
    const sig = time === null ? segments[0] : signatureAt(segments, time);
    if (!sig) return;
    const key = `${sig.beats}/${sig.unit}`;
    if (this.sigKey === key) return;
    this.sigKey = key;
    for (const pair of this.sigNodes || []) {
      this._setDigit(pair.top, String(sig.beats));
      this._setDigit(pair.bottom, String(sig.unit));
    }
  }

  /** Put one digit of the signature on the space that belongs to it. */
  _setDigit(cell, text) {
    if (cell.node.textContent !== text) cell.node.textContent = text;
    const size = this.layout.gap * 2.3;
    cell.node.setAttribute('y', centredBaseline(text, size, SIG_FONT, cell.target, this.svg));
  }

  /** The staff lines stay put; each scroll block draws its own stretch. */
  _drawStaves() {
    const layout = this.layout;
    this.staves = SVG('g', { class: 'sc-staves' });
    for (const staff of [TREBLE, BASS]) {
      const top = staff === TREBLE ? layout.staves.trebleTopY : layout.staves.bassTopY;
      for (let line = 0; line < 5; line++) {
        const y = top + line * layout.gap;
        this.staves.appendChild(SVG('line', {
          class: 'sc-line', x1: 0, x2: layout.width, y1: y, y2: y,
        }));
      }
    }
    this.svg.appendChild(this.staves);
  }

  _drawNeedle() {
    const layout = this.layout;
    const x = Math.round(layout.playheadRatio * layout.width);
    this.needle = SVG('g', { class: 'sc-needle' });
    this.needle.append(
      SVG('line', { class: 'sc-playhead-glow', x1: x, x2: x, y1: 0, y2: layout.height }),
      SVG('line', { class: 'sc-playhead', x1: x, x2: x, y1: 0, y2: layout.height }),
    );
    this.svg.appendChild(this.needle);
  }

  // --- Chunks ------------------------------------------------------------

  _chunk(index) {
    const layout = this.layout;
    const { gap, pxPerSecond } = layout;
    const start = index * layout.chunkSeconds;
    const span = layout.chunkSeconds * pxPerSecond;
    const x0 = start * pxPerSecond;
    const block = SVG('g', { class: 'sc-block', transform: `translate(${x0} 0)` });

    const trebleTop = layout.staves.trebleTopY;
    const bassBottom = layout.staves.bassBottomY;
    for (const time of layout.bars) {
      if (time < start || time >= start + layout.chunkSeconds) continue;
      const x = (time - start) * pxPerSecond;
      block.appendChild(SVG('line', {
        class: 'sc-bar', x1: x, x2: x, y1: trebleTop, y2: bassBottom,
      }));
    }

    const live = [];
    for (const glyph of this.buckets.get(index) || []) {
      const node = SVG('g', { class: 'sc-note', transform: `translate(${glyph.x - x0} 0)` });
      for (const ledger of glyph.ledgers) {
        node.appendChild(SVG('line', {
          class: 'sc-ledger', x1: ledger.x1, x2: ledger.x2, y1: ledger.y, y2: ledger.y,
        }));
      }
      if (glyph.stem) {
        node.appendChild(SVG('line', {
          class: 'sc-stem', x1: glyph.stem.x, x2: glyph.stem.x, y1: glyph.stem.y1, y2: glyph.stem.y2,
        }));
      }
      // A beamed note gets no flag: the beam shows the value instead.
      for (let flag = 0; flag < glyph.flags; flag++) {
        node.appendChild(SVG('path', { class: 'sc-flag', d: flagPath(glyph.stem, gap, flag) }));
      }

      const rx = (glyph.value.open ? OPEN_RX : HEAD_RX) * gap;
      const heads = [];
      for (const head of glyph.heads) {
        if (head.accidental) {
          const size = gap * 1.7;
          // The accidental reads from the same line as its notehead, and it
          // keeps clear of the head so the two marks do not touch.
          const sign = signGlyph(head.accidental);
          const accidental = SVG('text', {
            class: 'sc-acc', x: -(rx + 0.9 * gap), 'text-anchor': 'middle',
            y: centredBaseline(sign, size, ACC_FONT, head.y, this.svg),
            'font-size': size,
          });
          accidental.textContent = sign;
          node.appendChild(accidental);
        }
        const ellipse = SVG('ellipse', {
          class: glyph.value.open ? 'sc-head open' : 'sc-head',
          cx: 0, cy: head.y, rx, ry: HEAD_RY * gap,
          transform: `rotate(-18 0 ${head.y})`,
          'stroke-width': glyph.value.open ? 0.17 * gap : 0,
        });
        node.appendChild(ellipse);
        heads.push({ el: ellipse, start: head.start, end: head.end });
      }
      for (const dot of glyph.dots) {
        node.appendChild(SVG('circle', {
          class: 'sc-dot', cx: dot.x, cy: dot.y, r: 0.15 * gap,
        }));
      }
      block.appendChild(node);
      live.push({ heads, stem: node.querySelector('.sc-stem') });
    }

    for (const mark of this.marks.get(index) || []) {
      if (mark.kind === 'beam') {
        for (let line = 0; line < mark.count; line++) {
          // The first line sits on the stem tips and each further line steps
          // toward the heads by one thickness and one space.
          const drop = line * (BEAM_THICK + BEAM_SPACE) * gap * (mark.up ? 1 : -1);
          block.appendChild(SVG('line', {
            class: 'sc-beam',
            x1: mark.x1 - x0, y1: mark.y1 + drop,
            x2: mark.x2 - x0, y2: mark.y2 + drop,
            'stroke-width': BEAM_THICK * gap,
          }));
        }
      } else if (mark.kind === 'rest') {
        block.appendChild(restNode(mark, gap, mark.x - x0));
      }
    }

    this.world.appendChild(block);
    const chunk = { g: block, live };
    this.chunks.set(index, chunk);
    return chunk;
  }

  _paint(time) {
    const layout = this.layout;
    const { pxPerSecond, chunkSeconds } = layout;
    const playheadX = layout.playheadRatio * layout.width;
    this.world.setAttribute('transform', `translate(${playheadX - time * pxPerSecond} 0)`);
    this._showSignature(time);
    this._showKey(time);

    const first = Math.floor((time - playheadX / pxPerSecond) / chunkSeconds);
    const last = Math.floor((time + (layout.width - playheadX) / pxPerSecond) / chunkSeconds);
    const highest = Math.max(0, Math.ceil(layout.duration / chunkSeconds));

    for (let index = Math.max(0, first - 1); index <= Math.min(highest, last + 1); index++) {
      if (!this.chunks.has(index)) this._chunk(index);
    }
    for (const [index, chunk] of this.chunks) {
      if (index < first - 1 || index > last + 1 || index > highest) {
        chunk.g.remove();
        this.chunks.delete(index);
      }
    }

    for (const chunk of this.chunks.values()) {
      for (const entry of chunk.live) {
        let sounding = false;
        for (const head of entry.heads) {
          const on = time >= head.start && time < head.end;
          head.el.classList.toggle('on', on);
          if (on) sounding = true;
        }
        if (entry.stem) entry.stem.classList.toggle('on', sounding);
      }
    }
  }
}