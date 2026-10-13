// Records where Chrome places each character of lines of mixed direction,
// the oracle test/bidi-oracle.test.js checks a canvas's rows against: each
// line set on one row of a block in DejaVu Sans (test/fixtures/dejavu.ttf)
// at 16 px, kerning off, and each character's box (a Range over it)
// recorded as its left and right edges from the row's left edge (its
// text's). Hebrew, Latin, digits and punctuation: what is laid out with the
// font's own advances, unshaped. The block is left to right (the DOM's
// default direction), or right to left (`dir="rtl"`) for the lines marked
// so.
// Run it under the machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/bidi-oracle.mjs test/fixtures/bidi.json
import { copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withChrome } from './chrome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The lines: a name, its text, and its block's direction (left to right when not given). */
const lines = [
  ['Hebrew in Latin', 'abc אבג def'],
  ['Hebrew alone', 'שלום עולם'],
  ['a number in Hebrew', 'שלום 123 עולם'],
  ['a decimal and a sign', 'גדול 3.14 ממנו!'],
  ['brackets in Hebrew', 'א (ב) [ג] ד'],
  ['brackets around Hebrew in Latin', 'a (בג) c'],
  ['Latin in Hebrew', 'אב hello world גד'],
  ['punctuation at the ends', '!אבג, דה.'],
  ['a price', 'מחיר: 1,234.50 ₪'],
  ['Latin, Hebrew and a number', 'Hello, עולם! 42'],
  ['right to left: Latin and a mark', 'abc!', 'rtl'],
  ['right to left: Hebrew alone', 'שלום עולם', 'rtl'],
  ['right to left: Hebrew in Latin', 'abc אבג def', 'rtl'],
  ['right to left: Latin in Hebrew', 'אב hello world גד', 'rtl'],
  ['right to left: a number first', '12 abc, 34', 'rtl'],
  ['right to left: brackets', 'a (בג) c [d]', 'rtl'],
  ['right to left: Latin, Hebrew and a number', 'Hello, עולם! 42', 'rtl'],
  ['right to left: a price', 'מחיר: 1,234.50 ₪', 'rtl'],
];

const page = `
const rows = ${JSON.stringify(lines)}.map(([name, text, dir]) => {
  const row = document.createElement('div');
  if (dir !== undefined) row.dir = dir;
  row.textContent = text;
  document.body.appendChild(row);
  return { name, text, dir, row };
});
window.boxes = () => rows.map(({ name, text, dir, row }) => {
  const node = row.firstChild;
  const range = document.createRange();
  range.selectNodeContents(row);
  const at = range.getBoundingClientRect().left;
  const boxes = [];
  for (let i = 0; i < text.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    boxes.push([Math.round((r.left - at) * 1000) / 1000, Math.round((r.right - at) * 1000) / 1000]);
  }
  return dir === undefined ? { name, text, boxes } : { name, text, dir, boxes };
});
`;

await withChrome(async ({ send, evaluate, profile }) => {
  copyFileSync(join(root, 'test/fixtures/dejavu.ttf'), join(profile, 'dejavu.ttf'));
  const file = join(profile, 'bidi.html');
  writeFileSync(file, `<!doctype html><html><head><style>@font-face{font-family:DejaVu;src:url(dejavu.ttf)}body{margin:0;font:16px DejaVu;font-kerning:none;white-space:pre}div{width:600px}</style></head><body><script>${page}</script></body></html>`);
  await send('Page.navigate', { url: `file://${file}` });
  // Measured once the script has run and the font has loaded (withChrome's deadline ends a page that never does).
  while ((await evaluate('typeof boxes === "function"')) !== true);
  await evaluate('document.fonts.load("16px DejaVu").then(() => document.fonts.ready).then(() => 1)');
  const measured = await evaluate('boxes()');
  const recorded = (await send('Browser.getVersion')).result.product;
  writeFileSync(process.argv[2], `{"recorded":${JSON.stringify(recorded)},"lines":[\n${measured.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
  console.log('recorded', measured.length, 'lines with', recorded);
});
