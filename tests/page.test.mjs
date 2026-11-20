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

test('every test file runs under npm test', () => {
  const dir = new URL('../tests/', import.meta.url);
  const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(suites.length >= 8, 'the test directory looks empty');
  for (const suite of suites) {
    assert.ok(pkg.scripts.test.includes(`tests/${suite}`), `${suite} is not in the npm test script`);
  }
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