// The sheet-music overlay: a white paper band over the stage that scrolls the
// piece past a fixed marker. It reads the layout from src/score.js and builds
// only the blocks near the marker, so a long piece keeps a small DOM.
//
// The paper is an HTML overlay, not part of the WebGL scene. A recording
// captures the canvas only, so the view hides the paper while a capture runs.

import {
  BASS, BASS_MID_STEP, HEAD_RX, HEAD_RY, PAD, TREBLE, TREBLE_MID_STEP,
  layoutScore, staffTopStep,
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

// A glyph must be centred on a staff line, but a font file places its own ink
// above and below the baseline. These metrics give the shift that puts the ink
// centre on the line, whatever font the browser falls back to.
let measureContext = null;
const METRICS = new Map();
function glyphOffset(char, size, family) {
  const key = `${char}|${size}|${family}`;
  if (METRICS.has(key)) return METRICS.get(key);
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  measureContext.font = `${size}px ${family}`;
  const metrics = measureContext.measureText(char);
  const ascent = metrics.actualBoundingBoxAscent || size * 0.7;
  const descent = metrics.actualBoundingBoxDescent || 0;
  const offset = (ascent - descent) / 2;
  METRICS.set(key, offset);
  return offset;
}

export class ScoreView {
  constructor({ root, svg }) {
    this.root = root;
    this.svg = svg;
    this.notes = [];
    this.bars = [];
    this.layout = null;
    this.chunks = new Map();
    this.buckets = new Map();
    this.visible = false;
    this.recording = false;
    this.time = 0;
    this.paintedAt = NaN;
  }

  /** Take a new piece. `bars` holds the bar-line times in seconds. */
  setSong({ notes = [], bars = [] } = {}) {
    this.notes = notes;
    this.bars = bars;
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
  }

  _build() {
    const width = Math.max(260, Math.round(this.root.clientWidth || window.innerWidth * 0.7));
    const maxHeight = Math.min(200, Math.max(96, window.innerHeight * 0.26));
    const layout = layoutScore(this.notes, { bars: this.bars, width, maxHeight });
    this.layout = layout;
    this._clear();

    const height = Math.max(64, Math.round(layout.height));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', height);

    this.buckets = new Map();
    for (const glyph of layout.glyphs) {
      const index = Math.floor(glyph.time / layout.chunkSeconds);
      if (!this.buckets.has(index)) this.buckets.set(index, []);
      this.buckets.get(index).push(glyph);
    }

    const defs = SVG('defs');
    const fade = SVG('linearGradient', { id: 'sc-gutter', x1: 0, y1: 0, x2: 1, y2: 0 });
    fade.append(
      SVG('stop', { offset: '0.55', 'stop-color': '#fcfcfa' }),
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

  /** The clefs, the bracket, and the paper that fades the notes under them. */
  _drawGutter() {
    const layout = this.layout;
    const { gap, height } = layout;
    const width = Math.min(64, Math.max(40, gap * 5));
    this.gutterWidth = width;

    this.gutter = SVG('g', { class: 'sc-gutter' });
    this.gutter.appendChild(
      SVG('rect', { x: 0, y: 0, width, height, fill: 'url(#sc-gutter)' }),
    );

    const yOf = (step) => PAD + (layout.staves.topRef - step) * (gap / 2);
    const size = gap * 5;
    for (const [staff, step] of [[TREBLE, TREBLE_MID_STEP], [BASS, BASS_MID_STEP]]) {
      const clef = SVG('text', {
        class: 'sc-clef', x: width * 0.56, y: yOf(step) + glyphOffset(CLEF[staff], size, CLEF_FONT),
        'font-size': size, 'text-anchor': 'middle',
      });
      clef.textContent = CLEF[staff];
      this.gutter.appendChild(clef);
    }

    const top = yOf(staffTopStep(TREBLE));
    const bottom = yOf(staffTopStep(BASS) - 8);
    this.gutter.appendChild(SVG('path', {
      class: 'sc-bracket',
      d: `M ${width - 5} ${top} h -4 v ${bottom - top} h 4`,
    }));
    this.svg.appendChild(this.gutter);
  }

  /** The staff lines stay put; each scroll block draws its own stretch. */
  _drawStaves() {
    const layout = this.layout;
    const yOf = (step) => PAD + (layout.staves.topRef - step) * (layout.gap / 2);
    this.staves = SVG('g', { class: 'sc-staves' });
    for (const staff of [TREBLE, BASS]) {
      const top = staffTopStep(staff);
      for (let line = 0; line < 5; line++) {
        const y = yOf(top - line * 2);
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
    const yOf = (step) => PAD + (layout.staves.topRef - step) * (gap / 2);
    const block = SVG('g', { class: 'sc-block', transform: `translate(${x0} 0)` });

    const trebleTop = yOf(staffTopStep(TREBLE));
    const bassBottom = yOf(staffTopStep(BASS) - 8);
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
      node.appendChild(SVG('line', {
        class: 'sc-stem', x1: glyph.stem.x, x2: glyph.stem.x, y1: glyph.stem.y1, y2: glyph.stem.y2,
      }));

      const heads = [];
      for (const head of glyph.heads) {
        if (head.accidental) {
          const size = gap * 1.7;
          const accidental = SVG('text', {
            class: 'sc-acc', x: -HEAD_RX * gap * 1.5, 'text-anchor': 'middle',
            y: head.y + glyphOffset('\u266F', size, ACC_FONT), 'font-size': size,
          });
          accidental.textContent = '\u266F';
          node.appendChild(accidental);
        }
        const ellipse = SVG('ellipse', {
          class: 'sc-head', cx: 0, cy: head.y,
          rx: HEAD_RX * gap, ry: HEAD_RY * gap,
          transform: `rotate(-18 0 ${head.y})`,
        });
        node.appendChild(ellipse);
        heads.push({ el: ellipse, start: head.start, end: head.end });
      }
      block.appendChild(node);
      live.push({ heads, stem: node.querySelector('.sc-stem') });
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