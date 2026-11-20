// Responsive layout tests. Run: node --test tests/responsive.test.mjs
//
// A CSS file cannot be measured without a browser, so these tests guard the
// structure that the phone layout depends on. Each one names a defect that a
// real window measured: a hidden panel, a seek bar with no width, a transport
// bar under the panel, and targets too small for a finger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('src/styles.css');
const main = read('src/main.js');

/**
 * The body of every block that starts with this media query, joined. A rule in
 * one breakpoint therefore cannot satisfy a test for another.
 */
function mediaBlocks(query) {
  const bodies = [];
  let at = css.indexOf(query);
  while (at !== -1) {
    const open = css.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    bodies.push(css.slice(open, i + 1));
    at = css.indexOf(query, i);
  }
  return bodies.join('\n');
}

const phone = mediaBlocks('@media (max-width: 720px)');
const touch = mediaBlocks('@media (pointer: coarse)');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

test('the viewport keeps the full screen and the reader zoom', () => {
  const meta = html.match(/<meta\b[^>]*name="viewport"[^>]*>/);
  assert.ok(meta, 'index.html carries no viewport meta tag');
  // Without viewport-fit=cover the CSS safe-area insets read 0 on a notched
  // phone, and the bars sit under the notch.
  assert.match(attr(meta[0], 'content'), /viewport-fit=cover/, 'the viewport must extend under the notch');
  assert.doesNotMatch(meta[0], /user-scalable=no|maximum-scale=1(?![\d.])/, 'a reader must keep the zoom gesture');
});

test('a phone can reach every control', () => {
  // The panel holds the view buttons, the show toggles, the volume, and the
  // record button. It used to be display:none under 720px, so a phone lost
  // all of them.
  const button = html.match(/<button\b[^>]*\bid="panelBtn"[^>]*>/);
  assert.ok(button, 'index.html carries no #panelBtn');
  assert.equal(attr(button[0], 'aria-controls'), 'side', 'the button must name the panel');
  assert.equal(attr(button[0], 'aria-expanded'), 'false', 'the sheet starts closed');
  assert.ok(attr(button[0], 'aria-label'), 'the icon button needs a name');

  assert.match(phone, /#panelBtn\s*\{[^}]*display:\s*grid/, 'the button stays hidden on a phone');
  assert.match(phone, /#side\[data-open="true"\]\s*\{[^}]*display:\s*flex/, 'no rule opens the sheet');
  assert.doesNotMatch(phone, /#side section\s*\{[^}]*display:\s*none/, 'a section of the panel is hidden');
  // A short window has less height than the sections need, so the sheet must
  // scroll rather than push the last section off the screen.
  assert.match(phone, /#side\s*\{[^}]*overflow-y:\s*auto/, 'the sheet does not scroll');
  assert.match(phone, /#side\s*\{[^}]*max-height:/, 'the sheet has no height limit');
});

test('the sheet opens and closes from the panel button, the scrim, and Escape', () => {
  assert.match(html, /<div\b[^>]*\bid="panelScrim"/, 'no scrim in index.html');
  assert.match(html, /<button\b[^>]*\bid="panelClose"/, 'the sheet has no close button');
  assert.match(main, /panelBtn\.addEventListener\('click'/, 'the panel button is not wired');
  assert.match(main, /panelScrim\.addEventListener\('click'/, 'the scrim does not close the sheet');
  assert.match(main, /'Escape'/, 'Escape does not close the sheet');
  // A rotation to a wide window shows the panel in the corner, so a sheet left
  // open would keep its scrim over the stage.
  assert.match(main, /innerWidth\s*>\s*720/, 'a wide window leaves the sheet open');
});

test('the header stacks instead of overflowing at phone width', () => {
  // Three buttons and a 260px picker in one row cannot fit 320px. The header
  // becomes a grid, so each row keeps its own width.
  assert.match(phone, /#topbar\s*\{[^}]*display:\s*grid/, 'the header does not stack on a phone');
  assert.match(phone, /grid-template-columns:\s*repeat\(6/, 'the header grid has no column set');
  for (const id of ['loadBtn', 'libraryBtn', 'searchBtn']) {
    assert.match(phone, new RegExp(`#${id}\\s*\\{[^}]*grid-column:`), `#${id} takes no grid column`);
  }
  // The wrappers lose their box so their children join the header grid.
  assert.match(phone, /\.top-right,\s*\.song-controls\s*\{[^}]*display:\s*contents/);
  // A wrapper with no box passes no click through, so the children need the
  // rule that the header gives its own children.
  assert.match(phone, /#topbar \.btn[^{]*\{[^}]*pointer-events:\s*auto/, 'the stacked buttons take no click');
});

test('the seek bar keeps a width of its own', () => {
  // Measured before the fix: the seek input was 0px wide at 360px and 18px at
  // 414px, because the speed control could not shrink and took the row.
  assert.match(phone, /#transport\s*\{[^}]*grid-template-columns:\s*auto auto 1fr/, 'the transport is not a grid on a phone');
  assert.match(phone, /#seek\s*\{[^}]*grid-area:\s*seek/, 'the seek bar has no cell');
  assert.match(phone, /#seek\s*\{[^}]*width:\s*100%/, 'the seek bar does not fill its cell');
  assert.match(phone, /\.speed\s*\{[^}]*grid-area:\s*speed/, 'the speed control has no cell');
});

test('the transport sits clear of the side panel', () => {
  // A transport centred in the window slides under the 210px panel at about
  // 900px wide. It is now centred in the space left of the panel.
  const transport = css.match(/#transport\s*\{[^}]*\}/);
  assert.ok(transport, 'no #transport rule');
  assert.doesNotMatch(transport[0], /translateX\(-50%\)/, 'the transport is centred in the window');
  assert.match(transport[0], /right:\s*238px/, 'the transport does not reserve the panel width');
  assert.match(transport[0], /max-width:\s*760px/, 'the transport lost its width cap');
});

test('a touch target is at least 44px', () => {
  // A 30px button is a mouse target. A finger needs about 44px.
  assert.match(touch, /\.btn[^{]*\{[^}]*min-height:\s*44px/, 'buttons keep a mouse-sized height on a touch screen');
  assert.match(touch, /\.toggle\s*\{[^}]*padding:/, 'the toggle rows are too close together');
  assert.match(touch, /input\[type="range"\]\s*\{[^}]*height:/, 'a slider keeps a thin track');
});

test('the gesture hint names the device in hand', () => {
  assert.match(html, /class="hint hint-coarse"/, 'no touch hint in index.html');
  assert.match(html, /class="hint hint-fine"/, 'no pointer hint in index.html');
  assert.match(touch, /\.hint-fine\s*\{\s*display:\s*none/, 'the mouse hint stays on a touch screen');
});

test('a phone field does not zoom the page on focus', () => {
  // iOS zooms any field under 16px, which pushes the header off screen.
  for (const rule of ['.combobox input', '.search-form input', '.lib-rename input']) {
    assert.match(phone, new RegExp(`${rule.replace('.', '\\.')}[^{]*\\{[^}]*font-size:\\s*16px`), `${rule} stays under 16px`);
  }
});