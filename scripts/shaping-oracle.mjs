// Records where Chrome sets shaped text, the oracle test/shaping-oracle.test.js
// checks Sfnt's shaping (shape.js) against: each line set on one row of a
// left-to-right block in DejaVu Sans (test/fixtures/dejavu.ttf), Noto Sans
// Devanagari for what it lacks (test/fixtures/noto-devanagari.ttf), at 16
// px, with kerning and the optional ligatures off (as ren-dom sets DOM
// text), and recorded: the row's width, each grapheme cluster's box (a
// Range over it) as its left and right edges from the row's start, and,
// on a row of one direction, the caret before each cluster (a collapsed
// Range's left edge). Arabic, Hebrew with points, Devanagari, Latin with
// marks, Latin alone and marks a typeface lacks (font fallback by cluster).
// Run it under the machine-wide Chrome lock and commit what it writes:
//   flock "$HOME/.cache/chrome-bench.lock" node scripts/shaping-oracle.mjs test/fixtures/shaping.json
import { copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withChrome } from './chrome.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The lines: a name, its text and whether it is of one direction (its carets recorded). */
const lines = [
  ['Arabic joined', 'سلام عليكم يا صديقي', true],
  ['Arabic with marks', 'بِسْمِ الرَّحْمٰنِ', true],
  ['lam-alef', 'لا إله إلا هو', true],
  ['Arabic in Latin', 'abc سلام def', false],
  ['Hebrew with points', 'שָׁלוֹם עוֹלָם', true],
  ['Devanagari', 'नमस्ते दुनिया क्षत्रिय', true],
  ['Devanagari in Latin', 'Hindi: हिन्दी है', false],
  ['Latin with marks', 'q́é x̣ a­b', true],
  ['Latin', 'Hello, office world AV', true],
  // A cluster in the first typeface that has all of it, else the first one's missing glyphs: a mark only the fallback has on a base both have, on a base only the first has, on a base only the fallback has, and a mark only the first has on a base only the fallback has.
  ['Fallback by cluster', 'x-\u0951 a\u0951 \u0915\u0951 \u0915\u0301 b', true],
];

const page = `
const rows = ${JSON.stringify(lines)}.map(([name, text, carets]) => {
  const row = document.createElement('div');
  row.textContent = text;
  document.body.appendChild(row);
  return { name, text, carets, row };
});
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const round = v => Math.round(v * 10000) / 10000;
window.boxes = () => rows.map(({ name, text, carets, row }) => {
  const at = row.getBoundingClientRect().left;
  const node = row.firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, text.length);
  const width = round(range.getBoundingClientRect().width);
  const clusters = [];
  for (const s of graphemes.segment(text)) {
    range.setStart(node, s.index);
    range.setEnd(node, s.index + s.segment.length);
    const r = range.getBoundingClientRect();
    const entry = [s.index, s.index + s.segment.length, round(r.left - at), round(r.right - at)];
    if (carets) {
      range.setStart(node, s.index);
      range.setEnd(node, s.index);
      entry.push(round(range.getClientRects()[0].left - at));
    }
    clusters.push(entry);
  }
  return { name, text, width, clusters };
});
`;

await withChrome(async ({ send, evaluate, profile }) => {
  copyFileSync(join(root, 'test/fixtures/dejavu.ttf'), join(profile, 'dejavu.ttf'));
  copyFileSync(join(root, 'test/fixtures/noto-devanagari.ttf'), join(profile, 'deva.ttf'));
  const file = join(profile, 'shaping.html');
  writeFileSync(file, `<!doctype html><html><head><style>@font-face{font-family:DejaVu;src:url(dejavu.ttf)}@font-face{font-family:Deva;src:url(deva.ttf)}body{margin:0;font:16px DejaVu, Deva;font-kerning:none;font-variant-ligatures:none;white-space:pre}div{width:800px}</style></head><body><script>${page}</script></body></html>`);
  await send('Page.navigate', { url: `file://${file}` });
  // Measured once the script has run and the fonts have loaded (withChrome's deadline ends a page that never does).
  while ((await evaluate('typeof boxes === "function"')) !== true);
  await evaluate('Promise.all([document.fonts.load("16px DejaVu"), document.fonts.load("16px Deva", "न")]).then(() => document.fonts.ready).then(() => 1)');
  const measured = await evaluate('boxes()');
  const recorded = (await send('Browser.getVersion')).result.product;
  writeFileSync(process.argv[2], `{"recorded":${JSON.stringify(recorded)},"lines":[\n${measured.map((/** @type {any} */ c) => JSON.stringify(c)).join(',\n')}\n]}\n`);
  console.log('recorded', measured.length, 'lines with', recorded);
});
