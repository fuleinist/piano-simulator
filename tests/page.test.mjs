// Page and deploy-config tests. Run: node --test tests/page.test.mjs
//
// These guard the two things a reader of the repo cannot see break from a unit
// test: the repository link in the header, and the deploy wiring that keeps the
// published site in step with main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const html = read('index.html');
const pkg = JSON.parse(read('package.json'));
const css = read('src/styles.css');
const workflow = read('.github/workflows/deploy.yml');

// wrangler.jsonc allows comments, so drop the line comments before parsing.
const wrangler = JSON.parse(
  read('wrangler.jsonc')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, ''),
);

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};

test('the header links to the repository', () => {
  const anchor = html.match(/<a\b[^>]*class="icon-link"[^>]*>/);
  assert.ok(anchor, 'index.html carries no .icon-link anchor');

  const href = attr(anchor[0], 'href');
  assert.ok(href, 'the repository link has no href');
  const remote = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  assert.equal(href.replace(/\.git$/, ''), remote, 'header link and package.json repository disagree');

  // A link that leaves the page needs its own tab and no opener access.
  assert.equal(attr(anchor[0], 'target'), '_blank');
  assert.match(attr(anchor[0], 'rel') || '', /noopener/);
  // The icon carries no text, so it needs a label for a screen reader.
  assert.ok(attr(anchor[0], 'aria-label'), 'the icon link needs an aria-label');
  assert.equal(attr(anchor[0], 'aria-label'), attr(anchor[0], 'title'));
});

