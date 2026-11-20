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