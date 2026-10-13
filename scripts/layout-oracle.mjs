// Records how Chrome lays out the portable box model, the oracle
// test/oracle.test.jsx checks a Document's layout against: each view of
// test/fixtures/layout-cases.jsx is rendered by ren-dom (the markup and CSS
// the DOM renderer writes for it) on its own page 400 by 600, in DejaVu
// Sans (test/fixtures/dejavu.ttf, kerning off, as Sfnt measures it), and
// the border box of each primitive's element ([data-ren], in document
// order) is recorded relative to its page. ren-dom is bundled from its
// checkout beside this one (the workspace's layout), or from REN_DOM (its
// src/index.js). Run it under the machine-wide Chrome lock and commit what
// it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/layout-oracle.mjs test/fixtures/layout.json
import { copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { withChrome } from './chrome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dom = process.env.REN_DOM ?? join(root, '../../../ren-dom/wtree/_repo_/src/index.js');
const page = `
import { Root } from 'ren-core';
import { $dom } from 'ren-dom';
import { cases } from './test/fixtures/layout-cases.jsx';
const pages = cases.map(() => {
  const page = document.createElement('div');
  page.style.cssText = 'position:relative;width:400px;height:600px;overflow:hidden';
  document.body.appendChild(page);
  return page;
});
cases.forEach((c, i) => Root({ id: 'case' + i, target: pages[i], renderer: $dom(document), children: c.view() }));
const at = v => Math.round(v * 1000) / 1000;
window.boxes = () => cases.map((c, i) => {
  const o = pages[i].getBoundingClientRect();
  return { name: c.name, boxes: [...pages[i].querySelectorAll('[data-ren]')].map(e => {
    const r = e.getBoundingClientRect();
    return [at(r.x - o.x), at(r.y - o.y), at(r.width), at(r.height)];
  }) };
});
`;
const bundle = await build({ stdin: { contents: page, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', jsxImportSource: 'ren-core', alias: { 'ren-dom': dom }, logLevel: 'error' });
const js = bundle.outputFiles[0].text;

await withChrome(async ({ send, evaluate, profile }) => {
  copyFileSync(join(root, 'test/fixtures/dejavu.ttf'), join(profile, 'dejavu.ttf'));
  const file = join(profile, 'layout.html');
  writeFileSync(file, `<!doctype html><html><head><style>@font-face{font-family:DejaVu;src:url(dejavu.ttf)}body{margin:0;font-family:DejaVu;font-kerning:none}</style></head><body><script>${js.replace(/<\/script/g, '<\\/script')}</script></body></html>`);
  await send('Page.navigate', { url: `file://${file}` });
  // Laid out once the script has rendered and the font has loaded (withChrome's deadline ends a page that never does).
  while ((await evaluate('typeof boxes === "function"')) !== true);
  await evaluate('document.fonts.load("16px DejaVu").then(() => document.fonts.ready).then(() => 1)');
  const measured = await evaluate('boxes()');
  const recorded = (await send('Browser.getVersion')).result.product;
  // A case a line.
  writeFileSync(process.argv[2], `{"recorded":${JSON.stringify(recorded)},"cases":[\n${measured.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
  console.log('recorded', measured.length, 'cases with', recorded);
});