test('the icon link is styled and sits in the top bar', () => {
  assert.match(css, /\.icon-link\s*\{/, 'no .icon-link rule in styles.css');
  const header = html.slice(html.indexOf('<header id="topbar"'), html.indexOf('</header>'));
  assert.ok(header.includes('class="icon-link"'), 'the link belongs in the top bar');
});

test('the song picker is a searchable combobox, not a native select', () => {
  assert.doesNotMatch(html, /<select\b[^>]*\bid="songSelect"/, 'the native select is still in index.html');

  const inputTag = html.match(/<input\b[^>]*\bid="songSearch"[^>]*>/);
  assert.ok(inputTag, 'index.html carries no #songSearch input');
  const tag = inputTag[0];

  // WAI-ARIA 1.2 combobox: the input keeps focus and drives a listbox popup.
  assert.ok(attr(tag, 'aria-label'), 'the picker needs an accessible name');
  assert.equal(attr(tag, 'aria-expanded'), 'false', 'the popup starts closed');
  assert.equal(attr(tag, 'aria-autocomplete'), 'list');
  assert.ok(/\brole="combobox"/.test(tag), 'the input declares no combobox role');

  const popup = html.match(/<div\b[^>]*\brole="listbox"[^>]*>/);
  assert.ok(popup, 'index.html carries no listbox popup');
  assert.equal(attr(popup[0], 'id'), attr(tag, 'aria-controls'), 'aria-controls must name the listbox');
  assert.ok(/\bhidden\b/.test(popup[0]), 'the listbox must start hidden');

  // A styleable popup and touch-sized rows.
  assert.match(css, /\.cb-list\s*\{/, 'no .cb-list rule in styles.css');
  assert.match(css, /\.cb-option\s*\{/, 'no .cb-option rule in styles.css');
});

test('the global shortcuts do not fire while the picker has focus', () => {
  const main = read('src/main.js');
  assert.doesNotMatch(main, /\$\(['"]songSelect['"]\)/, 'main.js still drives the removed select');
  // The guard must cover the combobox, not only <input>: the popup and the
  // container sit outside a tag-name check.
  assert.match(main, /isTypingTarget/, 'main.js has no typing guard');
  const guard = main.slice(main.indexOf('const isTypingTarget'), main.indexOf('window.addEventListener(\'keydown\''));
  assert.match(guard, /#songPicker/, 'the typing guard does not cover the song picker');
  assert.match(guard, /input, textarea, select/, 'the typing guard dropped the plain field check');
});

test('the view pad spins the pan around the zoom pair', () => {
  // Pan is an angle spin and not a slide, so each press carries its degrees.
  const pads = [...html.matchAll(/<button\b[^>]*\bdata-orbit="([^"]+)"[^>]*>/g)];
  assert.equal(pads.length, 2, 'index.html needs two pan spins');
  assert.deepEqual(pads.map((m) => m[1]).sort(), ['-12', '12'], 'the pan pair needs both directions');
  for (const m of pads) {
    // An icon-only button carries no text for a screen reader.
    assert.ok(attr(m[0], 'aria-label'), 'every pan spin needs an aria-label');
    assert.equal(attr(m[0], 'aria-label'), attr(m[0], 'title'));
  }
  // The two circle arrows carry the meaning, and the icon needs no label of
  // its own because the button names the action.
  assert.match(html, /<circle\b[^>]*\bcx="8"[^>]*\bcy="8"[^>]*\br="5"[^>]*\bstroke-dasharray=/,
    'no circle-arrow mark in index.html');
  assert.match(html, /<path\b[^>]*\bd="M8\.3 1\.8L10\.5 3L8\.3 4\.2Z"/,
    'the circle arrow needs its head');
  assert.equal((html.match(/scale\(-1,1\) translate\(-16,0\)/g) || []).length, 1,
    'one circle arrow must be the mirrored copy');

  const open = html.indexOf('<div class="viewpad">');
  assert.ok(open > 0, 'index.html carries no .viewpad');
  const pad = html.slice(open, html.indexOf('</div>', open));
  assert.ok(pad.includes('id="zoomIn"') && pad.includes('id="zoomOut"'), 'the zoom pair belongs in the pad');
  assert.match(css, /\.viewpad\s*\{/, 'no .viewpad rule in styles.css');

  const main = read('src/main.js');
  assert.match(main, /\[data-orbit\]/, 'main.js does not wire the pan spins');
  assert.match(main, /scene\.orbitBy\(/, 'main.js calls no orbit spin');
});

test('a camera gesture keeps the view it reaches', () => {
  const scene = read('src/scene.js');
  assert.match(scene, /orbitBy\(deg\)/, 'scene.js has no orbit spin');
  // A spin turns the angle and keeps the distance.
  const spin = scene.slice(scene.indexOf('orbitBy(deg)'), scene.indexOf('zoomBy(factor)'));
  assert.match(spin, /_base\.pos/, 'a spin must move the anchor');
  assert.doesNotMatch(spin, /radius|distance/i, 'a spin must not change the distance');
  assert.match(scene, /_settling/, 'scene.js has no travel flag');

  // The anchor must not be taken from the camera before the gesture runs.
  // That copy is the view the gesture started from, so the preset lerp pulls
  // the view back and every drag, zoom, or spin is lost.
  const start = scene.indexOf("addEventListener('start'");
  const end = scene.indexOf("addEventListener('end'");
  assert.ok(start > 0 && end > start, 'scene.js has no gesture handlers');
  const handler = scene.slice(start, end);
  assert.doesNotMatch(handler, /_syncBaseFromCamera/,
    'the anchor is taken before the gesture runs, so the gesture snaps back');
  // An idle frame holds the anchor on the view on screen.
  assert.match(scene, /if \(!this\._settling && !follow\)/,
    'scene.js has no idle frame that leaves the camera alone');
});

test('every test file runs under npm test', () => {
  const dir = new URL('../tests/', import.meta.url);
  const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(suites.length >= 8, 'the test directory looks empty');
  for (const suite of suites) {
    assert.ok(pkg.scripts.test.includes(`tests/${suite}`), `${suite} is not in the npm test script`);
  }
});

test('the local library has a dialog and a persistent store', () => {
  const button = html.match(/<button\b[^>]*\bid="libraryBtn"[^>]*>/);
  assert.ok(button, 'index.html carries no #libraryBtn');
  assert.equal(attr(button[0], 'aria-haspopup'), 'dialog', 'the button must announce the dialog');

  const dialog = html.match(/<dialog\b[^>]*\bid="libraryDialog"[^>]*>/);
  assert.ok(dialog, 'index.html carries no library dialog');
  const labelled = attr(dialog[0], 'aria-labelledby');
  assert.ok(labelled, 'the dialog needs a name');
  assert.ok(html.includes(`id="${labelled}"`), 'aria-labelledby must name a real element');
  assert.match(html, /<ul\b[^>]*\bid="libList"/, 'the dialog needs its list');
  assert.match(html, /\bmultiple\b/, 'the file input should accept a batch');
  assert.match(css, /\.lib-dialog\s*\{/, 'no .lib-dialog rule in styles.css');

  // The bytes belong in IndexedDB: localStorage is string-only and near 5 MB.
  const store = read('src/librarystore.js');
  // The comment above the module explains the choice; this checks for a call.
  for (const file of ['src/librarystore.js', 'src/library.js', 'src/libraryui.js', 'src/main.js']) {
    assert.doesNotMatch(read(file), /localStorage\s*[.[]/, `${file} must not reach for localStorage`);
  }
  assert.match(store, /indexedDB\.open/, 'the library must open an IndexedDB database');
  assert.match(read('src/library.js'), /crypto\.subtle\.digest/, 'imports must dedupe on a content hash');
});

test('the remote search is wired to a Worker proxy', () => {
  assert.match(html, /<button\b[^>]*\bid="searchBtn"[^>]*aria-haspopup="dialog"/, 'no #searchBtn');
  const dialog = html.match(/<dialog\b[^>]*\bid="searchDialog"[^>]*>/);
  assert.ok(dialog, 'index.html carries no #searchDialog');
  const labelled = attr(dialog[0], 'aria-labelledby');
  assert.ok(html.includes(`id="${labelled}"`), 'aria-labelledby must name a real element');
  assert.match(html, /<input\b[^>]*\bid="searchInput"/, 'the dialog needs a search field');
  assert.match(html, /<ul\b[^>]*\bid="searchResults"/, 'the dialog needs a result list');

  // The Worker serves the site and owns /api/midi. Without the binding the
  // script has nothing to serve the build from.
  assert.equal(wrangler.main, 'worker/index.js', 'wrangler must run the Worker');
  assert.equal(wrangler.assets.binding, 'ASSETS', 'the Worker needs the assets binding');
  const worker = read('worker/index.js');
  assert.match(worker, /'\/api\/midi'/, 'the Worker must route the proxy path');
  assert.match(worker, /env\.ASSETS\.fetch/, 'the Worker must fall through to the assets');

  // The dev and preview servers have no Worker, so the same handler runs as
  // middleware there. Otherwise the feature only works after a deploy.
  const vite = read('vite.config.js');
  assert.match(vite, /worker\/proxy\.js/, 'vite must reuse the proxy handler');
  assert.match(vite, /configurePreviewServer/, 'vite preview must serve the proxy too');

  // The proxy is the only new network surface, so its limits are guarded.
  const proxy = read('worker/proxy.js');
  assert.match(proxy, /isAllowedTarget/, 'the proxy needs an address allowlist');
  assert.match(proxy, /MAX_BYTES/, 'the proxy needs a size cap');
  assert.match(proxy, /RateLimiter/, 'the proxy needs a rate limit');
});

test('the deploy publishes the build output', () => {
  assert.equal(wrangler.assets.directory, './dist', 'the Worker must serve dist/');
  // vite writes to dist/ unless vite.config.js says otherwise.
  assert.doesNotMatch(read('vite.config.js'), /outDir/, 'vite outDir moved; update wrangler.jsonc');
  // The deploy script has to build first, or it would publish the last bundle.
  assert.match(pkg.scripts.deploy, /npm run build/);
  assert.match(pkg.scripts.deploy, /wrangler deploy/);
  assert.match(pkg.devDependencies.wrangler, /^\^\d+\./, 'wrangler must be a pinned devDependency');
});

test('main is the only branch that deploys, and it deploys only a tested build', () => {
  const on = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('concurrency:'));
  assert.match(on, /^\s{2}push:/m, 'the workflow does not run on push');
  assert.match(on, /branches:\s*\[main\]/, 'the deploy must be limited to main');

  const order = ['npm ci', 'npm test', 'npm run build', 'npx wrangler deploy'];
  let at = -1;
  for (const step of order) {
    const next = workflow.indexOf(step, at + 1);
    assert.ok(next > at, `${step} is missing or runs out of order in deploy.yml`);
    at = next;
  }
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
});